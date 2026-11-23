/**
 * Moving, resizing and turning items (the lasso). A transform is a similarity: turn by `angle` and
 * scale by `scale` about `origin`, then shift by (dx, dy). Everything is in page space.
 */
import type { FillData, ImageData, InkPoint, Item, StickyData, StrokeData, TapeData, TextData } from '../model'
import type { Bounds } from '../ink/stroke'

export interface Similarity {
  origin: [number, number]
  scale: number
  angle: number
  dx: number
  dy: number
}

export const IDENTITY: Similarity = { origin: [0, 0], scale: 1, angle: 0, dx: 0, dy: 0 }

export function apply(t: Similarity, x: number, y: number): [number, number] {
  const cos = Math.cos(t.angle) * t.scale
  const sin = Math.sin(t.angle) * t.scale
  const px = x - t.origin[0]
  const py = y - t.origin[1]
  return [t.origin[0] + cos * px - sin * py + t.dx, t.origin[1] + sin * px + cos * py + t.dy]
}

function boxed<T extends { x: number; y: number; width: number; height: number; rotation: number }>(d: T, t: Similarity): T {
  const [cx, cy] = apply(t, d.x + d.width / 2, d.y + d.height / 2)
  const width = d.width * t.scale
  const height = d.height * t.scale
  return { ...d, x: cx - width / 2, y: cy - height / 2, width, height, rotation: d.rotation + t.angle }
}

/** The item after the transform (a new object; the input isn't changed). */
export function transformItem(item: Item, t: Similarity): Item {
  switch (item.kind) {
    case 'stroke': {
      const d = item.data as StrokeData
      const points = d.points.map(([x, y, p, time]): InkPoint => {
        const [nx, ny] = apply(t, x, y)
        return [Math.round(nx * 100) / 100, Math.round(ny * 100) / 100, p, time]
      })
      return { ...item, data: { ...d, points, width: Math.round(d.width * t.scale * 100) / 100 } }
    }
    case 'text': {
      const d = item.data as TextData
      // Text stays level; it moves and grows with the selection.
      const [x, y] = apply(t, d.x, d.y)
      return { ...item, data: { ...d, x, y, width: d.width * t.scale, size: Math.round(d.size * t.scale * 10) / 10 } }
    }
    case 'image':
    case 'sticker':
      return { ...item, data: boxed(item.data as ImageData, t) }
    case 'sticky':
      return { ...item, data: boxed(item.data as StickyData, t) }
    case 'tape': {
      const d = item.data as TapeData
      const [x1, y1] = apply(t, d.x1, d.y1)
      const [x2, y2] = apply(t, d.x2, d.y2)
      return { ...item, data: { ...d, x1, y1, x2, y2, width: d.width * t.scale } }
    }
    case 'fill': {
      const d = item.data as FillData
      return { ...item, data: { ...d, rings: d.rings.map((ring) => ring.map(([x, y]) => apply(t, x, y))) } }
    }
  }
}

/** Changes an item's colour (ink, text, sticky note background, tape, fill). */
export function recolorItem(item: Item, color: string): Item {
  switch (item.kind) {
    case 'stroke':
    case 'text':
    case 'tape':
    case 'fill':
      return { ...item, data: { ...(item.data as StrokeData), color } } as Item
    case 'sticky':
      return { ...item, data: { ...(item.data as StickyData), color } }
    default:
      return item
  }
}

export function pointInPolygon(x: number, y: number, polygon: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!
    const [xj, yj] = polygon[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Whether the lasso takes an item: most of a line's points, or the middle of anything else. */
export function lassoTakes(item: Item, polygon: Array<[number, number]>, bounds: Bounds): boolean {
  if (item.kind === 'stroke') {
    const pts = (item.data as StrokeData).points
    let inside = 0
    for (const p of pts) if (pointInPolygon(p[0], p[1], polygon)) inside++
    return inside / Math.max(1, pts.length) > 0.5
  }
  return pointInPolygon((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, polygon)
}

export type Quad = [[number, number], [number, number], [number, number], [number, number]]

/** Maps a point of the box onto a four-cornered shape (top-left, top-right, bottom-right, bottom-left). */
export function warpPoint(b: Bounds, q: Quad, x: number, y: number): [number, number] {
  const u = (x - b.minX) / (b.maxX - b.minX || 1)
  const v = (y - b.minY) / (b.maxY - b.minY || 1)
  const [tl, tr, br, bl] = q
  return [
    (1 - u) * (1 - v) * tl[0] + u * (1 - v) * tr[0] + u * v * br[0] + (1 - u) * v * bl[0],
    (1 - u) * (1 - v) * tl[1] + u * (1 - v) * tr[1] + u * v * br[1] + (1 - u) * v * bl[1]
  ]
}

/** Bends an item from the box `b` onto the shape `q` (the lasso's distort). */
export function warpItem(item: Item, b: Bounds, q: Quad): Item {
  const map = (x: number, y: number): [number, number] => warpPoint(b, q, x, y)
  switch (item.kind) {
    case 'stroke': {
      const d = item.data as StrokeData
      return { ...item, data: { ...d, points: d.points.map(([x, y, p, t]): InkPoint => [...map(x, y), p, t] as InkPoint) } }
    }
    case 'tape': {
      const d = item.data as TapeData
      const [x1, y1] = map(d.x1, d.y1)
      const [x2, y2] = map(d.x2, d.y2)
      return { ...item, data: { ...d, x1, y1, x2, y2 } }
    }
    case 'fill': {
      const d = item.data as FillData
      return { ...item, data: { ...d, rings: d.rings.map((ring) => ring.map(([x, y]) => map(x, y))) } }
    }
    case 'text': {
      const d = item.data as TextData
      const [x, y] = map(d.x, d.y)
      return { ...item, data: { ...d, x, y } }
    }
    default: {
      // Pictures and notes keep their shape: they take the box their corners land in.
      const d = item.data as ImageData
      const corners = [map(d.x, d.y), map(d.x + d.width, d.y), map(d.x + d.width, d.y + d.height), map(d.x, d.y + d.height)]
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      return { ...item, data: { ...d, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } } as Item
    }
  }
}
