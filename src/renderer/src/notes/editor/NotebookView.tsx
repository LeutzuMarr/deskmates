import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, Eraser, Highlighter, Lock, MoreHorizontal, Pencil, PenLine, Plus, Redo2, Undo2, Unlock } from 'lucide-react'
import { Menu, SegmentedControl, Slider } from 'glisse'
import { getAsset, getMeta, listItems, listPages, makePage, save, setMeta, updateNotebook, type Notebook } from '../db'
import { DEFAULT_PAGE_STYLE, type Item, type Page, type PageStyle } from '../model'
import { NotesEngine } from './engine'
import { isInk, withDefaults, type ActiveTool, type ToolState } from './tools'
import { PenOptions, toolName } from './PenOptions'
import { PaperPicker } from './PaperPicker'
import { Popover, anchorOf } from '../ui/Popover'
import { useLiquid } from '../ui/liquid'

export interface ToolDef {
  value: ActiveTool
  label: string
  icon: ReactNode
  advanced?: boolean
}

const BASE_TOOLS: ToolDef[] = [
  { value: 'pen', label: 'Pen', icon: <PenLine size={19} /> },
  { value: 'pencil', label: 'Pencil', icon: <Pencil size={19} /> },
  { value: 'highlighter', label: 'Highlighter', icon: <Highlighter size={19} /> },
  { value: 'eraser', label: 'Eraser', icon: <Eraser size={19} /> }
]

/** Tools added by later parts of the app (lasso, text, stickers, brushes…). */
export const EXTRA_TOOLS: ToolDef[] = []

export interface NotebookExtras {
  /** Extra controls in the top bar (AI, audio…). */
  topRight?: (engine: NotesEngine) => ReactNode
  /** Sets up tool handlers on a new engine. */
  setup?: (engine: NotesEngine, context: { notebook: Notebook; refresh: () => void }) => () => void
  /** Options shown for non-ink tools. */
  toolOptions?: (tool: ActiveTool, tools: ToolState, update: (next: ToolState) => void, engine: NotesEngine) => ReactNode
  /** Extra entries for the "more" menu. */
  menu?: (engine: NotesEngine, notebook: Notebook) => Array<{ label: string; onSelect: () => void }>
  /** Overlays above the page (text editing, selection handles…). */
  overlay?: (engine: NotesEngine) => ReactNode
}

export const notebookExtras: NotebookExtras = {}

function useBump(): [number, () => void] {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  const frame = useRef(0)
  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      bump()
    })
  }, [])
  return [n, schedule]
}

