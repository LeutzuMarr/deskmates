/**
 * A small Chrome DevTools Protocol client: one WebSocket to the browser, with flat sessions for the
 * tabs it attaches to. Only what the Chrome tools need; no Puppeteer.
 */
import WebSocket from 'ws'

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export class CdpError extends Error {}

export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private closedListeners: Array<() => void> = []
  private closed = false

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.receive(String(data)))
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
  }

  /**
   * Opens the browser's DevTools socket. When the user has turned remote debugging on in Chrome,
   * Chrome asks them to allow the connection first, so this can take as long as they take to answer.
   */
  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new CdpError('Chrome did not accept the connection in time.'))
      }, timeoutMs)
      timer.unref?.()
      socket.once('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new CdpError(error.message))
      })
      socket.once('unexpected-response', (_req, res) => {
        clearTimeout(timer)
        reject(new CdpError(`Chrome refused the connection (HTTP ${res.statusCode}).`))
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('The connection to Chrome was closed.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`Chrome did not answer ${method} in time.`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (value: Record<string, unknown>) => void, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpError(error.message))
      })
    })
  }

  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(method, set)
    return () => set.delete(listener)
  }

  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.closedListeners.push(listener)
  }

  close(): void {
    this.socket.close()
    this.finish()
  }

  private receive(raw: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(message.id)
      if (message.error) entry.reject(new CdpError(message.error.message ?? 'Chrome returned an error.'))
      else entry.resolve(message.result ?? {})
      return
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params ?? {}, message.sessionId)
        } catch {
          // One bad listener must not stop the others.
        }
      }
    }
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new CdpError('The connection to Chrome was closed.'))
      this.pending.delete(id)
    }
    const listeners = this.closedListeners
    this.closedListeners = []
    listeners.forEach((listener) => listener())
  }
}
