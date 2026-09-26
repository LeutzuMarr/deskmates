import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars, decorateWithSelection } from '../lib/design'
import type { Selection } from '../lib/design'

export interface ComposerHandle {
  focus: () => void
}

interface ComposerProps {
  projectId: string
  taskId?: string
  autoFocus?: boolean
  /** The Design tab's currently selected preview element: shown as a chip and prefixed onto the next message. */
  selection?: Selection | null
  onClearSelection?: () => void
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { projectId, taskId, autoFocus, selection, onClearSelection },
  ref
) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const settings = useStore((s) => s.settings)
  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)
  const createTask = useStore((s) => s.createTask)

  const inputId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), [])

  const project = projects.find((p) => p.id === projectId)
  const task = taskId ? (tasksByProject[projectId] ?? []).find((t) => t.id === taskId) : undefined
  const running = task?.status === 'running'
  const awaitingApproval = task?.status === 'waiting-approval'
  const modelId = project?.model?.modelId ?? settings?.defaultModel?.modelId ?? null

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  const send = async (): Promise<void> => {
    const message = text.trim()
    if (!message || busy || awaitingApproval) return
    const outgoing = selection ? decorateWithSelection(selection, message) : message
    setBusy(true)
    try {
      if (taskId !== undefined) {
        await core.call('tasks.send', { id: taskId, text: outgoing })
      } else {
        const created = await createTask(projectId)
        if (!created) return
        await core.call('tasks.send', { id: created.id, text: outgoing })
        if (project?.kind === 'design') navigate({ name: 'design', projectId })
        else navigate({ name: 'task', projectId, taskId: created.id })
      }
      setText('')
      onClearSelection?.()
    } catch (error) {
      showToast(`Couldn't send the message: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (taskId === undefined) return
    try {
      await core.call('tasks.stop', { id: taskId })
    } catch (error) {
      showToast(`Couldn't stop the task: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div>
      {selection && (
        <div className="chip mb-2">
          <span className="min-w-0 flex-1 truncate">Selected: {selection.label}</span>
          <button
            type="button"
            className="chip-close"
            aria-label="Clear selection"
            onClick={() => onClearSelection?.()}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="rounded-3xl border border-rule bg-card p-2">
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          value={text}
          autoFocus={autoFocus}
          disabled={awaitingApproval}
          placeholder={awaitingApproval ? 'Answer the request above to continue.' : 'What should we work on?'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          className="w-full resize-none bg-transparent text-[15px] leading-normal text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            className="no-drag r-concentric flex items-center border border-rule px-2.5 py-1 text-[12px] text-ink-muted hover:bg-oat"
            style={concentricVars(8)}
            aria-label={`Model: ${modelId ?? 'not set'}`}
            onClick={() => navigate({ name: 'project-settings', projectId })}
          >
            <span className="max-w-[180px] truncate">{modelId ?? 'No model selected'}</span>
          </button>
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              className="r-concentric flex h-8 w-9 items-center justify-center border border-ink-muted text-ink hover:bg-oat"
              style={concentricVars(8)}
              onClick={() => void stop()}
            >
              <Square size={13} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!text.trim() || awaitingApproval || busy}
              className="r-concentric flex h-8 w-9 items-center justify-center bg-clay text-white disabled:cursor-not-allowed disabled:opacity-50 enabled:hover:bg-clay-deep"
              style={concentricVars(8)}
              onClick={() => void send()}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