export function NotebookView({ notebook: initial, onClose }: { notebook: Notebook; onClose: (notebook: Notebook) => void }) {
  const [notebook, setNotebook] = useState(initial)
  const host = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const wetRef = useRef<HTMLCanvasElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const pageBarRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<NotesEngine | null>(null)
  const [tools, setToolsState] = useState<ToolState | null>(null)
  const [, refresh] = useBump()
  const [popover, setPopover] = useState<{ kind: 'pen' | 'eraser' | 'paper' | 'feel' | 'tool'; anchor: { x: number; y: number } | null } | null>(null)
  const queue = useRef<Map<string, Item>>(new Map())
  const flushTimer = useRef(0)
  useLiquid(barRef, { reach: 22 })
  useLiquid(pageBarRef, { reach: 18 })

  const flush = useCallback(() => {
    window.clearTimeout(flushTimer.current)
    flushTimer.current = 0
    const items = [...queue.current.values()]
    queue.current.clear()
    if (items.length) void save({ items })
  }, [])

  // Open the notebook: pages, items and tool settings, then the engine.
  useEffect(() => {
    let engine: NotesEngine | null = null
    let disposed = false
    let cleanupExtras: (() => void) | undefined
    const observer = new ResizeObserver(() => {
      const el = host.current
      if (el && engine) engine.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio || 1)
    })
    void (async () => {
      let [pages, items, savedTools] = await Promise.all([listPages(initial.id), listItems(initial.id), getMeta<Partial<ToolState>>('tools')])
      if (disposed || !baseRef.current || !wetRef.current || !host.current) return
      if (pages.length === 0) {
        const page = makePage(initial.id, 0, initial.pageStyle ?? DEFAULT_PAGE_STYLE)
        await save({ pages: [page] })
        pages = [page]
      }
      const state = withDefaults(savedTools)
      engine = new NotesEngine(baseRef.current, wetRef.current, initial.id, state, {
        persist: (changed) => {
          for (const item of changed) queue.current.set(item.id, item)
          if (!flushTimer.current) flushTimer.current = window.setTimeout(flush, 400)
        },
        changed: refresh,
        loadAsset: async (id) => (await getAsset(id))?.blob ?? null,
        audioStamp: () => notebookAudio.stamp?.(initial.id)
      })
      engine.topInset = 64
      engine.dark = matchMedia('(prefers-color-scheme: dark)').matches
      engine.load(pages, items)
      engineRef.current = engine
      cleanupExtras = notebookExtras.setup?.(engine, { notebook: initial, refresh })
      setToolsState(state)
      observer.observe(host.current)
      const startAt = initial.lastPageId ? pages.findIndex((p) => p.id === initial.lastPageId) : 0
      engine.resize(host.current.clientWidth, host.current.clientHeight, window.devicePixelRatio || 1)
      if (startAt > 0) engine.showPage(startAt, false)
    })()
    return () => {
      disposed = true
      observer.disconnect()
      cleanupExtras?.()
      engine?.destroy()
      flush()
    }
  }, [initial, flush, refresh])

  // Save before the app goes to the background (iOS may close it there).
  useEffect(() => {
    const hide = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', flush)
    }
  }, [flush])

  // Desktop keys, for trying it out on a PC.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      if ((e.target as HTMLElement).closest('input,textarea,[contenteditable]')) return
      e.preventDefault()
      if (e.shiftKey) engineRef.current?.redo()
      else engineRef.current?.undo()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const metaTimer = useRef(0)
  const updateTools = useCallback((next: ToolState) => {
    const engine = engineRef.current
    if (engine) {
      if (next.rotationLocked && !engine.tools.rotationLocked) engine.straighten()
      engine.tools = next
      engine.requestOverlay()
    }
    setToolsState(next)
    window.clearTimeout(metaTimer.current)
    metaTimer.current = window.setTimeout(() => void setMeta('tools', next), 500)
  }, [])

  const engine = engineRef.current
  const close = (): void => {
    flush()
    const page = engine?.pages[engine.currentPageIndex()]
    void updateNotebook(notebook.id, { lastPageId: page?.id }).then((n) => onClose(n ?? notebook))
  }

  const addPage = async (style?: PageStyle): Promise<void> => {
    if (!engine) return
    const index = engine.currentPageIndex()
    const pages = engine.pages
    const current = pages[index]
    const next = pages[index + 1]
    const order = current ? (next ? (current.order + next.order) / 2 : current.order + 1) : 0
    const page = makePage(notebook.id, order, style ?? notebook.pageStyle ?? DEFAULT_PAGE_STYLE)
    await save({ pages: [page] })
    engine.setPages([...pages.slice(0, index + 1), page, ...pages.slice(index + 1)])
    engine.showPage(index + 1)
  }

  const deletePage = async (): Promise<void> => {
    if (!engine || engine.pages.length <= 1) return
    const index = engine.currentPageIndex()
    const page = engine.pages[index]!
    if (!confirm('Delete this page? Everything on it goes too.')) return
    const now = Date.now()
    const items = engine.itemsOn(page.id).map((i) => ({ ...i, deletedAt: now, updatedAt: now }))
    await save({ pages: [{ ...page, deletedAt: now, updatedAt: now }], items })
    engine.history.clear()
    engine.setPages(engine.pages.filter((p) => p.id !== page.id))
    engine.showPage(Math.max(0, index - 1))
  }

  const restylePage = async (style: PageStyle): Promise<void> => {
    if (!engine) return
    const index = engine.currentPageIndex()
    const page = engine.pages[index]
    if (!page) return
    const next: Page = { ...page, ...style, width: page.width, height: page.height, updatedAt: Date.now() }
    await save({ pages: [next] })
    engine.setPages(engine.pages.map((p) => (p.id === next.id ? next : p)))
  }

  const tool = tools?.tool
  const toolList = [...BASE_TOOLS, ...EXTRA_TOOLS].filter((t) => !t.advanced || tools?.advanced)
  const selectTool = (value: string): void => {
    if (!tools) return
    const chosen = value as ActiveTool
    updateTools({ ...tools, tool: chosen, lastInk: isInk(chosen) ? chosen : tools.lastInk })
  }
  const optionsLabel = !tools ? '' : isInk(tools.tool) ? toolName(tools.tool) : tools.tool === 'eraser' ? (tools.eraser.mode === 'precise' ? 'Precise' : 'Whole line') : notebookExtras.toolOptions ? (toolList.find((t) => t.value === tools.tool)?.label ?? '') : ''

  const pageIndex = engine ? engine.currentPageIndex() : 0
  const pageCount = engine?.pages.length ?? 0
  const quick = tools && isInk(tools.tool) ? tools.favorites.slice(0, 5) : []

  return (
    <div className="fixed inset-0 overflow-hidden bg-canvas">
      <div ref={host} className="absolute inset-0">
        <canvas ref={baseRef} className="absolute inset-0" />
        <canvas ref={wetRef} className="ink-surface absolute inset-0" aria-label="Page" />
        {engine && notebookExtras.overlay?.(engine)}
      </div>

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-2 pt-[calc(env(safe-area-inset-top)+8px)]">
        <div ref={barRef} className="toolbar-capsule glass pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]">
          <button type="button" onClick={close} className="press flex shrink-0 items-center gap-0.5 rounded-full py-1.5 pl-1 pr-2.5 text-[15px] font-medium" aria-label="Back to notes">
            <ChevronLeft size={20} />
            <span className="max-w-[9rem] truncate">{notebook.title}</span>
          </button>
          <span className="mx-1 h-6 w-px shrink-0 bg-rule" />
          {tools && (
            <div className="shrink-0">
              <SegmentedControl
                aria-label="Tools"
                items={toolList.map((t) => ({ value: t.value, label: <span aria-label={t.label} title={t.label} className="flex px-1">{t.icon}</span> }))}
                value={tool ?? null}
                onValueChange={(v) => selectTool(v)}
              />
            </div>
          )}
          {quick.length > 0 && (
            <>
              <span className="mx-1 h-6 w-px shrink-0 bg-rule" />
              {quick.map((f, i) => {
                const active = tools && tools.tool === f.tool && tools.pens[f.tool].color === f.color && tools.pens[f.tool].width === f.width
                return (
                  <button
                    key={i}
                    type="button"
                    aria-label={`${toolName(f.tool)}, ${f.color}`}
                    aria-pressed={Boolean(active)}
                    className="swatch mx-0.5 shrink-0"
                    style={{ background: f.color, width: 24, height: 24, opacity: f.opacity ?? 1 }}
                    onClick={() => tools && updateTools({ ...tools, tool: f.tool, lastInk: f.tool, pens: { ...tools.pens, [f.tool]: { color: f.color, width: f.width, opacity: f.opacity ?? tools.pens[f.tool].opacity } } })}
                  />
                )
              })}
            </>
          )}
          {tools && optionsLabel && (
            <button
              type="button"
              aria-label={`${optionsLabel} options`}
              className="press flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[13px] font-medium text-ink-muted"
              onClick={(e) => setPopover({ kind: isInk(tools.tool) ? 'pen' : tools.tool === 'eraser' ? 'eraser' : 'tool', anchor: anchorOf(e.currentTarget) })}
            >
              {optionsLabel}
              <span aria-hidden>▾</span>
            </button>
          )}
          <span className="mx-1 h-6 w-px shrink-0 bg-rule" />
          <button type="button" aria-label="Undo" disabled={!engine?.history.canUndo} onClick={() => engine?.undo()} className="press shrink-0 rounded-full p-2 disabled:opacity-30">
            <Undo2 size={19} />
          </button>
          <button type="button" aria-label="Redo" disabled={!engine?.history.canRedo} onClick={() => engine?.redo()} className="press shrink-0 rounded-full p-2 disabled:opacity-30">
            <Redo2 size={19} />
          </button>
          {tools && (
            <button
              type="button"
              aria-label={tools.rotationLocked ? 'Let the page turn' : 'Keep the page upright'}
              aria-pressed={!tools.rotationLocked}
              onClick={() => updateTools({ ...tools, rotationLocked: !tools.rotationLocked })}
              className={`press shrink-0 rounded-full p-2 ${tools.rotationLocked ? '' : 'bg-clay/15 text-clay-deep'}`}
            >
              {tools.rotationLocked ? <Lock size={18} /> : <Unlock size={18} />}
            </button>
          )}
          {engine && notebookExtras.topRight?.(engine)}
          {engine && tools && (
            <Menu
              aria-label="More"
              align="end"
              icon={<MoreHorizontal size={19} />}
              items={[
                { label: 'Add a page after this one', onSelect: () => void addPage() },
                { label: 'Paper…', onSelect: () => setPopover({ kind: 'paper', anchor: anchorOf(barRef.current) }) },
                { label: 'Pen feel…', onSelect: () => setPopover({ kind: 'feel', anchor: anchorOf(barRef.current) }) },
                'separator',
                { label: tools.fingerDraws ? 'Finger moves the page' : 'Finger draws', onSelect: () => updateTools({ ...tools, fingerDraws: !tools.fingerDraws }) },
                { label: tools.holdToShape ? 'Turn off hold to shape' : 'Hold to straighten shapes', onSelect: () => updateTools({ ...tools, holdToShape: !tools.holdToShape }) },
                { label: tools.advanced ? 'Hide drawing tools' : 'Show drawing tools', onSelect: () => updateTools({ ...tools, advanced: !tools.advanced }) },
                ...(notebookExtras.menu?.(engine, notebook) ?? []),
                'separator',
                { label: 'Delete this page', destructive: true, disabled: pageCount <= 1, onSelect: () => void deletePage() }
              ]}
            />
          )}
        </div>
      </div>

      {/* Page number and a new page */}
      {engine && engine.pages[pageIndex]?.size !== 'infinite' && (
        <div className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom)+14px)] right-4 flex justify-end">
          <div ref={pageBarRef} className="toolbar-capsule glass pointer-events-auto flex items-center gap-1 px-1.5 py-1">
            <button type="button" className="press rounded-full px-2.5 py-1.5 text-[13px] font-medium tabular-nums" onClick={() => pageOverview.open?.(engine, notebook)}>
              {pageIndex + 1} / {pageCount}
            </button>
            <button type="button" aria-label="Add a page" className="press rounded-full p-1.5" onClick={() => void addPage()}>
              <Plus size={18} />
            </button>
          </div>
        </div>
      )}

      {tools && popover?.kind === 'pen' && isInk(tools.tool) && (
        <Popover open label="Pen options" anchor={popover.anchor ?? anchorOf(barRef.current)} onClose={() => setPopover(null)} width={340}>
          <PenOptions tools={tools} update={updateTools} />
        </Popover>
      )}
      {tools && popover?.kind === 'eraser' && (
        <Popover open label="Eraser options" anchor={popover.anchor ?? anchorOf(barRef.current)} onClose={() => setPopover(null)} width={300}>
          <div className="flex flex-col gap-4">
            <SegmentedControl
              aria-label="Eraser"
              items={[
                { value: 'stroke', label: 'Whole line' },
                { value: 'precise', label: 'Precise' }
              ]}
              value={tools.eraser.mode}
              onValueChange={(v) => updateTools({ ...tools, eraser: { ...tools.eraser, mode: v as 'stroke' | 'precise' } })}
            />
            <label className="flex items-center gap-3 text-[13px] text-ink-muted">
              Size
              <span className="flex-1">
                <Slider aria-label="Eraser size" min={4} max={60} step={1} value={tools.eraser.size} onValueChange={(v) => updateTools({ ...tools, eraser: { ...tools.eraser, size: v } })} />
              </span>
            </label>
          </div>
        </Popover>
      )}
      {tools && engine && popover?.kind === 'tool' && notebookExtras.toolOptions && (
        <Popover open label="Tool options" anchor={popover.anchor ?? anchorOf(barRef.current)} onClose={() => setPopover(null)} width={320}>
          {notebookExtras.toolOptions(tools.tool, tools, updateTools, engine)}
        </Popover>
      )}
      {tools && popover?.kind === 'feel' && (
        <Popover open label="Pen feel" anchor={popover.anchor} onClose={() => setPopover(null)} width={340}>
          <div className="flex flex-col gap-3 text-[13px]">
            {(
              [
                ['Pressure response', 'pressureCurve', 0.4, 2.2, 'Heavier', 'Lighter'],
                ['Speed thins the line', 'speedEffect', 0, 1, 'Off', 'Strong'],
                ['Tilt widens the pencil', 'tiltEffect', 0, 1, 'Off', 'Strong'],
                ['Steady hand', 'stabilizer', 0, 0.9, 'Off', 'Very steady']
              ] as const
            ).map(([label, key, min, max, low, high]) => (
              <div key={key}>
                <div className="mb-1 flex justify-between text-ink-muted">
                  <span className="font-medium text-ink">{label}</span>
                  <span>
                    {low} ↔ {high}
                  </span>
                </div>
                <Slider aria-label={label} min={min} max={max} step={0.05} value={tools[key]} onValueChange={(v) => updateTools({ ...tools, [key]: v })} />
              </div>
            ))}
            <p className="text-[12px] leading-snug text-ink-muted">Pens without pressure (like the Logitech Crayon) get their line width from speed and tilt.</p>
          </div>
        </Popover>
      )}
      {popover?.kind === 'paper' && engine && (
        <Popover open label="Paper" anchor={popover.anchor} onClose={() => setPopover(null)} width={380}>
          <PaperPicker
            value={engine.pages[pageIndex] ?? notebook.pageStyle ?? DEFAULT_PAGE_STYLE}
            onApply={(style, scope) => {
              if (scope === 'page') void restylePage(style)
              else void updateNotebook(notebook.id, { pageStyle: style }).then((n) => n && setNotebook(n))
              if (scope === 'new-page') void addPage(style)
            }}
          />
        </Popover>
      )}
    </div>
  )
}

/** Set by the audio recorder: the time stamp to give new ink. */
export const notebookAudio: { stamp?: (notebookId: string) => Item['audio'] } = {}

/** Set by the page overview (stage 2). */
export const pageOverview: { open?: (engine: NotesEngine, notebook: Notebook) => void } = {}
