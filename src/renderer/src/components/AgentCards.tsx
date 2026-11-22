import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { AssistantText } from './Markdown'
import type { ToolItem } from '../../../shared/protocol'
import type { QuickReplies } from '../../../shared/quick-replies'
import { WIDGET_PROMPT_MESSAGE, WIDGET_TOOL_NAMES } from '../../../shared/widgets'

/** Tools shown as their own card in the conversation instead of inside the gray activity summary. */
export const CARD_TOOLS = new Set(['AskUserQuestion', 'ask_user', 'ask_user_input_v0', 'SendUserMessage', 'SendUserFile', 'present_files', ...WIDGET_TOOL_NAMES])

/** Opening these runs them, so a file card only shows where they are. */
const RUNNABLE = /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|scr|hta|jar|reg|cpl|pif|url|appref-ms)$/i

type Choice = { label: string; description?: string }

interface QuestionField {
  id: string
  kind: 'choice' | 'color' | 'slider' | 'freeform'
  title: string
  subtitle?: string
  options: Choice[]
  multi: boolean
  min?: number
  max?: number
  step?: number
  initial?: string
  placeholder?: string
}

/** Normalises AskUserQuestion's and ask_user's two question formats into one. */
function questionFields(item: ToolItem): { title: string | null; prompt: string | null; fields: QuestionField[] } {
  const input = (item.input ?? {}) as Record<string, unknown>
  const list = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : []
  if (item.toolName === 'ask_user_input_v0') {
    // The operating prompt's format: options are plain labels, type says single or multi select.
    return {
      title: null,
      prompt: null,
      fields: list.map((q, i) => ({
        id: String(i),
        kind: 'choice',
        title: String(q.question ?? ''),
        options: (Array.isArray(q.options) ? q.options : []).map((o: unknown) => ({ label: String(o ?? '') })),
        multi: q.type === 'multi_select' || q.type === 'rank_priorities'
      }))
    }
  }
  if (item.toolName === 'AskUserQuestion') {
    return {
      title: null,
      prompt: null,
      fields: list.map((q, i) => ({
        id: String(q.header ?? i),
        kind: 'choice',
        title: String(q.question ?? ''),
        subtitle: q.header ? String(q.header) : undefined,
        options: (Array.isArray(q.options) ? q.options : []).map((o: { label?: unknown; description?: unknown }) => ({
          label: String(o.label ?? ''),
          description: o.description ? String(o.description) : undefined
        })),
        multi: Boolean(q.multiSelect)
      }))
    }
  }
  return {
    title: input.title ? String(input.title) : null,
    prompt: input.prompt ? String(input.prompt) : null,
    fields: list.map((q, i) => {
      const kind = String(q.kind ?? 'freeform')
      return {
        id: String(q.id ?? i),
        kind: kind === 'color' ? 'color' : kind === 'slider' ? 'slider' : kind === 'freeform' ? 'freeform' : 'choice',
        title: String(q.title ?? ''),
        subtitle: q.subtitle ? String(q.subtitle) : undefined,
        options: (Array.isArray(q.options) ? q.options : []).map((o: unknown) =>
          typeof o === 'string' ? { label: o } : { label: String((o as { label?: unknown }).label ?? '') }
        ),
        multi: Boolean(q.multi),
        min: typeof q.min === 'number' ? q.min : undefined,
        max: typeof q.max === 'number' ? q.max : undefined,
        step: typeof q.step === 'number' ? q.step : undefined,
        initial: q.default !== undefined ? String(q.default) : undefined,
        placeholder: q.placeholder ? String(q.placeholder) : undefined
      }
    })
  }
}

