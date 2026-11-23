/**
 * The eraser's geometry: whether a circle touches a stroke, and cutting a stroke where the circle
 * passed (for the precise eraser).
 */
import type { InkPoint, StrokeData } from '../model'

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Half the drawn width at a point. */
function halfWidth(stroke: StrokeData, p: InkPoint): number {
  if (stroke.tool === 'highlighter') return stroke.width / 2
  return (stroke.width * (0.4 + 0.6 * p[2])) / 2
}

export function circleHitsStroke(stroke: StrokeData, cx: number, cy: number, r: number): boolean {
  const pts = stroke.points
  if (pts.length === 1) return Math.hypot(pts[0]![0] - cx, pts[0]![1] - cy) <= r + halfWidth(stroke, pts[0]!)
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    if (distanceToSegment(cx, cy, a[0], a[1], b[0], b[1]) <= r + halfWidth(stroke, a)) return true
  }
  return false
}

/** Does the eraser's path from (ax, ay) to (bx, by) touch the stroke? Checked in small steps. */
export function sweepHitsStroke(stroke: StrokeData, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r)))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (circleHitsStroke(stroke, ax + (bx - ax) * t, ay + (by - ay) * t, r)) return true
  }
  return false
}

/**
 * Cuts out the part of a stroke under the circle. Returns the pieces left (each long enough to
 * keep), or null if the circle didn't touch it.
 */
export function cutStroke(stroke: StrokeData, cx: number, cy: number, r: number): InkPoint[][] | null {
  // Add points along long segments so the cut lands near the circle's edge.
  const dense: InkPoint[] = []
  const pts = stroke.points
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    dense.push(a)
    const b = pts[i + 1]
    if (!b) break
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.floor(len / Math.max(1, r / 2))
    for (let k = 1; k < n; k++) {
      const t = k / n
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t])
    }
  }
  const pieces: InkPoint[][] = []
  let current: InkPoint[] = []
  let touched = false
  for (const p of dense) {
    if (Math.hypot(p[0] - cx, p[1] - cy) <= r + halfWidth(stroke, p) * 0.5) {
      touched = true
      if (current.length) pieces.push(current)
      current = []
    } else current.push(p)
  }
  if (current.length) pieces.push(current)
  if (!touched) return null
  return pieces.filter((piece) => piece.length >= 2 || (pts.length === 1 && piece.length === 1))
}
