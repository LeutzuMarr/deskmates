import { describe, expect, it } from 'vitest'
import { floodMask, grow, traceOutline } from '../../src/renderer/src/notes/editor/fill'
import { hexToHsv, hsvToHex } from '../../src/renderer/src/notes/ui/ColorPicker'
import { warpItem, warpPoint } from '../../src/renderer/src/notes/editor/transform'
import type { Item } from '../../src/renderer/src/notes/model'

/** An RGBA picture with an opaque square outline from (2,2) to (12,12). */
function boxPicture(size = 16, gap = false): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 2; y <= 12; y++)
    for (let x = 2; x <= 12; x++) {
      const edge = x === 2 || x === 12 || y === 2 || y === 12
      if (edge && !(gap && x === 12 && y === 7)) data[(y * size + x) * 4 + 3] = 255
    }
  return data
}

describe('paint bucket', () => {
  it('fills the inside of a closed shape', () => {
    const mask = floodMask(boxPicture(), 16, 16, 7, 7)
    expect(mask).not.toBeNull()
    const filled = mask!.reduce((n, v) => n + v, 0)
    expect(filled).toBe(9 * 9)
    const outline = traceOutline(grow(mask!, 16, 16), 16, 16)
    const xs = outline.map((p) => p[0])
    expect(Math.min(...xs)).toBe(2)
    expect(Math.max(...xs)).toBe(12)
  })

  it('refuses an open shape and a tap on the ink', () => {
    expect(floodMask(boxPicture(16, true), 16, 16, 7, 7)).toBeNull()
    expect(floodMask(boxPicture(), 16, 16, 2, 5)).toBeNull()
  })
})

describe('colour picker', () => {
  it('turns colours to hue, saturation, brightness and back', () => {
    for (const hex of ['#ff0000', '#1f4fd1', '#0f9d76', '#ffffff', '#000000', '#8e44ad']) expect(hsvToHex(...hexToHsv(hex))).toBe(hex)
    expect(hexToHsv('#00ff00')[0]).toBeCloseTo(120)
  })
})

describe('distort', () => {
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 }

  it('maps the box corners onto the new corners', () => {
    const q: [[number, number], [number, number], [number, number], [number, number]] = [
      [10, 0],
      [100, 20],
      [120, 120],
      [0, 100]
    ]
    expect(warpPoint(box, q, 0, 0)).toEqual([10, 0])
    expect(warpPoint(box, q, 100, 100)).toEqual([120, 120])
    expect(warpPoint(box, q, 50, 50)).toEqual([57.5, 60])
  })

  it('bends a line point by point', () => {
    const line = { id: 'l', pageId: 'p', notebookId: 'n', kind: 'stroke', z: 1, data: { tool: 'pen', color: '#000', width: 2, points: [[0, 0, 0.5, 0], [100, 100, 0.5, 1]] }, createdAt: 1, updatedAt: 1, deletedAt: null } as Item<'stroke'>
    const bent = warpItem(line, box, [[0, 0], [100, 0], [150, 100], [0, 100]]) as Item<'stroke'>
    expect(bent.data.points[1]!.slice(0, 2)).toEqual([150, 100])
  })
})
