/**
 * The lasso: circle things to select them, then drag to move, pull the corner to resize, pull the
 * top handle to turn. Selected items are drawn on the top canvas while they move.
 */
import type { Item } from '../model'
import { itemBounds, paintItem } from '../ink/paint'
import type { Bounds } from '../ink/stroke'
import type { NotesEngine, PagePoint, ToolHandler } from './engine'
import { IDENTITY, apply, lassoTakes, transformItem, type Similarity } from './transform'

type Mode = { kind: 'lasso'; points: Array<[number, number]> } | { kind: 'move' | 'scale' | 'rotate'; start: [number, number]; t: Similarity } | null

export class Selection {
  pageId: string | null = null
  items: Item[] = []
  /** The transform being dragged, not yet applied. */
  live: Similarity = IDENTITY
  private listeners = new Set<() => void>()

  constructor(private readonly engine: NotesEngine) {}

  on(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(): void {
    for (const l of this.listeners) l()
  }

  get active(): boolean {
    return this.items.length > 0
  }

  set(pageId: string, items: Item[]): void {
    this.clearHidden()
    this.pageId = pageId
    this.items = items
    this.live = IDENTITY
    for (const i of items) this.engine.hidden.add(i.id)
    this.engine.requestRender()
    this.emit()
  }

  clear(): void {
    if (!this.active && !this.pageId) return
    this.clearHidden()
    this.items = []
    this.pageId = null
    this.live = IDENTITY
    this.engine.requestRender()
    this.emit()
  }

  private clearHidden(): void {
    for (const i of this.items) this.engine.hidden.delete(i.id)
  }

  /** Re-reads the selected items from the engine (after undo, recolour…). */
  refresh(): void {
    const next = this.items.map((i) => this.engine.getItem(i.id)).filter((i): i is Item => Boolean(i))
    if (next.length === 0) this.clear()
    else {
      this.items = next
      this.emit()
    }
  }

  bounds(): Bounds | null {
    if (!this.active) return null
    const all = this.items.map((i) => itemBounds(i, this.engine.cache))
    return { minX: Math.min(...all.map((b) => b.minX)), minY: Math.min(...all.map((b) => b.minY)), maxX: Math.max(...all.map((b) => b.maxX)), maxY: Math.max(...all.map((b) => b.maxY)) }
  }

  /** The selection box's corners on screen, with the live transform applied. */
  screenCorners(): Array<[number, number]> | null {
    const b = this.bounds()
    if (!b || !this.pageId) return null
    return ([[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as Array<[number, number]>).map(([x, y]) => {
      const [tx, ty] = apply(this.live, x, y)
      return this.engine.pageToScreen(this.pageId!, tx, ty)
    })
  }

  /** Applies a transform to the selection as one undoable step. */
  commitTransform(t: Similarity): void {
    if (!this.active || (t.scale === 1 && t.angle === 0 && t.dx === 0 && t.dy === 0)) {
      this.live = IDENTITY
      this.engine.requestOverlay()
      return
    }
    const pairs = this.items.map((before) => ({ before, after: transformItem(before, t) }))
    this.clearHidden()
    this.engine.updateItems(pairs)
    this.items = pairs.map((p) => this.engine.getItem(p.after.id) ?? p.after)
    for (const i of this.items) this.engine.hidden.add(i.id)
    this.live = IDENTITY
    this.engine.requestRender()
    this.emit()
  }

  /** Updates selected items with a function (recolour…), as one undoable step. */
  change(update: (item: Item) => Item): void {
    if (!this.active) return
    const pairs = this.items.map((before) => ({ before, after: update(before) }))
    this.clearHidden()
    this.engine.updateItems(pairs)
    this.items = pairs.map((p) => this.engine.getItem(p.after.id) ?? p.after)
    for (const i of this.items) this.engine.hidden.add(i.id)
    this.engine.requestRender()
    this.emit()
  }

  remove(): void {
    if (!this.active) return
    const items = this.items
    this.clearHidden()
    this.items = []
    this.pageId = null
    this.engine.removeItems(items)
    this.emit()
  }

  /** Draws the selected items (moving with the live transform) and the box with its handles. */
  paint(ctx: CanvasRenderingContext2D): void {
    if (!this.active || !this.pageId) return
    const page = this.engine.pageById(this.pageId)
    const pageCtx = this.engine.pageContext(this.pageId)
    if (!page || !pageCtx) return
    pageCtx.save()
    for (const item of this.items) paintItem(pageCtx, transformItem(item, this.live), this.engine.cache, page.color)
    pageCtx.restore()
    const corners = this.screenCorners()
    if (!corners) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.beginPath()
    corners.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    ctx.closePath()
    ctx.setLineDash([6, 5])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#2f80ed'
    ctx.stroke()
    ctx.setLineDash([])
    const handle = (x: number, y: number): void => {
      ctx.beginPath()
      ctx.arc(x, y, 9, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#2f80ed'
      ctx.stroke()
    }
    const [tl, tr, br] = corners as [[number, number], [number, number], [number, number]]
    handle(br[0], br[1])
    const top = this.rotateHandle()
    if (top) {
      ctx.beginPath()
      ctx.moveTo((tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2)
      ctx.lineTo(top[0], top[1])
      ctx.strokeStyle = '#2f80ed'
      ctx.lineWidth = 1.5
      ctx.stroke()
      handle(top[0], top[1])
    }
    ctx.restore()
  }

  /** Where the turn handle is, on screen: a little above the top edge's middle. */
  rotateHandle(): [number, number] | null {
    const c = this.screenCorners()
    if (!c) return null
    const [tl, tr, , bl] = c as [[number, number], [number, number], [number, number], [number, number]]
    const mx = (tl[0] + tr[0]) / 2
    const my = (tl[1] + tr[1]) / 2
    const ux = tl[0] - bl[0]
    const uy = tl[1] - bl[1]
    const len = Math.hypot(ux, uy) || 1
    return [mx + (ux / len) * 28, my + (uy / len) * 28]
  }
}

const selections = new WeakMap<NotesEngine, Selection>()

export function selectionOf(engine: NotesEngine): Selection {
  let s = selections.get(engine)
  if (!s) {
    s = new Selection(engine)
    selections.set(engine, s)
  }
  return s
}

/** The lasso tool's pen handling. */
export function lassoTool(engine: NotesEngine): ToolHandler {
  const selection = selectionOf(engine)
  let mode: Mode = null
  let pageId: string | null = null

  const near = (a: [number, number], b: [number, number] | null, r = 22): boolean => Boolean(b) && Math.hypot(a[0] - b![0], a[1] - b![1]) <= r

  return {
    down(at: PagePoint): boolean {
      const screen = at.screen
      if (selection.active && selection.pageId) {
        const corners = selection.screenCorners()!
        const b = selection.bounds()!
        if (near(screen, selection.rotateHandle())) {
          mode = { kind: 'rotate', start: [at.x, at.y], t: { ...IDENTITY, origin: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] } }
          return true
        }
        if (near(screen, corners[2]!)) {
          mode = { kind: 'scale', start: [at.x, at.y], t: { ...IDENTITY, origin: [b.minX, b.minY] } }
          return true
        }
        if (at.page.id === selection.pageId && at.x >= b.minX && at.x <= b.maxX && at.y >= b.minY && at.y <= b.maxY) {
          mode = { kind: 'move', start: [at.x, at.y], t: IDENTITY }
          return true
        }
        selection.clear()
      }
      pageId = at.page.id
      mode = { kind: 'lasso', points: [[at.x, at.y]] }
      return true
    },
    move(at: PagePoint): void {
      if (!mode) return
      if (mode.kind === 'lasso') {
        if (at.page.id === pageId) mode.points.push([at.x, at.y])
        return
      }
      const b = selection.bounds()!
      const [sx, sy] = mode.start
      if (mode.kind === 'move') selection.live = { ...IDENTITY, dx: at.x - sx, dy: at.y - sy }
      else if (mode.kind === 'scale') {
        const w = b.maxX - b.minX || 1
        const h = b.maxY - b.minY || 1
        const scale = Math.max(0.1, Math.max((w + (at.x - sx)) / w, (h + (at.y - sy)) / h))
        selection.live = { ...mode.t, scale }
      } else {
        const [cx, cy] = mode.t.origin
        let angle = Math.atan2(at.y - cy, at.x - cx) - Math.atan2(sy - cy, sx - cx)
        // Snap to 15° steps near them.
        const step = Math.PI / 12
        if (Math.abs(angle - Math.round(angle / step) * step) < 0.05) angle = Math.round(angle / step) * step
        selection.live = { ...mode.t, angle }
      }
      selection.emit()
    },
    up(): void {
      const m = mode
      mode = null
      if (!m) return
      if (m.kind === 'lasso') {
        if (!pageId || m.points.length < 3) return
        const polygon = m.points
        const items = engine.itemsOn(pageId).filter((item) => lassoTakes(item, polygon, itemBounds(item, engine.cache)))
        if (items.length) selection.set(pageId, items)
        return
      }
      selection.commitTransform(selection.live)
    },
    cancel(): void {
      mode = null
      selection.live = IDENTITY
    },
    overlay(ctx: CanvasRenderingContext2D): void {
      if (mode?.kind === 'lasso' && pageId) {
        const pts = mode.points.map(([x, y]) => engine.pageToScreen(pageId!, x, y))
        ctx.beginPath()
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.setLineDash([5, 5])
        ctx.lineWidth = 1.6
        ctx.strokeStyle = '#2f80ed'
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(47,128,237,.06)'
        ctx.fill()
      }
      selection.paint(ctx)
    }
  }
}
