/**
 * Things put on a page besides ink: text boxes, pictures, stickers, sticky notes and tape (which
 * hides an answer until tapped). Each is an item, so undo, the lasso and sync treat it like ink.
 */
import { newId, putAsset } from '../db'
import type { ImageData, Item, ItemDataMap, ItemKind, StickyData, TapeData, TextData } from '../model'
import { paintItem } from '../ink/paint'
import type { NotesEngine, PagePoint, ToolHandler } from './engine'
import { selectionOf } from './lasso'

export function makeItem<K extends ItemKind>(engine: NotesEngine, pageId: string, kind: K, data: ItemDataMap[K]): Item<K> {
  const now = Date.now()
  return { id: newId(), pageId, notebookId: engine.notebookId, kind, z: engine.nextZ(), data, createdAt: now, updatedAt: now, deletedAt: null }
}

// ---- text editing (shared by text boxes and sticky notes) ----

export interface Editing {
  item: Item<'text'> | Item<'sticky'>
  isNew: boolean
  /** What's typed so far (kept here so any way of ending the edit saves it). */
  draft?: string
}

type EditListener = (editing: Editing | null) => void
const editors = new WeakMap<NotesEngine, { current: Editing | null; listeners: Set<EditListener> }>()

function editorOf(engine: NotesEngine): { current: Editing | null; listeners: Set<EditListener> } {
  let e = editors.get(engine)
  if (!e) {
    e = { current: null, listeners: new Set() }
    editors.set(engine, e)
  }
  return e
}

export function onEditing(engine: NotesEngine, listener: EditListener): () => void {
  const e = editorOf(engine)
  e.listeners.add(listener)
  listener(e.current)
  return () => e.listeners.delete(listener)
}

export function startEditing(engine: NotesEngine, editing: Editing): void {
  const e = editorOf(engine)
  if (e.current) finishEditing(engine, e.current.item.id)
  editing.draft ??= editing.item.kind === 'text' ? (editing.item.data as TextData).text : (editing.item.data as StickyData).text
  e.current = editing
  engine.hidden.add(editing.item.id)
  engine.requestRender()
  for (const l of e.listeners) l(editing)
}

/** Ends editing (of `itemId`, if given), saving the text: an empty new box is dropped, an emptied text box deleted. */
export function finishEditing(engine: NotesEngine, itemId?: string): void {
  const e = editorOf(engine)
  const editing = e.current
  if (!editing || (itemId && editing.item.id !== itemId)) return
  const text = editing.draft ?? ''
  e.current = null
  engine.hidden.delete(editing.item.id)
  const trimmed = text.replace(/\s+$/, '')
  const item = editing.item
  if (item.kind === 'text') {
    if (!trimmed) {
      if (!editing.isNew) engine.removeItems([item])
    } else {
      const next = { ...item, data: { ...item.data, text: trimmed } } as Item
      if (editing.isNew) engine.addItems([next])
      else if (trimmed !== item.data.text) engine.updateItems([{ before: item, after: next }])
    }
  } else {
    const next = { ...item, data: { ...item.data, text: trimmed } } as Item
    if (editing.isNew) engine.addItems([next])
    else if (trimmed !== item.data.text) engine.updateItems([{ before: item, after: next }])
  }
  engine.requestRender()
  for (const l of e.listeners) l(null)
}

export function currentEditing(engine: NotesEngine): Editing | null {
  return editorOf(engine).current
}

// ---- tools ----

export function textTool(engine: NotesEngine): ToolHandler {
  return {
    down(at: PagePoint): boolean {
      const hit = engine.itemAt(at.page.id, at.x, at.y, ['text', 'sticky'])
      if (hit) {
        startEditing(engine, { item: hit as Item<'text'>, isNew: false })
        return false
      }
      const style = engine.tools.text
      const width = Math.min(360, at.page.width - at.x - 24)
      const item = makeItem(engine, at.page.id, 'text', { x: at.x, y: at.y - style.size * 0.6, width: Math.max(120, width), text: '', size: style.size, color: style.color, font: style.font })
      startEditing(engine, { item, isNew: true })
      return false
    },
    move() {},
    up() {},
    cancel() {}
  }
}

