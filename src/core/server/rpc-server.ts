import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve, sep } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { contentTypeFor } from '../../main/preview-files'
import type { EventBus } from '../events'
import type { FailOutcome, SignInGuard } from './sign-in-guard'
import type { ClientMessage, CoreEvent, RpcMethod, ServerMessage } from '../../shared/protocol'

/** Who is on the other end of a connection: the Deskmates UI itself, or a connected coding agent. */
export type CallerRole = 'app' | 'agent'
export type HandlerContext = { caller: CallerRole }

export type Handler = (params: any, context: HandlerContext) => unknown | Promise<unknown>
export type Handlers = Partial<Record<RpcMethod, Handler>>

/** Static files served over plain HTTP alongside the WebSocket endpoint (phone access, spec 5.12). */
export interface Www {
  /** Directory served as the site root. */
  root: string
  /** Exact URL paths served as inline HTML (e.g. `/login`); win over files on disk. */
  routes?: Record<string, string>
  /** Rewrites the index document before it's served, e.g. to patch its CSP and inject a bootstrap. */
  transformIndex?: (html: string) => string
  /** Content-Security-Policy applied to every HTML response (index and routes). */
  htmlCsp?: string
}

/** Largest static file the phone server will serve (the built renderer bundle). */
const WWW_MAX_FILE_BYTES = 64 * 1024 * 1024

/** What an agent-token connection may do: the methods it may call and the events it may receive. */
export interface AgentAccess {
  token: string
  methods: readonly RpcMethod[]
  events: readonly CoreEvent['type'][]
}

export const AGENT_METHOD_DENIED = "This method isn't available to connected agents."

/**
 * Starts the token-protected WebSocket JSON-RPC server the UI talks to, and optionally a second,
 * more restricted token for connected coding agents. Listens on 127.0.0.1 by default; phone access
 * (spec 5.12) passes `host: '0.0.0.0'` plus `www` so the same port also serves the built app.
 */
export async function startRpcServer(options: {
  handlers: Handlers
  bus: EventBus
  port?: number
  token?: string
  agent?: AgentAccess
  host?: string
  www?: Www
  /** Counts wrong tokens per remote address and refuses sign-ins after too many (phone access). */
  guard?: SignInGuard
}): Promise<{ port: number; token: string; close(): Promise<void> }> {
  const { handlers, bus, agent, guard } = options
  const token = options.token ?? randomBytes(24).toString('hex')
  const www = options.www

  const warnLocked = (outcome: FailOutcome): void => {
    if (!outcome.locked) return
    const minutes = Math.round(outcome.retryAfterMs / 60_000)
    bus.emit({
      type: 'notify',
      title: 'Phone access blocked',
      body:
        outcome.scope === 'device'
          ? `A device on your network entered a wrong phone code too many times. It's blocked for ${minutes} minutes.`
          : `Too many wrong phone codes. Phone sign-in is paused for ${minutes} minutes; make a new code in Settings to reopen it now.`
    })
  }

  const httpServer = www
    ? createServer((req, res) => {
        if (guard && req.url?.split('?')[0] === '/auth') {
          void checkCode(req, res, token, guard, warnLocked)
          return
        }
        serveWww(req, res, www)
      })
    : createServer((_req, res) => {
        res.writeHead(404)
        res.end()
      })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  // Which token a connection authenticated with; looked up again for every message and broadcast.
  const roles = new WeakMap<WebSocket, CallerRole>()

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const supplied = url.searchParams.get('token') ?? ''
    const device = req.socket.remoteAddress ?? ''
    if (guard && !guard.check(device).allowed) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }
    const role = roleForToken(supplied, token, agent)
    if (!role) {
      if (guard) warnLocked(guard.fail(device))
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    guard?.succeed(device)
    wss.handleUpgrade(req, socket, head, (ws) => {
      roles.set(ws, role)
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    const role = roles.get(ws) ?? 'app'
    ws.on('message', (data) => {
      handleMessage(ws, data, handlers, role, agent).catch((error: unknown) => {
        console.error('[core] rpc message handling failed', error)
      })
    })
  })

  const unsubscribe = bus.on((event) => {
    broadcast(wss, event, roles, agent)
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve())
  })

  const address = httpServer.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    token,
    async close() {
      unsubscribe()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()))
      })
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

/**
 * POST /auth with the code as the body: 200 when it's right, 401 with the tries left when it's wrong,
 * 429 with the seconds to wait while this device (or every sign-in) is blocked. The phone checks its
 * code here before opening the socket, so a stale code can't burn tries in a reconnect loop.
 */
