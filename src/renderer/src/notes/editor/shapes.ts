/**
 * Hold-to-shape: a hand-drawn line, angle, triangle, rectangle, polygon, circle or ellipse becomes
 * a clean one when the pen rests at the end.
 */
import type { InkPoint } from '../model'

type P = [number, number]

export interface Shape {
  kind: 'line' | 'polyline' | 'ellipse'
  points: InkPoint[]
}

function pathLength(points: P[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1])
  return length
}

function perpendicular(p: P, a: P, b: P): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(points: P[], epsilon: number): P[] {
  if (points.length < 3) return points
  let index = 0
  let max = 0
  const first = points[0]!
  const last = points[points.length - 1]!
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicular(points[i]!, first, last)
    if (d > max) {
      max = d
      index = i
    }
  }
  if (max <= epsilon) return [first, last]
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)]
}

/** Points along straight segments, so the outline stays even. */
function along(corners: P[], step: number): InkPoint[] {
  const out: InkPoint[] = []
  let t = 0
  for (let i = 0; i < corners.length - 1; i++) {
    const a = corners[i]!
    const b = corners[i + 1]!
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, 0.75, t++ * 8])
  }
  const end = corners[corners.length - 1]!
  out.push([end[0], end[1], 0.75, t * 8])
  return out
}

/** Snaps an angle to horizontal/vertical/45° when it's within a few degrees. */
function snapDirection(a: P, b: P): P {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0])
  const step = Math.PI / 4
  const snapped = Math.round(angle / step) * step
  if (Math.abs(angle - snapped) > (4 * Math.PI) / 180) return b
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  return [a[0] + Math.cos(snapped) * length, a[1] + Math.sin(snapped) * length]
}

function angleAt(a: P, b: P, c: P): number {
  const v1 = [a[0] - b[0], a[1] - b[1]]
  const v2 = [c[0] - b[0], c[1] - b[1]]
  const dot = v1[0]! * v2[0]! + v1[1]! * v2[1]!
  return Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(v1[0]!, v1[1]!) * Math.hypot(v2[0]!, v2[1]!) || 1))))
}

/** Fits an ellipse (centre, axes, angle) and says how well it fits (0 = perfect). */
function fitEllipse(points: P[]): { cx: number; cy: number; rx: number; ry: number; angle: number; error: number } {
  const n = points.length
  const cx = points.reduce((s, p) => s + p[0], 0) / n
  const cy = points.reduce((s, p) => s + p[1], 0) / n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const [x, y] of points) {
    sxx += (x - cx) ** 2
    syy += (y - cy) ** 2
    sxy += (x - cx) * (y - cy)
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  let rx = 0
  let ry = 0
  const local = points.map(([x, y]) => {
    const u = (x - cx) * cos + (y - cy) * sin
    const v = -(x - cx) * sin + (y - cy) * cos
    rx = Math.max(rx, Math.abs(u))
    ry = Math.max(ry, Math.abs(v))
    return [u, v] as P
  })
  // Use the average extent rather than the max, which a wobble would inflate.
  const ax = Math.sqrt((2 * local.reduce((s, p) => s + p[0] ** 2, 0)) / n) || rx
  const ay = Math.sqrt((2 * local.reduce((s, p) => s + p[1] ** 2, 0)) / n) || ry
  let error = 0
  for (const [u, v] of local) error += Math.abs(Math.sqrt((u / ax) ** 2 + (v / ay) ** 2) - 1)
  return { cx, cy, rx: ax, ry: ay, angle, error: error / n }
}

/**
 * Drops corners that aren't corners: a shape started in the middle of a side gets an extra vertex
 * there, almost in a straight line with its neighbours.
 */
export function dropStraight(vertices: P[], maxAngle = (155 * Math.PI) / 180): P[] {
  let out = [...vertices]
  for (let changed = true; changed && out.length > 3; ) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i + out.length - 1) % out.length]!
      const next = out[(i + 1) % out.length]!
      if (angleAt(prev, out[i]!, next) > maxAngle) {
        out = out.filter((_, j) => j !== i)
        changed = true
        break
      }
    }
  }
  return out
}

