import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// agent.py is a standalone stdlib-only Python HTTP service (see bot-image/agent.py); these tests
// run it directly as a child process, against a fake `xdotool` on PATH and temp data/shared
// folders, matching the "no Docker/WSL/network in tests" rule from the stage-2 plan.

const AGENT_SCRIPT = fileURLToPath(new URL('../../bot-image/agent.py', import.meta.url))
const TOKEN = 'test-token-3f9c2a'

interface PythonInfo {
  cmd: string
  exe: string
  version: string
}

function findPython(): PythonInfo | null {
  for (const cmd of ['python3', 'python']) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
    if (probe.error || probe.status !== 0) continue
    const versionText = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim()
    if (!/^Python 3\./.test(versionText)) continue
    const exeProbe = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
    const exe = exeProbe.stdout?.trim()
    if (exeProbe.status !== 0 || !exe) continue
    return { cmd, exe, version: versionText }
  }
  return null
}

const pythonInfo = findPython()
if (!pythonInfo) {
  console.warn(
    '[agent-service.test.ts] Skipping: no Python 3 interpreter found on PATH (tried "python3" then "python"). ' +
      'Install Python 3 to run this suite.'
  )
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('could not determine a free port')))
      }
    })
  })
}

// A minimal fake xdotool: logs its argv (as one JSON array per line) to FAKE_XDOTOOL_LOG, and
// returns canned output for the read subcommands agent.py's /windows handler uses.
const FAKE_XDOTOOL_BODY = `import json, os, sys

log_path = os.environ.get("FAKE_XDOTOOL_LOG")
if log_path:
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(sys.argv[1:]) + "\\n")

args = sys.argv[1:]
if args and args[0] == "search":
    print("111")
    print("222")
elif args and args[0] == "getwindowname":
    print("Fake Window " + args[-1])
elif args and args[0] == "getwindowgeometry":
    print("WINDOW=" + args[-1])
    print("X=10")
    print("Y=20")
    print("WIDTH=1280")
    print("HEIGHT=800")
    print("SCREEN=0")
sys.exit(0)
`

/** Writes a fake `xdotool` onto `binDir` that Python's subprocess (shell=False) can launch directly. */
function writeFakeXdotool(binDir: string, pythonExe: string): void {
  writeFileSync(path.join(binDir, 'fake_xdotool.py'), FAKE_XDOTOOL_BODY, 'utf8')
  if (process.platform === 'win32') {
    // A bare "xdotool" without shell=True can't launch a .cmd on Windows (CreateProcess doesn't
    // walk PATHEXT) - agent.py resolves xdotool via shutil.which() first specifically so this
    // works: which() does consult PATHEXT and hands back the .cmd's full path, which Windows can
    // then launch directly.
    writeFileSync(path.join(binDir, 'xdotool.cmd'), `@echo off\r\n"${pythonExe}" "%~dp0fake_xdotool.py" %*\r\n`, 'utf8')
  } else {
    writeFileSync(path.join(binDir, 'xdotool'), `#!/usr/bin/env python3\n${FAKE_XDOTOOL_BODY}`, { mode: 0o755 })
  }
}

/** Best-effort probe: can this environment create a symlink/junction at all? Windows needs either
 * admin rights or Developer Mode for a true symlink, but NOT for a directory junction - tried first. */
