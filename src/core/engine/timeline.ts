/**
 * Timeline builder: converts stored messages into timeline items for the UI.
 * Also provides pendingApprovals and danglingToolCalls helpers.
 */
import type { AssistantContent, ModelMessage } from 'ai'
import type { ReplySource, TimelineItem, ToolItem } from '../../shared/protocol'
import type { StoredMessage } from '../store/repos'
import { replyParts } from '../terminals/freebuff-host'

/**
 * How a Freebuff reply is stored: its prose as text, and each step it took ("• Read file.ts", its
 * thinking) as a text part marked as a step. The chat shows a step as a small grey step line rather
 * than as part of the answer. Plain text parts keep the history valid for any other model.
 */
export function freebuffReplyContent(reply: string): AssistantContent {
  const parts = replyParts(reply)
  if (!parts.some((part) => part.step)) return reply
  return parts.map((part) => (part.step ? { type: 'text' as const, text: part.text, providerOptions: { deskmates: { step: 'freebuff' } } } : { type: 'text' as const, text: part.text }))
}

/** Whether a stored text part is one of Freebuff's steps (see freebuffReplyContent). */
function isFreebuffStep(part: unknown): boolean {
  return (part as { providerOptions?: { deskmates?: { step?: unknown } } }).providerOptions?.deskmates?.step === 'freebuff'
}

const FETCH_TOOLS = /^(WebFetch|web_fetch|fetch_url|browser_open)$/
const SEARCH_TOOLS = /^(WebSearch|web_search)$/

