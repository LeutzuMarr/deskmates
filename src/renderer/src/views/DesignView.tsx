import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { EditorCommand } from '../../../shared/design-bridge'
import { useStore } from '../lib/store'
import { Conversation } from '../components/Conversation'
import { Composer } from '../components/Composer'
import type { ComposerHandle } from '../components/Composer'
import { PreviewPane } from '../components/PreviewPane'
import { clamp, latestTask, postToIframe } from '../lib/design'
import type { Selection } from '../lib/design'

const DIVIDER_KEY = 'deskmates:design-divider'
const MIN_CHAT_WIDTH = 340
const DEFAULT_CHAT_WIDTH = 420

function readStoredDividerWidth(): number {
  try {
    const raw = localStorage.getItem(DIVIDER_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : DEFAULT_CHAT_WIDTH
  } catch {
    return DEFAULT_CHAT_WIDTH
  }
}

function storeDividerWidth(width: number): void {
  try {
    localStorage.setItem(DIVIDER_KEY, String(Math.round(width)))
  } catch {
    // localStorage may be unavailable; the divider position just won't persist.
  }
}

export function DesignView({ projectId }: { projectId: string }) {
  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const timelines = useStore((s) => s.timelines)
  const settings = useStore((s) => s.settings)

  const project = projects.find((p) => p.id === projectId)
  const tasks = tasksByProject[projectId] ?? []
  const task = latestTask(tasks)
  const timeline = task ? (timelines[task.id] ?? []) : []
  const running = task?.status === 'running'
  const modelId = project?.model?.modelId ?? settings?.defaultModel?.modelId ?? null

  const [selection, setSelection] = useState<Selection | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const composerRef = useRef<ComposerHandle>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [chatWidth, setChatWidth] = useState(readStoredDividerWidth)
  const chatWidthRef = useRef(chatWidth)
  chatWidthRef.current = chatWidth

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const maxChatWidth = containerWidth > 0 ? Math.max(MIN_CHAT_WIDTH, containerWidth / 2) : DEFAULT_CHAT_WIDTH * 2
  const clampedChatWidth = clamp(chatWidth, MIN_CHAT_WIDTH, maxChatWidth)

  const clearSelection = useCallback((): void => {
    setSelection(null)
    postToIframe(iframeRef.current, { type: 'command', name: 'deselect' })
  }, [])

  const resizeBy = (delta: number): void => {
    const next = clamp(chatWidthRef.current + delta, MIN_CHAT_WIDTH, maxChatWidth)
    setChatWidth(next)
    storeDividerWidth(next)
  }

  const onDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = chatWidthRef.current
    const onMove = (moveEvent: PointerEvent): void => {
      const next = clamp(startWidth + (moveEvent.clientX - startX), MIN_CHAT_WIDTH, maxChatWidth)
      setChatWidth(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      storeDividerWidth(chatWidthRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onDividerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      resizeBy(-16)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      resizeBy(16)
    }
  }

  // Part D: forward editor shortcuts from the app window to the preview, except while an input/textarea
  // (including the composer) or the iframe itself has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!selection) return
      if (document.activeElement === iframeRef.current) return
      const activeTag = document.activeElement?.tagName
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return

      const ctrl = event.ctrlKey
      let name: EditorCommand | null = null
      if (event.key === 'Delete') name = 'delete'
      else if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'z') name = 'undo'
      else if ((ctrl && event.shiftKey && event.key.toLowerCase() === 'z') || (ctrl && event.key.toLowerCase() === 'y')) name = 'redo'
      else if (ctrl && event.key.toLowerCase() === 'd') name = 'duplicate'
      else if (event.key === 'Escape') name = 'deselect'
      if (!name) return

      event.preventDefault()
      if (name === 'deselect') clearSelection()
      else postToIframe(iframeRef.current, { type: 'command', name })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selection, clearSelection])

  if (!project) {
    return (
      <main className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[14px] text-ink-faint">This design was removed.</p>
      </main>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-rule px-6 py-3">
        <h1 className="truncate font-serif text-[20px] leading-tight">{project.name}</h1>
        <span className="shrink-0 truncate text-[12px] text-ink-muted">{modelId ?? 'No model selected'}</span>
      </header>

      <div ref={containerRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 shrink-0 flex-col" style={{ width: clampedChatWidth }}>
          <Conversation
            taskId={task?.id ?? ''}
            timeline={timeline}
            running={running}
            emptyHint="Describe what to design in the box below."
            contentClassName="max-w-[680px] px-6 py-6"
            pill={false}
          />
          <div className="shrink-0 px-6 py-4">
            {task?.status === 'error' && task.error && (
              <div className="error-bar mb-3" role="alert">
                {task.error}
              </div>
            )}
            <Composer
              ref={composerRef}
              projectId={projectId}
              taskId={task?.id}
              selection={selection}
              onClearSelection={clearSelection}
            />
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and preview"
          aria-valuenow={Math.round(clampedChatWidth)}
          aria-valuemin={MIN_CHAT_WIDTH}
          aria-valuemax={Math.round(maxChatWidth)}
          tabIndex={0}
          className="split-divider"
          onPointerDown={onDividerPointerDown}
          onKeyDown={onDividerKeyDown}
        />

        <PreviewPane
          projectId={projectId}
          running={running}
          workingSince={running ? ([...timeline].reverse().find((item) => item.kind === 'user')?.at ?? null) : null}
          selection={selection}
          onSelectionChange={setSelection}
          onClearSelection={clearSelection}
          onAskAboutThis={() => composerRef.current?.focus()}
          iframeRef={iframeRef}
        />
      </div>
    </div>
  )
}
