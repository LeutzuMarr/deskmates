import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../src/core/events'
import type { CoreEvent } from '../../src/shared/protocol'

const event: CoreEvent = { type: 'notify', title: 'hello', body: 'there' }

describe('EventBus', () => {
  afterEach(() => vi.restoreAllMocks())

  it('delivers emitted events to listeners in registration order', () => {
    const bus = new EventBus()
    const seen: number[] = []
    bus.on(() => seen.push(1))
    bus.on(() => seen.push(2))
    bus.on(() => seen.push(3))
    bus.emit(event)
    expect(seen).toEqual([1, 2, 3])
  })

  it('stops sending events to a listener once unsubscribed', () => {
    const bus = new EventBus()
    const seen: number[] = []
    const off = bus.on(() => seen.push(1))
    bus.on(() => seen.push(2))
    bus.emit(event)
    off()
    bus.emit(event)
    expect(seen).toEqual([1, 2, 2])
  })

  it('lets other listeners still run when one throws, logging the failure', () => {
    const boom = new Error('boom')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new EventBus()
    const seen: number[] = []
    bus.on(() => {
      seen.push(1)
      throw boom
    })
    bus.on(() => seen.push(2))
    expect(() => bus.emit(event)).not.toThrow()
    expect(seen).toEqual([1, 2])
    expect(logError).toHaveBeenCalledWith('[core] event listener failed', boom)
  })
})