/**
 * The advanced mode's textured brushes (graphite, charcoal, airbrush, watercolour). Each is made of
 * small "stamps" laid along the line, with grain from a random sequence seeded per stroke, so a
 * stroke looks the same every time it's drawn. A finished stroke is drawn once into its own small
 * picture and reused after that.
 */
import type { InkPoint, PaperColor, PenTool, StrokeData } from '../model'
import { inkOn } from './paper'
import { boundsOf, outlinePath, strokeOutline } from './stroke'

const BRUSHES: ReadonlySet<PenTool> = new Set(['graphite', 'charcoal', 'airbrush', 'watercolor'])

export function isBrush(tool: PenTool): boolean {
  return BRUSHES.has(tool)
}

function random(seed: number): () => number {
  let s = seed % 2147483647 || 1
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

const tips = new Map<string, HTMLCanvasElement>()

/** A brush tip in the given colour, drawn once at 64 px. */
function tip(tool: PenTool, color: string): HTMLCanvasElement {
  const key = `${tool}|${color}`
  const hit = tips.get(key)
  if (hit) return hit
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const c = canvas.getContext('2d')!
  const r = size / 2
  if (tool === 'airbrush') {
    const g = c.createRadialGradient(r, r, 0, r, r, r)
    g.addColorStop(0, color)
    g.addColorStop(1, 'transparent')
    c.globalAlpha = 0.5
    c.fillStyle = g
    c.fillRect(0, 0, size, size)
  } else {
    const rand = random(tool === 'charcoal' ? 99 : 7)
    c.fillStyle = color
    const grains = tool === 'charcoal' ? 260 : 420
    for (let i = 0; i < grains; i++) {
      const a = rand() * Math.PI * 2
      const d = Math.sqrt(rand()) * r * (tool === 'charcoal' ? 0.95 : 0.8)
      const s = tool === 'charcoal' ? 1 + rand() * 3.2 : 0.8 + rand() * 1.4
      c.globalAlpha = tool === 'charcoal' ? 0.25 + rand() * 0.6 : 0.3 + rand() * 0.5
      c.fillRect(r + Math.cos(a) * d, r + Math.sin(a) * d, s, s)
    }
  }
  tips.set(key, canvas)
  return canvas
}

const SETTINGS: Record<string, { spacing: number; flow: number; jitter: number }> = {
  graphite: { spacing: 0.12, flow: 0.55, jitter: 0.08 },
  charcoal: { spacing: 0.18, flow: 0.7, jitter: 0.25 },
  airbrush: { spacing: 0.08, flow: 0.12, jitter: 0 }
}

/** Lays stamps along the points (page space) onto the context. */
export function stampAlong(ctx: CanvasRenderingContext2D, data: StrokeData, color: string, points: InkPoint[] = data.points): void {
  const s = SETTINGS[data.tool] ?? SETTINGS.graphite!
  const image = tip(data.tool, color)
  const rand = random(data.seed ?? 1)
  const opacity = data.opacity ?? 1
  let carry = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[i + 1] ?? a
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    const size0 = Math.max(0.8, data.width * (0.35 + a[2] * 0.65))
    const step = Math.max(0.4, size0 * s.spacing)
    let t = carry
    while (t <= length || (length === 0 && t === 0)) {
      const f = length === 0 ? 0 : t / length
      const p = a[2] + (b[2] - a[2]) * f
      const size = Math.max(0.8, data.width * (0.35 + p * 0.65))
      const jx = (rand() - 0.5) * size * s.jitter
      const jy = (rand() - 0.5) * size * s.jitter
      ctx.globalAlpha = Math.min(1, s.flow * (0.4 + p * 0.6) * opacity)
      const x = a[0] + (b[0] - a[0]) * f + jx
      const y = a[1] + (b[1] - a[1]) * f + jy
      ctx.drawImage(image, x - size / 2, y - size / 2, size, size)
      t += step
      if (length === 0) break
    }
    carry = t - length
  }
  ctx.globalAlpha = 1
}

/** Watercolour: soft, see-through layers of the outline with a darker, pooled edge. */
function watercolor(ctx: CanvasRenderingContext2D, data: StrokeData, color: string, paper: PaperColor): void {
  const rand = random(data.seed ?? 3)
  const outline = strokeOutline({ ...data, tool: 'pen' })
  const path = outlinePath(outline)
  ctx.save()
  ctx.globalCompositeOperation = paper === 'dark' ? 'screen' : 'multiply'
  const opacity = data.opacity ?? 0.6
  for (let i = 0; i < 3; i++) {
    ctx.save()
    ctx.translate((rand() - 0.5) * data.width * 0.12, (rand() - 0.5) * data.width * 0.12)
    ctx.globalAlpha = 0.16 * opacity
    ctx.fillStyle = color
    ctx.fill(path)
    ctx.restore()
  }
  ctx.globalAlpha = 0.22 * opacity
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(0.8, data.width * 0.06)
  ctx.lineJoin = 'round'
  ctx.stroke(path)
  ctx.restore()
}

const pictures = new WeakMap<InkPoint[], { canvas: HTMLCanvasElement; x: number; y: number; scale: number; key: string }>()
/** Finished brush strokes are drawn at this many pixels per page pixel. */
const CACHE_SCALE = 2
const MAX_SIDE = 2048

function drawRaw(ctx: CanvasRenderingContext2D, data: StrokeData, paper: PaperColor): void {
  const color = inkOn(paper, data.color)
  if (data.tool === 'watercolor') watercolor(ctx, data, color, paper)
  else stampAlong(ctx, data, color)
}

/** Paints a brush stroke (context in page space), from its cached picture when it has one. */
export function paintBrush(ctx: CanvasRenderingContext2D, data: StrokeData, paper: PaperColor): void {
  const key = `${data.tool}|${data.color}|${data.width}|${data.opacity ?? ''}|${paper}`
  const hit = pictures.get(data.points)
  if (hit && hit.key === key) {
    ctx.drawImage(hit.canvas, hit.x, hit.y, hit.canvas.width / hit.scale, hit.canvas.height / hit.scale)
    return
  }
  const b = boundsOf(data.points, data.width)
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const scale = Math.min(CACHE_SCALE, MAX_SIDE / Math.max(w, h, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(w * scale))
  canvas.height = Math.max(1, Math.ceil(h * scale))
  const c = canvas.getContext('2d')
  if (!c) {
    drawRaw(ctx, data, paper)
    return
  }
  c.scale(scale, scale)
  c.translate(-b.minX, -b.minY)
  drawRaw(c, data, paper)
  pictures.set(data.points, { canvas, x: b.minX, y: b.minY, scale, key })
  ctx.drawImage(canvas, b.minX, b.minY, w, h)
}

/** Draws a brush stroke while it's being made (no caching; only the newest points are passed). */
export function paintBrushLive(ctx: CanvasRenderingContext2D, data: StrokeData, paper: PaperColor, fromIndex: number): void {
  if (data.tool === 'watercolor') {
    watercolor(ctx, data, inkOn(paper, data.color), paper)
    return
  }
  stampAlong(ctx, data, inkOn(paper, data.color), data.points.slice(Math.max(0, fromIndex - 1)))
}
