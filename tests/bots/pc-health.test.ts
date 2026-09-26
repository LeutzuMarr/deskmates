import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { PcEndpoints } from '../../src/core/bots/host'
import { probePcServices, waitForPcServices } from '../../src/core/bots/pc-health'

const TOKEN = 'health-token'
const servers: Server[] = []

/** One in-process server standing in for both the agent (`/health`, token-checked like agent.py) and CDP (`/json/version`). */
async function startPc(options: { cdpUp: boolean }): Promise<PcEndpoints> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const ok = req.headers['x-deskmates-token'] === TOKEN
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ok ? { status: 'ok' } : { error: 'missing or invalid token' }))
      return
    }
    if (req.url === '/json/version' && options.cdpUp) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ Browser: 'Chrome/140' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  servers.push(server)
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  const base = `http://127.0.0.1:${port}`
  return { agent: base, cdp: base, novnc: base, token: TOKEN }
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('probePcServices', () => {
  it('is true only when the agent answers /health with the token and the browser answers /json/version', async () => {
    const endpoints = await startPc({ cdpUp: true })
    expect(await probePcServices(endpoints)).toBe(true)
    expect(await probePcServices({ ...endpoints, token: 'wrong' })).toBe(false)
  })

  it('is false while the browser is not up yet', async () => {
    expect(await probePcServices(await startPc({ cdpUp: false }))).toBe(false)
  })

  it('is false, not a throw, when nothing is listening at all', async () => {
    const endpoints = await startPc({ cdpUp: true })
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
    expect(await probePcServices(endpoints)).toBe(false)
  })
})

describe('waitForPcServices', () => {
  const endpoints: PcEndpoints = { agent: 'http://a', cdp: 'http://c', novnc: 'http://n', token: 't' }

  it('keeps probing until the PC answers', async () => {
    let calls = 0
    const ready = await waitForPcServices(endpoints, async () => ++calls >= 3, 10_000)
    expect(ready).toBe(true)
    expect(calls).toBe(3)
  })

  it('gives up after the timeout, having probed at least once', async () => {
    let calls = 0
    const ready = await waitForPcServices(
      endpoints,
      async () => {
        calls++
        return false
      },
      0
    )
    expect(ready).toBe(false)
    expect(calls).toBe(1)
  })
})