function canMakeReparsePoint(): boolean {
  const base = mkdtempSync(path.join(tmpdir(), 'dm-reparse-probe-'))
  try {
    const target = path.join(base, 'target')
    mkdirSync(target)
    symlinkSync(target, path.join(base, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

interface HealthBody {
  status: string
  agentVersion: string
  pythonVersion: string
  display: string
  x: boolean
  vnc: boolean
  chromium: boolean
  chromiumVersion: string | null
}

interface WindowsBody {
  windows: Array<{ id: string; name: string; x: number; y: number; width: number; height: number }>
}

interface ExecBody {
  code: number | null
  timedOut: boolean
  stdout: string
  stdoutTruncated: boolean
  stderr: string
  stderrTruncated: boolean
}

describe.skipIf(!pythonInfo)('bot-image agent.py', () => {
  let tmpRoot: string
  let dataDir: string
  let sharedDir: string
  let fakeBinDir: string
  let xdotoolLog: string
  let baseUrl: string
  let child: ChildProcessByStdio<null, Readable, Readable>
  let childOutput: string[]
  const reparseSupported = canMakeReparsePoint()

  async function req(method: string, urlPath: string, opts: { token?: string | null; body?: string; json?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    if (opts.token !== null) headers['X-Deskmates-Token'] = opts.token ?? TOKEN
    let body = opts.body
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    }
    return fetch(`${baseUrl}${urlPath}`, { method, headers, body })
  }

  async function waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError = 'no attempt made'
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/health`, { headers: { 'X-Deskmates-Token': TOKEN } })
        if (res.status === 200) return
        lastError = `status ${res.status}`
      } catch (error) {
        lastError = String(error)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`agent.py did not become healthy within ${timeoutMs}ms (last: ${lastError}).\noutput:\n${childOutput.join('')}`)
  }

  beforeAll(async () => {
    const info = pythonInfo!
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'dm-agent-test-'))
    dataDir = path.join(tmpRoot, 'data')
    sharedDir = path.join(tmpRoot, 'shared')
    fakeBinDir = path.join(tmpRoot, 'fakebin')
    xdotoolLog = path.join(tmpRoot, 'xdotool.log')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(sharedDir, { recursive: true })
    mkdirSync(fakeBinDir, { recursive: true })
    writeFakeXdotool(fakeBinDir, info.exe)

    const port = await getFreePort()
    baseUrl = `http://127.0.0.1:${port}`
    childOutput = []

    child = spawn(info.exe, [AGENT_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
        DESKMATES_TOKEN: TOKEN,
        DESKMATES_AGENT_PORT: String(port),
        DESKMATES_DATA_DIR: dataDir,
        DESKMATES_SHARED_DIR: sharedDir,
        DESKMATES_RUNTIME_DIR: path.join(tmpRoot, 'runtime'),
        FAKE_XDOTOOL_LOG: xdotoolLog,
        DISPLAY: ':0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk: Buffer) => childOutput.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => childOutput.push(chunk.toString()))

    await waitForHealth(10_000)
  })

  afterAll(() => {
    child?.kill()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe('authentication', () => {
    it('rejects a request with no token', async () => {
      const res = await req('GET', '/health', { token: null })
      expect(res.status).toBe(401)
    })

    it('rejects a request with the wrong token', async () => {
      const res = await req('GET', '/health', { token: 'not-the-token' })
      expect(res.status).toBe(401)
    })

    it('accepts a request with the right token', async () => {
      const res = await req('GET', '/health')
      expect(res.status).toBe(200)
    })
  })

  describe('GET /health', () => {
    it('reports versions and liveness flags', async () => {
      const res = await req('GET', '/health')
      expect(res.status).toBe(200)
      const body = (await res.json()) as HealthBody
      expect(body.status).toBe('ok')
      expect(body.agentVersion).toEqual(expect.any(String))
      expect(body.pythonVersion).toEqual(expect.any(String))
      expect(body.display).toEqual(expect.any(String))
      // No real X/Chromium/VNC in this test environment, so all three should read false - but the
      // important thing is that the handler doesn't throw when they're absent.
      expect(typeof body.x).toBe('boolean')
      expect(typeof body.vnc).toBe('boolean')
      expect(typeof body.chromium).toBe('boolean')
    })
  })

  describe('POST /input', () => {
    beforeEach(() => {
      writeFileSync(xdotoolLog, '')
    })

    function lastXdotoolCall(): unknown[] {
      const lines = readFileSync(xdotoolLog, 'utf8').split('\n').filter(Boolean)
      expect(lines).toHaveLength(1)
      return JSON.parse(lines[0])
    }

    it('move reaches xdotool as a single mousemove', async () => {
      const res = await req('POST', '/input', { json: { action: 'move', x: 5, y: 9 } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['mousemove', '--sync', '5', '9'])
    })

    it('click with coordinates chains mousemove and click in one call', async () => {
      const res = await req('POST', '/input', { json: { action: 'click', x: 5, y: 9, button: 2 } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['mousemove', '--sync', '5', '9', 'click', '2'])
    })

    it('click with no coordinates clicks at the current position with the default button', async () => {
      const res = await req('POST', '/input', { json: { action: 'click' } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['click', '1'])
    })

    it('double_click repeats the click twice', async () => {
      const res = await req('POST', '/input', { json: { action: 'double_click', button: 3 } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['click', '--repeat', '2', '--delay', '100', '3'])
    })

    it('type sends the text after a "--" separator', async () => {
      const res = await req('POST', '/input', { json: { action: 'type', text: 'hi -- there' } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['type', '--clearmodifiers', '--', 'hi -- there'])
    })

    it('key sends the key combo after a "--" separator', async () => {
      const res = await req('POST', '/input', { json: { action: 'key', keys: 'ctrl+c' } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['key', '--clearmodifiers', '--', 'ctrl+c'])
    })

    it('scroll maps direction and amount to a repeated click', async () => {
      const res = await req('POST', '/input', { json: { action: 'scroll', direction: 'down', amount: 3 } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['click', '--repeat', '3', '5'])
    })

    it('scroll defaults amount to 1 and supports all four directions', async () => {
      const res = await req('POST', '/input', { json: { action: 'scroll', direction: 'up' } })
      expect(res.status).toBe(200)
      expect(lastXdotoolCall()).toEqual(['click', '--repeat', '1', '4'])
    })

    it('rejects an unknown action', async () => {
      const res = await req('POST', '/input', { json: { action: 'teleport' } })
      expect(res.status).toBe(400)
    })

    it('rejects type with no text', async () => {
      const res = await req('POST', '/input', { json: { action: 'type' } })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /exec', () => {
    it('runs a command and returns its output', async () => {
      const res = await req('POST', '/exec', { json: { command: [pythonInfo!.exe, '-c', 'print("hello from exec")'] } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ExecBody
      expect(body.code).toBe(0)
      expect(body.timedOut).toBe(false)
      expect(body.stdout.trim()).toBe('hello from exec')
    })

    it('reports a timeout instead of hanging', async () => {
      const started = Date.now()
      const res = await req('POST', '/exec', {
        json: { command: [pythonInfo!.exe, '-c', 'import time; time.sleep(5)'], timeoutMs: 300 }
      })
      const elapsedMs = Date.now() - started
      expect(res.status).toBe(200)
      const body = (await res.json()) as ExecBody
      expect(body.timedOut).toBe(true)
      expect(body.code).toBeNull()
      expect(elapsedMs).toBeLessThan(4000)
    })

    it('caps stdout at 100 KB and reports the truncation', async () => {
      const res = await req('POST', '/exec', {
        json: { command: [pythonInfo!.exe, '-c', 'print("x" * 200000, end="")'] }
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ExecBody
      expect(body.stdout).toHaveLength(100 * 1024)
      expect(body.stdoutTruncated).toBe(true)
    })

    it('rejects a command that is not an array of strings', async () => {
      const res = await req('POST', '/exec', { json: { command: 'echo hi' } })
      expect(res.status).toBe(400)
    })
  })

  describe('GET/PUT /files', () => {
    it('writes and reads a file under data/', async () => {
      const put = await req('PUT', '/files?path=data/notes.txt', { body: 'hello world' })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ ok: true, bytes: 11 })

      const get = await req('GET', '/files?path=data/notes.txt')
      expect(get.status).toBe(200)
      expect(await get.text()).toBe('hello world')
    })

    it('writes and reads a nested file under shared/, creating parent directories', async () => {
      const put = await req('PUT', '/files?path=shared/sub/dir/today.txt', { body: 'shared content' })
      expect(put.status).toBe(200)

      const get = await req('GET', '/files?path=shared/sub/dir/today.txt')
      expect(get.status).toBe(200)
      expect(await get.text()).toBe('shared content')
    })

    it('404s reading a file that does not exist', async () => {
      const res = await req('GET', '/files?path=data/does-not-exist.txt')
      expect(res.status).toBe(404)
    })

    it('rejects a path containing ".."', async () => {
      const res = await req('GET', '/files?path=data/../notes.txt')
      expect(res.status).toBe(400)
    })

    it('rejects a path that is not under data/ or shared/', async () => {
      const res = await req('GET', `/files?path=${encodeURIComponent('/etc/passwd')}`)
      expect(res.status).toBe(400)
    })

    it.skipIf(!reparseSupported)('rejects a symlink that leads outside the allowed root', async () => {
      const outsideDir = path.join(tmpRoot, 'outside-secret')
      mkdirSync(outsideDir, { recursive: true })
      writeFileSync(path.join(outsideDir, 'secret.txt'), 'nope')
      symlinkSync(outsideDir, path.join(dataDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

      const res = await req('GET', '/files?path=data/escape/secret.txt')
      expect(res.status).toBe(400)
    })
  })

  describe('GET /windows', () => {
    it('lists windows using xdotool search, getwindowname and getwindowgeometry', async () => {
      const res = await req('GET', '/windows')
      expect(res.status).toBe(200)
      const body = (await res.json()) as WindowsBody
      expect(body.windows).toEqual([
        { id: '111', name: 'Fake Window 111', x: 10, y: 20, width: 1280, height: 800 },
        { id: '222', name: 'Fake Window 222', x: 10, y: 20, width: 1280, height: 800 }
      ])
    })
  })

  describe('GET /screenshot', () => {
    it('returns a PNG when a real X server is reachable', async (ctx) => {
      const res = await req('GET', '/screenshot')
      if (res.status !== 200) {
        ctx.skip(`no real X server/xwd available in this environment (got ${res.status})`)
      }
      expect(res.headers.get('content-type')).toBe('image/png')
      const bytes = Buffer.from(await res.arrayBuffer())
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    })
  })

  describe('unknown routes', () => {
    it('returns 404 for a route that does not exist', async () => {
      const res = await req('GET', '/nope')
      expect(res.status).toBe(404)
    })
  })
})
