/**
 * The paint bucket: fills the area around a tap that ink closes off. The page's ink is drawn into
 * a small mask, the area is flooded from the tap, grown a pixel to slip under the lines, and its
 * outline is traced into a polygon, which is saved as a fill item under the ink.
 */
import type { Item, Page } from '../model'
import { paintItem, type InkCache } from '../ink/paint'

/** How many mask pixels per page pixel: enough for snug edges, small enough to stay quick. */
const SCALE = 1.5

export function floodMask(alpha: Uint8ClampedArray, width: number, height: number, sx: number, sy: number, threshold = 60): Uint8Array | null {
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null
  const wall = (i: number): boolean => alpha[i * 4 + 3]! > threshold
  const start = sy * width + sx
  if (wall(start)) return null
  const mask = new Uint8Array(width * height)
  const stack = [start]
  mask[start] = 1
  let count = 0
  while (stack.length) {
    const i = stack.pop()!
    count++
    const x = i % width
    const y = (i - x) / width
    // Touching the page edge means the area isn't closed: refuse rather than flood the page.
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return null
    for (const n of [i - 1, i + 1, i - width, i + width]) {
      if (!mask[n] && !wall(n)) {
        mask[n] = 1
        stack.push(n)
      }
    }
  }
  return count > 4 ? mask : null
}

/** Grows the area by one pixel so the fill tucks under the ink around it. */
export function grow(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = mask.slice()
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      if (mask[i]) out[i - 1] = out[i + 1] = out[i - width] = out[i + width] = 1
    }
  return out
}

/** The outer outline of the area (Moore neighbour tracing), as pixel corners. */
export function traceOutline(mask: Uint8Array, width: number, height: number): Array<[number, number]> {
  let start = -1
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      start = i
      break
    }
  if (start < 0) return []
  const dirs: Array<[number, number]> = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1]
  ]
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1
  let x = start % width
  let y = (start - x) / width
  const sx = x
  const sy = y
  let dir = 6
  const out: Array<[number, number]> = [[x, y]]
  for (let steps = 0; steps < width * height * 2; steps++) {
    let moved = false
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8
      const nx = x + dirs[d]![0]
      const ny = y + dirs[d]![1]
      if (at(nx, ny)) {
        x = nx
        y = ny
        dir = d
        moved = true
        break
      }
    }
    if (!moved || (x === sx && y === sy)) break
    out.push([x, y])
  }
  return out
}

function simplify(points: Array<[number, number]>, epsilon: number): Array<[number, number]> {
  if (points.length < 3) return points
  const [ax, ay] = points[0]!
  const [bx, by] = points[points.length - 1]!
  let index = 0
  let max = 0
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i]!
    const len = Math.hypot(bx - ax, by - ay) || 1
    const d = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / len
    if (d > max) {
      max = d
      index = i
    }
  }
  if (max <= epsilon) return [points[0]!, points[points.length - 1]!]
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)]
}

/** The fill polygon (page space) for a tap at (x, y), or null if the spot isn't closed in. */
export function fillAreaAt(page: Page, items: Item[], cache: InkCache, x: number, y: number): Array<[number, number]> | null {
  // Look at most this far around the tap (a whiteboard is far too big to scan whole).
  const reach = 1300
  const ox = Math.max(0, x - reach)
  const oy = Math.max(0, y - reach)
  const width = Math.ceil((Math.min(page.width, x + reach) - ox) * SCALE)
  const height = Math.ceil((Math.min(page.height, y + reach) - oy) * SCALE)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.scale(SCALE, SCALE)
  ctx.translate(-ox, -oy)
  for (const item of items) if (item.kind === 'stroke' || item.kind === 'fill') paintItem(ctx, item, cache, 'white')
  const data = ctx.getImageData(0, 0, width, height).data
  const mask = floodMask(data, width, height, Math.floor((x - ox) * SCALE), Math.floor((y - oy) * SCALE))
  if (!mask) return null
  const outline = traceOutline(grow(mask, width, height), width, height)
  if (outline.length < 3) return null
  // Split the closed loop so simplification keeps both halves.
  const half = Math.floor(outline.length / 2)
  const ring = [...simplify(outline.slice(0, half + 1), 0.6).slice(0, -1), ...simplify(outline.slice(half), 0.6)]
  return ring.map(([px, py]) => [Math.round((px / SCALE + ox) * 100) / 100, Math.round((py / SCALE + oy) * 100) / 100])
}
