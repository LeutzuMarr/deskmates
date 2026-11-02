import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars, decorateWithSelection } from '../lib/design'
import type { Selection } from '../lib/design'
import { FOCUS_COMPOSER_EVENT } from '../lib/shortcuts'
import { ModelPicker } from './ModelPicker'

/** Unsent text per task (or per project's new-task box), so switching away and back keeps a draft. */
const drafts = new Map<string, string>()

/** A path as the agent should read it: quoted when it has spaces. */
function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

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
  /** Text to put in the box, e.g. from a starter prompt. Applied whenever the value changes. */
  seed?: { text: string; nonce: number } | null
  /** Placeholder while idle. */
  placeholder?: string
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { projectId, taskId, autoFocus, selection, onClearSelection, seed, placeholder },
  ref
) {
  const draftKey = taskId ?? `project:${projectId}`
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? '')
  const setText = (value: string): void => {
    setTextState(value)
    if (value) drafts.set(draftKey, value)
    else drafts.delete(draftKey)
  }
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)

  // The same composer stays mounted when the view switches tasks; bring that task's own draft back.
  useEffect(() => {
    setTextState(drafts.get(draftKey) ?? '')
  }, [draftKey])
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
  useEffect(() => {
    const focus = (): void => textareaRef.current?.focus()
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus)
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focus)
  }, [])

  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(seed.text.length, seed.text.length)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce])

  /** Puts dropped or pasted files' full paths into the message at the cursor, for the agent to open. */
  const insertPaths = (files: FileList): boolean => {
    const paths = Array.from(files)
      .map((file) => window.deskmates.pathForFile?.(file) ?? '')
      .filter(Boolean)
      .map(quotePath)
    if (paths.length === 0) return false
    const el = textareaRef.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const before = text.slice(0, start)
    const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${paths.join(' ')} `
    const next = before + insert + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + insert.length, start + insert.length)
    })
    return true
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDragging(false)
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    if (!insertPaths(event.dataTransfer.files)) showToast('Only files saved on this PC can be dropped here.')
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    // Files copied in Explorer arrive with a path; a pasted screenshot has none and is left to the default.
    if (event.clipboardData.files.length > 0 && insertPaths(event.clipboardData.files)) event.preventDefault()
  }

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
    } else if (event.key === 'Escape' && running) {
      event.preventDefault()
      void stop()
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
      <div
        className={`composer-box rounded-3xl border bg-card p-2 ${dragging ? 'border-ink-muted' : 'border-rule'}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          if (!dragging) setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={onDrop}
      >
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          value={text}
          autoFocus={autoFocus}
          disabled={awaitingApproval}
          placeholder={
            awaitingApproval
              ? 'Answer the request above to continue.'
              : dragging
                ? 'Drop to add the file’s path'
                : running
                  ? 'Reply while it works, or press Esc to stop'
                  : (placeholder ?? 'What should we work on?')
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          className="w-full resize-none bg-transparent px-2 pt-1 text-[15px] leading-normal text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <ModelPicker projectId={projectId} />
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop (Esc)"
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
              className="send-btn r-concentric flex h-8 w-9 items-center justify-center bg-clay text-white disabled:cursor-not-allowed disabled:opacity-50 enabled:hover:bg-clay-deep"
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
