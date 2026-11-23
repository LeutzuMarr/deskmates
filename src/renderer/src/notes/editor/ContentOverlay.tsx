import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, CopyPlus, Palette, Spline, Sticker, Trash2 } from 'lucide-react'
import type { StickyData, TextData } from '../model'
import { fontFor } from '../ink/paint'
import type { NotesEngine } from './engine'
import { finishEditing, onEditing, selectionToPng, type Editing } from './content'
import { selectionOf } from './lasso'
import { PALETTE } from './tools'
import { recolorItem, transformItem } from './transform'
import { addMyStickers } from '../store/store'
import { setMeta, getMeta, newId } from '../db'
import type { Item } from '../model'

/** Text boxes and sticky notes are typed into a real text field laid over the page. */
function TextEditor({ engine, editing }: { engine: NotesEngine; editing: Editing }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const item = editing.item
  const sticky = item.kind === 'sticky'
  const d = item.data as TextData & StickyData
  const [text, setText] = useState(d.text)
  const [, force] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  // A tap anywhere else ends typing (iPadOS keeps the keyboard up when a canvas is tapped).
  useEffect(() => {
    const away = (e: PointerEvent): void => {
      const el = ref.current
      if (!el || e.target === el) return
      finishEditing(engine, item.id)
      if (document.activeElement === el) el.blur()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [engine, item.id])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [text])
  // Follow the page when it moves.
  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      force((n) => n + 1)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  const scale = engine.camera.scale
  const x = sticky ? d.x + 14 : d.x
  const y = sticky ? d.y + 14 : d.y
  const [sx, sy] = engine.pageToScreen(item.pageId, x, y)
  const size = sticky ? 17 : d.size
  const width = sticky ? d.width - 28 : d.width
  return (
    <>
      {sticky && (
        <div
          className="pointer-events-none absolute origin-top-left rounded-[4px] shadow-lg"
          style={{ left: engine.pageToScreen(item.pageId, d.x, d.y)[0], top: engine.pageToScreen(item.pageId, d.x, d.y)[1], width: d.width * scale, height: d.height * scale, background: d.color, transform: `rotate(${engine.camera.rotation}rad)` }}
        />
      )}
      <textarea
        ref={ref}
        value={text}
        aria-label={sticky ? 'Sticky note' : 'Text'}
        placeholder={sticky ? 'Write a note' : 'Type here'}
        onChange={(e) => {
          editing.draft = e.target.value
          setText(e.target.value)
        }}
        onBlur={() => finishEditing(engine, item.id)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
        }}
        className="absolute origin-top-left resize-none overflow-hidden border-0 bg-transparent p-0 leading-[1.35] outline-none ring-2 ring-[#2f80ed]/40 placeholder:text-black/30"
        style={{
          left: sx,
          top: sy,
          width: width * scale,
          font: fontFor({ font: sticky ? 'hand' : d.font, size: size * scale, bold: d.bold }),
          color: sticky ? '#2b2a28' : d.color,
          transform: `rotate(${engine.camera.rotation}rad)`
        }}
      />
    </>
  )
}

