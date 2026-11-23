import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, ClipboardPaste, Copy, CopyPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { Menu, SegmentedControl } from 'glisse'
import { copyPages, getMeta, reorderPages, save, setMeta } from '../db'
import type { Item, Page } from '../model'
import { usePageThumb } from '../ink/thumb'
import { NameSheet, Sheet } from '../ui/Sheet'
import type { NotesEngine } from './engine'

function PageThumb({ page, items, width }: { page: Page; items: Item[]; width: number }) {
  const ref = usePageThumb(page, items, width)
  return <canvas ref={ref} className="rounded-lg bg-white shadow-[0_0_0_1px_rgba(0,0,0,.08),0_4px_14px_rgba(0,0,0,.10)]" />
}

/** All pages of the notebook: jump, reorder by dragging, bookmark, name, duplicate, copy, paste, delete. */
export function PageOverview({ engine, notebookId, onClose, onPagesChanged }: { engine: NotesEngine; notebookId: string; onClose: () => void; onPagesChanged: (pages: Page[]) => void }) {
  const [pages, setPages] = useState(engine.pages)
  const [view, setView] = useState<'all' | 'outline'>('all')
  const [naming, setNaming] = useState<Page | null>(null)
  const [clipboard, setClipboard] = useState<string[] | null>(null)
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const current = engine.currentPageIndex()

  useEffect(() => {
    void getMeta<string[]>('pageClipboard').then(setClipboard)
  }, [])

  const commit = async (next: Page[]): Promise<void> => {
    const ordered = await reorderPages(next)
    setPages(ordered)
    onPagesChanged(ordered)
  }

  const update = async (page: Page, changes: Partial<Page>): Promise<void> => {
    const next = { ...page, ...changes, updatedAt: Date.now() }
    await save({ pages: [next] })
    const list = pages.map((p) => (p.id === page.id ? next : p))
    setPages(list)
    onPagesChanged(list)
  }

  const duplicate = async (page: Page): Promise<void> => {
    const index = pages.findIndex((p) => p.id === page.id)
    const [copy] = await copyPages([page.id], notebookId, page.order, pages[index + 1]?.order ?? page.order + 1)
    if (!copy) return
    await commit([...pages.slice(0, index + 1), copy, ...pages.slice(index + 1)])
  }

  const remove = async (page: Page): Promise<void> => {
    if (pages.length <= 1 || !confirm('Delete this page? Everything on it goes too.')) return
    const now = Date.now()
    await save({ pages: [{ ...page, deletedAt: now, updatedAt: now }], items: engine.itemsOn(page.id).map((i) => ({ ...i, deletedAt: now, updatedAt: now })) })
    engine.history.clear()
    const list = pages.filter((p) => p.id !== page.id)
    setPages(list)
    onPagesChanged(list)
  }

  const paste = async (): Promise<void> => {
    if (!clipboard?.length) return
    const index = Math.min(current, pages.length - 1)
    const at = pages[index]!
    const copies = await copyPages(clipboard, notebookId, at.order, pages[index + 1]?.order ?? at.order + 1)
    await commit([...pages.slice(0, index + 1), ...copies, ...pages.slice(index + 1)])
  }

  /** Dragging a page: a long press lifts it, moving finds the slot under the finger. */
  const startDrag = (id: string, e: React.PointerEvent): void => {
    const startX = e.clientX
    const startY = e.clientY
    let lifted = false
    const timer = window.setTimeout(() => {
      lifted = true
      navigator.vibrate?.(10)
      setDrag({ id, over: pages.findIndex((p) => p.id === id) })
    }, 350)
    const move = (ev: PointerEvent): void => {
      if (!lifted) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) cleanup()
        return
      }
      ev.preventDefault()
      const cells = [...(grid.current?.querySelectorAll<HTMLElement>('[data-page]') ?? [])]
      let best = 0
      let bestDistance = Infinity
      cells.forEach((cell, i) => {
        const r = cell.getBoundingClientRect()
        const d = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2))
        if (d < bestDistance) {
          bestDistance = d
          best = i
        }
      })
      setDrag({ id, over: best })
    }
    const up = (): void => {
      cleanup()
      if (!lifted) return
      setDrag((d) => {
        if (d) {
          const from = pages.findIndex((p) => p.id === d.id)
          if (from !== d.over) {
            const list = [...pages]
            const [moved] = list.splice(from, 1)
            list.splice(d.over, 0, moved!)
            void commit(list)
          }
        }
        return null
      })
    }
    const cleanup = (): void => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const shown = useMemo(() => {
    const indexed = pages.map((page, index) => ({ page, index }))
    if (view === 'all') return indexed
    return indexed.filter(({ page }) => page.bookmarked || page.title)
  }, [pages, view])

  const display = useMemo(() => {
    if (!drag || view !== 'all') return shown
    const list = [...shown]
    const from = list.findIndex((x) => x.page.id === drag.id)
    const [moved] = list.splice(from, 1)
    list.splice(drag.over, 0, moved!)
    return list
  }, [shown, drag, view])

  return (
    <Sheet title="Pages" onClose={onClose} width={760}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          aria-label="Show"
          items={[
            { value: 'all', label: 'All pages' },
            { value: 'outline', label: 'Outline' }
          ]}
          value={view}
          onValueChange={(v) => setView(v as 'all' | 'outline')}
        />
        {clipboard && clipboard.length > 0 && (
          <button type="button" className="press flex items-center gap-1.5 rounded-full bg-clay/15 px-3.5 py-1.5 text-[13px] font-semibold text-clay-deep" onClick={() => void paste()}>
            <ClipboardPaste size={15} /> Paste {clipboard.length} {clipboard.length === 1 ? 'page' : 'pages'}
          </button>
        )}
      </div>
      {view === 'outline' && shown.length === 0 && <p className="text-[14px] text-ink-muted">Bookmark a page or give it a title to see it here.</p>}
      <div ref={grid} className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4">
        {display.map(({ page, index }) => (
          <div key={page.id} data-page className={`flex flex-col items-center gap-1.5 transition-transform ${drag?.id === page.id ? 'scale-105 opacity-80' : ''}`}>
            <button
              type="button"
              className={`press relative rounded-xl p-1 ${index === current ? 'ring-2 ring-clay' : ''}`}
              onPointerDown={(e) => view === 'all' && startDrag(page.id, e)}
              onClick={() => {
                if (drag) return
                engine.showPage(index)
                onClose()
              }}
              aria-label={`Page ${index + 1}${page.title ? `, ${page.title}` : ''}`}
            >
              <PageThumb page={page} items={engine.itemsOn(page.id)} width={page.size === 'infinite' ? 110 : 104} />
              {page.bookmarked && <Bookmark size={18} className="absolute right-2 top-0 fill-[var(--clay)] text-clay" />}
            </button>
            <div className="flex w-full items-center justify-between gap-1 px-1">
              <span className="min-w-0 truncate text-[12px]">
                <span className="font-semibold">{index + 1}</span>
                {page.title ? <span className="text-ink-muted"> · {page.title}</span> : null}
              </span>
              <Menu
                aria-label={`Page ${index + 1} options`}
                align="end"
                icon={<MoreHorizontal size={16} />}
                items={[
                  { label: page.bookmarked ? 'Remove bookmark' : 'Bookmark', icon: <Bookmark size={15} />, onSelect: () => void update(page, { bookmarked: !page.bookmarked }) },
                  { label: page.title ? 'Rename' : 'Give it a title', icon: <Pencil size={15} />, onSelect: () => setNaming(page) },
                  { label: 'Duplicate', icon: <CopyPlus size={15} />, onSelect: () => void duplicate(page) },
                  {
                    label: 'Copy (paste in any notebook)',
                    icon: <Copy size={15} />,
                    onSelect: () => {
                      setClipboard([page.id])
                      void setMeta('pageClipboard', [page.id])
                    }
                  },
                  'separator',
                  { label: 'Delete', icon: <Trash2 size={15} />, destructive: true, disabled: pages.length <= 1, onSelect: () => void remove(page) }
                ]}
              />
            </div>
          </div>
        ))}
      </div>
      {view === 'all' && <p className="mt-4 text-[12px] text-ink-faint">Press and hold a page, then drag it to move it.</p>}
      {naming && (
        <NameSheet
          title="Page title"
          initial={naming.title ?? ''}
          placeholder="e.g. Lesson 3: Fractions"
          action="Save"
          onClose={() => setNaming(null)}
          onDone={(title) => {
            void update(naming, { title })
            setNaming(null)
          }}
        />
      )}
    </Sheet>
  )
}
