import { describe, expect, it } from 'vitest'
import { apply, lassoTakes, pointInPolygon, recolorItem, transformItem, type Similarity } from '../../src/renderer/src/notes/editor/transform'
import type { Item, ItemDataMap, ItemKind } from '../../src/renderer/src/notes/model'

function item<K extends ItemKind>(kind: K, data: ItemDataMap[K]): Item<K> {
  return { id: 'i', pageId: 'p', notebookId: 'n', kind, z: 1, data, createdAt: 1, updatedAt: 1, deletedAt: null }
}

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

describe('moving, resizing and turning', () => {
  const turn: Similarity = { origin: [100, 100], scale: 2, angle: Math.PI / 2, dx: 10, dy: 0 }

  it('turns and scales about the origin, then shifts', () => {
    const [x, y] = apply(turn, 110, 100)
    expect(close(x, 110) && close(y, 120)).toBe(true)
  })

  it('moves a line point by point and widens it with the scale', () => {
    const line = transformItem(item('stroke', { tool: 'pen', color: '#000', width: 3, points: [[110, 100, 0.5, 0]] }), turn) as Item<'stroke'>
    expect(line.data.points[0]!.slice(0, 2)).toEqual([110, 120])
    expect(line.data.width).toBe(6)
  })

  it('turns pictures about their middle and keeps text level', () => {
    const picture = transformItem(item('image', { assetId: 'a', x: 0, y: 0, width: 100, height: 50, rotation: 0 }), { origin: [0, 0], scale: 1, angle: 0.5, dx: 0, dy: 0 }) as Item<'image'>
    expect(picture.data.rotation).toBe(0.5)
    expect(picture.data.width).toBe(100)
    const text = transformItem(item('text', { x: 0, y: 0, width: 100, text: 'hi', size: 20, color: '#000', font: 'sans' }), { origin: [0, 0], scale: 1.5, angle: 0.4, dx: 5, dy: 5 }) as Item<'text'>
    expect(text.data.size).toBe(30)
    expect(text.data.x).toBe(5)
  })

  it('recolours ink and sticky notes but not pictures', () => {
    expect((recolorItem(item('stroke', { tool: 'pen', color: '#000', width: 2, points: [] }), '#f00') as Item<'stroke'>).data.color).toBe('#f00')
    expect((recolorItem(item('sticky', { x: 0, y: 0, width: 10, height: 10, rotation: 0, color: '#ff0', text: '' }), '#0f0') as Item<'sticky'>).data.color).toBe('#0f0')
    const picture = item('image', { assetId: 'a', x: 0, y: 0, width: 1, height: 1, rotation: 0 })
    expect(recolorItem(picture, '#f00')).toBe(picture)
  })
})

describe('lasso', () => {
  const square: Array<[number, number]> = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100]
  ]

  it('knows inside from outside', () => {
    expect(pointInPolygon(50, 50, square)).toBe(true)
    expect(pointInPolygon(150, 50, square)).toBe(false)
  })

  it('takes a line when most of it is inside', () => {
    const mostly = item('stroke', { tool: 'pen', color: '#000', width: 2, points: [[10, 10, 0.5, 0], [50, 50, 0.5, 1], [90, 90, 0.5, 2], [120, 120, 0.5, 3]] })
    const barely = item('stroke', { tool: 'pen', color: '#000', width: 2, points: [[90, 90, 0.5, 0], [120, 120, 0.5, 1], [150, 150, 0.5, 2]] })
    const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    expect(lassoTakes(mostly, square, bounds)).toBe(true)
    expect(lassoTakes(barely, square, bounds)).toBe(false)
    expect(lassoTakes(item('image', { assetId: 'a', x: 40, y: 40, width: 20, height: 20, rotation: 0 }), square, { minX: 40, minY: 40, maxX: 60, maxY: 60 })).toBe(true)
  })
})