/** Tape: drag to lay a strip over an answer; tap a strip to peek under it or cover it again. */
export function tapeTool(engine: NotesEngine): ToolHandler {
  let start: PagePoint | null = null
  let end: PagePoint | null = null
  const color = (): string => engine.tools.pens.highlighter.color
  return {
    down(at: PagePoint): boolean {
      const hit = engine.itemAt(at.page.id, at.x, at.y, ['tape'])
      if (hit) {
        const d = hit.data as TapeData
        engine.updateItems([{ before: hit, after: { ...hit, data: { ...d, revealed: !d.revealed } } }])
        return false
      }
      start = at
      end = at
      return true
    },
    move(at: PagePoint): void {
      if (start && at.page.id === start.page.id) end = at
    },
    up(): void {
      if (start && end && Math.hypot(end.x - start.x, end.y - start.y) > 12) {
        engine.addItems([makeItem(engine, start.page.id, 'tape', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, width: 22, color: tapeColor(color()), revealed: false })])
      }
      start = null
      end = null
    },
    cancel(): void {
      start = null
      end = null
    },
    overlay(): void {
      if (!start || !end) return
      const page = engine.pageById(start.page.id)
      const ctx = engine.pageContext(start.page.id)
      if (!page || !ctx) return
      paintItem(ctx, makeItem(engine, page.id, 'tape', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, width: 22, color: tapeColor(color()), revealed: false }), engine.cache, page.color)
    }
  }
}

/** Tape is a solid, slightly muted version of the colour. */
function tapeColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#f2c94c'
  const n = parseInt(m[1]!, 16)
  const mix = (c: number): number => Math.round(c * 0.82 + 255 * 0.04)
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`
}

// ---- inserting ----

/** Where to put something new: the middle of the screen on the page shown. */
function dropPoint(engine: NotesEngine): PagePoint | null {
  return engine.centerPoint()
}

/** Puts items on the page and selects them with the lasso, so they can be moved and resized at once. */
function placeAndSelect(engine: NotesEngine, items: Item[], selectTool: () => void): void {
  if (!items.length) return
  engine.addItems(items)
  selectTool()
  selectionOf(engine).set(items[0]!.pageId, items.map((i) => engine.getItem(i.id) ?? i))
}

export async function insertPictures(engine: NotesEngine, files: File[], selectTool: () => void): Promise<void> {
  const at = dropPoint(engine)
  if (!at) return
  const items: Item[] = []
  let offset = 0
  for (const file of files) {
    const asset = await putAsset(file, { name: file.name })
    let w = 400
    let h = 300
    try {
      const bitmap = await createImageBitmap(file)
      w = bitmap.width
      h = bitmap.height
      bitmap.close()
    } catch {
      // Keep a default shape.
    }
    const width = Math.min(at.page.width * 0.6, w)
    const height = (width * h) / w
    const data: ImageData = { assetId: asset.id, x: Math.max(0, at.x - width / 2 + offset), y: Math.max(0, at.y - height / 2 + offset), width, height, rotation: 0 }
    items.push(makeItem(engine, at.page.id, 'image', data))
    offset += 24
  }
  placeAndSelect(engine, items, selectTool)
}

export function insertSticker(engine: NotesEngine, sticker: { assetId: string; width: number; height: number }, selectTool: () => void): void {
  const at = dropPoint(engine)
  if (!at) return
  const size = 130
  const ratio = sticker.width / Math.max(1, sticker.height)
  const width = ratio >= 1 ? size : size * ratio
  const height = ratio >= 1 ? size / ratio : size
  // A small random tilt makes stickers look stuck on by hand.
  const rotation = (Math.random() - 0.5) * 0.16
  placeAndSelect(engine, [makeItem(engine, at.page.id, 'sticker', { assetId: sticker.assetId, x: at.x - width / 2, y: at.y - height / 2, width, height, rotation })], selectTool)
}

export const STICKY_COLORS = ['#fff3a8', '#ffd3e0', '#c9f0d4', '#cfe7ff', '#ffe0b8', '#e5d9ff']

export function insertSticky(engine: NotesEngine): void {
  const at = dropPoint(engine)
  if (!at) return
  const size = 190
  const color = STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)]!
  const item = makeItem(engine, at.page.id, 'sticky', { x: at.x - size / 2, y: at.y - size / 2, width: size, height: size, rotation: (Math.random() - 0.5) * 0.08, color, text: '' })
  startEditing(engine, { item, isNew: true })
}

/** Renders the selected items to a transparent PNG (to save them as a sticker). */
export async function selectionToPng(engine: NotesEngine): Promise<Blob | null> {
  const selection = selectionOf(engine)
  const b = selection.bounds()
  const page = selection.pageId ? engine.pageById(selection.pageId) : null
  if (!b || !page) return null
  const scale = 2
  const pad = 6
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((b.maxX - b.minX + pad * 2) * scale)
  canvas.height = Math.ceil((b.maxY - b.minY + pad * 2) * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.translate(pad - b.minX, pad - b.minY)
  for (const item of selection.items) paintItem(ctx, item, engine.cache, 'white')
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}
