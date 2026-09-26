import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { Conversation } from '../components/Conversation'
import { TerminalStatusLine } from '../components/TerminalStatusMark'
import { TOOL_LABELS, onboardingLabel } from '../lib/terminals'

export function AgentsSessionView({ sessionId }: { sessionId: string }) {
  const sessions = useStore((s) => s.terminalSessions)
  const itemsBySession = useStore((s) => s.terminalItemsBySession)
  const session = sessions.find((item) => item.id === sessionId)
  const timeline = itemsBySession[sessionId] ?? []
  const sendTerminalPrompt = useStore((s) => s.sendTerminalPrompt)
  const stopTerminalSession = useStore((s) => s.stopTerminalSession)
  const openTerminalSession = useStore((s) => s.openTerminalSession)

  const [text, setText] = useState('')
  const inputId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void openTerminalSession(sessionId)
  }, [sessionId, openTerminalSession])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  if (!session) {
    return (
      <main className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[14px] text-ink-faint">This session was closed.</p>
      </main>
    )
  }

  const busy = session.state === 'busy' || session.state === 'starting'
  const onboardingText = onboardingLabel(session.onboarding)

  const send = (): void => {
    const message = text.trim()
    if (!message || busy) return
    void sendTerminalPrompt(sessionId, message)
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
          <div className="mt-1 truncate text-[12px] text-ink-muted" title={session.folder}>
            {session.folder}
          </div>
          <div className="mt-1 text-[12px] text-ink-muted">
            <TerminalStatusLine state={session.state} />
            {onboardingText && (
              <span className={session.onboarding === 'failed' ? 'ml-2' : 'ml-2 text-ink-faint'} style={session.onboarding === 'failed' ? { color: 'var(--brick)' } : undefined}>
                · {onboardingText}
              </span>
            )}
          </div>
        </div>
        {busy && (
          <button type="button" className="btn btn-outline shrink-0" onClick={() => void stopTerminalSession(sessionId)}>
            <Square size={13} aria-hidden="true" className="mr-1.5" />
            Stop
          </button>
        )}
      </header>

      {session.error && (
        <div className="error-bar mx-8 mt-4" role="alert">
          {session.error}
        </div>
      )}

      <Conversation
        taskId={sessionId}
        timeline={timeline}
        running={busy}
        emptyHint="Deskmates is checking in with the agent. Its reply — and the check-in confirmation — will show up here."
      />

      <div className="shrink-0 px-8 pb-6">
        <div className="rounded-3xl border border-rule bg-card p-2">
          <label htmlFor={inputId} className="sr-only">
            Message
          </label>
          <textarea
            id={inputId}
            ref={textareaRef}
            value={text}
            disabled={busy}
            placeholder={busy ? 'Waiting for the agent to reply…' : `Send a prompt to ${TOOL_LABELS[session.tool]}`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            className="w-full resize-none bg-transparent text-[15px] leading-normal text-ink outline-none placeholder:text-ink-faint"
          />
          <div className="mt-2 flex items-center justify-end">
            <button
              type="button"
              aria-label="Send"
              disabled={!text.trim() || busy}
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
