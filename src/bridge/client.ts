import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { RpcMethod, RpcParams, RpcResult } from '../shared/protocol'

export const NOT_RUNNING_MESSAGE = "Deskmates isn't running. Start the app, then try again."

/** Thrown when the core isn't reachable: no bridge.json, or a refused connection. */
export class NotRunningError extends Error {
  constructor() {
    super(NOT_RUNNING_MESSAGE)
    this.name = 'NotRunningError'
  }
}

interface BridgeInfo {
  port: number
  token: string
}

function readBridgeInfo(dataDir: string): BridgeInfo {
  let raw: string
  try {
    raw = readFileSync(join(dataDir, 'agent-kit', 'bridge.json'), 'utf8')
  } catch {
    throw new NotRunningError()
  }
  try {
    const parsed = JSON.parse(raw) as BridgeInfo
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string') return parsed
  } catch {
    // Falls through.
  }
  throw new NotRunningError()
}

/** The 30s request timeout, matching the core's own RPC budget. */
const CALL_TIMEOUT_MS = 30_000

export interface CoreClient {
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>
  close(): void
}

/**
 * Connects to the running app's core over its token-protected WebSocket.
 * The port and token come from <dataDir>/agent-kit/bridge.json, which the core
 * writes while it runs and deletes on exit. Throws NotRunningError when the
 * file is missing or the connection is refused.
 */
export async function connectCore(options: { dataDir: string }): Promise<CoreClient> {
  const info = readBridgeInfo(options.dataDir)
  const ws = await openSocket(info)

  let nextId = 1
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()

  ws.on('message', (data: WebSocket.RawData) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const message = parsed as { type?: string; id?: number; ok?: boolean }
    if (message.type === 'event') return // Events are for the app's UI, not for us.
    if (message.type !== 'res' || typeof message.id !== 'number') return
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.ok) waiting.resolve((parsed as { result?: unknown }).result ?? null)
    else waiting.reject(new Error((parsed as { error?: string }).error ?? 'Unknown core error'))
  })

  return {
    call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      return new Promise<RpcResult<M>>((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Deskmates didn't answer ${method} within ${CALL_TIMEOUT_MS / 1000}s.`))
        }, CALL_TIMEOUT_MS)
        timer.unref?.()
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value as RpcResult<M>)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          }
        })
        try {
          ws.send(JSON.stringify({ type: 'req', id, method, params }))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    close() {
      for (const waiting of pending.values()) waiting.reject(new Error('Connection closed.'))
      pending.clear()
      ws.close()
    }
  }
}

/** Opens the WebSocket, resolving on open and failing as NotRunningError otherwise. */
function openSocket(info: BridgeInfo): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new NotRunningError())
    }, 5_000)
    timer.unref?.()
    ws.once('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.once('error', () => {
      clearTimeout(timer)
      reject(new NotRunningError())
    })
  })
}
