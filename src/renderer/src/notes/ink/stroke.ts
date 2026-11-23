/**
 * Turns a stroke's points into something to paint. Pens and pencils become a filled outline whose
 * width follows pressure (perfect-freehand); the highlighter is a flat, see-through band.
 * Outlines are cached per stroke, so redrawing a page is just filling paths.
 */
import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { InkPoint, StrokeData } from '../model'

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function boundsOf(points: ReadonlyArray<readonly [number, number, ...number[]]>, pad = 0): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

/** perfect-freehand settings per tool. */
export function freehandOptions(stroke: Pick<StrokeData, 'tool' | 'width' | 'shape'>, last: boolean): StrokeOptions {
  const shape = Boolean(stroke.shape)
  switch (stroke.tool) {
    case 'pencil':
    case 'graphite':
      return { size: stroke.width, thinning: 0.3, smoothing: 0.5, streamline: 0, simulatePressure: false, last: true, start: { taper: 0, cap: true }, end: { taper: 0, cap: true } }
    case 'marker':
      return { size: stroke.width, thinning: 0.05, smoothing: 0.5, streamline: 0, simulatePressure: false, last: true }
    default:
      return {
        size: stroke.width,
        thinning: shape ? 0.1 : 0.5,
        smoothing: 0.5,
        // No streamlining: it pulls the newest points toward older ones and lets them go a frame
        // later, so the end of the line wobbles near the pen. Points stay where they're drawn.
        streamline: 0,
        simulatePressure: false,
        last: true,
        // Round ends, like a real pen: a taper at the start shows as a sliver where the pen lands.
        start: { taper: 0, cap: true },
        end: { taper: 0, cap: true }
      }
  }
}

/**
 * A solid pen line as round-capped pieces: one smooth curve per point (from the midpoint before it
 * to the midpoint after it), each as wide as the pressure there. Pieces of about the same width
 * share a path, so a line is a handful of strokes. Unlike a filled outline, this can never fold
 * over itself and leave see-through gaps, however quickly the width changes.
 */
export function penPieces(points: InkPoint[], width: number, uniform = false): Array<{ width: number; path: Path2D }> {
  const buckets = new Map<number, Path2D>()
  const add = (w: number): Path2D => {
    const key = Math.max(0.25, Math.round(w * 4) / 4)
    let path = buckets.get(key)
    if (!path) {
      path = new Path2D()
      buckets.set(key, path)
    }
    return path
  }
  const widthAt = (p: number): number => (uniform ? width : width * (0.55 + 0.9 * Math.min(1, Math.max(0, p))))
  const n = points.length
  if (n === 0) return []
  if (n === 1) {
    const [x, y, p] = points[0]!
    const path = add(widthAt(p))
    path.moveTo(x, y)
    path.lineTo(x + 0.01, y)
  }
  for (let i = 0; n > 1 && i < n; i++) {
    const c = points[i]!
    const prev = points[i - 1]
    const next = points[i + 1]
    const ax = prev ? (prev[0] + c[0]) / 2 : c[0]
    const ay = prev ? (prev[1] + c[1]) / 2 : c[1]
    const bx = next ? (c[0] + next[0]) / 2 : c[0]
    const by = next ? (c[1] + next[1]) / 2 : c[1]
    const path = add(widthAt(c[2]))
    path.moveTo(ax, ay)
    path.quadraticCurveTo(c[0], c[1], bx, by)
  }
  return [...buckets].map(([w, path]) => ({ width: w, path }))
}

/** The outline polygon as a smooth closed path. */
export function outlinePath(outline: number[][]): Path2D {
  const path = new Path2D()
  const n = outline.length
  if (n < 2) return path
  const [x0, y0] = outline[0]!
  path.moveTo(x0!, y0!)
  for (let i = 1; i < n; i++) {
    const [ax, ay] = outline[i]!
    const [bx, by] = outline[(i + 1) % n]!
    path.quadraticCurveTo(ax!, ay!, (ax! + bx!) / 2, (ay! + by!) / 2)
  }
  path.closePath()
  return path
}

/** A dot for a tap (a stroke with a single point). */
function dotPoints(points: InkPoint[]): InkPoint[] {
  if (points.length !== 1) return points
  const [x, y, p, t] = points[0]!
  return [points[0]!, [x + 0.1, y + 0.1, p, t + 1]]
}

export function strokeOutline(stroke: StrokeData, last = true): number[][] {
  return getStroke(dotPoints(stroke.points), freehandOptions(stroke, last))
}

/** The centre line, for tools drawn as a band (highlighter) rather than an outline. */
export function centerPath(points: InkPoint[]): Path2D {
  const path = new Path2D()
  if (points.length === 0) return path
  path.moveTo(points[0]![0], points[0]![1])
  if (points.length === 1) {
    path.lineTo(points[0]![0] + 0.1, points[0]![1])
    return path
  }
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = points[i]!
    const [bx, by] = points[i + 1]!
    path.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2)
  }
  const end = points[points.length - 1]!
  path.lineTo(end[0], end[1])
  return path
}

/** Smooths raw points a little for the highlighter, which has no pressure outline to hide jitter. */
export function steady(points: InkPoint[], amount = 0.5): InkPoint[] {
  if (points.length < 3) return points
  const out: InkPoint[] = [points[0]!]
  let [px, py] = points[0]!
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!
    px += (p[0] - px) * (1 - amount)
    py += (p[1] - py) * (1 - amount)
    out.push([px, py, p[2], p[3]])
  }
  const end = points[points.length - 1]!
  out.push([end[0], end[1], end[2], end[3]])
  return out
}
