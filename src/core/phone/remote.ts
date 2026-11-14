/**
 * Deskmates from anywhere: paired phones reach this PC through a relay (Supabase Realtime broadcast)
 * that only carries end-to-end-encrypted messages (see shared/remote-crypto.ts). Each phone session
 * is joined to a local WebSocket on the app's own RPC server, so the phone gets exactly what the
 * desktop app gets. Notifications go to phones as web pushes, sent from this PC.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import { hostname } from 'node:os'
import type { EventBus } from '../events'
import { channelFor, encodePairing, newId, newKey, open, seal } from '../../shared/remote-crypto'

/** The largest piece one relay message carries; bigger messages are split. */
const PART_SIZE = 150_000
const PAIRING_MS = 5 * 60_000

export interface RemoteDevice {
  id: string
  name: string
  key: string
  push: webpush.PushSubscription | null
  createdAt: number
  lastSeenAt: number | null
}

export interface RemoteConfig {
  relay: string
  anon: string
  /** The web app's address on Vercel. */
  appUrl: string
  vapid: { publicKey: string; privateKey: string } | null
  devices: RemoteDevice[]
}

export interface RemoteStatus {
  configured: boolean
  appUrl: string
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number | null; notifications: boolean }>
  pairing: { url: string; until: number } | null
}

interface Pending {
  device: RemoteDevice
  until: number
  url: string
}

interface Session {
  socket: WebSocket
  queue: string[]
}

export interface RemoteAccessDeps {
  bus: EventBus
  getConfig: () => RemoteConfig
  setConfig: (config: RemoteConfig) => void
  /** The app's own RPC server, which each phone session joins. */
  core: () => { port: number; token: string } | null
}

export class RemoteAccess {
  private client: SupabaseClient | null = null
  private readonly channels = new Map<string, RealtimeChannel>()
  private readonly sessions = new Map<string, Session>()
  private readonly lastIn = new Map<string, number>()
  private readonly parts = new Map<string, string[]>()
  private outCounter = Date.now() * 1000
  private pending: Pending | null = null

  constructor(private readonly deps: RemoteAccessDeps) {}

  private config(): RemoteConfig {
    return this.deps.getConfig()
  }

