import { describe, expect, it, vi } from 'vitest'
import {
  OpenCodeServerPool,
  readSse,
  DESKMATES_OPENCODE_PERMISSIONS,
  modelOf,
  providerOf,
  SERVER_IDLE_TIMEOUT_MS
} from '../../src/core/terminals/opencode-server'
import type { ProcessSpawner, SpawnedProcess, SpawnOptions } from '../../src/core/terminals/process'
import type { OpenCodeEvent } from '../../src/core/terminals/opencode-server'
import { fakeOpenCode } from './helpers/opencode-server'
import type { FakeOpenCode } from './helpers/opencode-server'

class FakeProcess implements SpawnedProcess {
  killed = false
  constructor(readonly pid: number) {}
  private readonly stdout: Array<(line: string) => void> = []
  private readonly stderr: Array<(line: string) => void> = []
  private readonly exits: Array<(code: number | null) => void> = []

  kill(): void {
    this.killed = true
  }
  onStdoutLine(fn: (line: string) => void): void {
    this.stdout.push(fn)
  }
  onStderrLine(fn: (line: string) => void): void {
    this.stderr.push(fn)
  }
  onExit(fn: (code: number | null) => void): void {
    this.exits.push(fn)
  }
  emitStdout(line: string): void {
    for (const fn of this.stdout) fn(line)
  }
  emitStderr(line: string): void {
    for (const fn of this.stderr) fn(line)
  }
  emitExit(code: number | null = 0): void {
    for (const fn of this.exits) fn(code)
  }
}

class FakeSpawner implements ProcessSpawner {
  readonly calls: { file: string; args: string[]; cwd?: string; env?: Record<string, string> }[] = []
  readonly processes: FakeProcess[] = []
  private nextPid = 1000
  spawn(file: string, args: string[], options: SpawnOptions = {}): SpawnedProcess {
    this.calls.push({ file, args, cwd: options.cwd, env: options.env })
    const proc = new FakeProcess(this.nextPid++)
    this.processes.push(proc)
    return proc
  }
}

const PORT_LINE = 'opencode server listening on http://127.0.0.1:41234'

/** A pool whose port lookup and server are both instant, so tests never wait on the network. */
function makePool(spawner: FakeSpawner, idleTimeoutMs = SERVER_IDLE_TIMEOUT_MS): OpenCodeServerPool {
  return new OpenCodeServerPool({ spawner, idleTimeoutMs, freePort: async () => 41234 })
}

/** Waits for the server process to exist, then has it announce its address. */
async function up(spawner: FakeSpawner, index = 0): Promise<void> {
  await vi.waitFor(() => expect(spawner.processes.length).toBeGreaterThan(index))
  spawner.processes[index].emitStdout(PORT_LINE)
}

/** Waits for the nth prompt to reach the server.
 *
 *  A reply can only follow a prompt, and the prompt only goes out after the health probe and the
 *  session POST have both come back. Emitting a reply without this wait is a race: the frames land
 *  before the client knows which session it is even listening for, get filtered out, and the test
 *  hangs instead of failing. */
async function prompted(server: FakeOpenCode, n = 1): Promise<void> {
  await vi.waitFor(() => expect(server.prompts).toHaveLength(n))
}

const turn = (over: Partial<Parameters<OpenCodeServerPool['run']>[1]> = {}): any => ({
  model: 'opencode/big-pickle',
  prompt: 'what model are you?',
  stallMs: 60_000,
  timeoutMs: 600_000,
  ...over
})

describe('readSse', () => {
  it('yields one object per data frame, and only once a frame is complete', async () => {
    const encoder = new TextEncoder()
    const chunks = ['data: {"a"', ':1}\n\n', 'data: {"b":2}\n\ndata: {"c":3}\n\n']
    const rs = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
    const seen: Record<string, unknown>[] = []
    for await (const frame of readSse(rs)) seen.push(frame)
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('joins a payload split across chunks, and survives one it cannot parse', async () => {
    const encoder = new TextEncoder()
    const rs = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"na'))
        controller.enqueue(encoder.encode('me":"x"}\n\ndata: not json\n\ndata: {"ok":1}\n\n'))
        controller.close()
      }
    })
    const seen: Record<string, unknown>[] = []
    for await (const frame of readSse(rs)) seen.push(frame)
    expect(seen).toEqual([{ name: 'x' }, { ok: 1 }])
  })
})

