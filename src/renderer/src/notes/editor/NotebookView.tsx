import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, Eraser, Highlighter, Lock, MoreHorizontal, Pencil, PenLine, Plus, Redo2, Undo2, Unlock } from 'lucide-react'
import { Menu, SegmentedControl, Slider } from 'glisse'
import { assetBlob, getMeta, listItems, listPages, makePage, save, setMeta, updateNotebook, type Notebook } from '../db'
import { DEFAULT_PAGE_STYLE, type Item, type Page, type PageStyle } from '../model'
import type { RemoteDevice } from '../../remote/relay'
import { NotesEngine } from './engine'
import { isBrushTool, isInk, withDefaults, type ActiveTool, type ToolState } from './tools'
import { PenOptions, toolName } from './PenOptions'
import { PaperPicker } from './PaperPicker'
import { Popover, anchorOf } from '../ui/Popover'
import { Sheet } from '../ui/Sheet'
import { PageOverview } from './PageOverview'
import { TemplatePicker, type PageChoice } from '../library/TemplatePicker'
import { backgroundPages } from '../db'
import { templateById } from '../templates/registry'
import { savePageStyleAsTemplate } from '../store/store'
import { NameSheet } from '../ui/Sheet'
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

/** What extra parts get to work with. */
export interface NotebookContext {
  notebook: Notebook
  notice: (text: string) => void
  setTool: (tool: ActiveTool) => void
  device: RemoteDevice | null
  online: boolean
}

