/**
 * The writing surface: two canvases (the finished page below, the line being drawn on top), the
 * pen, the eraser, finger gestures (move, pinch, turn, two-finger tap to undo) and undo itself.
 * Plain TypeScript, outside React, so nothing re-renders while the pen moves.
 *
 * Speed: the line being drawn is redrawn on its own canvas every frame from every point the pen
 * reported (coalesced events) plus a guess of where it's heading (predicted events), and nothing
 * else runs while it draws. A finished line is painted onto the page canvas once.
 */
import type { InkPoint, Item, Page, StrokeData } from '../model'
import { InkCache, itemBounds, paintItem } from '../ink/paint'
import { drawPaper } from '../ink/paper'
import { boundsOverlap, type Bounds } from '../ink/stroke'
import { isBrush, paintBrushLive } from '../ink/brush'
import { PressureTracker, tiltAmount, type PenSample } from '../ink/pressure'
import { fitPage, layoutPages, matrix, pan, pinch, rotateAbout, toDoc, toScreen, visibleDocBounds, zoomAt, type Camera, type PageSlot, type Vec } from './camera'
import { cutStroke, sweepHitsStroke } from './erase'
import { History, type Change } from './history'
import { isInk, type ToolState } from './tools'
import { recognizeShape } from './shapes'
import { Spring } from '../ui/spring'
import { pointInPolygon } from './transform'
import { templateById } from '../templates/registry'
import { drawTemplate } from '../templates/spec'

export interface EngineHost {
  /** Saves changed items (deleted ones carry deletedAt). */
  persist(items: Item[]): void
  /** Something the toolbar shows changed (page number, undo, rotation…). */
  changed(): void
  loadAsset(id: string): Promise<Blob | null>
  /** The current time relative to a running audio recording, if any. */
  audioStamp(): Item['audio']
}

/** A tool that handles the pen itself (lasso, text, shapes…), added by later parts. */
export interface ToolHandler {
  down(at: PagePoint, e: PointerEvent): boolean
  move(at: PagePoint, e: PointerEvent): void
  up(at: PagePoint, e: PointerEvent): void
  cancel(): void
  /** Draws its own marks over the page (selection box, handles…), in screen space. */
  overlay?(ctx: CanvasRenderingContext2D): void
}

export interface PagePoint {
  page: Page
  slot: PageSlot
  x: number
  y: number
  doc: Vec
  screen: Vec
}

interface LiveStroke {
  pointerId: number
  page: Page
  slot: PageSlot
  data: StrokeData
  pressure: PressureTracker
  predicted: InkPoint[]
  steady: Vec | null
  start: number
  /** Where the pen has been still since (for hold-to-shape). */
  still: { x: number; y: number; since: number } | null
  shaped: boolean
  drawnUpTo: number
}

interface EraseGesture {
  pointerId: number
  last: Vec | null
  changes: Map<string, Change>
}

type TouchInfo = { x: number; y: number; startX: number; startY: number; time: number }

const BACKDROP_LIGHT = '#e9e6dd'
const BACKDROP_DARK = '#1a1918'

function round(n: number): number {
  return Math.round(n * 100) / 100
}

export class NotesEngine {
  readonly cache: InkCache
  readonly history = new History()
  camera: Camera = { scale: 1, rotation: 0, x: 0, y: 0 }
  pages: Page[] = []
  slots: PageSlot[] = []
  private readonly items = new Map<string, Item[]>()
  private readonly byId = new Map<string, Item>()
  private width = 0
  private height = 0
  private dpr = 1
  private readonly base: CanvasRenderingContext2D
  private readonly wet: CanvasRenderingContext2D
  private frame = 0
  private wetFrame = 0
  private live: LiveStroke | null = null
  private erase: EraseGesture | null = null
  private eraserAt: Vec | null = null
  private readonly touches = new Map<number, TouchInfo>()
  private gestureStart = 0
  private gestureMoved = 0
  private maxTouches = 0
  private momentum = 0
  private velocity: Vec = [0, 0]
  private lastPanAt = 0
  private penSeen = false
  private handlerPointer: number | null = null
  private snapshot: { canvas: HTMLCanvasElement; camera: Camera } | null = null
  private slowFrames = 0
  private rotationSpring: Spring | null = null
  private zCounter = 0
  handlers: Partial<Record<string, ToolHandler>> = {}
  /** Items drawn elsewhere for now (being moved, or edited as text). */
  readonly hidden = new Set<string>()
  /** While a recording plays: ink written later than `at` in it is drawn faint. */
  audioFilter: { recordingId: string; at: number } | null = null
  /** Lets tools change the tool settings (the eyedropper picks a colour and hands back to the pen). */
  requestTools: ((next: ToolState) => void) | null = null
  /** Lets tools tell the user something short. */
  say: ((text: string) => void) | null = null
  /** A quick one-finger tap on a page (audio jump, tape reveal…); return true if handled. */
  onTap: ((at: PagePoint) => boolean) | null = null
  topInset = 0
  dark = false