  status(): RemoteStatus {
    const config = this.config()
    return {
      configured: Boolean(config.relay && config.anon && config.appUrl),
      appUrl: config.appUrl,
      devices: config.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, notifications: d.push !== null })),
      pairing: this.pending && this.pending.until > Date.now() ? { url: this.pending.url, until: this.pending.until } : null
    }
  }

  start(): void {
    const config = this.config()
    if (!config.relay || !config.anon) return
    if (!config.vapid) {
      const keys = webpush.generateVAPIDKeys()
      this.deps.setConfig({ ...config, vapid: keys })
    }
    for (const device of this.config().devices) this.listen(device)
  }

  stop(): void {
    for (const session of this.sessions.values()) session.socket.close()
    this.sessions.clear()
    for (const channel of this.channels.values()) void channel.unsubscribe()
    this.channels.clear()
  }

  /** Starts pairing a new phone: a link (for a QR code) valid for five minutes. */
  pairStart(): { url: string; until: number } {
    const config = this.config()
    if (!config.relay || !config.anon || !config.appUrl) throw new Error('Phone access from anywhere isn’t set up on this PC.')
    if (!config.vapid) this.start()
    const vapid = this.config().vapid!
    const device: RemoteDevice = { id: newId(), name: 'Phone', key: newKey(), push: null, createdAt: Date.now(), lastSeenAt: null }
    const until = Date.now() + PAIRING_MS
    const fragment = encodePairing({ v: 1, relay: config.relay, anon: config.anon, device: device.id, key: device.key, pc: hostname(), vapid: vapid.publicKey, until })
    const url = `${config.appUrl.replace(/\/+$/, '')}/#pair=${fragment}`
    if (this.pending) this.unlisten(this.pending.device.id)
    this.pending = { device, until, url }
    this.listen(device)
    return { url, until }
  }

  remove(id: string): RemoteStatus {
    const config = this.config()
    this.deps.setConfig({ ...config, devices: config.devices.filter((d) => d.id !== id) })
    this.unlisten(id)
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${id}:`)) {
        session.socket.close()
        this.sessions.delete(key)
      }
    }
    return this.status()
  }

  /** A notification on every paired phone that turned them on. Short: the title and one line. */
  async push(title: string, body: string): Promise<void> {
    const config = this.config()
    if (!config.vapid) return
    const payload = JSON.stringify({ title: title.slice(0, 80), body: body.slice(0, 160) })
    for (const device of config.devices) {
      if (!device.push) continue
      try {
        await webpush.sendNotification(device.push, payload, {
          vapidDetails: { subject: 'mailto:noreply@deskmates.app', publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey },
          TTL: 3600
        })
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        // The phone dropped the subscription: forget it, so pushes stop failing.
        if (status === 404 || status === 410) this.updateDevice(device.id, { push: null })
      }
    }
  }

  // ---- relay ----

  private relay(): SupabaseClient {
    if (this.client) return this.client
    const config = this.config()
    // The client's own limit is 10 messages a second and drops the rest; replies come in bursts.
    this.client = createClient(config.relay, config.anon, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 200 } } })
    return this.client
  }

  private listen(device: RemoteDevice): void {
    if (this.channels.has(device.id)) return
    const channel = this.relay().channel(channelFor(device.id), { config: { broadcast: { self: false } } })
    channel.on('broadcast', { event: 'm' }, ({ payload }) => void this.receive(device.id, payload as { x?: string; part?: { id: string; i: number; n: number } }))
    channel.subscribe()
    this.channels.set(device.id, channel)
  }

  private unlisten(id: string): void {
    const channel = this.channels.get(id)
    if (channel) void channel.unsubscribe()
    this.channels.delete(id)
  }

  private keyFor(id: string): string | null {
    if (this.pending?.device.id === id) return this.pending.device.key
    return this.config().devices.find((d) => d.id === id)?.key ?? null
  }

  private async receive(id: string, message: { x?: string; part?: { id: string; i: number; n: number } }): Promise<void> {
    if (!message?.x) return
    let sealed = message.x
    if (message.part) {
      const key = `${id}:${message.part.id}`
      const parts = this.parts.get(key) ?? new Array<string>(message.part.n)
      parts[message.part.i] = message.x
      this.parts.set(key, parts)
      if (parts.filter((p) => p !== undefined).length < message.part.n) return
      this.parts.delete(key)
      sealed = parts.join('')
    }
    const key = this.keyFor(id)
    if (!key) return
    const opened = await open(key, 'to-pc', sealed, this.lastIn.get(id) ?? 0)
    if (!opened) return
    this.lastIn.set(id, opened.counter)
    const payload = opened.payload as { t: string; s?: string; d?: string; name?: string; sub?: webpush.PushSubscription }

    if (payload.t === 'hello') {
      if (this.pending?.device.id === id) {
        if (Date.now() > this.pending.until) return
        const device = { ...this.pending.device, name: String(payload.name ?? 'Phone').slice(0, 40), lastSeenAt: Date.now() }
        this.pending = null
        const config = this.config()
        this.deps.setConfig({ ...config, devices: [...config.devices.filter((d) => d.id !== id), device] })
        this.deps.bus.emit({ type: 'notify', title: 'Phone paired', body: `${device.name} can now use Deskmates from anywhere.` })
      }
      await this.send(id, { t: 'welcome', pc: hostname() })
      return
    }
    // Everything else only from a phone that finished pairing.
    if (!this.config().devices.some((d) => d.id === id)) return
    this.updateDevice(id, { lastSeenAt: Date.now() })
    if (payload.t === 'push' && payload.sub) {
      this.updateDevice(id, { push: payload.sub })
      return
    }
    const sessionId = `${id}:${String(payload.s ?? '')}`
    if (payload.t === 'open') this.openSession(id, sessionId)
    else if (payload.t === 'ws' && typeof payload.d === 'string') {
      const session = this.sessions.get(sessionId)
      if (!session) return
      if (session.socket.readyState === WebSocket.OPEN) session.socket.send(payload.d)
      else session.queue.push(payload.d)
    } else if (payload.t === 'close') {
      this.sessions.get(sessionId)?.socket.close()
      this.sessions.delete(sessionId)
    }
  }

  private openSession(device: string, sessionId: string): void {
    const core = this.deps.core()
    if (!core) return
    this.sessions.get(sessionId)?.socket.close()
    const socket = new WebSocket(`ws://127.0.0.1:${core.port}/?token=${core.token}`)
    const session: Session = { socket, queue: [] }
    this.sessions.set(sessionId, session)
    const s = sessionId.slice(device.length + 1)
    socket.onopen = () => {
      void this.send(device, { t: 'open', s })
      for (const queued of session.queue.splice(0)) socket.send(queued)
    }
    socket.onmessage = (event) => void this.send(device, { t: 'ws', s, d: String(event.data) })
    socket.onclose = () => {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      void this.send(device, { t: 'close', s })
    }
  }

  /** Sends in order per phone, one at a time, retrying a message the relay didn't take. */
  private send(id: string, payload: unknown): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const run = previous.then(() => this.sendNow(id, payload))
    this.queues.set(id, run.catch(() => undefined))
    return run
  }

  private readonly queues = new Map<string, Promise<unknown>>()

  private async broadcast(channel: RealtimeChannel, payload: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await channel.send({ type: 'broadcast', event: 'm', payload })
      if (result === 'ok') return
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }

  private async sendNow(id: string, payload: unknown): Promise<void> {
    const key = this.keyFor(id)
    const channel = this.channels.get(id)
    if (!key || !channel) return
    const sealed = await seal(key, 'to-phone', ++this.outCounter, payload)
    if (sealed.length <= PART_SIZE) {
      await this.broadcast(channel, { x: sealed })
      return
    }
    const partId = newId(6)
    const n = Math.ceil(sealed.length / PART_SIZE)
    for (let i = 0; i < n; i++) await this.broadcast(channel, { x: sealed.slice(i * PART_SIZE, (i + 1) * PART_SIZE), part: { id: partId, i, n } })
  }

  private updateDevice(id: string, patch: Partial<RemoteDevice>): void {
    const config = this.config()
    if (!config.devices.some((d) => d.id === id)) return
    this.deps.setConfig({ ...config, devices: config.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) })
  }
}
