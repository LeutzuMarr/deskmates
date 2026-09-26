import type {
  ClientMessage,
  CoreEvent,
  RpcMethod,
  RpcParams,
  RpcResult,
  ServerMessage
} from '../../../shared/protocol'

export type CoreStatus = 'connecting' | 'open' | 'closed'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const MAX_BACKOFF_MS = 5_000
const INITIAL_BACKOFF_MS = 500

export class CoreClient {
  private socket: WebSocket | null = null
  private connecting = false
  private nextId = 1
  private pending = new Map<number, Pending>()
  private waiters = new Set<() => void>()
  private eventListeners = new Set<(event: CoreEvent) => void>()
  private statusListeners = new Set<(status: CoreStatus) => void>()
  private status: CoreStatus = 'connecting'
  private backoffMs = INITIAL_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private unsubscribeRestart: () => void = () => {}

  constructor() {
    this.unsubscribeRestart = window.deskmates.onCoreRestarted(() => {
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      const old = this.socket
      if (old) {
        this.socket = null
        old.close()
      }
      this.backoffMs = INITIAL_BACKOFF_MS
      void this.connect()
    })
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return
    if (this.connecting) return
    this.connecting = true
    this.setStatus('connecting')
    try {
      const { port, token } = await window.deskmates.getCoreConnection()
      this.connecting = false
      if (this.stopped) return
      // Desktop loads from file:// (hostname is empty -> 127.0.0.1); the phone page loads from
      // http://<lan-ip>:<port> and must talk to that same address, not to loopback.
      const host = location.hostname || '127.0.0.1'
      const ws = new WebSocket(`ws://${host}:${port}/?token=${token}`)
      this.socket = ws
      ws.onopen = () => {
        if (this.socket !== ws) return
        this.backoffMs = INITIAL_BACKOFF_MS
        this.setStatus('open')
      }
      ws.onmessage = (event) => this.handleMessage(event.data)
      ws.onclose = () => {
        if (this.socket !== ws) return
        this.socket = null
        this.pending.forEach((p) => p.reject(new Error('Connection to the assistant core closed.')))
        this.pending.clear()
        this.wakeWaiters(false)
        this.setStatus('closed')
        this.scheduleReconnect()
      }
      ws.onerror = () => {
        ws.close()
      }
    } catch (error) {
      this.connecting = false
      this.setStatus('closed')
      this.scheduleReconnect()
    }
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const send = (): void => {
        const ws = this.socket
        const id = this.nextId++
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        const message: ClientMessage = { type: 'req', id, method, params: (params ?? {}) as Record<string, never> }
        ws?.send(JSON.stringify(message))
      }
      if (this.status === 'open' && this.socket?.readyState === WebSocket.OPEN) {
        send()
      } else {
        this.waiters.add(() => (this.status === 'open' ? send() : reject(new Error('No connection to the assistant core.'))))
      }
    })
  }

  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStatus(listener: (status: CoreStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  dispose(): void {
    this.stopped = true
    this.unsubscribeRestart()
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = null
    this.wakeWaiters(false)
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let message: ServerMessage
    try {
      message = JSON.parse(data) as ServerMessage
    } catch {
      return
    }
    if (message.type === 'res') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    } else if (message.type === 'event') {
      this.eventListeners.forEach((listener) => listener(message.event))
    }
  }

  private setStatus(status: CoreStatus): void {
    this.status = status
    this.statusListeners.forEach((listener) => listener(status))
    if (status === 'open') this.wakeWaiters(true)
  }

  private wakeWaiters(open: boolean): void {
    this.waiters.forEach((wake) => wake())
    this.waiters.clear()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = this.backoffMs
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      void this.connect()
    }, delay)
  }
}

export const core = new CoreClient()