/**
 * The view onto a notebook: where it is, how big and how turned. Document space holds the pages
 * stacked top to bottom; screen = rotate(rotation) · scale · doc + (x, y).
 */

export interface Camera {
  scale: number
  rotation: number
  x: number
  y: number
}

export type Vec = [number, number]

export const MIN_SCALE = 0.25
export const MAX_SCALE = 10

export function toScreen(c: Camera, p: Vec): Vec {
  const cos = Math.cos(c.rotation) * c.scale
  const sin = Math.sin(c.rotation) * c.scale
  return [cos * p[0] - sin * p[1] + c.x, sin * p[0] + cos * p[1] + c.y]
}

export function toDoc(c: Camera, s: Vec): Vec {
  const dx = s[0] - c.x
  const dy = s[1] - c.y
  const cos = Math.cos(-c.rotation) / c.scale
  const sin = Math.sin(-c.rotation) / c.scale
  return [cos * dx - sin * dy, sin * dx + cos * dy]
}

/** The canvas transform for this camera, at a device pixel ratio. */
export function matrix(c: Camera, dpr: number): [number, number, number, number, number, number] {
  const cos = Math.cos(c.rotation) * c.scale * dpr
  const sin = Math.sin(c.rotation) * c.scale * dpr
  return [cos, sin, -sin, cos, c.x * dpr, c.y * dpr]
}

/** Moves the view so a screen point stays put while zooming by `factor`. */
export function zoomAt(c: Camera, at: Vec, factor: number): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * factor))
  const k = scale / c.scale
  return { ...c, scale, x: at[0] + (c.x - at[0]) * k, y: at[1] + (c.y - at[1]) * k }
}

export function pan(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x + dx, y: c.y + dy }
}

/**
 * Two fingers moved from (a0, b0) to (a1, b1): pan, zoom and (unless locked) turn so the page
 * stays under the fingers.
 */
export function pinch(c: Camera, a0: Vec, b0: Vec, a1: Vec, b1: Vec, allowRotation: boolean): Camera {
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1
  const d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]) || 1
  const m0: Vec = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2]
  const m1: Vec = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2]
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * (d1 / d0)))
  const k = scale / c.scale
  const turn = allowRotation ? Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]) : 0
  const cos = Math.cos(turn) * k
  const sin = Math.sin(turn) * k
  const tx = c.x - m0[0]
  const ty = c.y - m0[1]
  return { scale, rotation: normalizeAngle(c.rotation + turn), x: m1[0] + cos * tx - sin * ty, y: m1[1] + sin * tx + cos * ty }
}

export function normalizeAngle(a: number): number {
  let r = a % (Math.PI * 2)
  if (r > Math.PI) r -= Math.PI * 2
  if (r < -Math.PI) r += Math.PI * 2
  return r
}

/** Turns the view about a screen point. */
export function rotateAbout(c: Camera, at: Vec, angle: number): Camera {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const tx = c.x - at[0]
  const ty = c.y - at[1]
  return { ...c, rotation: normalizeAngle(c.rotation + angle), x: at[0] + cos * tx - sin * ty, y: at[1] + sin * tx + cos * ty }
}

/** The document-space box the screen shows (with a margin). */
export function visibleDocBounds(c: Camera, width: number, height: number, margin = 0): { minX: number; minY: number; maxX: number; maxY: number } {
  const corners: Vec[] = [
    [-margin, -margin],
    [width + margin, -margin],
    [-margin, height + margin],
    [width + margin, height + margin]
  ].map((p) => toDoc(c, p as Vec))
  return {
    minX: Math.min(...corners.map((p) => p[0])),
    minY: Math.min(...corners.map((p) => p[1])),
    maxX: Math.max(...corners.map((p) => p[0])),
    maxY: Math.max(...corners.map((p) => p[1]))
  }
}

export interface PageSlot {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export const PAGE_GAP = 36

/** Stacks pages top to bottom, centred on x = 0. A whiteboard page is centred on the origin. */
export function layoutPages(pages: ReadonlyArray<{ id: string; width: number; height: number; size?: string }>): PageSlot[] {
  let y = 0
  return pages.map((p) => {
    if (p.size === 'infinite') return { id: p.id, x: -p.width / 2, y: -p.height / 2, width: p.width, height: p.height }
    const slot = { id: p.id, x: -p.width / 2, y, width: p.width, height: p.height }
    y += p.height + PAGE_GAP
    return slot
  })
}

/** A camera that fits a page's width to the screen, with its top near the top. */
export function fitPage(slot: PageSlot, width: number, height: number, topInset: number): Camera {
  if (slot.width >= 10000) return { scale: 1, rotation: 0, x: width / 2, y: height / 2 }
  const scale = Math.min((width - 32) / slot.width, 1.5)
  return { scale, rotation: 0, x: width / 2 - (slot.x + slot.width / 2) * scale, y: topInset + 16 - slot.y * scale }
}