  constructor(
    private readonly baseCanvas: HTMLCanvasElement,
    private readonly wetCanvas: HTMLCanvasElement,
    readonly notebookId: string,
    public tools: ToolState,
    private readonly host: EngineHost
  ) {
    this.base = baseCanvas.getContext('2d', { alpha: false })!
    this.wet = wetCanvas.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings)!
    this.cache = new InkCache(host.loadAsset, () => this.requestRender())
    wetCanvas.addEventListener('pointerdown', this.onDown)
    wetCanvas.addEventListener('pointermove', this.onMove)
    wetCanvas.addEventListener('pointerup', this.onUp)
    wetCanvas.addEventListener('pointercancel', this.onCancel)
    wetCanvas.addEventListener('wheel', this.onWheel, { passive: false })
    // iOS would otherwise start its own gestures (text loupe, zoom) on long presses.
    wetCanvas.addEventListener('touchstart', this.preventTouch, { passive: false })
    wetCanvas.addEventListener('touchmove', this.preventTouch, { passive: false })
    wetCanvas.addEventListener('contextmenu', this.preventTouch)
  }

  destroy(): void {
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.wetFrame)
    cancelAnimationFrame(this.momentum)
    const c = this.wetCanvas
    c.removeEventListener('pointerdown', this.onDown)
    c.removeEventListener('pointermove', this.onMove)
    c.removeEventListener('pointerup', this.onUp)
    c.removeEventListener('pointercancel', this.onCancel)
    c.removeEventListener('wheel', this.onWheel)
    c.removeEventListener('touchstart', this.preventTouch)
    c.removeEventListener('touchmove', this.preventTouch)
    c.removeEventListener('contextmenu', this.preventTouch)
  }

  private readonly preventTouch = (e: Event): void => {
    if (e.cancelable) e.preventDefault()
  }

  // ---- content ----

  load(pages: Page[], items: Item[]): void {
    this.pages = pages
    this.slots = layoutPages(pages)
    this.items.clear()
    this.byId.clear()
    for (const item of items) this.index(item)
    for (const list of this.items.values()) list.sort((a, b) => a.z - b.z)
    this.requestRender()
    this.host.changed()
  }

  setPages(pages: Page[]): void {
    this.pages = pages
    this.slots = layoutPages(pages)
    this.requestRender()
    this.host.changed()
  }

  private index(item: Item): void {
    if (item.deletedAt) return
    const list = this.items.get(item.pageId) ?? []
    list.push(item)
    this.items.set(item.pageId, list)
    this.byId.set(item.id, item)
  }

  itemsOn(pageId: string): Item[] {
    return this.items.get(pageId) ?? []
  }

  getItem(id: string): Item | null {
    return this.byId.get(id) ?? null
  }

  nextZ(): number {
    this.zCounter = (this.zCounter + 1) % 1000
    return Date.now() * 1000 + this.zCounter
  }

  /** Puts items into the given states (null = removed), saves them and redraws. */
  private applyStates(states: Array<{ id: string; state: Item | null; previous: Item | null }>): void {
    const now = Date.now()
    const saved: Item[] = []
    for (const { id, state, previous } of states) {
      const old = this.byId.get(id)
      if (old) {
        const list = this.items.get(old.pageId)
        if (list) this.items.set(old.pageId, list.filter((i) => i.id !== id))
        this.byId.delete(id)
        this.cache.forget(id)
      }
      if (state) {
        const next = { ...state, deletedAt: null, updatedAt: now }
        const list = this.items.get(next.pageId) ?? []
        list.push(next)
        list.sort((a, b) => a.z - b.z)
        this.items.set(next.pageId, list)
        this.byId.set(id, next)
        saved.push(next)
      } else {
        const gone = old ?? previous
        if (gone) saved.push({ ...gone, deletedAt: now, updatedAt: now })
      }
    }
    if (saved.length) this.host.persist(saved)
    this.requestRender()
    this.host.changed()
  }

  /** Records and applies a change made by a tool (drawing, erasing, moving…). */
  commit(changes: Change[]): void {
    if (changes.length === 0) return
    this.history.push(changes)
    this.applyStates(changes.map((c) => ({ id: c.id, state: c.after, previous: c.before })))
  }

  /** Called before undo and redo, so tools can let go of what they hold (selection, typing). */
  readonly beforeHistory = new Set<() => void>()

  undo(): void {
    this.cancelLive()
    for (const f of this.beforeHistory) f()
    const states = this.history.undo()
    if (states) this.applyStates(states)
  }

  redo(): void {
    this.cancelLive()
    for (const f of this.beforeHistory) f()
    const states = this.history.redo()
    if (states) this.applyStates(states)
  }

  // ---- view ----

  resize(width: number, height: number, dpr: number): void {
    const first = this.width === 0
    const turned = !first && Math.abs(width - this.width) > 40
    // Turning the iPad: keep the same spot in the middle, with the page fitted to the new width.
    const keep = turned ? toDoc(this.camera, [this.width / 2, this.height / 2]) : null
    this.width = width
    this.height = height
    this.dpr = Math.min(2, dpr)
    for (const canvas of [this.baseCanvas, this.wetCanvas]) {
      canvas.width = Math.round(width * this.dpr)
      canvas.height = Math.round(height * this.dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    if (first) this.showPage(0, false)
    else if (keep) {
      const slot = this.slots[this.currentPageIndex()]
      if (slot && slot.width < 10000 && Math.abs(this.camera.rotation) < 0.001) {
        const fitted = fitPage(slot, width, height, this.topInset)
        this.camera = { scale: fitted.scale, rotation: 0, x: 0, y: 0 }
        const [sx, sy] = toScreen(this.camera, keep)
        this.camera = { ...this.camera, x: width / 2 - sx, y: height / 2 - sy }
      }
    }
    this.snapshot = null
    this.render()
  }

  /** The page canvas (what's on screen), e.g. to send a picture of the page. */
  get baseCanvasElement(): HTMLCanvasElement {
    return this.baseCanvas
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /** Index of the page at the middle of the screen. */
  currentPageIndex(): number {
    const [x, y] = toDoc(this.camera, [this.width / 2, this.height / 2])
    let best = 0
    let bestDistance = Infinity
    this.slots.forEach((s, i) => {
      const dy = y < s.y ? s.y - y : y > s.y + s.height ? y - s.y - s.height : 0
      const dx = x < s.x ? s.x - x : x > s.x + s.width ? x - s.x - s.width : 0
      const d = dx + dy
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    })
    return best
  }

  showPage(index: number, animate = true): void {
    const slot = this.slots[index]
    if (!slot) return
    const target = fitPage(slot, this.width, this.height, this.topInset)
    if (!animate) {
      this.camera = target
      this.requestRender()
      this.host.changed()
      return
    }
    const from = { ...this.camera }
    const start = performance.now()
    cancelAnimationFrame(this.momentum)
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / 320)
      const e = 1 - Math.pow(1 - t, 3)
      this.camera = {
        scale: from.scale + (target.scale - from.scale) * e,
        rotation: from.rotation + (target.rotation - from.rotation) * e,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e
      }
      this.cameraMoved()
      if (t < 1) this.momentum = requestAnimationFrame(step)
      else this.settle()
    }
    this.momentum = requestAnimationFrame(step)
  }

  /** Turns the page back upright (when the rotation lock is switched on). */
  straighten(): void {
    if (Math.abs(this.camera.rotation) < 0.001) return
    const spring = new Spring(this.camera.rotation, { stiffness: 260, damping: 24 })
    spring.target = 0
    this.rotationSpring = spring
    let last = performance.now()
    const step = (now: number): void => {
      if (this.rotationSpring !== spring) return
      const moving = spring.step((now - last) / 1000)
      last = now
      this.camera = rotateAbout(this.camera, [this.width / 2, this.height / 2], spring.value - this.camera.rotation)
      this.cameraMoved()
      if (moving) requestAnimationFrame(step)
      else {
        this.rotationSpring = null
        this.settle()
      }
    }
    requestAnimationFrame(step)
  }

  zoomBy(factor: number): void {
    this.camera = zoomAt(this.camera, [this.width / 2, this.height / 2], factor)
    this.cameraMoved()
    this.settle()
  }

  private cameraMoved(): void {
    this.requestRender(true)
    this.host.changed()
  }

  /** After a gesture ends: draw everything sharply again. */
  private settle(): void {
    this.clampCamera()
    this.snapshot = null
    this.requestRender()
    this.host.changed()
  }

  /** Keeps some of the notebook on screen. */
  private clampCamera(): void {
    if (this.slots.length === 0) return
    const content: Bounds = {
      minX: Math.min(...this.slots.map((s) => s.x)),
      minY: Math.min(...this.slots.map((s) => s.y)),
      maxX: Math.max(...this.slots.map((s) => s.x + s.width)),
      maxY: Math.max(...this.slots.map((s) => s.y + s.height))
    }
    const center = toDoc(this.camera, [this.width / 2, this.height / 2])
    const marginX = this.width / 2 / this.camera.scale
    const marginY = this.height / 2 / this.camera.scale
    const cx = Math.min(content.maxX + marginX * 0.6, Math.max(content.minX - marginX * 0.6, center[0]))
    const cy = Math.min(content.maxY + marginY * 0.6, Math.max(content.minY - marginY * 0.6, center[1]))
    if (cx === center[0] && cy === center[1]) return
    const [sx, sy] = toScreen(this.camera, [cx, cy])
    this.camera = pan(this.camera, this.width / 2 - sx, this.height / 2 - sy)
  }

  // ---- drawing ----

  requestRender(moving = false): void {
    if (!moving) this.snapshot = null
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (moving && this.snapshot) this.renderSnapshot()
      else {
        const started = performance.now()
        this.render()
        // Pages too full to redraw every frame: move a picture of them while the fingers move.
        if (moving) {
          this.slowFrames = performance.now() - started > 14 ? this.slowFrames + 1 : 0
          if (this.slowFrames >= 2) this.takeSnapshot()
        }
      }
    })
  }

  private takeSnapshot(): void {
    const canvas = document.createElement('canvas')
    canvas.width = this.baseCanvas.width
    canvas.height = this.baseCanvas.height
    canvas.getContext('2d')!.drawImage(this.baseCanvas, 0, 0)
    this.snapshot = { canvas, camera: { ...this.camera } }
  }

  private renderSnapshot(): void {
    const snap = this.snapshot!
    const ctx = this.base
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = this.dark ? BACKDROP_DARK : BACKDROP_LIGHT
    ctx.fillRect(0, 0, this.baseCanvas.width, this.baseCanvas.height)
    // The transform taking the old screen to the new one.
    const a = this.camera
    const b = snap.camera
    const k = a.scale / b.scale
    const turn = a.rotation - b.rotation
    const cos = Math.cos(turn) * k
    const sin = Math.sin(turn) * k
    const origin = toScreen(a, toDoc(b, [0, 0]))
    ctx.setTransform(cos, sin, -sin, cos, origin[0] * this.dpr, origin[1] * this.dpr)
    ctx.drawImage(snap.canvas, 0, 0)
    this.renderOverlay()
  }

  render(): void {
    const ctx = this.base
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = this.dark ? BACKDROP_DARK : BACKDROP_LIGHT
    ctx.fillRect(0, 0, this.baseCanvas.width, this.baseCanvas.height)
    const view = visibleDocBounds(this.camera, this.width, this.height, 8)
    const m = matrix(this.camera, this.dpr)
    this.slots.forEach((slot, i) => {
      const page = this.pages[i]!
      if (!boundsOverlap(view, { minX: slot.x, minY: slot.y, maxX: slot.x + slot.width, maxY: slot.y + slot.height })) return
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.translate(slot.x, slot.y)
      this.paintPage(ctx, page, slot, view)
    })
    this.renderOverlay()
  }

  /** Paints one page (context already at the page's origin). */
  private paintPage(ctx: CanvasRenderingContext2D, page: Page, slot: PageSlot, view: Bounds): void {
    const local: Bounds = { minX: view.minX - slot.x, minY: view.minY - slot.y, maxX: view.maxX - slot.x, maxY: view.maxY - slot.y }
    if (page.size !== 'infinite') {
      // A soft edge so the page reads as a sheet.
      ctx.fillStyle = this.dark ? 'rgba(0,0,0,.45)' : 'rgba(60,50,30,.10)'
      ctx.fillRect(-1.5 / this.camera.scale, -1 / this.camera.scale, page.width + 3 / this.camera.scale, page.height + 4 / this.camera.scale)
    }
    drawPaper(ctx, page, local, this.camera.scale)
    const template = templateById(page.template)
    if (template) drawTemplate(ctx, template, page.width, page.color, this.camera.scale)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, page.width, page.height)
    ctx.clip()
    if (page.background) {
      const picture = this.cache.picture(page.background.assetId)
      if (picture) ctx.drawImage(picture, 0, 0, page.width, page.height)
    }
    for (const item of this.itemsOn(page.id)) {
      if (this.hidden.has(item.id)) continue
      if (!boundsOverlap(local, itemBounds(item, this.cache))) continue
      const later = this.audioFilter && item.audio?.recordingId === this.audioFilter.recordingId && item.audio.at > this.audioFilter.at
      if (later) ctx.globalAlpha = 0.18
      paintItem(ctx, item, this.cache, page.color)
      if (later) ctx.globalAlpha = 1
    }
    ctx.restore()
  }

  /** Paints one item onto the page canvas without a full redraw (it's on top of everything). */
  private paintOnTop(item: Item): void {
    const index = this.pages.findIndex((p) => p.id === item.pageId)
    const slot = this.slots[index]
    const page = this.pages[index]
    if (!slot || !page || this.snapshot) {
      this.requestRender()
      return
    }
    const ctx = this.base
    const m = matrix(this.camera, this.dpr)
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.translate(slot.x, slot.y)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, page.width, page.height)
    ctx.clip()
    paintItem(ctx, item, this.cache, page.color)
    ctx.restore()
  }

  /** The wet canvas: the line being drawn, the eraser ring, and tool marks. */
  private renderOverlay(): void {
    const ctx = this.wet
    const live = this.live
    if (live && isBrush(live.data.tool)) {
      // Brushes build up stamp by stamp, so their canvas isn't cleared while drawing.
      const m = matrix(this.camera, this.dpr)
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.translate(live.slot.x, live.slot.y)
      if (live.data.tool === 'watercolor') {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, this.wetCanvas.width, this.wetCanvas.height)
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
        ctx.translate(live.slot.x, live.slot.y)
      }
      paintBrushLive(ctx, live.data, live.page.color, live.drawnUpTo)
      live.drawnUpTo = live.data.points.length
      return
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.wetCanvas.width, this.wetCanvas.height)
    if (live) {
      const m = matrix(this.camera, this.dpr)
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.translate(live.slot.x, live.slot.y)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, live.page.width, live.page.height)
      ctx.clip()
      const preview: Item<'stroke'> = {
        id: '__live',
        pageId: live.page.id,
        notebookId: this.notebookId,
        kind: 'stroke',
        z: 0,
        data: live.shaped ? live.data : { ...live.data, points: live.data.points.concat(live.predicted) },
        createdAt: 0,
        updatedAt: performance.now(),
        deletedAt: null
      }
      this.cache.forget('__live')
      paintItem(ctx, preview, this.cache, live.page.color)
      ctx.restore()
    }
    if (this.eraserAt && this.tools.tool === 'eraser') {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.beginPath()
      ctx.arc(this.eraserAt[0], this.eraserAt[1], this.tools.eraser.size, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,.35)'
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(60,60,60,.55)'
      ctx.stroke()
    }
    const handler = this.handlers[this.tools.tool]
    if (handler?.overlay) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      handler.overlay(ctx)
    }
  }

  requestOverlay(): void {
    if (this.wetFrame) return
    this.wetFrame = requestAnimationFrame(() => {
      this.wetFrame = 0
      this.renderOverlay()
    })
  }

  // ---- pointer input ----

  private screenPoint(e: PointerEvent): Vec {
    const rect = this.wetCanvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  /** The page under a screen point, and the point in that page's coordinates. */
  pageAt(screen: Vec, anyPage = false): PagePoint | null {
    const doc = toDoc(this.camera, screen)
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!
      const inside = doc[0] >= slot.x && doc[0] <= slot.x + slot.width && doc[1] >= slot.y && doc[1] <= slot.y + slot.height
      if (inside || (anyPage && i === this.currentPageIndex())) return { page: this.pages[i]!, slot, x: doc[0] - slot.x, y: doc[1] - slot.y, doc, screen }
    }
    return null
  }

  /** The same page, for a point that may have left it (a line can run past the edge). */
  private onPage(slot: PageSlot, page: Page, screen: Vec): PagePoint {
    const doc = toDoc(this.camera, screen)
    return { page, slot, x: doc[0] - slot.x, y: doc[1] - slot.y, doc, screen }
  }

  private drawsWith(e: PointerEvent): boolean {
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true
    return this.tools.fingerDraws && !this.penSeen
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'pen') this.penSeen = true
    if (e.pointerType === 'touch' && (this.live || this.erase || this.handlerPointer !== null)) return
    if (this.drawsWith(e) && e.button <= 0 && this.touches.size === 0) {
      // A pen down ends any finger gesture: a palm that landed first must not move the page.
      if (e.pointerType === 'pen') this.endTouches()
      cancelAnimationFrame(this.momentum)
      const screen = this.screenPoint(e)
      const tool = this.tools.tool
      const handler = this.handlers[tool]
      if (handler) {
        const at = this.pageAt(screen, true)
        if (at && handler.down(at, e)) {
          this.handlerPointer = e.pointerId
          this.capture(e.pointerId)
          this.requestOverlay()
        }
        return
      }
      if (tool === 'eraser') {
        this.erase = { pointerId: e.pointerId, last: null, changes: new Map() }
        this.capture(e.pointerId)
        this.eraseTo(screen)
        return
      }
      if (isInk(tool)) {
        const at = this.pageAt(screen)
        if (!at) return
        this.capture(e.pointerId)
        this.startStroke(e, at)
      }
      return
    }
    if (e.pointerType !== 'touch' && e.pointerType !== 'mouse') return
    cancelAnimationFrame(this.momentum)
    this.rotationSpring = null
    const [x, y] = this.screenPoint(e)
    this.touches.set(e.pointerId, { x, y, startX: x, startY: y, time: performance.now() })
    if (this.touches.size === 1) {
      this.gestureStart = performance.now()
      this.gestureMoved = 0
      this.maxTouches = 1
      this.velocity = [0, 0]
    }
    this.maxTouches = Math.max(this.maxTouches, this.touches.size)
    this.capture(e.pointerId)
  }

  private readonly onMove = (e: PointerEvent): void => {
    if (this.live && e.pointerId === this.live.pointerId) {
      this.extendStroke(e)
      return
    }
    if (this.erase && e.pointerId === this.erase.pointerId) {
      this.eraseTo(this.screenPoint(e))
      return
    }
    if (this.handlerPointer === e.pointerId) {
      const handler = this.handlers[this.tools.tool]
      const at = this.pageAt(this.screenPoint(e), true)
      if (handler && at) handler.move(at, e)
      this.requestOverlay()
      return
    }
    const touch = this.touches.get(e.pointerId)
    if (!touch) return
    const [x, y] = this.screenPoint(e)
    const before = new Map([...this.touches].map(([id, t]) => [id, [t.x, t.y] as Vec]))
    touch.x = x
    touch.y = y
    this.gestureMoved = Math.max(this.gestureMoved, Math.hypot(x - touch.startX, y - touch.startY))
    const ids = [...this.touches.keys()]
    if (ids.length === 1) {
      const prev = before.get(e.pointerId)!
      const dx = x - prev[0]
      const dy = y - prev[1]
      const now = performance.now()
      const dt = Math.max(1, now - this.lastPanAt)
      this.lastPanAt = now
      this.velocity = [this.velocity[0] * 0.6 + (dx / dt) * 0.4 * 16, this.velocity[1] * 0.6 + (dy / dt) * 0.4 * 16]
      this.camera = pan(this.camera, dx, dy)
    } else {
      const [a, b] = ids
      const a0 = before.get(a!)!
      const b0 = before.get(b!)!
      const ta = this.touches.get(a!)!
      const tb = this.touches.get(b!)!
      this.camera = pinch(this.camera, a0, b0, [ta.x, ta.y], [tb.x, tb.y], !this.tools.rotationLocked)
      this.velocity = [0, 0]
    }
    this.cameraMoved()
  }

  private readonly onUp = (e: PointerEvent): void => {
    if (this.live && e.pointerId === this.live.pointerId) {
      this.extendStroke(e)
      this.finishStroke()
      return
    }
    if (this.erase && e.pointerId === this.erase.pointerId) {
      this.finishErase()
      return
    }
    if (this.handlerPointer === e.pointerId) {
      this.handlerPointer = null
      const handler = this.handlers[this.tools.tool]
      const at = this.pageAt(this.screenPoint(e), true)
      if (handler && at) handler.up(at, e)
      this.requestOverlay()
      return
    }
    if (!this.touches.has(e.pointerId)) return
    this.touches.delete(e.pointerId)
    if (this.touches.size > 0) return
    const quick = performance.now() - this.gestureStart < 320 && this.gestureMoved < 12
    if (quick && this.maxTouches === 1 && this.onTap) {
      const at = this.pageAt(this.screenPoint(e))
      if (at && this.onTap(at)) {
        this.settle()
        return
      }
    }
    if (quick && this.maxTouches === 2) this.undo()
    else if (quick && this.maxTouches === 3) this.redo()
    else if (this.maxTouches === 1 && Math.hypot(...this.velocity) > 0.6) this.glide()
    else this.settle()
  }

  private readonly onCancel = (e: PointerEvent): void => {
    if (this.live && e.pointerId === this.live.pointerId) this.cancelLive()
    if (this.erase && e.pointerId === this.erase.pointerId) this.finishErase()
    if (this.handlerPointer === e.pointerId) {
      this.handlers[this.tools.tool]?.cancel()
      this.handlerPointer = null
    }
    this.touches.delete(e.pointerId)
    if (this.touches.size === 0) this.settle()
  }

  /** Keeps getting a pointer's moves even when it leaves the canvas (ignored for synthetic pointers). */
  private capture(pointerId: number): void {
    try {
      this.wetCanvas.setPointerCapture(pointerId)
    } catch {
      // Not an active pointer (a test or an already lifted pen): nothing to capture.
    }
  }

  private endTouches(): void {
    if (this.touches.size === 0) return
    this.touches.clear()
    this.settle()
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    cancelAnimationFrame(this.momentum)
    if (e.ctrlKey || e.metaKey) this.camera = zoomAt(this.camera, this.screenPoint(e as unknown as PointerEvent), Math.exp(-e.deltaY * 0.01))
    else this.camera = pan(this.camera, -e.deltaX, -e.deltaY)
    this.cameraMoved()
    clearTimeout((this as unknown as { wheelTimer?: number }).wheelTimer)
    ;(this as unknown as { wheelTimer?: number }).wheelTimer = window.setTimeout(() => this.settle(), 140)
  }

  /** Lets the page keep sliding after a flick, slowing like iOS scrolling. */
  private glide(): void {
    let [vx, vy] = this.velocity
    let last = performance.now()
    const step = (now: number): void => {
      const dt = Math.min(48, now - last)
      last = now
      const decay = Math.pow(0.95, dt / 16)
      vx *= decay
      vy *= decay
      this.camera = pan(this.camera, vx * (dt / 16), vy * (dt / 16))
      this.cameraMoved()
      if (Math.hypot(vx, vy) > 0.15) this.momentum = requestAnimationFrame(step)
      else this.settle()
    }
    this.momentum = requestAnimationFrame(step)
  }

  // ---- ink ----

  private sample(e: PointerEvent): PenSample {
    const [x, y] = this.screenPoint(e)
    return { x, y, time: e.timeStamp, pressure: e.pressure, tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0, pointerType: e.pointerType }
  }

  private startStroke(e: PointerEvent, at: PagePoint): void {
    const tool = this.tools.tool as StrokeData['tool']
    const pen = this.tools.pens[tool]
    this.live = {
      pointerId: e.pointerId,
      page: at.page,
      slot: at.slot,
      data: { tool, color: pen.color, width: pen.width, opacity: pen.opacity, points: [], seed: Math.floor(Math.random() * 1e9) },
      pressure: new PressureTracker({ devicePressure: false, speedEffect: this.tools.speedEffect, curve: this.tools.pressureCurve }),
      predicted: [],
      steady: null,
      start: e.timeStamp,
      still: null,
      shaped: false,
      drawnUpTo: 0
    }
    this.extendStroke(e)
  }

  private addPoint(live: LiveStroke, s: PenSample): void {
    // The stabiliser trails the pen a little, which irons out shakes.
    const k = this.tools.stabilizer
    const steady: Vec = live.steady ? [live.steady[0] + (s.x - live.steady[0]) * (1 - k), live.steady[1] + (s.y - live.steady[1]) * (1 - k)] : [s.x, s.y]
    live.steady = steady
    const at = this.onPage(live.slot, live.page, steady)
    let pressure = live.pressure.next(s)
    const tool = live.data.tool
    if (tool === 'pencil' || tool === 'graphite' || tool === 'charcoal' || tool === 'airbrush') {
      // On its side the pencil lays down a wider, softer line.
      pressure = Math.min(1, pressure * (1 - 0.3 * this.tools.tiltEffect) + tiltAmount(s) * this.tools.tiltEffect)
    }
    const last = live.data.points[live.data.points.length - 1]
    if (last && Math.hypot(last[0] - at.x, last[1] - at.y) < 0.35 / this.camera.scale) return
    live.data.points.push([round(at.x), round(at.y), round(pressure), Math.round(s.time - live.start)])
  }

  private extendStroke(e: PointerEvent): void {
    const live = this.live
    if (!live || live.shaped) return
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    for (const ev of events.length ? events : [e]) this.addPoint(live, this.sample(ev))
    // Only where the pen really went is drawn: no guess ahead of the tip, which would show as a
    // line that wavers near the pen and then settles.
    live.predicted = []
    this.watchStillness(live)
    this.requestOverlay()
  }

  /** Hold-to-shape: if the pen rests at the end of a line, the line is straightened into a shape. */
  private watchStillness(live: LiveStroke): void {
    if (!this.tools.holdToShape || live.data.tool === 'highlighter' || isBrush(live.data.tool)) return
    const last = live.data.points[live.data.points.length - 1]
    if (!last) return
    const now = performance.now()
    const tolerance = 4 / this.camera.scale
    if (!live.still || Math.hypot(last[0] - live.still.x, last[1] - live.still.y) > tolerance) {
      live.still = { x: last[0], y: last[1], since: now }
      clearTimeout((live as unknown as { timer?: number }).timer)
      ;(live as unknown as { timer?: number }).timer = window.setTimeout(() => {
        if (this.live !== live || live.shaped) return
        const shape = recognizeShape(live.data.points)
        if (!shape) return
        live.data = { ...live.data, points: shape.points, shape: shape.kind }
        live.shaped = true
        live.predicted = []
        navigator.vibrate?.(8)
        this.requestOverlay()
      }, 750)
    }
  }

  private finishStroke(): void {
    const live = this.live
    this.live = null
    if (!live) return
    clearTimeout((live as unknown as { timer?: number }).timer)
    live.predicted = []
    if (live.data.points.length === 0) {
      this.requestOverlay()
      return
    }
    const now = Date.now()
    const item: Item<'stroke'> = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 24),
      pageId: live.page.id,
      notebookId: this.notebookId,
      kind: 'stroke',
      z: this.nextZ(),
      data: live.data,
      audio: this.host.audioStamp(),
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    }
    if (!item.audio) delete item.audio
    this.history.push([{ id: item.id, before: null, after: item }])
    this.index(item)
    this.host.persist([item])
    this.paintOnTop(item)
    const ctx = this.wet
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.wetCanvas.width, this.wetCanvas.height)
    this.renderOverlay()
    this.host.changed()
  }

  private cancelLive(): void {
    if (!this.live) return
    clearTimeout((this.live as unknown as { timer?: number }).timer)
    this.live = null
    const ctx = this.wet
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.wetCanvas.width, this.wetCanvas.height)
    this.requestOverlay()
  }

  // ---- eraser ----

  private eraseTo(screen: Vec): void {
    const gesture = this.erase
    if (!gesture) return
    this.eraserAt = screen
    const from = gesture.last ?? screen
    gesture.last = screen
    const radius = this.tools.eraser.size / this.camera.scale
    const precise = this.tools.eraser.mode === 'precise'
    let changed = false
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!
      const page = this.pages[i]!
      const a = toDoc(this.camera, from)
      const b = toDoc(this.camera, screen)
      const ax = a[0] - slot.x
      const ay = a[1] - slot.y
      const bx = b[0] - slot.x
      const by = b[1] - slot.y
      const sweep: Bounds = { minX: Math.min(ax, bx) - radius, minY: Math.min(ay, by) - radius, maxX: Math.max(ax, bx) + radius, maxY: Math.max(ay, by) + radius }
      if (sweep.maxX < 0 || sweep.maxY < 0 || sweep.minX > page.width || sweep.minY > page.height) continue
      for (const item of [...this.itemsOn(page.id)]) {
        if (item.kind !== 'stroke' && item.kind !== 'fill') continue
        if (!boundsOverlap(sweep, itemBounds(item, this.cache))) continue
        if (item.kind === 'fill') {
          if (this.pointInFill(item as Item<'fill'>, bx, by)) changed = this.removeLive(gesture, item) || changed
          continue
        }
        const data = item.data as StrokeData
        if (!precise) {
          if (sweepHitsStroke(data, ax, ay, bx, by, radius)) changed = this.removeLive(gesture, item) || changed
          continue
        }
        const pieces = cutStroke(data, bx, by, radius)
        if (!pieces) continue
        changed = this.removeLive(gesture, item) || changed
        for (const points of pieces) {
          const piece: Item<'stroke'> = { ...(item as Item<'stroke'>), id: crypto.randomUUID().replace(/-/g, '').slice(0, 24), data: { ...data, points }, updatedAt: Date.now() }
          gesture.changes.set(piece.id, { id: piece.id, before: null, after: piece })
          this.index(piece)
          const list = this.items.get(piece.pageId)!
          list.sort((x, y) => x.z - y.z)
        }
      }
    }
    if (changed) this.requestRender()
    else this.requestOverlay()
  }

  private pointInFill(item: Item<'fill'>, x: number, y: number): boolean {
    // Even-odd over all rings, in page space (independent of any canvas transform).
    let inside = false
    for (const ring of item.data.rings) if (pointInPolygon(x, y, ring)) inside = !inside
    return inside
  }

  private removeLive(gesture: EraseGesture, item: Item): boolean {
    const list = this.items.get(item.pageId)
    if (!list) return false
    this.items.set(item.pageId, list.filter((i) => i.id !== item.id))
    this.byId.delete(item.id)
    this.cache.forget(item.id)
    const existing = gesture.changes.get(item.id)
    if (existing) {
      // A piece made earlier in this same swipe: it simply never existed.
      if (existing.before === null) gesture.changes.delete(item.id)
      else existing.after = null
    } else gesture.changes.set(item.id, { id: item.id, before: item, after: null })
    return true
  }

  private finishErase(): void {
    const gesture = this.erase
    this.erase = null
    this.eraserAt = null
    if (!gesture) return
    const changes = [...gesture.changes.values()]
    if (changes.length) {
      this.history.push(changes)
      const now = Date.now()
      this.host.persist(changes.map((c) => (c.after ? { ...c.after, updatedAt: now } : { ...c.before!, deletedAt: now, updatedAt: now })))
    }
    this.requestRender()
    this.host.changed()
  }

  /** Adds new items (undoable). */
  addItems(items: Item[]): void {
    this.commit(items.map((item) => ({ id: item.id, before: null, after: item })))
  }

  /** Replaces items with changed versions (undoable). */
  updateItems(pairs: Array<{ before: Item; after: Item }>): void {
    this.commit(pairs.map(({ before, after }) => ({ id: before.id, before, after })))
  }

  removeItems(items: Item[]): void {
    this.commit(items.map((item) => ({ id: item.id, before: item, after: null })))
  }

  /** The topmost item under a page point (lines within a few pixels count). */
  itemAt(pageId: string, x: number, y: number, kinds?: Item['kind'][]): Item | null {
    const slop = 8 / this.camera.scale
    const list = this.itemsOn(pageId)
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]!
      if (kinds && !kinds.includes(item.kind)) continue
      const b = itemBounds(item, this.cache)
      if (x < b.minX - slop || x > b.maxX + slop || y < b.minY - slop || y > b.maxY + slop) continue
      if (item.kind === 'stroke') {
        const d = item.data as StrokeData
        if (!sweepHitsStroke(d, x, y, x, y, slop)) continue
      }
      return item
    }
    return null
  }

  /** The wet canvas set up to draw in a page's coordinates (for tools drawing previews). */
  pageContext(pageId: string): CanvasRenderingContext2D | null {
    const index = this.pageIndex(pageId)
    const slot = this.slots[index]
    if (!slot) return null
    const m = matrix(this.camera, this.dpr)
    this.wet.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    this.wet.translate(slot.x, slot.y)
    return this.wet
  }

  pageById(id: string): Page | null {
    return this.pages.find((p) => p.id === id) ?? null
  }

  /** The page point at the middle of the screen. */
  centerPoint(): PagePoint | null {
    return this.pageAt([this.width / 2, this.height / 2], true)
  }

  /** The colour shown at a screen point (what the eyedropper picks). */
  colorAt(screen: Vec): string | null {
    const x = Math.round(screen[0] * this.dpr)
    const y = Math.round(screen[1] * this.dpr)
    if (x < 0 || y < 0 || x >= this.baseCanvas.width || y >= this.baseCanvas.height) return null
    const [r, g, b] = this.base.getImageData(x, y, 1, 1).data
    return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}`
  }

  /** Index of a page by id. */
  pageIndex(id: string): number {
    return this.pages.findIndex((p) => p.id === id)
  }

  /** Converts a page point to the screen. */
  pageToScreen(pageId: string, x: number, y: number): Vec {
    const slot = this.slots[this.pageIndex(pageId)]
    if (!slot) return [0, 0]
    return toScreen(this.camera, [slot.x + x, slot.y + y])
  }
}