function QuestionCard({ taskId, item, answered, running }: { taskId: string; item: ToolItem; answered: boolean; running: boolean }) {
  const showToast = useStore((s) => s.showToast)
  const { title, prompt, fields } = questionFields(item)
  const [values, setValues] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(fields.map((f) => [f.id, f.initial !== undefined ? [f.initial] : f.kind === 'color' ? ['#000000'] : []]))
  )
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  /** What the user typed in a choice question's "Other" box. */
  const [other, setOther] = useState<Record<string, string>>({})
  const done = answered || sent

  const toggle = (field: QuestionField, label: string): void =>
    setValues((prev) => {
      const current = prev[field.id] ?? []
      const next = field.multi ? (current.includes(label) ? current.filter((v) => v !== label) : [...current, label]) : [label]
      return { ...prev, [field.id]: next }
    })

  const send = async (): Promise<void> => {
    const lines = fields.map((f) => {
      const picked = [...(values[f.id] ?? []), ...(f.kind === 'choice' && other[f.id]?.trim() ? [other[f.id]!.trim()] : [])]
      return `- ${f.subtitle ?? f.title}: ${picked.join(', ') || '(no answer)'}`
    })
    setBusy(true)
    try {
      await core.call('tasks.send', { id: taskId, text: `My answers:\n${lines.join('\n')}` })
      setSent(true)
    } catch (error) {
      showToast(`Couldn't send your answers: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="msg-in rounded-3xl border border-rule bg-card p-4">
      {title && <div className="font-serif text-[18px] leading-snug">{title}</div>}
      {prompt && <p className="mt-1 text-[13px] text-ink-muted">{prompt}</p>}
      <div className="mt-2 flex flex-col gap-4">
        {fields.map((field) => (
          <div key={field.id}>
            <div className="text-[14px] font-medium text-ink">{field.title}</div>
            {field.subtitle && field.subtitle !== field.title && <div className="caption mt-0.5">{field.subtitle}</div>}
            {field.kind === 'choice' && (
              <div className="mt-2 flex flex-wrap gap-2">
                {field.options.map((option) => {
                  const on = (values[field.id] ?? []).includes(option.label)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      disabled={done}
                      title={option.description}
                      className={`btn r-concentric ${on ? 'btn-clay' : 'btn-outline'}`}
                      style={concentricVars(16)}
                      onClick={() => toggle(field, option.label)}
                    >
                      {option.label}
                    </button>
                  )
                })}
                <input
                  disabled={done}
                  className="input min-w-[160px] flex-1"
                  placeholder="Other: type your own answer"
                  aria-label={`Other answer to: ${field.title}`}
                  value={other[field.id] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    setOther((prev) => ({ ...prev, [field.id]: value }))
                    // A typed answer replaces a single choice.
                    if (!field.multi && value.trim()) setValues((prev) => ({ ...prev, [field.id]: [] }))
                  }}
                />
              </div>
            )}
            {field.kind === 'color' && (
              <input
                type="color"
                disabled={done}
                className="mt-2 h-9 w-16"
                value={(values[field.id] ?? ['#000000'])[0]}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: [e.target.value] }))}
              />
            )}
            {field.kind === 'slider' && (
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  disabled={done}
                  min={field.min ?? 0}
                  max={field.max ?? 100}
                  step={field.step ?? 1}
                  value={(values[field.id] ?? [String(field.min ?? 0)])[0] ?? String(field.min ?? 0)}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: [e.target.value] }))}
                />
                <span className="tabular-nums text-[13px] text-ink-muted">{(values[field.id] ?? [])[0] ?? field.min ?? 0}</span>
              </div>
            )}
            {field.kind === 'freeform' && (
              <textarea
                disabled={done}
                rows={2}
                placeholder={field.placeholder}
                className="input mt-2 w-full resize-none"
                value={(values[field.id] ?? [])[0] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: [e.target.value] }))}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {done ? (
          <span className="text-[12px] text-ink-faint">Answered</span>
        ) : (
          <button
            type="button"
            className="btn btn-clay r-concentric"
            style={concentricVars(16)}
            disabled={busy || running}
            title={running ? 'Wait until the assistant has finished its turn' : undefined}
            onClick={() => void send()}
          >
            Send answers
          </button>
        )}
      </div>
    </div>
  )
}

function FileCards({ item }: { item: ToolItem }) {
  const showToast = useStore((s) => s.showToast)
  const output = (item.output ?? {}) as { files?: Array<{ path: string; absolutePath: string }>; caption?: string | null }
  const files = output.files ?? []
  if (files.length === 0) return null
  return (
    <div className="msg-in flex flex-col gap-2">
      {output.caption && <p className="text-[14px] text-ink">{output.caption}</p>}
      {files.map((file) => (
        <div key={file.absolutePath} className="flex items-center gap-3 rounded-2xl border border-rule bg-card px-4 py-3">
          <FileText size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={file.absolutePath}>
            {file.path}
          </span>
          {RUNNABLE.test(file.path) ? (
            <span className="shrink-0 text-[12px] text-ink-faint">Program or script: open it yourself if you trust it</span>
          ) : (
            <button
              type="button"
              className="btn btn-outline shrink-0"
              onClick={() =>
                void window.deskmates.openPath(file.absolutePath).catch((error: unknown) =>
                  showToast(`Couldn't open it: ${error instanceof Error ? error.message : String(error)}`)
                )
              }
            >
              Open
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** The card for one of CARD_TOOLS. `answered` is true once the user has written after it. */
export function AgentCard({ taskId, item, answered, running }: { taskId: string; item: ToolItem; answered: boolean; running: boolean }) {
  if (item.toolName === 'SendUserMessage') {
    const message = String(((item.input ?? {}) as { message?: unknown }).message ?? '')
    return message ? <AssistantText text={message} /> : null
  }
  if (item.toolName === 'SendUserFile' || item.toolName === 'present_files') return item.state === 'done' ? <FileCards item={item} /> : null
  if (WIDGET_TOOL_NAMES.includes(item.toolName)) return <WidgetCard taskId={taskId} item={item} running={running} />
  return <QuestionCard taskId={taskId} item={item} answered={answered} running={running} />
}

/**
 * Tap-to-answer options under a reply that asked the user to choose in plain text (what Freebuff and
 * the other command-line agents do, since they can't draw a question card). A tap sends that option;
 * the box sends anything else.
 */
export function QuickReplyCard({ taskId, replies, running }: { taskId: string; replies: QuickReplies; running: boolean }) {
  const showToast = useStore((s) => s.showToast)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const send = async (answer: string): Promise<void> => {
    if (!answer.trim() || busy || sent) return
    setBusy(true)
    try {
      await core.call('tasks.send', { id: taskId, text: answer.trim() })
      setSent(answer.trim())
    } catch (error) {
      showToast(`Couldn't send your answer: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  if (sent) return null
  return (
    <div className="msg-in mt-3 rounded-3xl border border-rule bg-card p-3" aria-label="Quick answers">
      <div className="flex flex-wrap gap-2">
        {replies.options.map((option) => (
          <button
            key={option}
            type="button"
            className="btn btn-outline r-concentric text-left"
            style={concentricVars(14)}
            disabled={busy || running}
            onClick={() => void send(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send(text)
        }}
      >
        <input className="input flex-1" placeholder="Or type something else" value={text} disabled={busy || running} onChange={(e) => setText(e.target.value)} aria-label="Your own answer" />
        <button type="submit" className="btn btn-clay r-concentric" style={concentricVars(14)} disabled={busy || running || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

/**
 * A widget an agent drew (a chart, cards, a quiz, a map…): its page in a sandboxed frame that grows
 * to the height the page reports. While the tool runs, a placeholder line; if it failed, the error.
 */
function WidgetCard({ taskId, item, running }: { taskId: string; item: ToolItem; running: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(160)
  const showToast = useStore((s) => s.showToast)
  const runningRef = useRef(running)
  runningRef.current = running
  const output = (item.output ?? {}) as { widget?: unknown; title?: unknown }
  const src = typeof output.widget === 'string' && output.widget.startsWith('deskmates-preview://widget/') ? output.widget : null
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown; text?: unknown }
      if (data?.type === 'deskmates-widget-height' && typeof data.height === 'number') setHeight(Math.min(Math.max(data.height, 40), 2400))
      // The Visualizer's sendPrompt(text): the widget asks a follow-up as the user's next message.
      if (data?.type === WIDGET_PROMPT_MESSAGE && typeof data.text === 'string' && data.text.trim()) {
        if (runningRef.current) {
          showToast('Wait for the answer to finish, then try again.')
          return
        }
        core.call('tasks.send', { id: taskId, text: data.text.trim().slice(0, 2000) }).catch((error: unknown) => showToast(`Couldn't send that: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [taskId, showToast])
  if (item.state === 'error') {
    return <div className="msg-in rounded-2xl border border-[color:var(--danger,#b3412f)]/40 px-4 py-3 text-[13px] text-[color:var(--danger,#b3412f)]">Couldn't show this: {typeof item.output === 'string' ? item.output : 'the widget failed.'}</div>
  }
  if (!src) {
    return item.state === 'running' ? <div className="msg-in shimmer-txt text-[13px] text-ink-muted">Drawing…</div> : null
  }
  return (
    <iframe
      ref={frameRef}
      title={typeof output.title === 'string' ? output.title : 'Widget'}
      src={src}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      className="msg-in w-full rounded-2xl border-0 bg-transparent"
      style={{ height }}
    />
  )
}