describe('providerOf / modelOf', () => {
  it('splits the provider/model string the API wants', () => {
    expect(providerOf('opencode/big-pickle')).toBe('opencode')
    expect(modelOf('opencode/big-pickle')).toBe('big-pickle')
    // A provider name with no model, and a model id that itself contains slashes.
    expect(providerOf('anthropic')).toBe('anthropic')
    expect(modelOf('anthropic')).toBe('anthropic')
    expect(modelOf('openrouter/anthropic/claude-3')).toBe('anthropic/claude-3')
  })
})

describe('OpenCodeServerPool: starting a server', () => {
  it('asks for a free port explicitly, since the server defaults to 4096 whether or not --port 0 is passed', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\proj', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'hi')
      await done

      const args = spawner.calls[0].args
      expect(spawner.calls[0].file).toBe('opencode')
      expect(args).toContain('serve')
      expect(args[args.indexOf('--port') + 1]).toBe('41234')
    } finally {
      server.restore()
    }
  })

  it('runs the server under a permission set that refuses to write prompt copies', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\proj', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'hi')
      await done

      const perms = JSON.parse(spawner.calls[0].env!.OPENCODE_PERMISSION)
      // The one hard constraint, on top of the blanket allow that stands in for --auto.
      expect(perms['*']).toBe('allow')
      expect(perms.edit['*claude-cowork*.md']).toBe('deny')
      // And nothing is smuggled in through a config file that would clobber the user's own.
      expect(spawner.calls[0].env!.OPENCODE_CONFIG_CONTENT).toBeUndefined()
      expect(JSON.parse(DESKMATES_OPENCODE_PERMISSIONS).edit['*claude-cowork*.md']).toBe('deny')
    } finally {
      server.restore()
    }
  })

  it('starts the server in the project folder, so its file tools are rooted there', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\work\\thing', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'hi')
      await done
      expect(spawner.calls[0].cwd).toBe('D:\\work\\thing')
    } finally {
      server.restore()
    }
  })

  it('trusts the port the server reports over the one it was asked for', async () => {
    const server = fakeOpenCode({ baseUrl: 'http://127.0.0.1:51999' })
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\proj', turn())
      await vi.waitFor(() => expect(spawner.processes).toHaveLength(1))
      // A shim that rewrites the port must not leave us talking to the one we guessed.
      spawner.processes[0].emitStdout('opencode server listening on http://127.0.0.1:51999')
      await prompted(server)
      server.reply('ses_1', 'hi')
      expect((await done).text).toBe('hi')
    } finally {
      server.restore()
    }
  })

  it('starts one server when two turns race, not one each', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const first = pool.run('D:\\proj', turn({ prompt: 'one' }))
      const second = pool.run('D:\\proj', turn({ prompt: 'two' }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      server.reply('ses_1', 'first')
      await first
      await vi.waitFor(() => expect(server.prompts).toHaveLength(2))
      server.reply('ses_1', 'second')

      expect(spawner.calls).toHaveLength(1)
      expect(server.sessions).toHaveLength(1)
      expect((await second).text).toBe('second')
    } finally {
      server.restore()
    }
  })

  it('reports a server that dies during start-up, with what it printed', async () => {
    const spawner = new FakeSpawner()
    const pool = makePool(spawner)
    const done = pool.run('D:\\proj', turn())
    await vi.waitFor(() => expect(spawner.processes).toHaveLength(1))
    spawner.processes[0].emitStderr('Error: unknown flag --port')
    spawner.processes[0].emitExit(1)

    const result = await done
    expect(result.error).toContain('stopped unexpectedly')
    expect(result.error).toContain('unknown flag --port')
    expect(spawner.processes[0].killed).toBe(true)
  })

  it('gives up on a server that never announces itself', async () => {
    vi.useFakeTimers()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\proj', turn())
      await vi.advanceTimersByTimeAsync(61_000)
      const result = await done
      expect(result.error).toContain('did not start')
      expect(spawner.processes[0].killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OpenCodeServerPool: a conversation', () => {
  it('does not answer with the prompt echoed back, as if the assistant had repeated it', async () => {
    // Captured from opencode 1.18.18: the server broadcasts the whole session, so the prompt we just
    // POSTed comes straight back down /event as a `role: 'user'` message plus a text part for it. The
    // role lives on the message and the part only points back at it, so filtering the user *message*
    // is not enough — the part has to be matched to it. When this regressed, every reply rendered the
    // user's own prompt as the assistant's first line, directly above the real answer.
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const events: OpenCodeEvent[] = []
      const done = pool.run('D:\\proj', turn({ prompt: 'Say OK and nothing else.', onEvent: (e) => events.push(e) }))
      await up(spawner)
      await prompted(server)

      server.echoUser('ses_1', 'Say OK and nothing else.')
      server.reply('ses_1', 'OK')

      expect((await done).text).toBe('OK')
      const spoken = events.filter((e) => e.kind === 'text').map((e: any) => e.text).join('')
      expect(spoken).toBe('OK')
      expect(spoken).not.toContain('nothing else')
    } finally {
      server.restore()
    }
  })

  it('ignores a tool part belonging to the user message', async () => {
    // Same broadcast, different part type: a user turn carrying an attachment must not announce a
    // tool call the assistant never made.
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const events: OpenCodeEvent[] = []
      const done = pool.run('D:\\proj', turn({ onEvent: (e) => events.push(e) }))
      await up(spawner)
      await prompted(server)

      server.echoUser('ses_1', 'look at this')
      server.emit('message.updated', { sessionID: 'ses_1', info: { role: 'user', id: 'msg_7', sessionID: 'ses_1' } })
      server.emit('message.part.updated', {
        sessionID: 'ses_1',
        part: { id: 'prt_u7', messageID: 'msg_7', type: 'tool', tool: 'read', state: { status: 'completed', input: {} } }
      })
      server.tool('ses_1', 'prt_a', 'running')
      server.complete('ses_1')

      await vi.waitFor(() => expect(events.filter((e) => e.kind === 'tool')).toHaveLength(1))
      expect((await done).text).toBe('')
    } finally {
      server.restore()
    }
  })

  it('delivers only the new text when a part grows, instead of the whole text again', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const events: OpenCodeEvent[] = []
      const done = pool.run('D:\\proj', turn({ onEvent: (e) => events.push(e) }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))

      const grow = (text: string): void =>
        server.emit('message.part.updated', {
          sessionID: 'ses_1',
          part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text }
        })
      grow('I ')
      grow('I am ')
      grow('I am big-pickle')

      await vi.waitFor(() =>
        expect(events.filter((e) => e.kind === 'text').map((e: any) => e.text)).toEqual(['I ', 'am ', 'big-pickle'])
      )
      server.reply('ses_1', 'I am big-pickle')
      // And the turn ends with the whole reply, not the pieces.
      expect((await done).text).toBe('I am big-pickle')
    } finally {
      server.restore()
    }
  })

  it('reports a tool call once per state, not once per re-send', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const tools: OpenCodeEvent[] = []
      const done = pool.run('D:\\proj', turn({ onEvent: (e) => e.kind === 'tool' && tools.push(e) }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))

      server.tool('ses_1', 'prt_t', 'pending')
      server.tool('ses_1', 'prt_t', 'running')
      server.tool('ses_1', 'prt_t', 'running') // the same part, re-sent as opencode fills it in
      server.tool('ses_1', 'prt_t', 'completed')

      await vi.waitFor(() => expect(tools.length).toBeGreaterThanOrEqual(2))
      // `pending` is filtered out, and the duplicate `running` collapses.
      expect(tools.map((t: any) => t.state)).toEqual(['running', 'done'])
      // The server's own part id, so the renderer updates one line rather than stacking three.
      expect(new Set(tools.map((t: any) => t.id))).toEqual(new Set(['prt_t']))
      server.complete('ses_1')
      await done
    } finally {
      server.restore()
    }
  })

  it('ignores another conversation\'s events, which the stream is full of', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const seen: string[] = []
      const done = pool.run('D:\\proj', turn({ onEvent: (e) => e.kind === 'text' && seen.push(e.text) }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))

      // Another task's turn on the same server, plus the noise the stream carries on its own.
      server.emit('message.part.updated', { sessionID: 'ses_other', part: { id: 'p', type: 'text', text: 'not mine' } })
      server.emit('server.heartbeat', {})
      server.emit('plugin.added', {})
      server.emit('message.part.updated', { sessionID: 'ses_1', part: { id: 'prt_1', type: 'text', text: 'mine' } })
      server.complete('ses_1')

      expect((await done).text).toBe('mine')
      expect(seen).toEqual(['mine'])
    } finally {
      server.restore()
    }
  })

  it('starts a new conversation when the model changes, since the old one answered in the old model', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)

      const first = pool.run('D:\\proj', turn({ model: 'opencode/big-pickle' }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      server.reply('ses_1', 'big-pickle')
      await first

      const second = pool.run('D:\\proj', turn({ model: 'anthropic/claude-opus-5' }))
      await vi.waitFor(() => expect(server.prompts).toHaveLength(2))
      server.reply('ses_2', 'claude')
      await second

      expect(server.sessions).toHaveLength(2)
      expect(server.prompts[1].model).toEqual({ providerID: 'anthropic', modelID: 'claude-opus-5' })
    } finally {
      server.restore()
    }
  })

  it('carries the system block into the new conversation after a model switch', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const brief = 'THE BRIEF'

      const first = pool.run('D:\\proj', turn({ model: 'opencode/big-pickle', system: brief }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      server.reply('ses_1', 'ok')
      await first

      const second = pool.run('D:\\proj', turn({ model: 'anthropic/claude-opus-5', system: brief }))
      await vi.waitFor(() => expect(server.prompts).toHaveLength(2))
      server.reply('ses_2', 'ok')
      await second

      // A new session has nothing, so the brief goes in again — the "once" is per conversation, not
      // per app run.
      expect(server.prompts[1].system).toBe(brief)
    } finally {
      server.restore()
    }
  })

  it('keeps listening past a completed step and ends the turn on session.idle', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)

      const ok = pool.run('D:\\proj', turn())
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      // A completed assistant message closes one *step*. The turn is not over, and the answer is
      // still coming.
      server.complete('ses_1')
      let settled = false
      void ok.then(() => (settled = true))
      await new Promise((r) => setTimeout(r, 60))
      expect(settled).toBe(false)

      // A frame that lands after the step completed is still collected, and `session.idle` — which
      // carries its own sessionID and so survives the filter — is what ends the turn.
      server.emit('message.part.updated', {
        sessionID: 'ses_1',
        part: { id: 'prt_2', messageID: 'msg_2', type: 'text', text: 'late but delivered' }
      })
      server.idle('ses_1')
      expect((await ok).text).toBe('late but delivered')
      expect((await ok).error).toBeUndefined()

      const bad = pool.run('D:\\proj', turn())
      await vi.waitFor(() => expect(server.prompts).toHaveLength(2))
      server.error('ses_1', 'Provider is overloaded')
      expect((await bad).error).toBe('Provider is overloaded')
    } finally {
      server.restore()
    }
  })

  it('answers a tool turn in full, even though it completes a message per step', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const events: OpenCodeEvent[] = []
      const done = pool.run('D:\\proj', turn({ onEvent: (e) => events.push(e) }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))

      server.toolTurn('ses_1', 'playwright_browser_navigate', 'It is a page about cars.')

      // The answer from the *second* step is not lost, and the tool shows up in the timeline — the
      // bug this covers made every tool-using prompt look like it had stalled on the page load.
      expect((await done).text).toBe('It is a page about cars.')
      expect(events.filter((e) => e.kind === 'tool').map((e: any) => e.tool)).toContain('playwright_browser_navigate')
    } finally {
      server.restore()
    }
  })

  it('ends the turn at once when the server dies under it, instead of waiting out the stall watchdog', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\proj', turn({ stallMs: 600_000 }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))

      spawner.processes[0].emitExit(1)

      const result = await done
      expect(result.error).toContain('stopped while it was working')
    } finally {
      server.restore()
    }
  })

  it('stops a wedged turn on the stall watchdog, and asks the server to halt', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeOpenCode()
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\proj', turn({ stallMs: 5_000 }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      // Nothing at all from here on: not a tool call, not a token.
      await vi.advanceTimersByTimeAsync(5_001)

      const result = await done
      expect(result.error).toContain('stopped responding')
      await vi.waitFor(() =>
        expect(server.fetch.mock.calls.some(([url]: any) => String(url).includes('/abort'))).toBe(true)
      )
      server.restore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a turn that never finishes however busy it is', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeOpenCode()
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const done = pool.run('D:\\proj', turn({ stallMs: 5_000, timeoutMs: 60_000 }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      for (let i = 0; i < 20; i++) {
        server.tool('ses_1', `prt_${i}`, 'running')
        await vi.advanceTimersByTimeAsync(4_000)
      }
      await vi.advanceTimersByTimeAsync(60_000)

      expect((await done).error).toContain('without finishing')
      server.restore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves a stopped turn at once and leaves the conversation usable', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const controller = new AbortController()

      const first = pool.run('D:\\proj', turn({ signal: controller.signal }))
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      controller.abort()

      expect(await first).toMatchObject({ text: '', stopped: true })
      const second = pool.run('D:\\proj', turn())
      await vi.waitFor(() => expect(server.prompts).toHaveLength(2))
      server.reply('ses_1', 'still here')
      expect((await second).text).toBe('still here')
    } finally {
      server.restore()
    }
  })
})

