/**
 * Talking to Deskmates on the PC from the notes app: the same encrypted relay the rest of the phone
 * app uses, with a small request/response client on top. Loaded only when the Deskmates bar opens.
 */
import type { RpcMethod, RpcParams, RpcResult, ServerMessage } from '../../../../shared/protocol'
import type { RemoteDevice } from '../../remote/relay'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class PcClient {
  private socket: WebSocket | null = null
  private opening: Promise<WebSocket> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly device: RemoteDevice) {}

  private open(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === 1) return Promise.resolve(this.socket)
    this.opening ??= (async () => {
      const { RelayConnection, RelaySocket } = await import('../../remote/relay')
      const connection = new RelayConnection(this.device)
      const socket = new RelaySocket(connection) as unknown as WebSocket
      return await new Promise<WebSocket>((resolve, reject) => {
        socket.onopen = () => {
          this.socket = socket
          resolve(socket)
        }
        socket.onclose = () => {
          this.socket = null
          this.opening = null
          for (const p of this.pending.values()) p.reject(new Error('Deskmates on your PC isn’t answering. Is it on?'))
          this.pending.clear()
          reject(new Error('Deskmates on your PC isn’t answering. Is it on?'))
        }
        socket.onmessage = (event) => this.receive(event.data)
      })
    })().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let message: ServerMessage
    try {
      message = JSON.parse(data) as ServerMessage
    } catch {
      return
    }
    if (message.type !== 'res') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error))
  }

  async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const socket = await this.open()
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      socket.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}

let shared: { device: RemoteDevice; client: PcClient } | null = null

export function pcClient(device: RemoteDevice): PcClient {
  if (!shared || shared.device.device !== device.device) {
    shared?.client.close()
    shared = { device, client: new PcClient(device) }
  }
  return shared.client
}

/** Asks and waits for the answer, checking every couple of seconds (answers can take minutes). */
export async function askAndWait(
  client: PcClient,
  params: RpcParams<'notes.ask'>,
  onStatus?: (status: string) => void,
  signal?: AbortSignal
): Promise<{ taskId: string; text: string }> {
  const startedAt = Date.now() - 2000
  const { taskId } = await client.call('notes.ask', params)
  let seen = false
  for (let tries = 0; tries < 600; tries++) {
    if (signal?.aborted) throw new Error('Stopped.')
    await new Promise((r) => setTimeout(r, tries < 5 ? 1200 : 2500))
    const result = await client.call('notes.reply', { taskId, after: startedAt })
    if (result.status === 'running' || result.status === 'waiting-approval') {
      seen = true
      onStatus?.(result.status === 'waiting-approval' ? 'Waiting for approval on your PC…' : 'Thinking…')
      continue
    }
    if (result.status === 'error') throw new Error(result.error ?? 'Freebuff couldn’t answer.')
    const last = result.replies[result.replies.length - 1]
    if (last) return { taskId, text: last.text }
    if (seen || tries > 8) throw new Error('No answer came back. Look in Deskmates on your PC (Work → Notes).')
  }
  throw new Error('This is taking too long. The answer will be in Deskmates on your PC (Work → Notes).')
}

/** The JSON list inside a reply (models sometimes wrap it in text or a code block). */
export function jsonList<T>(text: string): T[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}
