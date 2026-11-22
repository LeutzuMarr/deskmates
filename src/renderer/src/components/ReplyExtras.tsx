import { useState } from 'react'
import { ChevronLeft, ChevronRight, Globe, ThumbsDown, ThumbsUp } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import type { ReplyFeedback, ReplySource } from '../../../shared/protocol'

/** ‹ 2 / 3 › under an edited message: flips between its versions and their replies. */
export function VersionSwitcher({ taskId, position, index, count, disabled }: { taskId: string; position: number; index: number; count: number; disabled: boolean }) {
  const showToast = useStore((s) => s.showToast)
  const go = (next: number): void => {
    core.call('tasks.switchVersion', { id: taskId, position, index: next }).catch((error: unknown) => showToast(`Couldn't switch versions: ${error instanceof Error ? error.message : String(error)}`))
  }
  return (
    <div className="version-switcher" role="group" aria-label={`Version ${index + 1} of ${count}`}>
      <button type="button" aria-label="Previous version" title={disabled ? 'Wait for the reply to finish' : 'Previous version'} disabled={disabled || index === 0} onClick={() => go(index - 1)}>
        <ChevronLeft size={13} aria-hidden="true" />
      </button>
      <span>
        {index + 1} / {count}
      </span>
      <button type="button" aria-label="Next version" title={disabled ? 'Wait for the reply to finish' : 'Next version'} disabled={disabled || index === count - 1} onClick={() => go(index + 1)}>
        <ChevronRight size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * Thumbs up and down on a reply, as in Claude. A thumbs down asks what was wrong; that reason goes
 * to the project's agents as feedback to learn from (it stays on this computer).
 */
export function FeedbackButtons({
  taskId,
  itemId,
  text,
  current,
  onChange
}: {
  taskId: string
  itemId: string
  text: () => string
  current: ReplyFeedback | undefined
  onChange: (all: Record<string, ReplyFeedback>) => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState(current?.comment ?? '')
  const rate = async (rating: 'up' | 'down' | null, comment = ''): Promise<void> => {
    try {
      onChange(await core.call('tasks.setFeedback', { id: taskId, itemId, rating, comment, text: text().slice(0, 4000) }))
      if (rating === 'up') showToast('Thanks for the feedback.')
    } catch (error) {
      showToast(`Couldn't save the feedback: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <>
      <button
        type="button"
        className={`copy-btn ${current?.rating === 'up' ? 'text-ink' : ''}`}
        aria-label="Good reply"
        aria-pressed={current?.rating === 'up'}
        title="Good reply"
        onClick={() => void rate(current?.rating === 'up' ? null : 'up')}
      >
        <ThumbsUp size={12} aria-hidden="true" fill={current?.rating === 'up' ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        className={`copy-btn ${current?.rating === 'down' ? 'text-ink' : ''}`}
        aria-label="Bad reply"
        aria-pressed={current?.rating === 'down'}
        title={current?.rating === 'down' && current.comment ? `Bad reply: ${current.comment}` : 'Bad reply'}
        onClick={() => {
          if (current?.rating === 'down') void rate(null)
          else setAsking(true)
        }}
      >
        <ThumbsDown size={12} aria-hidden="true" fill={current?.rating === 'down' ? 'currentColor' : 'none'} />
      </button>
      {asking && (
        <form
          className="feedback-form"
          onSubmit={(event) => {
            event.preventDefault()
            setAsking(false)
            void rate('down', reason.trim())
          }}
        >
          <label htmlFor={`fb-${itemId}`} className="text-[12px] text-ink-muted">
            What was wrong? The agents in this project will take it into account.
          </label>
          <textarea
            id={`fb-${itemId}`}
            autoFocus
            rows={2}
            value={reason}
            placeholder="Wrong facts, ignored my request, too long…"
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAsking(false)
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-text px-2 text-[12px]" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-ivory px-3 text-[12px]">
              Send feedback
            </button>
          </div>
        </form>
      )}
    </>
  )
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The web pages a reply drew on: a "N sources" chip that opens the list, as Claude shows them. */
export function SourcesChip({ sources }: { sources: ReplySource[] }) {
  const [open, setOpen] = useState(false)
  const hosts = [...new Set(sources.map((s) => hostOf(s.url)))]
  return (
    <div className="sources">
      <button type="button" className="copy-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={hosts.join(', ')}>
        <Globe size={12} aria-hidden="true" />
        {sources.length === 1 ? '1 source' : `${sources.length} sources`}
      </button>
      {open && (
        <ol className="sources-list">
          {sources.map((source, index) => (
            <li key={source.url}>
              <span className="sources-n">{index + 1}</span>
              <a href={source.url} target="_blank" rel="noreferrer" title={source.url}>
                <span className="block truncate text-[13px] text-ink">{source.title}</span>
                <span className="block truncate text-[12px] text-ink-faint">{hostOf(source.url)}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
