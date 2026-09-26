import { get } from 'node:http'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { EventBus } from '../../src/core/events'
import { AGENT_METHOD_DENIED, startRpcServer, type AgentAccess, type Handlers } from '../../src/core/server/rpc-server'
import type { RpcMethod, ServerMessage } from '../../src/shared/protocol'

type Cleanup = () => Promise<void> | void

let cleanups: Cleanup[] = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

async function start(handlers: Handlers = {}, bus: EventBus = new EventBus(), agent?: AgentAccess) {
  const server = await startRpcServer({ handlers, bus, port: 0, agent })
  cleanups.push(() => server.close())
  return { server, bus }
}

/** Connects with the ws client and resolves once the handshake completes. */
function connect(port: number, token: string | null): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = token === null ? '' : `?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`)
    ws.on('error', reject)
    ws.once('open', () => resolve(ws))
  })
}

/** Connects expecting the handshake to be rejected; resolves with the HTTP status code. */
function connectExpectingRejection(port: number, token: string | null): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const query = token === null ? '' : `?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`)
    ws.on('error', () => {
      // Expected: the server destroys the socket after a 401, which surfaces as a client error too.
    })
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode)
      ws.terminate()
    })
    ws.once('open', () => reject(new Error('expected the handshake to be rejected')))
  })
}

function sendReq(ws: WebSocket, id: number, method: RpcMethod, params: unknown = {}): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as ServerMessage
      if (message.type === 'res' && message.id === id) {
        ws.off('message', onMessage)
        resolve(message)
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'req', id, method, params }))
  })
}

/** Returns a token the same length as `token` that differs from it by exactly one character. */
function flipOneChar(token: string): string {
  const replacement = token[0] === '0' ? '1' : '0'
  return replacement + token.slice(1)
}

/** Picks a non-internal (i.e. not loopback) local IPv4 address, if this machine has one. */
function findNonInternalIPv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

/**
 * Attempts a raw TCP connection and reports whether it was accepted. A regression that makes
 * the server listen on all interfaces would connect near-instantly; anything else (an explicit
 * ECONNREFUSED, or - observed on Windows, where an unsolicited SYN to a non-loopback local
 * address with no listener is silently dropped rather than RST'd - a timeout) proves it wasn't.
 */
function attemptConnection(host: string, port: number, timeoutMs = 2000): Promise<{ accepted: boolean; code?: string }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs })
    const finish = (result: { accepted: boolean; code?: string }) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish({ accepted: true }))
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ accepted: false, code: error.code }))
    socket.once('timeout', () => finish({ accepted: false, code: 'ETIMEDOUT' }))
  })
}

const nonInternalIPv4 = findNonInternalIPv4()
if (!nonInternalIPv4) {
  console.warn(
    '[rpc-server.test] no non-internal IPv4 address found on this machine; skipping the loopback-only bind check'
  )
}
/** Runs the test only when this machine has a non-loopback local address to probe. */
const itIfNonLoopbackAvailable = nonInternalIPv4 ? it : it.skip