/** A tool output's value as data: search results come back as arrays, sometimes as JSON text. */
function outputValue(output: unknown): unknown {
  const value = output && typeof output === 'object' && 'value' in (output as object) ? (output as { value: unknown }).value : output
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

interface TurnSources {
  end: number
  fetched: Map<string, string>
  found: Map<string, string>
}

/**
 * The sources of each turn's answer: the pages it read (fetches) and the search results its reply
 * points at, put under the turn's last reply as Claude shows them.
 */
function attachSources(items: TimelineItem[], turns: TurnSources[]): void {
  let start = 0
  for (const turn of turns) {
    const replies = items.slice(start, turn.end).filter((item): item is Extract<TimelineItem, { kind: 'assistant' }> => item.kind === 'assistant')
    start = turn.end
    const last = replies.at(-1)
    if (!last) continue
    const said = replies.map((r) => r.text).join('\n').toLowerCase()
    const sources = new Map<string, string>(turn.fetched)
    for (const [url, title] of turn.found) {
      const host = hostOf(url)
      if (said.includes(url.toLowerCase()) || (host && said.includes(host))) sources.set(url, sources.get(url) || title)
    }
    const list: ReplySource[] = [...sources]
      .filter(([url]) => /^https?:\/\//i.test(url))
      .slice(0, 10)
      .map(([url, title]) => ({ url, title: title || hostOf(url) || url }))
    if (list.length) last.sources = list
  }
}

/**
 * Builds a timeline of items from stored messages. `forks` are the positions that have versions
 * (TasksRepo.forks), so an edited message shows its ‹ 1/2 › switcher.
 */
export function buildTimeline(stored: StoredMessage[], forks?: Map<number, { index: number; count: number }>): TimelineItem[] {
  const items: TimelineItem[] = []
  // Map toolCallId → ToolItem for mutation during processing
  const toolMap = new Map<string, ToolItem>()
  // Each turn's pages read and search results, for the sources under its answer.
  const turns: TurnSources[] = []
  let turn: TurnSources = { end: 0, fetched: new Map(), found: new Map() }
  const fetchUrls = new Map<string, string>()

  for (let i = 0; i < stored.length; i++) {
    const { message, at } = stored[i]
    const msg = message as ModelMessage

    if (msg.role === 'user') {
      turn.end = items.length
      turns.push(turn)
      turn = { end: 0, fetched: new Map(), found: new Map() }
      // Join text parts
      const texts: string[] = Array.isArray(msg.content)
        ? msg.content.filter((p: any) => p.type === 'text').map((p: any) => String(p.text ?? p.value ?? ''))
        : [String(msg.content)]
      // Attached documents are their own text parts: shown as file chips, not as the message.
      const files = texts.map((t) => /^<document name="([^"]*)">/.exec(t)?.[1]).filter((name): name is string => name !== undefined)
      const parts = texts.filter((t) => !t.startsWith('<document name="'))
      // Pictures sent with the message, shown as thumbnails above its text.
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((p: any) => p.type === 'image' && typeof p.image === 'string')
            .map((p: any) => `data:${p.mediaType ?? 'image/png'};base64,${p.image}`)
        : []
      const versions = forks?.get(i)
      items.push({ kind: 'user', id: `m${i}`, at, text: parts.join('\n'), position: i, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(versions && versions.count > 1 ? { versions } : {}) })
    } else if (msg.role === 'assistant') {
      // CLI-backed providers (OpenCode/agy) store their reply as a plain string.
      const content =
        typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : Array.isArray(msg.content)
            ? msg.content
            : []
      let partIdx = 0
      for (const part of content) {
        if ((part as any).type === 'reasoning') {
          const text = ((part as any).text ?? '').toString()
          if (text.trim()) items.push({ kind: 'thinking', id: `m${i}r${partIdx}`, at, text })
        } else if ((part as any).type === 'text') {
          const text = ((part as any).text ?? '').toString()
          if (text.trim() && isFreebuffStep(part)) {
            items.push({ kind: 'tool', id: `m${i}p${partIdx}`, at, toolName: 'freebuff', input: { activity: text }, state: 'done' })
          } else if (text.trim()) {
            items.push({ kind: 'assistant', id: `m${i}p${partIdx}`, at, text })
          }
        } else if ((part as any).type === 'tool-call') {
          const tc = part as any
          const toolItem: ToolItem = {
            kind: 'tool',
            id: tc.toolCallId,
            at,
            toolName: tc.toolName,
            input: tc.input,
            state: 'running'
          }
          items.push(toolItem)
          toolMap.set(tc.toolCallId, toolItem)
          if (FETCH_TOOLS.test(String(tc.toolName)) && typeof tc.input?.url === 'string') fetchUrls.set(tc.toolCallId, tc.input.url)
        } else if ((part as any).type === 'tool-approval-request') {
          const req = part as any
          if (!req.isAutomatic) {
            const existing = toolMap.get(req.toolCallId)
            if (existing) {
              existing.state = 'awaiting-approval'
              existing.approvalId = req.approvalId
            }
          }
        }
        partIdx++
      }
    } else if (msg.role === 'tool') {
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const part of content) {
        if ((part as any).type === 'tool-result') {
          const tr = part as any
          const existing = toolMap.get(tr.toolCallId)
          if (existing) {
            const output = tr.output
            if (output?.type === 'error-text') {
              existing.state = 'error'
              existing.error = output.value
            } else if (output?.type === 'error-json') {
              existing.state = 'error'
              existing.error = JSON.stringify(output.value)
            } else if (output?.type === 'execution-denied') {
              existing.state = 'denied'
              existing.error = output.reason ?? undefined
            } else {
              // text, json, content
              existing.state = 'done'
              existing.output = output?.value ?? output
              const url = fetchUrls.get(tr.toolCallId)
              if (url) {
                const value = outputValue(output) as { title?: unknown } | string
                turn.fetched.set(url, typeof value === 'object' && value && typeof value.title === 'string' ? value.title : '')
              }
              if (SEARCH_TOOLS.test(String(existing.toolName))) {
                const value = outputValue(output) as unknown
                const list = Array.isArray(value) ? value : Array.isArray((value as { results?: unknown })?.results) ? (value as { results: unknown[] }).results : []
                for (const r of list as Array<{ url?: unknown; title?: unknown }>) if (typeof r?.url === 'string') turn.found.set(r.url, typeof r.title === 'string' ? r.title : '')
              }
            }
          }
        } else if ((part as any).type === 'tool-approval-response') {
          const resp = part as any
          // Find the tool item with this approvalId
          for (const item of items) {
            if (item.kind === 'tool' && item.approvalId === resp.approvalId) {
              if (resp.approved) {
                item.state = 'running'
                delete item.approvalId
              } else {
                item.state = 'denied'
              }
              break
            }
          }
        }
      }
    }
  }

  turn.end = items.length
  turns.push(turn)
  attachSources(items, turns)
  return items
}