describe('OpenCodeServerPool: server lifetime', () => {
  it('shuts a server down once it has been idle, so a closed project stops holding a process', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeOpenCode()
      const spawner = new FakeSpawner()
      const pool = makePool(spawner, 60_000)
      const done = pool.run('D:\\proj', turn())
      await up(spawner)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      server.reply('ses_1', 'ok')
      // The turn now ends on `session.idle` after a short quiet window, so the clock has to move.
      await vi.advanceTimersByTimeAsync(500)
      await done

      expect(pool.isWarm('D:\\proj')).toBe(true)
      await vi.advanceTimersByTimeAsync(60_001)
      expect(spawner.processes[0].killed).toBe(true)
      expect(pool.isWarm('D:\\proj')).toBe(false)
      server.restore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a folder\'s server separate from another folder\'s', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const a = pool.run('D:\\a', turn())
      await up(spawner, 0)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))

      const b = pool.run('D:\\b', turn())
      await up(spawner, 1)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(2))

      // Two folders, two conversations — so a project never sees another project's history.
      server.reply('ses_1', 'for a')
      server.reply('ses_2', 'for b')
      expect((await a).text).toBe('for a')
      expect((await b).text).toBe('for b')
      expect(server.sessions).toHaveLength(2)
      expect(spawner.calls.map((c) => c.cwd)).toEqual(['D:\\a', 'D:\\b'])
    } finally {
      server.restore()
    }
  })

  it('is not warm for a folder that has never been asked anything', async () => {
    const pool = makePool(new FakeSpawner())
    expect(pool.isWarm('D:\\never-used')).toBe(false)
  })

  it('kills every server on dispose, and waits for nothing', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const a = pool.run('D:\\a', turn())
      await up(spawner, 0)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
      server.reply('ses_1', 'ok')
      await a
      const b = pool.run('D:\\b', turn())
      await up(spawner, 1)
      await vi.waitFor(() => expect(server.prompts).toHaveLength(2))
      server.reply('ses_2', 'ok')
      await b

      pool.disposeAll()

      expect(spawner.processes.every((p) => p.killed)).toBe(true)
      expect(pool.isWarm('D:\\a')).toBe(false)
      expect(pool.isWarm('D:\\b')).toBe(false)
    } finally {
      server.restore()
    }
  })
})