describe('startRpcServer', () => {
  it('rejects a connection with no token, a shorter wrong token, and a same-length wrong token, all with HTTP 401', async () => {
    const { server } = await start()
    // Same length as server.token (so a regression that only checks length, and skips the
    // timingSafeEqual content comparison, would wrongly accept this) but differs by one character.
    const sameLengthWrongToken = flipOneChar(server.token)
    expect(sameLengthWrongToken).not.toBe(server.token)
    expect(sameLengthWrongToken.length).toBe(server.token.length)

    const [noToken, shorterWrongToken, sameLengthWrongTokenStatus] = await Promise.all([
      connectExpectingRejection(server.port, null),
      connectExpectingRejection(server.port, 'not-the-token'),
      connectExpectingRejection(server.port, sameLengthWrongToken)
    ])
    expect(noToken).toBe(401)
    expect(shorterWrongToken).toBe(401)
    expect(sameLengthWrongTokenStatus).toBe(401)
  })

  it("returns a handler's result for a known method", async () => {
    const handlers: Handlers = {
      'app.info': async () => ({ version: '0.1.0', dataDir: '/data', keys: [] })
    }
    const { server } = await start(handlers)
    const ws = await connect(server.port, server.token)
    cleanups.push(() => ws.close())

    const res = await sendReq(ws, 1, 'app.info')

    expect(res).toEqual({
      type: 'res',
      id: 1,
      ok: true,
      result: { version: '0.1.0', dataDir: '/data', keys: [] }
    })
  })

  it('returns ok: false with the message when a handler throws', async () => {
    const handlers: Handlers = {
      'app.info': () => {
        throw new Error('boom')
      }
    }
    const { server } = await start(handlers)
    const ws = await connect(server.port, server.token)
    cleanups.push(() => ws.close())

    const res = await sendReq(ws, 7, 'app.info')

    expect(res).toEqual({ type: 'res', id: 7, ok: false, error: 'boom' })
  })

  it('returns an error for an unknown method', async () => {
    const { server } = await start({})
    const ws = await connect(server.port, server.token)
    cleanups.push(() => ws.close())

    const res = await sendReq(ws, 3, 'app.info')

    expect(res).toEqual({ type: 'res', id: 3, ok: false, error: 'Unknown method: app.info' })
  })

  it('delivers bus events to a connected client', async () => {
    const bus = new EventBus()
    const { server } = await start({}, bus)
    const ws = await connect(server.port, server.token)
    cleanups.push(() => ws.close())

    const received = new Promise<ServerMessage>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())))
    })
    bus.emit({ type: 'notify', title: 'Hi', body: 'there' })

    await expect(received).resolves.toEqual({
      type: 'event',
      event: { type: 'notify', title: 'Hi', body: 'there' }
    })
  })

  it('listens on 127.0.0.1 and answers plain HTTP requests with 404', async () => {
    const { server } = await start()

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port: server.port, path: '/' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
    })

    expect(status).toBe(404)
  })

  // Test 6 above only proves 127.0.0.1 works; it would still pass if a regression dropped the
  // '127.0.0.1' host argument to listen() and the server bound to all interfaces instead. This
  // proves the negative: a non-loopback local address must NOT reach the server.
  itIfNonLoopbackAvailable('refuses a connection on a non-loopback local address', async () => {
    const { server } = await start()

    const result = await attemptConnection(nonInternalIPv4 as string, server.port)

    expect(result.accepted).toBe(false)
  })

  describe('the agent role', () => {
    const AGENT_TOKEN = 'agent-token-' + '7'.repeat(36)
    const agent: AgentAccess = {
      token: AGENT_TOKEN,
      methods: ['app.info', 'projects.list'],
      events: ['project.updated']
    }

    it('the agent token calls an allowed method and gets the result', async () => {
      const handlers: Handlers = {
        'app.info': async () => ({ version: '0.1.0', dataDir: '/data', keys: [] })
      }
      const { server } = await start(handlers, new EventBus(), agent)
      const ws = await connect(server.port, AGENT_TOKEN)
      cleanups.push(() => ws.close())

      const res = await sendReq(ws, 1, 'app.info')

      expect(res).toEqual({
        type: 'res',
        id: 1,
        ok: true,
        result: { version: '0.1.0', dataDir: '/data', keys: [] }
      })
    })

    it('a disallowed method is refused before the handler runs', async () => {
      let called = false
      const handlers: Handlers = {
        'settings.get': () => {
          called = true
          return {}
        }
      }
      const { server } = await start(handlers, new EventBus(), agent)
      const ws = await connect(server.port, AGENT_TOKEN)
      cleanups.push(() => ws.close())

      const res = await sendReq(ws, 1, 'settings.get')

      expect(res).toEqual({ type: 'res', id: 1, ok: false, error: AGENT_METHOD_DENIED })
      expect(called).toBe(false)
    })

    it('an agent connection only receives its allowed event types', async () => {
      const bus = new EventBus()
      const { server } = await start({}, bus, agent)
      const ws = await connect(server.port, AGENT_TOKEN)
      cleanups.push(() => ws.close())

      const firstMessage = new Promise<ServerMessage>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())))
      })
      // Emitted first: if it were delivered, firstMessage would resolve to it instead.
      bus.emit({ type: 'notify', title: 'Hi', body: 'there' })
      bus.emit({
        type: 'project.updated',
        project: { id: 'p1', name: 'X', folder: 'D:\\x', model: null, createdAt: 1, kind: 'work' }
      })

      await expect(firstMessage).resolves.toMatchObject({ type: 'event', event: { type: 'project.updated' } })
    })

    it('the app token keeps full access to methods and events outside the agent list', async () => {
      const handlers: Handlers = {
        'settings.get': () => ({ ok: true })
      }
      const bus = new EventBus()
      const { server } = await start(handlers, bus, agent)
      const ws = await connect(server.port, server.token)
      cleanups.push(() => ws.close())

      const res = await sendReq(ws, 1, 'settings.get')
      expect(res).toEqual({ type: 'res', id: 1, ok: true, result: { ok: true } })

      const received = new Promise<ServerMessage>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())))
      })
      bus.emit({ type: 'notify', title: 'Hi', body: 'there' }) // Not in agent.events, but the app gets everything.
      await expect(received).resolves.toEqual({
        type: 'event',
        event: { type: 'notify', title: 'Hi', body: 'there' }
      })
    })

    it('a token that is neither the app token nor the agent token gets 401', async () => {
      const { server } = await start({}, new EventBus(), agent)

      const status = await connectExpectingRejection(server.port, 'totally-wrong-token')

      expect(status).toBe(401)
    })

    it("handlers see the caller's role via context", async () => {
      const seen: string[] = []
      const handlers: Handlers = {
        'app.info': async (_params, context) => {
          seen.push(context.caller)
          return { version: '0.1.0', dataDir: '/data', keys: [] }
        }
      }
      const { server } = await start(handlers, new EventBus(), agent)

      const agentWs = await connect(server.port, AGENT_TOKEN)
      cleanups.push(() => agentWs.close())
      await sendReq(agentWs, 1, 'app.info')

      const appWs = await connect(server.port, server.token)
      cleanups.push(() => appWs.close())
      await sendReq(appWs, 2, 'app.info')

      expect(seen).toEqual(['agent', 'app'])
    })
  })
})