export function recognizeShape(points: InkPoint[]): Shape | null {
  if (points.length < 4) return null
  const pts: P[] = points.map((p) => [p[0], p[1]])
  const length = pathLength(pts)
  if (length < 12) return null
  // Handwriting is small: only something at least ~1 cm across is straightened.
  const span = Math.hypot(Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])))
  if (span < 36) return null
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1])
  const step = 6

  // A straight line.
  if (gap / length > 0.92) return { kind: 'line', points: along([first, snapDirection(first, last)], step) }

  // Tolerances follow the shape's size, so a big scribble isn't read as a few long sides.
  const box = { minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])) }
  const size = Math.hypot(box.maxX - box.minX, box.maxY - box.minY)
  /** A drawn path much longer than its straightened version went back and forth: not a shape. */
  const plausible = (corners: P[]): boolean => length / Math.max(1, pathLength(corners)) < 1.18

  const closed = gap < Math.max(18, length * 0.18)
  if (closed) {
    const ellipse = fitEllipse(pts)
    const corners = simplify([...pts, first], size * 0.06)
    const vertices = dropStraight(corners.slice(0, -1))
    const roundish = ellipse.error < 0.12
    if (vertices.length >= 3 && vertices.length <= 6 && !(roundish && vertices.length >= 5) && plausible(corners)) {
      if (vertices.length === 4) {
        const right = vertices.every((v, i) => Math.abs(angleAt(vertices[(i + 3) % 4]!, v, vertices[(i + 1) % 4]!) - Math.PI / 2) < (20 * Math.PI) / 180)
        if (right) {
          // A clean rectangle along its own first side (snapped upright when nearly so).
          const a = vertices[0]!
          const dir = snapDirection(a, vertices[1]!)
          const ux = (dir[0] - a[0]) / (Math.hypot(dir[0] - a[0], dir[1] - a[1]) || 1)
          const uy = (dir[1] - a[1]) / (Math.hypot(dir[0] - a[0], dir[1] - a[1]) || 1)
          const us = vertices.map((v) => (v[0] - a[0]) * ux + (v[1] - a[1]) * uy)
          const vs = vertices.map((v) => -(v[0] - a[0]) * uy + (v[1] - a[1]) * ux)
          let [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)]
          // Sides within ~12 % of each other: a square.
          const w = u1 - u0
          const h = v1 - v0
          if (Math.abs(w - h) / Math.max(w, h) < 0.12) {
            const side = (w + h) / 2
            const cu = (u0 + u1) / 2
            const cv = (v0 + v1) / 2
            ;[u0, u1, v0, v1] = [cu - side / 2, cu + side / 2, cv - side / 2, cv + side / 2]
          }
          const at = (u: number, v: number): P => [a[0] + u * ux - v * uy, a[1] + u * uy + v * ux]
          return { kind: 'polyline', points: along([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1), at(u0, v0)], step) }
        }
      }
      if (plausible([...vertices, vertices[0]!])) return { kind: 'polyline', points: along([...vertices, vertices[0]!], step) }
    }
    if (roundish || ellipse.error < 0.2) {
      let { rx, ry, angle } = ellipse
      // Nearly round → a circle.
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) rx = ry = (rx + ry) / 2
      if (Math.abs(Math.sin(angle * 2)) < 0.12) angle = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2)
      const n = 72
      const out: InkPoint[] = []
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2
        const u = Math.cos(t) * rx
        const v = Math.sin(t) * ry
        out.push([ellipse.cx + u * Math.cos(angle) - v * Math.sin(angle), ellipse.cy + u * Math.sin(angle) + v * Math.cos(angle), 0.75, i * 8])
      }
      return { kind: 'ellipse', points: out }
    }
    return null
  }

  // An open shape: an angle or a zigzag of a few straight parts.
  const corners = simplify(pts, size * 0.05)
  if (corners.length >= 3 && corners.length <= 5 && plausible(corners)) return { kind: 'polyline', points: along(corners, step) }
  return null
}
