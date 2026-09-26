import { get, request } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { EventBus } from '../../src/core/events'
import { createPhoneServer, generatePairingCode, isValidPairingCode, type PhoneServer } from '../../src/core/phone/server'
import type { Handlers } from '../../src/core/server/rpc-server'
import { DEFAULT_SETTINGS, type ServerMessage, type Settings } from '../../src/shared/protocol'

type Cleanup = () => Promise<void> | void

let cleanups: Cleanup[] = []

let tempDirs: string[] = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
  tempDirs = []
})

function tempRenderer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deskmates-phone-'))
  tempDirs.push(dir)
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src deskmates-preview:; connect-src ws://127.0.0.1:*"
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>`)
  writeFileSync(join(dir, 'asset.txt'), 'asset body')
  return dir
}

function settings(phoneAccess: boolean, pairingCode: string): Settings {
  return { ...DEFAULT_SETTINGS, phoneAccess, pairingCode }
}

/** Starts a phone server with the STANDARD handlers it needs for static+tests and cleanups it on teardown. */
function startPhone(opts: { rendererDir?: string; port?: number } = {}): PhoneServer {
  const handlers: Handlers = { 'app.info': () => ({ version: '0.1.0' }) }
  const phone = createPhoneServer({ rendererDir: opts.rendererDir, handlers: () => handlers, bus: new EventBus(), port: opts.port })
  cleanups.push(() => phone.stop())
  return phone
}

function connect(port: number, token: string | null): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = token === null ? '' : `?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`)
    ws.on('error', reject)
    ws.once('open', () => resolve(ws))
  })
}

function connectExpectingRejection(port: number, token: string | null): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const query = token === null ? '' : `?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`)
    ws.on('error', () => undefined)
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode)
      ws.terminate()
    })
    ws.once('open', () => reject(new Error('expected the handshake to be rejected')))
  })
}

function sendReq(ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<ServerMessage> {
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

function flipOneChar(code: string): string {
  const replacement = code[0] === '0' ? '1' : '0'
  return replacement + code.slice(1)
}

/** POSTs a code to /auth and resolves the status plus the JSON body. */
function postCode(port: number, code: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/auth', method: 'POST', agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end(code)
  })
}

/** Resolves a single HTTP GET; rejects when the server refuses the connection (no listener). */
function httpGet(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    // agent:false so the response doesn't come back through the keep-alive pool, whose sockets
    // outlive the per-test phone server.
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
  })
}

describe('pairing codes', () => {
  it('generates six-digit codes, including codes with leading zeros', () => {
    for (let i = 0; i < 500; i++) {
      const code = generatePairingCode()
      expect(code).toMatch(/^\d{6}$/)
    }
  })

  it('accepts only exactly-six-digit codes', () => {
    expect(isValidPairingCode('000000')).toBe(true)
    expect(isValidPairingCode('123456')).toBe(true)
    expect(isValidPairingCode('abc123')).toBe(false)
    expect(isValidPairingCode('12345')).toBe(false)
    expect(isValidPairingCode('1234567')).toBe(false)
    expect(isValidPairingCode('')).toBe(false)
    expect(isValidPairingCode('1234 5')).toBe(false)
  })
})

describe('createPhoneServer', () => {
  it('starts disabled and stays disabled until phoneAccess is on', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(false, ''))
    expect(info).toEqual({ enabled: false, port: null, urls: [], error: null })
  })

  it('reports an error (and never listens) when enabled without a renderer dir', async () => {
    const phone = startPhone({})
    const info = await phone.sync(settings(true, '123456'))
    expect(info.enabled).toBe(false)
    expect(info.error).toBeTruthy()
  })

  it('refuses to enable with an invalid pairing code', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '12ab'))
    expect(info.enabled).toBe(false)
    expect(info.error).toBeTruthy()
  })

  it('serves the login page, the index transformed for the phone, and plain assets', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '123456'))
    expect(info.enabled).toBe(true)
    const port = info.port as number

    const login = await httpGet(port, '/login')
    expect(login.status).toBe(200)
    expect(login.body).toContain('Sign in to Deskmates')
    expect(login.body).toContain('Pairing code')
    expect(login.type).toContain('text/html')

    const index = await httpGet(port, '/')
    expect(index.status).toBe(200)
    expect(index.body).toContain('id="root"')
    // The baked desktop CSP is relaxed for the phone...
    expect(index.body).not.toContain('connect-src ws://127.0.0.1')
    // ...and the bootstrap that wires up window.deskmates rides along.
    expect(index.body).toContain('deskmates:phone-token')

    const asset = await httpGet(port, '/asset.txt')
    expect(asset.status).toBe(200)
    expect(asset.body).toBe('asset body')

    const missing = await httpGet(port, '/nope.txt')
    expect(missing.status).toBe(404)
  })

  it('serves the transformed index with the phone CSP header', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '123456'))
    const port = info.port as number
    const req = await new Promise<{ header: string }>((resolve, reject) => {
      const r = get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        resolve({ header: String(res.headers['content-security-policy'] ?? '') })
      })
      r.on('error', reject)
    })
    expect(req.header).toContain("script-src 'self' 'unsafe-inline'")
    expect(req.header).toContain("connect-src 'self' ws: wss:")
  })

  it('resolves requests safely through the www root (no traversal escape)', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '123456'))
    const port = info.port as number

    const escaped = await httpGet(port, '/%2e%2e/%2e%2e/x.txt')
    expect(escaped.status).toBe(404)
    const encoded = await httpGet(port, '/%2e%2e/asset.txt')
    expect(encoded.status).toBe(404)
  })

  it('accepts websocket connections with the pairing code and rejects others with 401', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '123456'))
    const port = info.port as number

    const ws = await connect(port, '123456')
    const message = await sendReq(ws, 1, 'app.info')
    expect(message.type).toBe('res')
    expect(message).toMatchObject({ id: 1 })

    const [noCode, wrongCode] = await Promise.all([
      connectExpectingRejection(port, null),
      connectExpectingRejection(port, flipOneChar('123456'))
    ])
    expect(noCode).toBe(401)
    expect(wrongCode).toBe(401)
  })

  it('checks codes at /auth and blocks a device after five wrong tries, socket included', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '123456'))
    const port = info.port as number

    expect(await postCode(port, '123456')).toEqual({ status: 200, body: { ok: true } })
    for (let left = 4; left >= 1; left--) {
      expect(await postCode(port, '000000')).toEqual({ status: 401, body: { ok: false, triesLeft: left } })
    }
    const fifth = await postCode(port, '000000')
    expect(fifth.status).toBe(429)
    expect(fifth.body.retryAfterSeconds).toBe(900)
    // Locked out: even the right code, and even straight at the socket, is refused.
    expect((await postCode(port, '123456')).status).toBe(429)
    expect(await connectExpectingRejection(port, '123456')).toBe(429)
  })

  it('counts wrong socket tokens too, and a new code opens the door again', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const port = (await phone.sync(settings(true, '123456'))).port as number
    for (let i = 0; i < 5; i++) expect(await connectExpectingRejection(port, '000000')).toBe(401)
    expect(await connectExpectingRejection(port, '123456')).toBe(429)

    const fresh = await phone.sync(settings(true, '654321'))
    const ws = await connect(fresh.port as number, '654321')
    ws.close()
  })

  it('closes the port again when phone access is switched off', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '123456'))
    const off = await phone.sync(settings(false, ''))
    expect(off).toEqual({ enabled: false, port: null, urls: [], error: null })
    await expect(httpGet(info.port as number, '/login')).rejects.toBeTruthy()
  })

  it('restarts on a new pairing code and moves the door to the new code', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const first = await phone.sync(settings(true, '123456'))
    const port = first.port as number

    const viaFirstCode = await connect(port, '123456')
    viaFirstCode.terminate()
    // A different code restarts the listener (same port) under the new token.
    const second = await phone.sync(settings(true, '654321'))
    expect(second.port).toBe(port)
    await expect(connectExpectingRejection(port, '123456')).resolves.toBe(401)
    const ws = await connect(port, '654321')
    ws.terminate()
  })

  it('keeps serving when synced again with the same code', async () => {
    const phone = startPhone({ rendererDir: tempRenderer() })
    const info = await phone.sync(settings(true, '123456'))
    const port = info.port as number
    const again = await phone.sync(settings(true, '123456'))
    expect(again.port).toBe(port)
    const ws = await connect(port, '123456')
    ws.terminate()
  })
})