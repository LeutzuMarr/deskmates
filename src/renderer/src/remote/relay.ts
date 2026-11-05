/**
 * The phone web app's link to the PC: an encrypted channel on the relay (Supabase Realtime
 * broadcast) and WebSocket-like sessions over it, so the app's normal RPC client works unchanged.
 */
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { channelFor, newId, open, seal } from '../../../shared/remote-crypto'

export interface RemoteDevice {
  relay: string
  anon: string
  device: string
  key: string
  pc: string
  vapid: string
}

const PART_SIZE = 150_000

type Listener = (payload: { t: string; s?: string; d?: string; pc?: string }) => void

export class RelayConnection {
  private channel: RealtimeChannel
  private ready: Promise<void>
  private counter = Date.now() * 1000
  private lastIn = 0
  private readonly parts = new Map<string, string[]>()
  private readonly listeners = new Set<Listener>()

  constructor(readonly device: RemoteDevice) {
    // The client's own limit is 10 messages a second and drops the rest; the app sends bursts.
    const client = createClient(device.relay, device.anon, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 200 } } })
    this.channel = client.channel(channelFor(device.device), { config: { broadcast: { self: false } } })
    this.channel.on('broadcast', { event: 'm' }, ({ payload }) => void this.receive(payload as { x?: string; part?: { id: string; i: number; n: number } }))
    this.ready = new Promise((resolve) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve()
      })
    })
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Sends in order, one at a time, retrying a message the relay didn't take. */
  send(payload: unknown): Promise<void> {
    const run = this.queue.then(() => this.sendNow(payload))
    this.queue = run.catch(() => undefined)
    return run
  }

  private queue: Promise<unknown> = Promise.resolve()

  private async sendNow(payload: unknown): Promise<void> {
    await this.ready
    const sealed = await seal(this.device.key, 'to-pc', ++this.counter, payload)
    if (sealed.length <= PART_SIZE) {
      await this.broadcast({ x: sealed })
      return
    }
    const id = newId(6)
    const n = Math.ceil(sealed.length / PART_SIZE)
    for (let i = 0; i < n; i++) await this.broadcast({ x: sealed.slice(i * PART_SIZE, (i + 1) * PART_SIZE), part: { id, i, n } })
  }

  private async broadcast(payload: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await this.channel.send({ type: 'broadcast', event: 'm', payload })
      if (result === 'ok') return
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }

  private async receive(message: { x?: string; part?: { id: string; i: number; n: number } }): Promise<void> {
    if (!message?.x) return
    let sealed = message.x
    if (message.part) {
      const parts = this.parts.get(message.part.id) ?? new Array<string>(message.part.n)
      parts[message.part.i] = message.x
      this.parts.set(message.part.id, parts)
      if (parts.filter((p) => p !== undefined).length < message.part.n) return
      this.parts.delete(message.part.id)
      sealed = parts.join('')
    }
    const opened = await open(this.device.key, 'to-phone', sealed, this.lastIn)
    if (!opened) return
    this.lastIn = opened.counter
    for (const listener of this.listeners) listener(opened.payload as { t: string })
  }
}

/** A WebSocket the app's RPC client can use, carried over the relay. */
export class RelaySocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly id = newId(8)
  private readonly off: () => void
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(private readonly connection: RelayConnection) {
    this.off = connection.on((payload) => {
      if (payload.s !== this.id) return
      if (payload.t === 'open' && this.readyState === 0) {
        this.readyState = 1
        clearTimeout(this.timer)
        this.onopen?.(new Event('open'))
      } else if (payload.t === 'ws' && typeof payload.d === 'string') {
        this.onmessage?.(new MessageEvent('message', { data: payload.d }))
      } else if (payload.t === 'close') {
        this.finish()
      }
    })
    // The PC is off, asleep or Deskmates isn't running: give up and let the client retry.
    this.timer = setTimeout(() => {
      if (this.readyState === 0) this.finish()
    }, 15_000)
    void connection.send({ t: 'open', s: this.id })
  }

  send(data: string): void {
    if (this.readyState !== 1) return
    void this.connection.send({ t: 'ws', s: this.id, d: data })
  }

  close(): void {
    if (this.readyState >= 2) return
    void this.connection.send({ t: 'close', s: this.id })
    this.finish()
  }

  private finish(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    clearTimeout(this.timer)
    this.off()
    this.onclose?.(new CloseEvent('close'))
  }
}
