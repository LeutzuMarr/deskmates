import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParentPortRenderClient, type RenderPort } from '../../src/core/render/client'

class FakePort implements RenderPort {
  sent: any[] = []
  private listeners: Array<(event: { data?: unknown }) => void> = []
  postMessage(message: unknown): void {
    this.sent.push(message)
  }
  on(_event: 'message', listener: (event: { data?: unknown }) => void): void {
    this.listeners.push(listener)
  }
  emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data })
  }
}

afterEach(() => vi.useRealTimers())

describe('ParentPortRenderClient', () => {
  it('sends numbered requests and settles each with the matching result', async () => {
    const port = new FakePort()
    const client = new ParentPortRenderClient(port)
    const first = client.render({ url: 'deskmates-preview://design/a/index.html' })
    const second = client.render({ url: 'deskmates-preview://design/a/other.html' })
    expect(port.sent.map((message) => [message.type, message.id, message.request.url])).toEqual([
      ['render-request', 1, 'deskmates-preview://design/a/index.html'],
      ['render-request', 2, 'deskmates-preview://design/a/other.html']
    ])

    port.emit({ type: 'keys', keys: {} })
    port.emit({ type: 'render-result', id: 2, result: { screenshots: ['b'], logs: [] } })
    port.emit({ type: 'render-result', id: 1, result: { screenshots: [], logs: [], error: 'nope' } })
    await expect(second).resolves.toEqual({ screenshots: ['b'], logs: [] })
    await expect(first).resolves.toMatchObject({ error: 'nope' })

    // A late or unknown answer is ignored.
    expect(client.receive({ type: 'render-result', id: 1, result: { screenshots: [], logs: [] } })).toBe(true)
    expect(client.receive({ type: 'shutdown' })).toBe(false)
  })

  it('rejects when there is no host, on timeout, and when aborted', async () => {
    await expect(new ParentPortRenderClient(undefined).render({ url: 'x' })).rejects.toThrow(/needs the Deskmates app/)

    vi.useFakeTimers()
    const port = new FakePort()
    const client = new ParentPortRenderClient(port)
    const slow = client.render({ url: 'x', timeoutMs: 1000 })
    const check = expect(slow).rejects.toThrow(/did not finish rendering/)
    await vi.advanceTimersByTimeAsync(1000 + 90_000)
    await check

    const controller = new AbortController()
    const stopped = client.render({ url: 'x' }, controller.signal)
    controller.abort()
    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.render({ url: 'x' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects instead of throwing when the port cannot send', async () => {
    const client = new ParentPortRenderClient({
      postMessage: () => {
        throw new Error('channel closed')
      },
      on: () => undefined
    })
    await expect(client.render({ url: 'x' })).rejects.toThrow('channel closed')
  })
})