async function checkCode(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  guard: SignInGuard,
  warnLocked: (outcome: FailOutcome) => void
): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return reply(405, { ok: false })
  const device = req.socket.remoteAddress ?? ''
  const verdict = guard.check(device)
  if (!verdict.allowed) {
    req.resume()
    return reply(429, { ok: false, retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000) })
  }
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > 64) return reply(400, { ok: false })
  }
  if (tokensMatch(body.trim(), token)) {
    guard.succeed(device)
    return reply(200, { ok: true })
  }
  const outcome = guard.fail(device)
  warnLocked(outcome)
  if (outcome.locked) return reply(429, { ok: false, retryAfterSeconds: Math.ceil(outcome.retryAfterMs / 1000) })
  return reply(401, { ok: false, triesLeft: outcome.triesLeft })
}

/** 'app' for the primary token, 'agent' for the agent token (when configured), null for anything else. */
function roleForToken(supplied: string, appToken: string, agent: AgentAccess | undefined): CallerRole | null {
  if (tokensMatch(supplied, appToken)) return 'app'
  if (agent && tokensMatch(supplied, agent.token)) return 'agent'
  return null
}

async function handleMessage(
  ws: WebSocket,
  data: WebSocket.RawData,
  handlers: Handlers,
  role: CallerRole,
  agent: AgentAccess | undefined
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString())
  } catch {
    return
  }
  if (!isClientMessage(parsed)) return

  const { id, method, params } = parsed

  if (role === 'agent' && !agent?.methods.includes(method)) {
    send(ws, { type: 'res', id, ok: false, error: AGENT_METHOD_DENIED })
    return
  }

  const handler = handlers[method]
  if (!handler) {
    send(ws, { type: 'res', id, ok: false, error: `Unknown method: ${method}` })
    return
  }
  try {
    const result = await handler(params, { caller: role })
    send(ws, { type: 'res', id, ok: true, result: result ?? null })
  } catch (error) {
    send(ws, { type: 'res', id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.type === 'req' && typeof candidate.id === 'number' && typeof candidate.method === 'string'
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

/** Broadcasts a bus event to every connection, filtering agent connections to their allowed event types. */
function broadcast(
  wss: WebSocketServer,
  event: CoreEvent,
  roles: WeakMap<WebSocket, CallerRole>,
  agent: AgentAccess | undefined
): void {
  const payload = JSON.stringify({ type: 'event', event } satisfies ServerMessage)
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    const role = roles.get(client) ?? 'app'
    if (role === 'agent' && !agent?.events.includes(event.type)) continue
    client.send(payload)
  }
}

/** Constant-time token comparison; length is checked first because timingSafeEqual throws on a mismatch. */
function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Serves `www` over plain HTTP: inline routes first, then files from `www.root`. */
function serveWww(req: IncomingMessage, res: ServerResponse, www: Www): void {
  let pathname: string
  try {
    // Split the raw URL (new URL() would normalize %2e%2e to '.' before the traversal guard sees it),
    // drop the query, then decode.
    pathname = decodeURIComponent((req.url ?? '/').split('?')[0])
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  const route = www.routes?.[pathname]
  if (route !== undefined) {
    sendWwwHtml(res, Buffer.from(route, 'utf8'), www.htmlCsp)
    return
  }

  const target = resolveWwwFile(www.root, pathname)
  if (!target) {
    res.writeHead(404)
    res.end()
    return
  }

  let body: Buffer
  try {
    body = target.isIndex && www.transformIndex ? Buffer.from(www.transformIndex(readFileSync(target.path, 'utf8')), 'utf8') : readFileSync(target.path)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }

  if (target.contentType === 'text/html') {
    sendWwwHtml(res, body, www.htmlCsp)
    return
  }
  res.writeHead(200, {
    'Content-Type': target.contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(body)
}

function sendWwwHtml(res: ServerResponse, body: Buffer, csp: string | undefined): void {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
  if (csp) headers['Content-Security-Policy'] = csp
  res.writeHead(200, headers)
  res.end(body)
}

/**
 * Resolves a URL path to a file inside `root`, rejecting escapes: traversal (`..`), backslashes,
 * NUL bytes, non-files, oversized files and symlinks that point outside the root. Mirrors
 * preview-files.resolvePreviewRequest, which serves a different (design-folder) tree.
 */
function resolveWwwFile(root: string, pathname: string): { path: string; contentType: string; isIndex: boolean } | null {
  let relative = pathname.split('/').filter((segment) => segment.length > 0).join('/')
  if (relative === '') relative = 'index.html'
  if (relative.includes('\\') || relative.includes('\0')) return null
  if (relative.split('/').some((segment) => segment === '..')) return null

  const folder = resolve(root)
  const absolute = resolve(folder, relative)
  if (absolute !== folder && !absolute.startsWith(folder + sep)) return null

  let stats
  try {
    stats = statSync(absolute)
  } catch {
    return null
  }
  if (!stats.isFile() || stats.size >= WWW_MAX_FILE_BYTES) return null

  // A symlink inside the served folder must not resolve outside it.
  let realFile: string
  let realRoot: string
  try {
    realFile = realpathSync.native(absolute)
    realRoot = realpathSync.native(folder)
  } catch {
    return null
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return null

  return { path: realFile, contentType: contentTypeFor(realFile), isIndex: relative === 'index.html' }
}