/** The bar over a lasso selection: colour, copy, duplicate, make a sticker, delete. */
function SelectionBar({ engine, notice }: { engine: NotesEngine; notice: (text: string) => void }) {
  const selection = selectionOf(engine)
  const [, force] = useState(0)
  const [colors, setColors] = useState(false)
  useEffect(() => selection.on(() => force((n) => n + 1)), [selection])
  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      force((n) => n + 1)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])
  const corners = selection.screenCorners()
  if (!selection.active || !corners || engine.tools.tool !== 'lasso') return null
  const top = Math.min(...corners.map((c) => c[1]))
  const left = (Math.min(...corners.map((c) => c[0])) + Math.max(...corners.map((c) => c[0]))) / 2
  const canColor = selection.items.some((i) => i.kind === 'stroke' || i.kind === 'text' || i.kind === 'sticky' || i.kind === 'tape' || i.kind === 'fill')

  const copy = async (): Promise<void> => {
    await setMeta('itemClipboard', selection.items)
    notice('Copied. Tap “Paste” in the menu to put it on any page.')
  }
  const duplicate = (): void => {
    const copies: Item[] = selection.items.map((i) => ({ ...transformItem(i, { origin: [0, 0], scale: 1, angle: 0, dx: 24, dy: 24 }), id: newId(), z: engine.nextZ(), createdAt: Date.now(), updatedAt: Date.now() }))
    engine.addItems(copies)
    selection.set(selection.pageId!, copies.map((c) => engine.getItem(c.id) ?? c))
  }
  const sticker = async (): Promise<void> => {
    const png = await selectionToPng(engine)
    if (!png) return
    await addMyStickers([{ blob: png, name: 'From my notes' }])
    notice('Saved to My stickers.')
  }

  return (
    <div className="absolute z-20 -translate-x-1/2" style={{ left, top: Math.max(70, top - 64) }}>
      <div className="toolbar-capsule glass flex items-center gap-0.5 px-1.5 py-1 text-[13px] font-medium" style={{ animation: 'pop-in .28s cubic-bezier(.2,.9,.3,1.25)' }}>
        {canColor && (
          <button type="button" className="press flex items-center gap-1 rounded-full px-2.5 py-1.5" onClick={() => setColors(!colors)}>
            <Palette size={15} /> Colour
          </button>
        )}
        <button type="button" className="press flex items-center gap-1 rounded-full px-2.5 py-1.5" onClick={() => void copy()}>
          <Copy size={15} /> Copy
        </button>
        <button type="button" className="press flex items-center gap-1 rounded-full px-2.5 py-1.5" onClick={duplicate}>
          <CopyPlus size={15} /> Duplicate
        </button>
        <button type="button" className="press flex items-center gap-1 rounded-full px-2.5 py-1.5" onClick={() => void sticker()}>
          <Sticker size={15} /> Make sticker
        </button>
        {engine.tools.advanced && (
          <button type="button" aria-pressed={Boolean(selection.warp)} className={`press flex items-center gap-1 rounded-full px-2.5 py-1.5 ${selection.warp ? 'bg-[#8e44ad]/15 text-[#8e44ad]' : ''}`} onClick={() => selection.toggleWarp()}>
            <Spline size={15} /> {selection.warp ? 'Done' : 'Distort'}
          </button>
        )}
        <button type="button" aria-label="Delete" className="press rounded-full px-2.5 py-1.5 text-[#c8372d]" onClick={() => selection.remove()}>
          <Trash2 size={15} />
        </button>
      </div>
      {colors && (
        <div className="glass mt-2 flex flex-wrap justify-center gap-2 rounded-2xl p-2.5 shadow-xl" style={{ width: 236, animation: 'pop-in .28s cubic-bezier(.2,.9,.3,1.25)' }}>
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              className="swatch"
              style={{ background: c }}
              onClick={() => {
                selection.change((i) => recolorItem(i, c))
                setColors(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ContentOverlay({ engine, notice }: { engine: NotesEngine; notice: (text: string) => void }) {
  const [editing, setEditing] = useState<Editing | null>(null)
  useEffect(() => onEditing(engine, setEditing), [engine])
  return (
    <>
      {editing && <TextEditor key={editing.item.id} engine={engine} editing={editing} />}
      <SelectionBar engine={engine} notice={notice} />
    </>
  )
}

/** Puts what was copied with the lasso onto the page shown, and selects it. */
export async function pasteItems(engine: NotesEngine, selectTool: () => void): Promise<boolean> {
  const copied = await getMeta<Item[]>('itemClipboard')
  const at = engine.centerPoint()
  if (!copied?.length || !at) return false
  const xs = copied.map((i) => i.kind === 'stroke' ? (i.data as { points: number[][] }).points[0]![0]! : (i.data as { x?: number; x1?: number }).x ?? (i.data as { x1: number }).x1)
  const ys = copied.map((i) => i.kind === 'stroke' ? (i.data as { points: number[][] }).points[0]![1]! : (i.data as { y?: number; y1?: number }).y ?? (i.data as { y1: number }).y1)
  const dx = at.x - (Math.min(...xs) + Math.max(...xs)) / 2
  const dy = at.y - (Math.min(...ys) + Math.max(...ys)) / 2
  const now = Date.now()
  const items = copied.map((i) => ({ ...transformItem(i, { origin: [0, 0], scale: 1, angle: 0, dx, dy }), id: newId(), pageId: at.page.id, notebookId: engine.notebookId, z: engine.nextZ(), createdAt: now, updatedAt: now, deletedAt: null }))
  engine.addItems(items)
  selectTool()
  selectionOf(engine).set(at.page.id, items.map((i) => engine.getItem(i.id) ?? i))
  return true
}
