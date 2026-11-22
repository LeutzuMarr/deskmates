import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { ArrowUp, Paperclip, Square, X } from 'lucide-react'
import { Glass } from 'glisse'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars, decorateWithSelection } from '../lib/design'
import type { Selection } from '../lib/design'
import { FOCUS_COMPOSER_EVENT } from '../lib/shortcuts'
import { ModelPicker } from './ModelPicker'
import { EffortPicker } from './EffortPicker'
import { ContextMeter } from './ContextMeter'
import { BUILT_IN_COMMANDS, runBuiltIn } from '../lib/commands'

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
  const queued = useStore((s) => (taskId ? s.queued[taskId] : undefined)) ?? []
  // The likely next message, greyed out in the empty box once a reply ends; Tab puts it in.
  const suggestion = useStore((s) => (taskId ? s.suggestions[taskId] : undefined)) ?? null
  const showSuggestion = Boolean(suggestion) && !text && !running && !awaitingApproval && !selection
  const timeline = useStore((s) => (taskId ? s.timelines[taskId] : undefined))
  /** What the user sent before in this task, newest first, for the up arrow. */
  const sentBefore = (): string[] =>
    (timeline ?? [])
      .filter((item) => item.kind === 'user')
      .map((item) => (item as { text: string }).text)
      .reverse()
  const historyAt = useRef(-1)

  // "/" at the start lists installed skills; "@" anywhere lists project files, as in Claude.
  const [caret, setCaret] = useState(0)
  const token = /(?:^|\s)([@/])([^\s@]*)$/.exec(text.slice(0, caret))
  const mention = token && (token[1] === '@' || token.index === 0 && text.slice(0, caret).trimStart().startsWith('/'))
    ? { kind: token[1] === '@' ? ('file' as const) : ('skill' as const), query: token[2] ?? '', start: caret - (token[2]?.length ?? 0) - 1 }
    : null
  const [menuItems, setMenuItems] = useState<string[]>([])
  const [menuAt, setMenuAt] = useState(0)
  const [menuClosed, setMenuClosed] = useState<string | null>(null)
  const menuKey = mention ? `${mention.kind}:${mention.start}` : null
  const menuOpen = Boolean(mention) && menuItems.length > 0 && menuClosed !== menuKey
  useEffect(() => {
    if (!mention) {
      setMenuItems([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found =
          mention.kind === 'skill'
            ? [
                // The app's own commands first, then installed skills.
                ...BUILT_IN_COMMANDS.map((c) => c.name.slice(1)).filter((name) => name.startsWith(mention.query.toLowerCase())),
                ...(await core.call('skills.list', {}))
                  .filter((skill) => skill.enabled && skill.name.toLowerCase().includes(mention.query.toLowerCase()))
                  .map((skill) => skill.name)
                  .slice(0, 30)
              ]
            : await core.call('projects.findFiles', { projectId, query: mention.query })
        if (!cancelled) {
          setMenuItems(found)
          setMenuAt(0)
        }
      } catch {
        if (!cancelled) setMenuItems([])
      }
    }, mention.kind === 'file' ? 120 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.kind, mention?.query, projectId])
  // Up from the box when there is room above it; down (this far below the menu's anchor, past the
  // box) when the box sits near the top of the window, where an upward menu would be cut off.
  const [menuBelow, setMenuBelow] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!menuOpen) return
    const box = textareaRef.current?.closest('.composer-box') as HTMLElement | null
    if (!box) return
    const rect = box.getBoundingClientRect()
    setMenuBelow(rect.top < 320 ? box.offsetHeight + 6 : null)
  }, [menuOpen])

  /** Replaces the typed "/name" or "@path" with the picked one. */
  const pick = (choice: string): void => {
    if (!mention) return
    const mark = mention.kind === 'skill' ? '/' : '@'
    const insert = `${mark}${/\s/.test(choice) ? `"${choice}"` : choice} `
    const next = text.slice(0, mention.start) + insert + text.slice(caret)
    const at = mention.start + insert.length
    setText(next)
    setMenuItems([])
    requestAnimationFrame(() => {
      const el = textareaRef.current
      el?.focus()
      el?.setSelectionRange(at, at)
      setCaret(at)
    })
  }
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

  /** Pictures attached to the next message (pasted, dropped or picked), as Claude takes them. */
  const [images, setImages] = useState<Array<{ dataUrl: string; name: string }>>([])
  const imageInputRef = useRef<HTMLInputElement>(null)
  const isImage = (file: File): boolean => /^image\/(png|jpeg|gif|webp)$/.test(file.type)
  const attachImages = (files: File[]): void => {
    const room = 6 - images.length
    if (room <= 0) {
      showToast('A message can carry at most 6 images.')
      return
    }
    for (const file of files.slice(0, room)) {
      if (file.size > 8 * 1024 * 1024) {
        showToast(`${file.name || 'That image'} is larger than 8 MB.`)
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        if (dataUrl) setImages((current) => (current.length >= 6 ? current : [...current, { dataUrl, name: file.name || 'Pasted image' }]))
      }
      reader.readAsDataURL(file)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDragging(false)
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    // Pictures are attached for the model to see; other files go in as their paths.
    const all = Array.from(event.dataTransfer.files)
    const pictures = all.filter(isImage)
    if (pictures.length) attachImages(pictures)
    const others = all.filter((file) => !isImage(file))
    if (others.length) {
      const list = new DataTransfer()
      others.forEach((file) => list.items.add(file))
      if (!insertPaths(list.files)) showToast('Only files saved on this PC can be dropped here.')
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    // A pasted screenshot or copied picture is attached; files copied in Explorer go in as paths.
    const pictures = files.filter(isImage)
    if (pictures.length) {
      event.preventDefault()
      attachImages(pictures)
      return
    }
    if (insertPaths(event.clipboardData.files)) event.preventDefault()
  }

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  const send = async (): Promise<void> => {
    const typed = text.trim()
    if ((!typed && images.length === 0) || busy || awaitingApproval) return
    // The app's own commands, as Claude has them; they never reach the agent.
    const command = BUILT_IN_COMMANDS.find((c) => c.name === typed.toLowerCase())
    if (command) {
      setText('')
      runBuiltIn(command.name, { taskId, projectId })
      return
    }
    const message = typed || 'Here is an image.'
    const outgoing = selection ? decorateWithSelection(selection, message) : message
    const attached = images.map(({ dataUrl, name }) => ({ dataUrl, name }))
    setBusy(true)
    try {
      if (taskId !== undefined) {
        await core.call('tasks.send', { id: taskId, text: outgoing, ...(attached.length ? { images: attached } : {}) })
      } else {
        const created = await createTask(projectId)
        if (!created) return
        await core.call('tasks.send', { id: created.id, text: outgoing, ...(attached.length ? { images: attached } : {}) })
        if (project?.kind === 'design') navigate({ name: 'design', projectId })
        else navigate({ name: 'task', projectId, taskId: created.id })
      }
      setText('')
      setImages([])
      historyAt.current = -1
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

  /** Puts text in the box with the cursor at its end. */
  const fill = (value: string): void => {
    setText(value)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      el?.focus()
      el?.setSelectionRange(value.length, value.length)
    })
  }

  /** Takes the queued messages back into the box to change them. */
  const editQueued = async (): Promise<void> => {
    if (taskId === undefined) return
    try {
      const back = await core.call('tasks.unqueue', { id: taskId })
      if (back.length) fill([back.join('\n\n'), text].filter(Boolean).join('\n\n'))
    } catch (error) {
      showToast(`Couldn't take the message back: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // The / and @ menu takes the arrows, Enter, Tab and Esc while it is open.
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setMenuAt((at) => (at + step + menuItems.length) % menuItems.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        pick(menuItems[menuAt] ?? menuItems[0]!)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuClosed(menuKey)
        return
      }
    }
    // Tab takes the suggested next message.
    if (event.key === 'Tab' && !event.shiftKey && showSuggestion && suggestion) {
      event.preventDefault()
      fill(suggestion)
      return
    }
    // The up arrow in an empty box (or one still showing a recalled message) brings back earlier
    // messages, newest first; the down arrow walks forward again.
    const el = textareaRef.current
    const atStart = !el || (el.selectionStart === 0 && el.selectionEnd === 0)
    const past = sentBefore()
    if (event.key === 'ArrowUp' && (!text || (historyAt.current >= 0 && atStart)) && past.length > 0) {
      event.preventDefault()
      historyAt.current = Math.min(historyAt.current + 1, past.length - 1)
      setText(past[historyAt.current]!)
      return
    }
    if (event.key === 'ArrowDown' && historyAt.current >= 0 && text === past[historyAt.current]) {
      event.preventDefault()
      historyAt.current -= 1
      setText(historyAt.current >= 0 ? past[historyAt.current]! : '')
      return
    }
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
      {queued.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5" aria-label="Queued messages">
          {queued.map((message, index) => (
            <div
              key={`${index}-${message.slice(0, 20)}`}
              className="flex items-start gap-2 rounded-xl border border-dashed border-rule px-3 py-2 text-[13px] text-ink-muted"
            >
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
              <span className="shrink-0 text-[12px] text-ink-faint">Queued · sends when this reply ends</span>
              {index === queued.length - 1 && (
                <button type="button" className="btn btn-text shrink-0 px-0 text-[12px]" onClick={() => void editQueued()}>
                  Edit
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {menuOpen && mention && (
        <div className="relative">
          <div
            className={`menu left-0 right-0 ${menuBelow === null ? 'bottom-1' : ''}`}
            style={menuBelow === null ? undefined : { top: menuBelow }}
            role="listbox" aria-label={mention.kind === 'skill' ? 'Skills' : 'Files'}>
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-wide text-ink-faint">{mention.kind === 'skill' ? 'Skills' : 'Files in this project'}</div>
            <div className="scroll-area max-h-[240px] overflow-y-auto">
              {menuItems.map((choice, index) => (
                <button
                  key={choice}
                  type="button"
                  role="option"
                  aria-selected={index === menuAt}
                  className="menu-item font-mono text-[12px]"
                  onMouseEnter={() => setMenuAt(index)}
                  onMouseDown={(event) => {
                    // Keep the focus in the box; the click picks.
                    event.preventDefault()
                    pick(choice)
                  }}
                >
                  <span className="truncate">
                    {mention.kind === 'skill' ? '/' : '@'}
                    {choice}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <Glass
        className={`composer-box p-2 ${dragging ? 'composer-box-dropping' : ''}`}
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
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1" aria-label="Attached images">
            {images.map((image, index) => (
              <div key={`${index}-${image.name}`} className="attach-thumb">
                <img src={image.dataUrl} alt={image.name} />
                <button
                  type="button"
                  className="attach-thumb-remove"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
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
                  : showSuggestion && suggestion
                    ? suggestion
                    : (placeholder ?? 'What should we work on?')
          }
          onChange={(event) => {
            setText(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          className="w-full resize-none bg-transparent px-2 pt-1 text-[15px] leading-normal text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="copy-btn h-8 w-8 justify-center p-0"
              aria-label="Attach images"
              title="Attach images (or paste a screenshot)"
              onClick={() => imageInputRef.current?.click()}
            >
              <Paperclip size={15} aria-hidden="true" />
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(event) => {
                attachImages(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            <ModelPicker projectId={projectId} />
            <EffortPicker />
            <ContextMeter taskId={taskId} />
            {showSuggestion && (
              <span className="truncate text-[12px] text-ink-faint">
                <kbd className="kbd">Tab</kbd> to use the suggestion
              </span>
            )}
          </div>
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop (Esc)"
              className="stop-btn r-concentric flex h-8 w-9 items-center justify-center text-ink"
              style={concentricVars(8)}
              onClick={() => void stop()}
            >
              <Square size={13} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={(!text.trim() && images.length === 0) || awaitingApproval || busy}
              className="send-btn r-concentric flex h-8 w-9 items-center justify-center bg-clay text-white disabled:cursor-not-allowed disabled:opacity-50 enabled:hover:bg-clay-deep"
              style={concentricVars(8)}
              onClick={() => void send()}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </Glass>
    </div>
  )
})