export interface NotebookExtras {
  /** Extra controls in the top bar (insert, audio, AI…). */
  topRight?: Array<(engine: NotesEngine, context: NotebookContext) => ReactNode>
  /** Sets up tool handlers on a new engine. */
  setup?: Array<(engine: NotesEngine, context: { notebook: Notebook; refresh: () => void }) => () => void>
  /** Options shown for non-ink tools. */
  toolOptions?: (tool: ActiveTool, tools: ToolState, update: (next: ToolState) => void, engine: NotesEngine) => ReactNode
  /** Extra entries for the "more" menu. */
  menu?: Array<(engine: NotesEngine, context: NotebookContext) => Array<{ label: string; onSelect: () => void }>>
  /** Overlays above the page (text editing, selection handles…). */
  overlay?: Array<(engine: NotesEngine, context: NotebookContext) => ReactNode>
  /** Called when the tool changes. */
  toolChanged?: Array<(engine: NotesEngine, tool: ActiveTool) => void>
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

export function NotebookView({
  notebook: initial,
  startPageId,
  device = null,
  online = false,
  onClose
}: {
  notebook: Notebook
  startPageId?: string
  device?: RemoteDevice | null
  online?: boolean
  onClose: (notebook: Notebook) => void
}) {
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
  const [overview, setOverview] = useState(false)
  const [templates, setTemplates] = useState<PageChoice | null>(null)
  const [saveTemplate, setSaveTemplate] = useState(false)
  const queue = useRef<Map<string, Item>>(new Map())
  const setToastRef = useRef<(text: string) => void>(() => undefined)
  const updateToolsRef = useRef<(next: ToolState) => void>(() => undefined)
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
        loadAsset: (id) => assetBlob(id),
        audioStamp: () => notebookAudio.stamp?.(initial.id)
      })
      engine.topInset = 64
      engine.say = setToastRef.current
      engine.dark = matchMedia('(prefers-color-scheme: dark)').matches
      engine.load(pages, items)
      engineRef.current = engine
      engine.requestTools = (next) => updateToolsRef.current(next)
      const cleanups = (notebookExtras.setup ?? []).map((setup) => setup(engine!, { notebook: initial, refresh }))
      cleanupExtras = () => cleanups.forEach((c) => c())
      setToolsState(state)
      observer.observe(host.current)
      const wanted = startPageId ?? initial.lastPageId
      const startAt = wanted ? pages.findIndex((p) => p.id === wanted) : 0
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
  }, [initial, startPageId, flush, refresh])

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
      if (next.tool !== engine.tools.tool) for (const changed of notebookExtras.toolChanged ?? []) changed(engine, next.tool)
      engine.tools = next
      engine.requestOverlay()
    }
    setToolsState(next)
    window.clearTimeout(metaTimer.current)
    metaTimer.current = window.setTimeout(() => void setMeta('tools', next), 500)
  }, [])

  const [toast, setToast] = useState<string | null>(null)
  setToastRef.current = setToast
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(timer)
  }, [toast])
  updateToolsRef.current = updateTools
  const engine = engineRef.current
  const context: NotebookContext | null = tools
    ? {
        notebook,
        notice: setToast,
        setTool: (tool) => updateTools({ ...(engine?.tools ?? tools), tool, lastInk: isInk(tool) ? tool : (engine?.tools ?? tools).lastInk }),
        device,
        online
      }
    : null
  const close = (): void => {
    flush()
    const page = engine?.pages[engine.currentPageIndex()]
    void updateNotebook(notebook.id, { lastPageId: page?.id }).then((n) => onClose(n ?? notebook))
  }

  const addPage = async (style?: PageStyle, template?: string | null): Promise<void> => {
    if (!engine) return
    const index = engine.currentPageIndex()
    const pages = engine.pages
    const current = pages[index]
    const next = pages[index + 1]
    const order = current ? (next ? (current.order + next.order) / 2 : current.order + 1) : 0
    const page = makePage(notebook.id, order, style ?? notebook.pageStyle ?? DEFAULT_PAGE_STYLE, Date.now(), { template: template === null ? undefined : (template ?? (style ? undefined : notebook.pageTemplate)) })
    await save({ pages: [page] })
    engine.setPages([...pages.slice(0, index + 1), page, ...pages.slice(index + 1)])
    engine.showPage(index + 1)
  }

  /** Pages from a picture/PDF template, after the current page. */
  const addBackgroundPages = async (assetIds: string[]): Promise<void> => {
    if (!engine) return
    const index = engine.currentPageIndex()
    const pages = engine.pages
    const current = pages[index]
    const next = pages[index + 1]
    const from = current?.order ?? 0
    const span = next ? next.order - from : assetIds.length + 1
    const fields = await backgroundPages(assetIds)
    const made = fields.map((extra, i) => makePage(notebook.id, from + (span * (i + 1)) / (fields.length + 1), { paper: 'blank', color: 'white', size: 'a4' }, Date.now(), extra))
    await save({ pages: made })
    engine.setPages([...pages.slice(0, index + 1), ...made, ...pages.slice(index + 1)])
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

  const restylePage = async (style: PageStyle, template?: string | null): Promise<void> => {
    if (!engine) return
    const index = engine.currentPageIndex()
    const page = engine.pages[index]
    if (!page) return
    const next: Page = { ...page, ...style, size: page.size, width: page.width, height: page.height, template: template === undefined ? page.template : (template ?? undefined), updatedAt: Date.now() }
    await save({ pages: [next] })
    engine.setPages(engine.pages.map((p) => (p.id === next.id ? next : p)))
  }

  const tool = tools?.tool
  // The brushes share one button: the one in hand, or the last one used.
  const brushShown = tools ? (isBrushTool(tools.tool) ? tools.tool : tools.brush) : null
  const toolList = [...BASE_TOOLS, ...EXTRA_TOOLS].filter((t) => (!t.advanced || tools?.advanced) && (!isBrushTool(t.value) || t.value === brushShown))
  const selectTool = (value: string): void => {
    if (!tools) return
    const chosen = value as ActiveTool
    updateTools({ ...tools, tool: chosen, lastInk: isInk(chosen) ? chosen : tools.lastInk, brush: isBrushTool(chosen) ? (chosen as ToolState['brush']) : tools.brush })
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
        {engine && context && (notebookExtras.overlay ?? []).map((o, i) => <div key={i}>{o(engine, context)}</div>)}
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
          {engine && context && (notebookExtras.topRight ?? []).map((t, i) => <span key={i} className="flex shrink-0 items-center">{t(engine, context)}</span>)}
          {engine && tools && (
            <Menu
              aria-label="More"
              align="end"
              icon={<MoreHorizontal size={19} />}
              items={[
                { label: 'Add a page after this one', onSelect: () => void addPage() },
                { label: 'Pages…', onSelect: () => setOverview(true) },
                { label: 'Paper…', onSelect: () => setPopover({ kind: 'paper', anchor: anchorOf(barRef.current) }) },
                { label: 'Templates…', onSelect: () => setTemplates({ style: notebook.pageStyle ?? DEFAULT_PAGE_STYLE, template: notebook.pageTemplate, name: templateById(notebook.pageTemplate)?.name ?? 'Paper' }) },
                { label: 'Save this page’s paper as a template', onSelect: () => setSaveTemplate(true) },
                { label: 'Pen feel…', onSelect: () => setPopover({ kind: 'feel', anchor: anchorOf(barRef.current) }) },
                'separator',
                { label: tools.fingerDraws ? 'Finger moves the page' : 'Finger draws', onSelect: () => updateTools({ ...tools, fingerDraws: !tools.fingerDraws }) },
                { label: tools.holdToShape ? 'Turn off hold to shape' : 'Hold to straighten shapes', onSelect: () => updateTools({ ...tools, holdToShape: !tools.holdToShape }) },
                { label: tools.advanced ? 'Hide drawing tools' : 'Show drawing tools', onSelect: () => updateTools({ ...tools, advanced: !tools.advanced }) },
                ...(context ? (notebookExtras.menu ?? []).flatMap((m) => m(engine, context)) : []),
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
            <button type="button" className="press rounded-full px-2.5 py-1.5 text-[13px] font-medium tabular-nums" onClick={() => setOverview(true)}>
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
      {toast && (
        <div role="status" className="glass fixed bottom-[calc(env(safe-area-inset-bottom)+70px)] left-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 rounded-2xl px-4 py-3 text-center text-[14px] shadow-xl">
          {toast}
        </div>
      )}
      {overview && engine && (
        <PageOverview
          engine={engine}
          notebookId={notebook.id}
          onClose={() => setOverview(false)}
          onPagesChanged={(pages) => engine.setPages(pages)}
        />
      )}
      {templates && engine && (
        <Sheet title="Templates" onClose={() => setTemplates(null)} width={620}>
          <TemplatePicker value={templates} onChange={setTemplates} />
          <div className="mt-4 grid grid-cols-3 gap-2 text-[13px] font-semibold">
            <button
              type="button"
              className="press rounded-full bg-black/5 px-2 py-2.5 dark:bg-white/10"
              disabled={Boolean(templates.backgrounds)}
              onClick={() => {
                void restylePage(templates.style, templates.template ?? null)
                setTemplates(null)
              }}
            >
              This page
            </button>
            <button
              type="button"
              className="press rounded-full bg-black/5 px-2 py-2.5 dark:bg-white/10"
              disabled={Boolean(templates.backgrounds)}
              onClick={() => {
                void updateNotebook(notebook.id, { pageStyle: templates.style, pageTemplate: templates.template }).then((n) => n && setNotebook(n))
                setTemplates(null)
              }}
            >
              New pages
            </button>
            <button
              type="button"
              className="press rounded-full bg-clay px-2 py-2.5 text-white"
              onClick={() => {
                const choice = templates
                setTemplates(null)
                if (choice.backgrounds) void addBackgroundPages(choice.backgrounds)
                else void addPage(choice.style, choice.template ?? null)
              }}
            >
              Add page
            </button>
          </div>
        </Sheet>
      )}
      {saveTemplate && engine && (
        <NameSheet
          title="Save as a template"
          initial={notebook.title}
          action="Save template"
          onClose={() => setSaveTemplate(false)}
          onDone={(name) => {
            setSaveTemplate(false)
            const page = engine.pages[pageIndex]
            if (!page) return
            const base = templateById(page.template)
            void savePageStyleAsTemplate(name, {
              id: '',
              name,
              group: 'Mine',
              paper: page.paper,
              color: page.color,
              size: page.size === 'infinite' ? 'a4' : page.size,
              landscape: page.landscape,
              accent: base?.accent,
              elements: base?.elements ?? []
            })
          }}
        />
      )}
    </div>
  )
}

/** Set by the audio recorder: the time stamp to give new ink. */
export const notebookAudio: { stamp?: (notebookId: string) => Item['audio'] } = {}