/** Returns pending (non-automatic) approval requests that have no later response. */
export function pendingApprovals(
  stored: StoredMessage[]
): Array<{ approvalId: string; toolCallId: string; toolName: string; input: unknown }> {
  // Collect all approval requests and responses
  const requests = new Map<string, { approvalId: string; toolCallId: string; toolName: string; input: unknown }>()
  const responded = new Set<string>()

  // Collect all tool calls for looking up toolName and input
  const toolCalls = new Map<string, { toolName: string; input: unknown }>()

  for (const { message } of stored) {
    const msg = message as ModelMessage
    if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const part of content) {
        if ((part as any).type === 'tool-call') {
          const tc = part as any
          toolCalls.set(tc.toolCallId, { toolName: tc.toolName, input: tc.input })
        }
        if ((part as any).type === 'tool-approval-request') {
          const req = part as any
          if (!req.isAutomatic) {
            const tc = toolCalls.get(req.toolCallId)
            requests.set(req.approvalId, {
              approvalId: req.approvalId,
              toolCallId: req.toolCallId,
              toolName: tc?.toolName ?? '',
              input: tc?.input
            })
          }
        }
      }
    } else if (msg.role === 'tool') {
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const part of content) {
        if ((part as any).type === 'tool-approval-response') {
          responded.add((part as any).approvalId)
        }
      }
    }
  }

  const result: Array<{ approvalId: string; toolCallId: string; toolName: string; input: unknown }> = []
  for (const [approvalId, req] of requests) {
    if (!responded.has(approvalId)) {
      result.push(req)
    }
  }
  return result
}

/**
 * Looks at tool calls in the last assistant message that have no tool-result
 * and aren't waiting for approval. If there are any, returns a repair tool message.
 */
export function danglingToolCalls(stored: StoredMessage[]): ModelMessage | null {
  // Find the last assistant message
  let lastAssistantIdx = -1
  for (let i = stored.length - 1; i >= 0; i--) {
    if ((stored[i].message as ModelMessage).role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx === -1) return null

  const assistantMsg = stored[lastAssistantIdx].message as ModelMessage
  const content = Array.isArray(assistantMsg.content) ? assistantMsg.content : []

  // Collect tool call IDs from the last assistant message
  const toolCallIds = new Map<string, string>() // toolCallId -> toolName
  const pendingApprovalIds = new Set<string>() // toolCallIds waiting for approval

  for (const part of content) {
    if ((part as any).type === 'tool-call') {
      const tc = part as any
      toolCallIds.set(tc.toolCallId, tc.toolName)
    }
    if ((part as any).type === 'tool-approval-request' && !(part as any).isAutomatic) {
      pendingApprovalIds.add((part as any).toolCallId)
    }
  }

  // Check which tool calls have results in subsequent messages
  const answeredIds = new Set<string>()
  const respondedApprovalToolIds = new Set<string>()

  for (let i = lastAssistantIdx + 1; i < stored.length; i++) {
    const msg = stored[i].message as ModelMessage
    if (msg.role === 'tool') {
      const parts = Array.isArray(msg.content) ? msg.content : []
      for (const part of parts) {
        if ((part as any).type === 'tool-result') {
          answeredIds.add((part as any).toolCallId)
        }
        if ((part as any).type === 'tool-approval-response') {
          // Find the tool call for this approval
          for (const p of content) {
            if ((p as any).type === 'tool-approval-request' && (p as any).approvalId === (part as any).approvalId) {
              respondedApprovalToolIds.add((p as any).toolCallId)
            }
          }
        }
      }
    }
  }

  // Find dangling: no tool-result and not waiting for approval (or approval already responded)
  const dangling: Array<{ toolCallId: string; toolName: string }> = []
  for (const [toolCallId, toolName] of toolCallIds) {
    if (answeredIds.has(toolCallId)) continue
    // Check if it's pending approval that hasn't been responded to
    if (pendingApprovalIds.has(toolCallId) && !respondedApprovalToolIds.has(toolCallId)) continue
    dangling.push({ toolCallId, toolName })
  }

  if (dangling.length === 0) return null

  return {
    role: 'tool',
    content: dangling.map(({ toolCallId, toolName }) => ({
      type: 'tool-result' as const,
      toolCallId,
      toolName,
      output: {
        type: 'error-text' as const,
        value: 'Interrupted before this tool finished.'
      }
    }))
  } as ModelMessage
}