describe('OpenCodeServerPool.usage', () => {
  it('reports nothing for a folder with no conversation, rather than a zero', async () => {
    const server = fakeOpenCode()
    try {
      const pool = makePool(new FakeSpawner())
      expect(await pool.usage('D:\\never-started')).toBeNull()
    } finally {
      server.restore()
    }
  })

  it('reads the newest assistant message and the context limit the model reports', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      expect(await pool.usage('D:\\a')).toEqual({ used: 40_952 + 1_940, limit: 200_000, summarized: false })
    } finally {
      server.restore()
    }
  })

  it('picks the newest message by time, not by position in the response', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      // The newest assistant turn is listed FIRST, which is the ordering a real server uses and which
      // an implementation that trusted the response order would get backwards.
      const older = {
        info: { role: 'assistant', id: 'msg_old', time: { created: 1_000 }, tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: []
      }
      const newest = {
        info: { role: 'assistant', id: 'msg_new', time: { created: 9_000 }, tokens: { input: 777, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: []
      }
      server.setMessages([newest, older])

      expect((await pool.usage('D:\\a'))?.used).toBe(777)
    } finally {
      server.restore()
    }
  })

  it('excludes the output of this turn, which is not carried into the next one', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      server.setMessages([
        {
          info: {
            role: 'assistant',
            id: 'msg_1',
            time: { created: 9_000 },
            // `total` includes the 4 output tokens; only input + cacheRead occupy the next window.
            tokens: { total: 9_999, input: 5_000, output: 4_000, reasoning: 0, cache: { read: 500, write: 0 } }
          },
          parts: []
        }
      ])

      expect((await pool.usage('D:\\a'))?.used).toBe(5_500)
    } finally {
      server.restore()
    }
  })

  it('hides the meter rather than guessing when the model reports no limit', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      server.setContextLimit(null)

      const usage = await pool.usage('D:\\a')
      expect(usage?.limit).toBeNull()
      expect(usage?.used).toBeGreaterThan(0)
    } finally {
      server.restore()
    }
  })

  it('recognises a turn that is already a compaction summary', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      server.setMessages([
        {
          info: {
            role: 'assistant',
            id: 'msg_sum',
            time: { created: 9_000 },
            summary: true,
            tokens: { input: 302, output: 87, reasoning: 41, cache: { read: 272, write: 0 } }
          },
          parts: []
        }
      ])

      expect((await pool.usage('D:\\a'))?.summarized).toBe(true)
    } finally {
      server.restore()
    }
  })

  it('never mistakes the unrelated summary object on a user message for a compaction', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      // Captured live: a user message carries `summary: {diffs: []}`, which is truthy. A truthiness
      // test here would report every conversation as already compacted and disable the button.
      server.setMessages([
        {
          info: { role: 'user', id: 'msg_u', time: { created: 9_000 }, summary: { diffs: [] } },
          parts: []
        },
        {
          info: {
            role: 'assistant',
            id: 'msg_1',
            time: { created: 8_000 },
            tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
          },
          parts: []
        }
      ])

      expect((await pool.usage('D:\\a'))?.summarized).toBe(false)
    } finally {
      server.restore()
    }
  })

  it('returns null when the server will not answer, instead of throwing into the UI', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      vi.mocked(globalThis.fetch).mockImplementationOnce(async () => new Response('', { status: 500 }))

      expect(await pool.usage('D:\\a')).toBeNull()
    } finally {
      server.restore()
    }
  })
})

