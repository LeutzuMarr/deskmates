import { describe, expect, it } from 'vitest'
import { pinch, toDoc, toScreen, zoomAt, layoutPages, type Camera } from '../../src/renderer/src/notes/editor/camera'
import { recognizeShape } from '../../src/renderer/src/notes/editor/shapes'
import { circleHitsStroke, cutStroke } from '../../src/renderer/src/notes/editor/erase'
import { History } from '../../src/renderer/src/notes/editor/history'
import { PressureTracker, altitude, tiltAmount } from '../../src/renderer/src/notes/ink/pressure'
import type { InkPoint, Item, StrokeData } from '../../src/renderer/src/notes/model'

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

describe('camera', () => {
  const cam: Camera = { scale: 1.5, rotation: 0.3, x: 40, y: -20 }

  it('maps document to screen and back', () => {
    const [x, y] = toDoc(cam, toScreen(cam, [123, 456]))
    expect(close(x, 123) && close(y, 456)).toBe(true)
  })

  it('keeps the point under the fingers while pinching and turning', () => {
    const a0: [number, number] = [100, 100]
    const b0: [number, number] = [300, 100]
    const under = toDoc(cam, [200, 100])
    const next = pinch(cam, a0, b0, [120, 140], [380, 240], true)
    const [mx, my] = toScreen(next, under)
    expect(close(mx, 250, 1e-6) && close(my, 190, 1e-6)).toBe(true)
    expect(next.scale).toBeGreaterThan(cam.scale)
    expect(next.rotation).not.toBe(cam.rotation)
  })

  it('does not turn when the rotation is locked', () => {
    const next = pinch(cam, [0, 0], [100, 0], [0, 0], [0, 100], false)
    expect(next.rotation).toBe(cam.rotation)
  })

  it('zooms about a point and stops at the limits', () => {
    const at: [number, number] = [300, 200]
    const doc = toDoc(cam, at)
    const z = zoomAt(cam, at, 2)
    const [x, y] = toScreen(z, doc)
    expect(close(x, 300) && close(y, 200)).toBe(true)
    expect(zoomAt(cam, at, 1000).scale).toBe(10)
  })

  it('stacks pages with a gap and centres a whiteboard', () => {
    const slots = layoutPages([
      { id: 'a', width: 794, height: 1123 },
      { id: 'b', width: 794, height: 1123 }
    ])
    expect(slots[1]!.y).toBe(1123 + 36)
    expect(slots[0]!.x).toBe(-397)
    expect(layoutPages([{ id: 'w', width: 20000, height: 20000, size: 'infinite' }])[0]).toMatchObject({ x: -10000, y: -10000 })
  })
})

function points(list: Array<[number, number]>): InkPoint[] {
  return list.map(([x, y], i) => [x, y, 0.5, i * 8])
}

function wobble(n: number, f: (t: number) => [number, number]): InkPoint[] {
  return points(Array.from({ length: n + 1 }, (_, i) => f(i / n)))
}

describe('hold to shape', () => {
  it('straightens a shaky line and snaps it level', () => {
    const shape = recognizeShape(wobble(40, (t) => [10 + t * 300, 100 + Math.sin(t * 20) * 2 + t * 6]))
    expect(shape?.kind).toBe('line')
    const ys = shape!.points.map((p) => p[1])
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.001)
  })

  it('turns a rough circle into an ellipse and a rough box into a rectangle', () => {
    const circle = recognizeShape(wobble(60, (t) => [200 + Math.cos(t * Math.PI * 2) * (80 + Math.sin(t * 30) * 3), 200 + Math.sin(t * Math.PI * 2) * 80]))
    expect(circle?.kind).toBe('ellipse')
    const corners: Array<[number, number]> = [
      [0, 0],
      [200, 3],
      [198, 120],
      [2, 118],
      [0, 2]
    ]
    const box: Array<[number, number]> = []
    for (let i = 0; i < corners.length - 1; i++) {
      const [a, b] = [corners[i]!, corners[i + 1]!]
      for (let k = 0; k < 20; k++) box.push([a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20])
    }
    const rect = recognizeShape(points(box))
    expect(rect?.kind).toBe('polyline')
    // Every point lies on the sides of an upright rectangle.
    const xs = rect!.points.map((p) => p[0])
    const ys = rect!.points.map((p) => p[1])
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    for (const [x, y] of rect!.points) expect(close(x, x0, 0.5) || close(x, x1, 0.5) || close(y, y0, 0.5) || close(y, y1, 0.5)).toBe(true)
  })

  it('leaves scribbles alone', () => {
    expect(recognizeShape(wobble(80, (t) => [t * 300, Math.sin(t * 40) * 40 + Math.cos(t * 13) * 30]))).toBeNull()
  })
})

