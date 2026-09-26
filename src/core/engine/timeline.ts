/**
 * Timeline builder: converts stored messages into timeline items for the UI.
 * Also provides pendingApprovals and danglingToolCalls helpers.
 */
import type { ModelMessage } from 'ai'
import type { TimelineItem, ToolItem } from '../../shared/protocol'
import type { StoredMessage } from '../store/repos'

/** Builds a timeline of items from stored messages. */
export function buildTimeline(stored: StoredMessage[]): TimelineItem[] {
  const items: TimelineItem[] = []
  // Map toolCallId → ToolItem for mutation during processing
  const toolMap = new Map<string, ToolItem>()

  for (let i = 0; i < stored.length; i++) {
    const { message, at } = stored[i]
    const msg = message as ModelMessage

    if (msg.role === 'user') {
      // Join text parts
      const parts = Array.isArray(msg.content)
        ? msg.content
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text ?? p.value ?? '')
        : [String(msg.content)]
      items.push({ kind: 'user', id: `m${i}`, at, text: parts.join('\n') })
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
        if ((part as any).type === 'text') {
          const text = ((part as any).text ?? '').toString()
          if (text.trim()) {
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