describe('OpenCodeServerPool.compact', () => {
  it('summarizes the existing session on the same model, and reports the new usage', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn({ model: 'opencode/big-pickle' }))
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      server.setMessages([
        {
          info: {
            role: 'assistant',
            id: 'msg_sum',
            time: { created: 9_000 },
            summary: true,
            tokens: { input: 302, output: 87, reasoning: 41, cache: { read: 272, write: 0 } }
          },
          parts: []
        }
      ])

      const usage = await pool.compact('D:\\a')

      expect(server.summaries).toEqual([{ providerID: 'opencode', modelID: 'big-pickle' }])
      expect(usage?.summarized).toBe(true)
      expect(usage?.used).toBe(302 + 272)
    } finally {
      server.restore()
    }
  })

  it('summarizes in the model the conversation is already using, not a default', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn({ model: 'anthropic/claude-opus-4-8' }))
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      await pool.compact('D:\\a')

      expect(server.summaries).toEqual([{ providerID: 'anthropic', modelID: 'claude-opus-4-8' }])
    } finally {
      server.restore()
    }
  })

  it('keeps the same session, so the thread is compacted rather than replaced', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      await pool.compact('D:\\a')

      // One conversation was ever opened, and no prompt was sent to re-open one.
      expect(server.sessions).toHaveLength(1)
      expect(server.prompts).toHaveLength(1)
    } finally {
      server.restore()
    }
  })