describe('eraser', () => {
  const stroke: StrokeData = { tool: 'pen', color: '#000', width: 4, points: points(Array.from({ length: 11 }, (_, i) => [i * 10, 0] as [number, number])) }

  it('hits a line near it and misses one far away', () => {
    expect(circleHitsStroke(stroke, 50, 5, 4)).toBe(true)
    expect(circleHitsStroke(stroke, 50, 30, 4)).toBe(false)
  })

  it('cuts a line in two where the eraser passed', () => {
    const pieces = cutStroke(stroke, 50, 0, 6)
    expect(pieces).toHaveLength(2)
    expect(Math.max(...pieces![0]!.map((p) => p[0]))).toBeLessThan(50)
    expect(Math.min(...pieces![1]!.map((p) => p[0]))).toBeGreaterThan(50)
    expect(cutStroke(stroke, 50, 40, 6)).toBeNull()
  })
})

describe('pressure without a pressure-sensitive pen', () => {
  it('makes slow lines heavier than fast ones', () => {
    const slow = new PressureTracker({ devicePressure: false, speedEffect: 1, curve: 1 })
    const fast = new PressureTracker({ devicePressure: false, speedEffect: 1, curve: 1 })
    let s = 0
    let f = 0
    for (let i = 0; i < 20; i++) {
      s = slow.next({ x: i * 0.5, y: 0, time: i * 16, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
      f = fast.next({ x: i * 60, y: 0, time: i * 16, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
    }
    expect(s).toBeGreaterThan(f + 0.2)
  })

  it('uses real pressure once the pen reports changing values', () => {
    const t = new PressureTracker({ devicePressure: false, speedEffect: 1, curve: 1 })
    t.next({ x: 0, y: 0, time: 0, pressure: 0.2, tiltX: 0, tiltY: 0, pointerType: 'pen' })
    t.next({ x: 1, y: 0, time: 16, pressure: 0.9, tiltX: 0, tiltY: 0, pointerType: 'pen' })
    expect(t.sawRealPressure).toBe(true)
  })

  it('reads how far the pen leans', () => {
    expect(close(altitude({ tiltX: 0, tiltY: 0 }), Math.PI / 2)).toBe(true)
    expect(tiltAmount({ tiltX: 0, tiltY: 0 })).toBe(0)
    expect(tiltAmount({ tiltX: 60, tiltY: 0 })).toBeGreaterThan(0.4)
  })
})

describe('undo', () => {
  it('undoes and redoes a step, and a new step clears redo', () => {
    const history = new History()
    const item = { id: 'a' } as Item
    history.push([{ id: 'a', before: null, after: item }])
    expect(history.undo()).toEqual([{ id: 'a', state: null, previous: item }])
    expect(history.canRedo).toBe(true)
    expect(history.redo()).toEqual([{ id: 'a', state: item, previous: null }])
    history.undo()
    history.push([{ id: 'b', before: null, after: { id: 'b' } as Item }])
    expect(history.canRedo).toBe(false)
  })
})
