import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, RotateCw, ShieldQuestion, Unplug } from 'lucide-react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { TerminalStatusMark } from '../components/TerminalStatusMark'
import { TOOL_LABELS, attachStateLabel, onboardingLabel } from '../lib/terminals'

export function AgentsAttachView({ sessionId }: { sessionId: string }) {
  const attached = useStore((s) => s.attachedTerminalSessions)
  const sendAttachedPrompt = useStore((s) => s.sendAttachedPrompt)
  const retryAttachedPrimer = useStore((s) => s.retryAttachedPrimer)
  const stopAttachedTerminal = useStore((s) => s.stopAttachedTerminal)
  const answerAttachedPermission = useStore((s) => s.answerAttachedPermission)
  const session = attached.find((item) => item.id === sessionId)

  const [text, setText] = useState('')
  const [answering, setAnswering] = useState<string | null>(null)
  const inputId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  // Keep the newest lines of the live mirror in view while the agent streams its reply.
  useEffect(() => {
    const el = mirrorRef.current
    if (el && session?.screen) el.scrollTop = el.scrollHeight
  }, [session?.screen])

  if (!session) {
    return (
      <main className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[14px] text-ink-faint">This terminal is no longer attached.</p>
      </main>
    )
  }

  const canType = session.state === 'priming' || session.state === 'connected'
  const onboardingText = onboardingLabel(session.onboarding)
  const needsRetry = session.onboarding === 'failed'

  const send = (): void => {
    const message = text.trim()
    if (!message || !canType) return
    void sendAttachedPrompt(sessionId, message)
    setText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-rule px-8 py-4">
        <div className="min-w-0">
          <h1 className="truncate font-serif text-[24px] leading-tight">{TOOL_LABELS[session.tool]}</h1>
          <div className="mt-1 truncate text-[12px] text-ink-muted">attached to pid {session.pid}</div>
          <div className="mt-1 text-[12px] text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <TerminalStatusMark state={session.state} />
              <span>{attachStateLabel(session.state)}</span>
            </span>
            {onboardingText && (
              <span
                className="ml-2"
                style={session.onboarding === 'failed' ? { color: 'var(--brick)' } : { color: 'var(--ink-faint)' }}
              >
                · {onboardingText}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {needsRetry && (
            <button type="button" className="btn btn-outline" onClick={() => void retryAttachedPrimer(sessionId)}>
              <RotateCw size={13} aria-hidden="true" className="mr-1.5" />
              Retry check-in
            </button>
          )}
          {session.state !== 'closed' && (
            <button type="button" className="btn btn-outline" onClick={() => void stopAttachedTerminal(sessionId)}>
              <Unplug size={13} aria-hidden="true" className="mr-1.5" />
              Detach
            </button>
          )}
        </div>
      </header>

      {session.error && (
        <div className="error-bar mx-8 mt-4" role="alert">
          {session.error}
        </div>
      )}

      <pre
        ref={mirrorRef}
        className="scroll-area mx-8 mt-4 flex-1 overflow-auto rounded-3xl border border-rule bg-card p-4 text-[12px] leading-[1.55] text-ink"
        style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {session.screen ? session.screen : 'Waiting for a first screen snapshot of this terminal…'}
      </pre>

      <p className="mx-8 mt-3 text-[11px] leading-relaxed text-ink-faint">
        {attachStateLabel(session.state)} — your terminal keeps working normally; typing here goes straight into it.
        {needsRetry
          ? " The agent didn't confirm it read the Deskmates guide. Retry the check-in, or just send your prompt and it'll be checked in before your text lands."
          : ''}
      </p>

      {session.permission && (
        <div className="mx-8 mt-3 shrink-0 rounded-3xl border bg-card p-4" style={{ borderColor: 'var(--clay)' }} role="alert">
          <div className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
            <ShieldQuestion size={14} aria-hidden="true" style={{ color: 'var(--clay)' }} />
            {TOOL_LABELS[session.tool]} is asking for permission
          </div>
          <div className="mt-1.5 text-[15px] leading-snug text-ink">{session.permission.title}</div>
          {session.permission.detail && (
            <pre
              className="mt-2 max-h-28 overflow-auto text-[12px] leading-[1.5] text-ink-muted"
              style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {session.permission.detail}
            </pre>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {session.permission.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                disabled={answering === session.permission?.key}
                className={`btn r-concentric ${index === 0 ? 'btn-ivory' : 'btn-outline'}`}
                style={{ ...concentricVars(24), ...(option.danger ? { color: 'var(--brick)' } : {}) }}
                onClick={() => {
                  const key = session.permission?.key
                  if (!key) return
                  setAnswering(key)
                  void answerAttachedPermission(sessionId, key, option.id)
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="shrink-0 px-8 pb-6">
        <div className="rounded-3xl border border-rule bg-card p-2">
          <label htmlFor={inputId} className="sr-only">
            Message
          </label>
          <textarea
            id={inputId}
            ref={textareaRef}
            value={text}
            disabled={!canType}
            placeholder={canType ? `Type into ${TOOL_LABELS[session.tool]}…` : 'Waiting for the terminal to connect…'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            className="w-full resize-none bg-transparent text-[15px] leading-normal text-ink outline-none placeholder:text-ink-faint"
          />
          <div className="mt-2 flex items-center justify-end">
            <button
              type="button"
              aria-label="Send"
              disabled={!text.trim() || !canType}
              className="r-concentric flex h-8 w-9 items-center justify-center bg-clay text-white disabled:cursor-not-allowed disabled:opacity-50 enabled:hover:bg-clay-deep"
              style={concentricVars(8)}
              onClick={send}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}