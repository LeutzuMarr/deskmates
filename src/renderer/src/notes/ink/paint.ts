/**
 * Paints items onto a canvas context that is already in page space. Outlines and pictures are
 * cached per item, so a full redraw is mostly filling cached paths.
 */
import type { FillData, ImageData, Item, PaperColor, StickyData, StrokeData, TapeData, TextData } from '../model'
import { inkOn } from './paper'
import { boundsOf, centerPath, outlinePath, strokeOutline, type Bounds } from './stroke'
import { paintBrush, isBrush } from './brush'

interface Cached {
  version: number
  path: Path2D
  bounds: Bounds
}

const grain = new Map<string, CanvasPattern>()

/** A see-through speckle in the stroke's colour, so the pencil looks like graphite on paper. */
function pencilPattern(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | string {
  const cached = grain.get(color)
  if (cached) return cached
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const c = canvas.getContext('2d')
  if (!c) return color
  c.fillStyle = color
  c.fillRect(0, 0, size, size)
  const image = c.getImageData(0, 0, size, size)
  let seed = 1234567
  for (let i = 3; i < image.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647
    const r = seed / 2147483647
    image.data[i] = Math.round(255 * (r < 0.18 ? 0.15 : 0.55 + r * 0.45))
  }
  c.putImageData(image, 0, 0)
  const pattern = ctx.createPattern(canvas, 'repeat')
  if (!pattern) return color
  pattern.setTransform(new DOMMatrix().scale(0.5))
  grain.set(color, pattern)
  return pattern
}

export class InkCache {
  private readonly items = new Map<string, Cached>()
  private readonly pictures = new Map<string, ImageBitmap | HTMLImageElement | 'loading' | 'missing'>()

  constructor(
    private readonly loadAsset: (id: string) => Promise<Blob | null>,
    private readonly onPictureReady: () => void
  ) {}

  forget(id: string): void {
    this.items.delete(id)
  }

  clear(): void {
    this.items.clear()
  }

  strokePath(item: Item<'stroke'>): Cached {
    const hit = this.items.get(item.id)
    if (hit && hit.version === item.updatedAt) return hit
    const data = item.data
    const path = data.tool === 'highlighter' ? centerPath(data.points) : outlinePath(strokeOutline(data))
    const cached = { version: item.updatedAt, path, bounds: boundsOf(data.points, data.width) }
    this.items.set(item.id, cached)
    return cached
  }

  picture(assetId: string): ImageBitmap | HTMLImageElement | null {
    const hit = this.pictures.get(assetId)
    if (hit && hit !== 'loading' && hit !== 'missing') return hit
    if (!hit) {
      this.pictures.set(assetId, 'loading')
      void this.loadAsset(assetId).then(async (blob) => {
        if (!blob) {
          this.pictures.set(assetId, 'missing')
          return
        }
        try {
          // SVG stickers need an <img> to keep their size; everything else decodes off the main thread.
          if (blob.type === 'image/svg+xml') {
            const img = new Image()
            img.src = URL.createObjectURL(blob)
            await img.decode()
            this.pictures.set(assetId, img)
          } else this.pictures.set(assetId, await createImageBitmap(blob))
        } catch {
          this.pictures.set(assetId, 'missing')
        }
        this.onPictureReady()
      })
    }
    return null
  }
}

/** An item's bounds in page space (for culling and selection). */
export function itemBounds(item: Item, cache: InkCache): Bounds {
  switch (item.kind) {
    case 'stroke':
      return cache.strokePath(item as Item<'stroke'>).bounds
    case 'text': {
      const d = item.data as TextData
      const lines = Math.max(1, d.text.split('\n').length)
      return { minX: d.x, minY: d.y, maxX: d.x + d.width, maxY: d.y + lines * d.size * 1.35 + d.size }
    }
    case 'image':
    case 'sticker':
    case 'sticky': {
      const d = item.data as ImageData | StickyData
      const r = Math.hypot(d.width, d.height) / 2
      const cx = d.x + d.width / 2
      const cy = d.y + d.height / 2
      return d.rotation ? { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r } : { minX: d.x, minY: d.y, maxX: d.x + d.width, maxY: d.y + d.height }
    }
    case 'tape': {
      const d = item.data as TapeData
      return boundsOf([[d.x1, d.y1], [d.x2, d.y2]], d.width / 2)
    }
    case 'fill':
      return boundsOf((item.data as FillData).rings.flat())
  }
}

const FONTS: Record<TextData['font'], string> = {
  sans: "'Instrument Sans Variable', system-ui, sans-serif",
  serif: "'Newsreader Variable', Georgia, serif",
  mono: 'ui-monospace, Menlo, monospace',
  hand: "'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive"
}

export function fontFor(d: Pick<TextData, 'font' | 'size' | 'bold'>): string {
  return `${d.bold ? 600 : 400} ${d.size}px ${FONTS[d.font]}`
}

/** Splits text into lines that fit the box. */
export function wrapText(ctx: CanvasRenderingContext2D, d: TextData): string[] {
  ctx.font = fontFor(d)
  const out: string[] = []
  for (const paragraph of d.text.split('\n')) {
    const words = paragraph.split(/(\s+)/)
    let line = ''
    for (const word of words) {
      const candidate = line + word
      if (line && ctx.measureText(candidate).width > d.width) {
        out.push(line.trimEnd())
        line = word.trimStart()
      } else line = candidate
    }
    out.push(line)
  }
  return out
}

function paintText(ctx: CanvasRenderingContext2D, d: TextData, paper: PaperColor): void {
  ctx.fillStyle = inkOn(paper, d.color)
  ctx.textBaseline = 'top'
  const lines = wrapText(ctx, d)
  lines.forEach((line, i) => ctx.fillText(line, d.x, d.y + i * d.size * 1.35))
}

function withRotation(ctx: CanvasRenderingContext2D, d: { x: number; y: number; width: number; height: number; rotation: number }, draw: () => void): void {
  if (!d.rotation) {
    draw()
    return
  }
  ctx.save()
  const cx = d.x + d.width / 2
  const cy = d.y + d.height / 2
  ctx.translate(cx, cy)
  ctx.rotate(d.rotation)
  ctx.translate(-cx, -cy)
  draw()
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

export function paintItem(ctx: CanvasRenderingContext2D, item: Item, cache: InkCache, paper: PaperColor): void {
  switch (item.kind) {
    case 'stroke': {
      const d = item.data as StrokeData
      if (isBrush(d.tool)) {
        paintBrush(ctx, d, paper)
        return
      }
      const { path } = cache.strokePath(item as Item<'stroke'>)
      const color = inkOn(paper, d.color)
      if (d.tool === 'highlighter') {
        ctx.save()
        ctx.globalAlpha = d.opacity ?? 0.38
        ctx.globalCompositeOperation = paper === 'dark' ? 'screen' : 'multiply'
        ctx.strokeStyle = color
        ctx.lineWidth = d.width
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke(path)
        ctx.restore()
        return
      }
      if (d.tool === 'pencil') {
        ctx.save()
        ctx.globalAlpha = d.opacity ?? 0.9
        ctx.fillStyle = pencilPattern(ctx, color)
        ctx.fill(path)
        ctx.restore()
        return
      }
      if (d.opacity !== undefined && d.opacity < 1) {
        ctx.save()
        ctx.globalAlpha = d.opacity
        ctx.fillStyle = color
        ctx.fill(path)
        ctx.restore()
        return
      }
      ctx.fillStyle = color
      ctx.fill(path)
      return
    }
    case 'text':
      paintText(ctx, item.data as TextData, paper)
      return
    case 'image':
    case 'sticker': {
      const d = item.data as ImageData
      const picture = cache.picture(d.assetId)
      withRotation(ctx, d, () => {
        if (picture) ctx.drawImage(picture, d.x, d.y, d.width, d.height)
        else {
          ctx.fillStyle = 'rgba(128,128,128,.12)'
          ctx.fillRect(d.x, d.y, d.width, d.height)
        }
      })
      return
    }
    case 'sticky': {
      const d = item.data as StickyData
      withRotation(ctx, d, () => {
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,.16)'
        ctx.shadowBlur = 10
        ctx.shadowOffsetY = 3
        ctx.fillStyle = d.color
        roundRect(ctx, d.x, d.y, d.width, d.height, 4)
        ctx.fill()
        ctx.restore()
        paintText(ctx, { x: d.x + 14, y: d.y + 14, width: d.width - 28, text: d.text, size: 17, color: '#2b2a28', font: 'hand' }, 'white')
      })
      return
    }
    case 'tape': {
      const d = item.data as TapeData
      const angle = Math.atan2(d.y2 - d.y1, d.x2 - d.x1)
      const length = Math.hypot(d.x2 - d.x1, d.y2 - d.y1)
      ctx.save()
      ctx.translate(d.x1, d.y1)
      ctx.rotate(angle)
      ctx.globalAlpha = d.revealed ? 0.22 : 1
      ctx.fillStyle = d.color
      // Torn-looking ends.
      const h = d.width / 2
      ctx.beginPath()
      ctx.moveTo(0, -h)
      ctx.lineTo(length, -h)
      for (let i = 0; i <= 6; i++) ctx.lineTo(length + (i % 2 ? 3 : -2), -h + (i * d.width) / 6)
      ctx.lineTo(0, h)
      for (let i = 6; i >= 0; i--) ctx.lineTo(i % 2 ? -3 : 2, -h + (i * d.width) / 6)
      ctx.closePath()
      ctx.fill()
      if (!d.revealed) {
        ctx.globalAlpha = 0.18
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1
        for (let x = 8; x < length; x += 14) {
          ctx.beginPath()
          ctx.moveTo(x, -h)
          ctx.lineTo(x - 8, h)
          ctx.stroke()
        }
      }
      ctx.restore()
      return
    }
    case 'fill': {
      const d = item.data as FillData
      const path = new Path2D()
      for (const ring of d.rings) {
        ring.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)))
        path.closePath()
      }
      ctx.fillStyle = inkOn(paper, d.color)
      ctx.fill(path, 'evenodd')
      return
    }
  }
}