it('refuses before a conversation exists, rather than letting the server 404', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      // No turn was ever run, so this folder has a server but no conversation. The guard has to fire
      // on its own: without it the request would go out and come back as a bare HTTP 404.
      const compacting = pool.compact('D:\\a')
      await up(spawner)

      await expect(compacting).rejects.toThrow(/no conversation here to compact/i)
      expect(server.summaries).toHaveLength(0)
      expect(server.sessions).toHaveLength(0)
    } finally {
      server.restore()
    }
  })

  it('reports a refused compaction instead of silently doing nothing', async () => {
    const server = fakeOpenCode({ summarizeStatus: 500 })
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)
      server.reply('ses_1', 'ok')
      await run

      await expect(pool.compact('D:\\a')).rejects.toThrow(/HTTP 500/)
    } finally {
      server.restore()
    }
  })

  it('waits for a turn in flight rather than compacting mid-answer', async () => {
    const server = fakeOpenCode()
    try {
      const spawner = new FakeSpawner()
      const pool = makePool(spawner)
      const run = pool.run('D:\\a', turn())
      await up(spawner)
      await prompted(server)

      let compacted = false
      const compacting = pool.compact('D:\\a').then(() => {
        compacted = true
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(compacted).toBe(false)
      expect(server.summaries).toHaveLength(0)

      server.reply('ses_1', 'ok')
      await run
      await compacting

      expect(server.summaries).toHaveLength(1)
    } finally {
      server.restore()
    }
  })
})