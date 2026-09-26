import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { BotRunner } from '../../src/core/bots/runner'
import { EventBus } from '../../src/core/events'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import type { BotHost, PcEndpoints } from '../../src/core/bots/host'
import type { AgentClient, AgentExecResult, InputAction } from '../../src/core/bots/tools/agent-client'
import type { CdpClient, CdpTargetInfo, PageContent } from '../../src/core/bots/tools/cdp-client'
import type { CoreEvent, PcState } from '../../src/shared/protocol'
import { BotHostError } from '../../src/core/bots/host'
import { PcUnreachableError } from '../../src/core/bots/tools/types'

// ---- MockLanguageModelV4 chunk helpers, matching the shapes proven in tests/core/runner.test.ts ----

function textChunks(id: string, text: string): any[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
  ]
}

function toolCallChunks(toolCallId: string, toolName: string, input: unknown): any[] {
  return [
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
  ]
}

/** A model that returns one scripted set of chunks per doStream call, in order; throws if asked for more than scripted. */
function scriptedModel(steps: any[][]): MockLanguageModelV4 {
  let callCount = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      if (callCount >= steps.length) {
        throw new Error(`scriptedModel: doStream called more times (${callCount + 1}) than scripted (${steps.length})`)
      }
      const chunks = steps[callCount]
      callCount++
      return { stream: simulateReadableStream({ chunks }) }
    }
  })
}

function makeModels(model: MockLanguageModelV4) {
  return { resolve: () => ({ model, provider: 'google' as const, modelId: 'test-model' }) }
}

const FAKE_ENDPOINTS: PcEndpoints = {
  novnc: 'http://127.0.0.1:6900',
  agent: 'http://127.0.0.1:8700',
  cdp: 'http://127.0.0.1:9220',
  token: 'test-token'
}

// ---- fakes for the PC host and its two clients (no Docker, WSL or network involved) ----

/** BotRunner only ever calls start()/endpoints(); every other method throws if it's ever reached. */
function makeFakeHost(options: { endpoints: PcEndpoints | null; startState?: PcState }): { host: BotHost; calls: string[] } {
  const { endpoints, startState = 'running' } = options
  const calls: string[] = []
  const notUsed = (name: string) => (): never => {
    throw new Error(`BotRunner should not call BotHost.${name} in this test`)
  }
  const host: BotHost = {
    create: notUsed('create'),
    async start(botId) {
      calls.push(`start:${botId}`)
      return { botId, state: startState, containerId: `c-${botId}`, memoryMb: 1024, idleStopMinutes: 30, lastUsedAt: 1, error: null }
    },
    stop: notUsed('stop'),
    reset: notUsed('reset'),
    delete: notUsed('delete'),
    status: notUsed('status'),
    async endpoints(botId) {
      calls.push(`endpoints:${botId}`)
      return endpoints
    },
    exec: notUsed('exec'),
    copyIn: notUsed('copyIn'),
    copyOut: notUsed('copyOut'),
    pull: notUsed('pull'),
    buildLocal: notUsed('buildLocal')
  }
  return { host, calls }
}

/** A fake Chromium, in the spirit of bot-tools.test.ts's FakeCdpClient: pages keyed by tab id, content from a callback. */
class FakeCdpClient implements CdpClient {
  private nextId = 1
  private readonly pages = new Map<string, PageContent>()

  constructor(private readonly makePage: (url: string) => Partial<PageContent> = () => ({})) {}

  private contentFor(url: string): PageContent {
    const partial = this.makePage(url)
    return {
      url,
      title: partial.title ?? `Title for ${url}`,
      text: partial.text ?? `Text for ${url}`,
      links: partial.links ?? [],
      hasPasswordField: partial.hasPasswordField ?? false
    }
  }

  async listTargets(): Promise<CdpTargetInfo[]> {
    return [...this.pages.entries()].map(([targetId, p]) => ({ targetId, url: p.url, title: p.title }))
  }

  async newTab(url: string): Promise<CdpTargetInfo> {
    const targetId = `t${this.nextId++}`
    const content = this.contentFor(url)
    this.pages.set(targetId, content)
    return { targetId, url: content.url, title: content.title }
  }

  async navigate(targetId: string, url: string): Promise<CdpTargetInfo> {
    if (!this.pages.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    const content = this.contentFor(url)
    this.pages.set(targetId, content)
    return { targetId, url: content.url, title: content.title }
  }

  async closeTab(targetId: string): Promise<void> {
    this.pages.delete(targetId)
  }

  async readPage(targetId: string): Promise<PageContent> {
    const page = this.pages.get(targetId)
    if (!page) throw new Error('No open tab with that id. Use tabs to see what is open.')
    return page
  }

  async click(targetId: string): Promise<void> {
    if (!this.pages.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
  }

  /** Mirrors cdp-client.ts's real behavior: a "#password" selector is always refused, exactly like a real password field would be. */
  async typeText(targetId: string, selector: string): Promise<void> {
    if (!this.pages.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    if (selector === '#password') {
      throw new Error("That field looks like a password field. I never type passwords — ask the user to open Take Over and sign in themselves.")
    }
  }

  async screenshot(targetId: string): Promise<Buffer> {
    if (!this.pages.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    return Buffer.from('fake-page-png')
  }

  async close(): Promise<void> {}
}

/** A fake agent.py service: an in-memory files map plus a call log, in the spirit of bot-tools.test.ts's FakeAgentClient. */
class FakeAgentClient implements AgentClient {
  readonly calls: string[] = []
  readonly files = new Map<string, Buffer>()

  async screenshot(): Promise<Buffer> {
    this.calls.push('screenshot')
    return Buffer.from('fake-screen-png')
  }

  async input(action: InputAction): Promise<void> {
    this.calls.push(`input:${JSON.stringify(action)}`)
  }

  async exec(command: string[]): Promise<AgentExecResult> {
    this.calls.push(`exec:${command.join(' ')}`)
    return { code: 0, timedOut: false, stdout: '', stdoutTruncated: false, stderr: '', stderrTruncated: false }
  }

  async readFile(path: string): Promise<Buffer> {
    this.calls.push(`readFile:${path}`)
    const data = this.files.get(path)
    if (!data) throw new Error('file not found')
    return data
  }

  async writeFile(path: string, data: Buffer | string): Promise<{ bytes: number }> {
    this.calls.push(`writeFile:${path}`)
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    this.files.set(path, buf)
    return { bytes: buf.length }
  }
}

/** A Chromium whose first `n` newTab calls find the PC gone, the way a stopped container looks from the host. */
class UnreachableOnceCdpClient extends FakeCdpClient {
  closes = 0

  constructor(private failuresLeft = 1) {
    super()
  }

  override async newTab(url: string): Promise<CdpTargetInfo> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--
      throw new PcUnreachableError('browser', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    }
    return super.newTab(url)
  }

  override async close(): Promise<void> {
    this.closes++
  }
}

describe('BotRunner', () => {
  let db: DatabaseSync
  let repos: Repos
  let bus: EventBus
  let events: CoreEvent[]
  let dataDir: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    repos = createRepos(db)
    bus = new EventBus()
    events = []
    bus.on((event) => events.push(event))
    dataDir = mkdtempSync(join(tmpdir(), 'deskmates-bot-runner-'))
  })

  afterEach(() => {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('1. a full run opens a page, reads it, takes a screenshot, writes a note and finishes, with the log and screenshot on disk', async () => {
    const { host, calls: hostCalls } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient((url) => ({ text: `Front page of ${url}: nothing new today.` }))
    const agent = new FakeAgentClient()
    const model = scriptedModel([
      toolCallChunks('c1', 'open_page', { url: 'https://news.example' }),
      toolCallChunks('c2', 'read_page', {}),
      toolCallChunks('c3', 'screenshot', {}),
      toolCallChunks('c4', 'write_pc_file', { path: 'data/notes.md', content: "Nothing new as of today; don't repeat this." }),
      textChunks('text-1', "Checked the front page — nothing new, so I made a note and I'm done.")
    ])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('Digest bot', 'Summarize the front page.')
    const run = repos.runs.create(bot.id, "Summarize today's front page", join(dataDir, 'runs', 'run-1'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)

    const finalRun = repos.runs.require(run.id)
    expect(finalRun.state).toBe('done')
    expect(finalRun.error).toBeNull()
    expect(hostCalls).toEqual([`start:${bot.id}`, `endpoints:${bot.id}`])

    // The log file is really on disk, not just in memory.
    expect(existsSync(join(run.folder, 'log.jsonl'))).toBe(true)
    const items = await runner.items(run.id)
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
    const toolItems = items.filter((i) => i.kind === 'tool') as any[]
    expect(toolItems.map((i) => i.toolName)).toEqual(['open_page', 'read_page', 'screenshot', 'write_pc_file'])
    expect(toolItems.every((i) => i.state === 'done')).toBe(true)

    // The screenshot PNG is really on disk too, under the run's folder, not just referenced in the log.
    expect(existsSync(join(run.folder, 'browser-1.png'))).toBe(true)
    expect(readFileSync(join(run.folder, 'browser-1.png')).toString('utf8')).toBe('fake-page-png')

    // The note went through the agent to the bot's own PC storage, not onto the local disk.
    expect(agent.calls).toContain('writeFile:data/notes.md')
    expect(agent.files.get('data/notes.md')?.toString('utf8')).toBe("Nothing new as of today; don't repeat this.")

    expect(events.some((e) => e.type === 'run.updated' && e.run.id === run.id && e.run.state === 'running')).toBe(true)
    expect(events.some((e) => e.type === 'run.updated' && e.run.id === run.id && e.run.state === 'done')).toBe(true)
    expect(events.filter((e) => e.type === 'run.item' && e.runId === run.id).length).toBeGreaterThan(0)
    expect(repos.usage.list().length).toBeGreaterThan(0)
  })

  it('2. an approved risky tool call resumes the run and actually executes it', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient()
    const agent = new FakeAgentClient()
    const model = scriptedModel([toolCallChunks('c1', 'screen_click', { x: 100, y: 200 }), textChunks('text-1', 'Clicked where you approved.')])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('Clicker bot')
    const run = repos.runs.create(bot.id, 'Click the button', join(dataDir, 'runs', 'run-1'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)

    expect(repos.runs.require(run.id).state).toBe('waiting-approval')
    expect(agent.calls).toEqual([]) // not executed yet — still waiting

    const pending = (await runner.items(run.id)).find((i) => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    expect(pending.toolName).toBe('screen_click')

    await runner.respond(run.id, pending.approvalId, true)
    await runner.whenIdle(run.id)

    expect(agent.calls).toContain(`input:${JSON.stringify({ action: 'click', x: 100, y: 200, button: 1 })}`)
    expect(repos.runs.require(run.id).state).toBe('done')
    expect(repos.bots.require(bot.id).autoApprove).toEqual([]) // a one-time approval, not "always"
  })

  it('3. a denied risky tool call resumes the run without ever executing it', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient()
    const agent = new FakeAgentClient()
    const model = scriptedModel([toolCallChunks('c1', 'screen_click', { x: 5, y: 5 }), textChunks('text-1', "Okay, I won't click that.")])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('Clicker bot')
    const run = repos.runs.create(bot.id, 'Click the button', join(dataDir, 'runs', 'run-1'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)

    const pending = (await runner.items(run.id)).find((i) => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    await runner.respond(run.id, pending.approvalId, false)
    await runner.whenIdle(run.id)

    expect(agent.calls).toEqual([]) // the click never happened
    const finalItems = await runner.items(run.id)
    const toolItem = finalItems.find((i) => i.kind === 'tool') as any
    expect(toolItem.state).toBe('denied')
    expect(repos.runs.require(run.id).state).toBe('done')
  })

  it('4. approving "always" auto-approves the tool for this and future runs, and tells listeners the bot changed', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient()
    const agent = new FakeAgentClient()
    const model = scriptedModel([
      toolCallChunks('c1', 'screen_click', { x: 1, y: 1 }),
      textChunks('text-1', 'Clicked it.'),
      toolCallChunks('c2', 'screen_click', { x: 2, y: 2 }),
      textChunks('text-2', "Clicked it again — you said I could, so I didn't ask this time.")
    ])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    let bot = repos.bots.create('Clicker bot')
    const run1 = repos.runs.create(bot.id, 'Click once', join(dataDir, 'runs', 'run-1'))

    await runner.start(run1, bot)
    await runner.whenIdle(run1.id)
    const pending = (await runner.items(run1.id)).find((i) => i.kind === 'tool' && i.state === 'awaiting-approval') as any

    await runner.respond(run1.id, pending.approvalId, true, true)
    await runner.whenIdle(run1.id)

    bot = repos.bots.require(bot.id)
    expect(bot.autoApprove).toContain('screen_click')
    expect(events.some((e) => e.type === 'bot.updated' && e.bot.id === bot.id && e.bot.autoApprove.includes('screen_click'))).toBe(true)

    // A second, fresh run for the same (now auto-approving) bot never has to pause.
    const run2 = repos.runs.create(bot.id, 'Click again', join(dataDir, 'runs', 'run-2'))
    await runner.start(run2, bot)
    await runner.whenIdle(run2.id)

    expect(repos.runs.require(run2.id).state).toBe('done')
    expect(agent.calls.filter((c) => c.startsWith('input:')).length).toBe(2)
  })

  it('5. stop() aborts an actively streaming run and leaves it in a clean "stopped" state', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient()
    const agent = new FakeAgentClient()
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'still working on it' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
          ] as any[],
          chunkDelayInMs: 200
        })
      })
    })
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('Slow bot')
    const run = repos.runs.create(bot.id, 'Take your time', join(dataDir, 'runs', 'run-1'))

    await runner.start(run, bot)
    expect(runner.isRunning(run.id)).toBe(true)
    await runner.stop(run.id)
    await runner.whenIdle(run.id)

    const finalRun = repos.runs.require(run.id)
    expect(finalRun.state).toBe('stopped')
    expect(finalRun.error).toBe('Stopped.')
    expect(runner.isRunning(run.id)).toBe(false)
  })

  it('6. a login wall blocks typing credentials; the bot is left to point the user at Take Over instead', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient((url) => ({ hasPasswordField: url.includes('accounts.example') }))
    const agent = new FakeAgentClient()
    const model = scriptedModel([
      toolCallChunks('c1', 'open_page', { url: 'https://accounts.example/login' }),
      toolCallChunks('c2', 'read_page', {}),
      toolCallChunks('c3', 'type_text', { selector: '#password', text: 'hunter2' }),
      textChunks('text-1', "That site needs a login I don't have. Please open Take Over and sign in yourself, then ask me again.")
    ])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('Digest bot')
    const run = repos.runs.create(bot.id, 'Check the site', join(dataDir, 'runs', 'run-1'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)

    // A blocked tool call is not a broken run: the loop recovers and finishes normally.
    expect(repos.runs.require(run.id).state).toBe('done')

    const items = await runner.items(run.id)
    const toolItems = items.filter((i) => i.kind === 'tool') as any[]
    const readItem = toolItems.find((i) => i.toolName === 'read_page')
    expect(readItem.output).toMatchObject({ hasPasswordField: true })

    const typeItem = toolItems.find((i) => i.toolName === 'type_text')
    expect(typeItem.state).toBe('error')
    expect(typeItem.error).toMatch(/never type passwords/i)
    expect(typeItem.error).toMatch(/Take Over/)
    // The audit trail records what was attempted...
    expect(typeItem.input).toMatchObject({ selector: '#password' })

    const assistantItem = items.find((i) => i.kind === 'assistant') as any
    expect(assistantItem.text).toMatch(/Take Over/)

    // ...but the credential was never actually delivered anywhere: neither the page (blocked above) nor,
    // as a workaround, the raw desktop-input path that has no way to recognize a password field itself.
    expect(agent.calls.filter((c) => c.startsWith('input:')).length).toBe(0)
  })

  it('7. the PC failing to start, or being unreachable once started, ends the run in error rather than leaving it stuck', async () => {
    const cdp = new FakeCdpClient()
    const agent = new FakeAgentClient()

    const didNotStart = makeFakeHost({ endpoints: null, startState: 'error' })
    const runnerA = new BotRunner({
      repos,
      bus,
      host: didNotStart.host,
      models: makeModels(scriptedModel([])),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })
    const botA = repos.bots.create('Bot A')
    const runA = repos.runs.create(botA.id, 'Do something', join(dataDir, 'runs', 'run-a'))
    await runnerA.start(runA, botA)
    await runnerA.whenIdle(runA.id)
    expect(repos.runs.require(runA.id)).toMatchObject({ state: 'error', error: "This bot's PC didn't start." })

    const unreachable = makeFakeHost({ endpoints: null, startState: 'running' })
    const runnerB = new BotRunner({
      repos,
      bus,
      host: unreachable.host,
      models: makeModels(scriptedModel([])),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })
    const botB = repos.bots.create('Bot B')
    const runB = repos.runs.create(botB.id, 'Do something', join(dataDir, 'runs', 'run-b'))
    await runnerB.start(runB, botB)
    await runnerB.whenIdle(runB.id)
    expect(repos.runs.require(runB.id)).toMatchObject({ state: 'error', error: "This bot's PC isn't reachable right now." })
  })

  it('8. stopAll() aborts every in-flight run at once and waits for each to actually go idle', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient()
    const agent = new FakeAgentClient()
    // Stateless doStream (same 4 chunks every call) so one model instance is safe to share across
    // two concurrently-streaming runs — unlike scriptedModel, nothing here depends on call order.
    const slowModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'still working on it' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
          ] as any[],
          chunkDelayInMs: 200
        })
      })
    })
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(slowModel),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const botA = repos.bots.create('Bot A')
    const botB = repos.bots.create('Bot B')
    const runA = repos.runs.create(botA.id, 'Take your time', join(dataDir, 'runs', 'run-a'))
    const runB = repos.runs.create(botB.id, 'Take your time too', join(dataDir, 'runs', 'run-b'))

    await runner.start(runA, botA)
    await runner.start(runB, botB)
    expect(runner.isRunning(runA.id)).toBe(true)
    expect(runner.isRunning(runB.id)).toBe(true)

    await runner.stopAll()

    expect(repos.runs.require(runA.id)).toMatchObject({ state: 'stopped', error: 'Stopped.' })
    expect(repos.runs.require(runB.id)).toMatchObject({ state: 'stopped', error: 'Stopped.' })
    expect(runner.isRunning(runA.id)).toBe(false)
    expect(runner.isRunning(runB.id)).toBe(false)
  })

  it('9. a taken-over PC blocks its next PC-touching tool call, and lets it through again once control is given back', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient((url) => ({ text: `Front page of ${url}` }))
    const agent = new FakeAgentClient()
    const model = scriptedModel([
      toolCallChunks('c1', 'open_page', { url: 'https://news.example' }),
      textChunks('text-1', "I couldn't open the page just now — the user has control."),
      toolCallChunks('c2', 'open_page', { url: 'https://news.example' }),
      textChunks('text-2', 'Opened the page.')
    ])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('Browsing bot')
    runner.setTakenOver(bot.id, true)

    const run1 = repos.runs.create(bot.id, 'Open the news site', join(dataDir, 'runs', 'run-1'))
    await runner.start(run1, bot)
    await runner.whenIdle(run1.id)

    // Blocked, not left stuck: the loop recovers from the refused tool call the same way it
    // recovers from a blocked password field, and the run still finishes cleanly.
    expect(repos.runs.require(run1.id).state).toBe('done')
    const items1 = await runner.items(run1.id)
    const blocked = items1.find((i) => i.kind === 'tool') as any
    expect(blocked.toolName).toBe('open_page')
    expect(blocked.state).toBe('error')
    expect(blocked.error).toMatch(/taken over/i)
    expect(await cdp.listTargets()).toEqual([]) // the page was genuinely never opened

    // Give control back, then the exact same tool call goes through normally.
    runner.setTakenOver(bot.id, false)

    const run2 = repos.runs.create(bot.id, 'Open the news site', join(dataDir, 'runs', 'run-2'))
    await runner.start(run2, bot)
    await runner.whenIdle(run2.id)

    expect(repos.runs.require(run2.id).state).toBe('done')
    const items2 = await runner.items(run2.id)
    const succeeded = items2.find((i) => i.kind === 'tool') as any
    expect(succeeded.toolName).toBe('open_page')
    expect(succeeded.state).toBe('done')
    expect(await cdp.listTargets()).toHaveLength(1) // now it really opened

    // Approval-gated PC tools are blocked the same way, even once approved: the click never reaches the agent.
    const model2 = scriptedModel([toolCallChunks('c3', 'screen_click', { x: 1, y: 1 }), textChunks('text-3', "Couldn't click — taken over.")])
    const runner2 = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model2),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })
    runner2.setTakenOver(bot.id, true)
    const run3 = repos.runs.create(bot.id, 'Click something', join(dataDir, 'runs', 'run-3'))
    await runner2.start(run3, bot)
    await runner2.whenIdle(run3.id)
    const pending = (await runner2.items(run3.id)).find((i) => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    await runner2.respond(run3.id, pending.approvalId, true)
    await runner2.whenIdle(run3.id)
    const clickItem = (await runner2.items(run3.id)).find((i) => i.kind === 'tool') as any
    expect(clickItem.state).toBe('error')
    expect(clickItem.error).toMatch(/taken over/i)
    expect(agent.calls.filter((c) => c.startsWith('input:')).length).toBe(0)
  })

  it('10. a run left "waiting-approval" mid-flight across a simulated app restart ends up "error", not stuck forever', async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient()
    const agent = new FakeAgentClient()
    const model = scriptedModel([toolCallChunks('c1', 'screen_click', { x: 9, y: 9 }), textChunks('text-1', 'Clicked it.')])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('Clicker bot')
    const run = repos.runs.create(bot.id, 'Click the button', join(dataDir, 'runs', 'run-1'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)
    expect(repos.runs.require(run.id).state).toBe('waiting-approval')

    // Simulate the app closing and restarting: a brand-new BotRunner has no idea this run ever
    // existed (its pending approval lived only in the old process's memory), exactly like a real
    // restart. main.ts calls repos.runs.resetInterrupted() at startup before any runner exists.
    const resetRuns = repos.runs.resetInterrupted()
    expect(resetRuns.map((r) => r.id)).toContain(run.id)
    expect(repos.runs.require(run.id)).toMatchObject({ state: 'error', error: 'Stopped because Deskmates was closed.' })

    const freshRunner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(scriptedModel([])),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    // Not stuck: the old approval id gets a clear, immediate rejection instead of hanging forever
    // or silently doing nothing (the exact bug — respond()/stop() used to no-op on an unknown run).
    const pending = (await freshRunner.items(run.id)).find((i) => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    await expect(freshRunner.respond(run.id, pending.approvalId, true)).rejects.toThrow("isn't waiting for approval")
    await expect(freshRunner.stop(run.id)).resolves.toBeUndefined() // stop() is always a safe no-op on an unknown run

    expect(repos.runs.require(run.id).state).toBe('error')
  })

  it('11. a whatsapp_send call never writes the raw number or message body to the log file — only a masked number and a redacted body, the same way the agent token is kept out of it', async () => {
    const RAW_NUMBER = '+1 555 987 6543'
    const RAW_DIGITS = '15559876543' // the full, contiguous digit run — must never appear, though its trailing 4 digits legitimately do (that's the "masked but recognizable" design)
    const RAW_MESSAGE = 'The front page changed: new headline about the harbor bridge closing next week.'

    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new FakeCdpClient((url) => ({ text: `WhatsApp Web chat for ${url}` }))
    const agent = new FakeAgentClient()
    const model = scriptedModel([
      toolCallChunks('c1', 'whatsapp_send', { to: RAW_NUMBER, message: RAW_MESSAGE }),
      textChunks('text-1', 'Sent the digest.')
    ])
    repos.settings.update({ whatsappTo: RAW_NUMBER })
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 10,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })

    const bot = repos.bots.create('WhatsApp bot')
    const run = repos.runs.create(bot.id, 'Send the digest', join(dataDir, 'runs', 'run-1'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)

    // whatsapp_send is risky by default (RISKY_BOT_TOOLS), so this run should be paused at
    // waiting-approval — prove the raw content is already redacted at THIS point, on disk, not
    // only after the tool actually executes.
    expect(repos.runs.require(run.id).state).toBe('waiting-approval')
    const pendingLog = readFileSync(join(run.folder, 'log.jsonl'), 'utf8')
    expect(pendingLog).not.toContain(RAW_NUMBER)
    expect(pendingLog).not.toContain(RAW_DIGITS)
    expect(pendingLog).not.toContain(RAW_MESSAGE)
    expect(pendingLog).not.toContain('harbor bridge')

    const pending = (await runner.items(run.id)).find((i) => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    expect(pending.toolName).toBe('whatsapp_send')
    expect(pending.input.to).toBe('+•••••••6543') // masked, but its last 4 digits stay recognizable
    expect(pending.input.message).toBe(`[redacted, ${RAW_MESSAGE.length} chars]`)

    await runner.respond(run.id, pending.approvalId, true)
    await runner.whenIdle(run.id)

    expect(repos.runs.require(run.id).state).toBe('done')

    // The strongest check: across every line written over the run's whole lifecycle (running,
    // awaiting-approval, done), the raw number and message never appear anywhere in the physical
    // log file on disk — not just in the latest parsed snapshot.
    const finalLog = readFileSync(join(run.folder, 'log.jsonl'), 'utf8')
    expect(finalLog).not.toContain(RAW_NUMBER)
    expect(finalLog).not.toContain(RAW_DIGITS)
    expect(finalLog).not.toContain(RAW_MESSAGE)
    expect(finalLog).not.toContain('harbor bridge')

    // ...and the same holds for every run.item event on the bus (the live/IPC path), not only the
    // file — "redacted before it reaches the log" must mean before either sink, not just one.
    const busPayload = JSON.stringify(events.filter((e) => e.type === 'run.item' && e.runId === run.id))
    expect(busPayload).not.toContain(RAW_NUMBER)
    expect(busPayload).not.toContain(RAW_DIGITS)
    expect(busPayload).not.toContain(RAW_MESSAGE)

    // But the log still shows a message was sent, and to a masked-but-recognizable number.
    const sendItem = (await runner.items(run.id)).find((i) => i.kind === 'tool' && (i as any).toolName === 'whatsapp_send') as any
    expect(sendItem.state).toBe('done')
    expect(sendItem.input).toEqual({ to: '+•••••••6543', message: `[redacted, ${RAW_MESSAGE.length} chars]` })
    expect(sendItem.output).toMatchObject({ sent: true })
  })

  it('12. a PC tool that finds the PC gone brings the PC back up and retries once, so the run carries on', async () => {
    const { host, calls: hostCalls } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    const cdp = new UnreachableOnceCdpClient()
    const model = scriptedModel([
      toolCallChunks('c1', 'open_page', { url: 'https://www.youtube.com' }),
      textChunks('text-1', 'Opened it.')
    ])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 5,
      createAgentClient: () => new FakeAgentClient(),
      createCdpClient: () => cdp
    })
    const bot = repos.bots.create('Browser bot', '')
    const run = repos.runs.create(bot.id, 'go to youtube.com', join(dataDir, 'runs', 'run-12'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)

    expect(repos.runs.require(run.id).state).toBe('done')
    expect(hostCalls).toEqual([`start:${bot.id}`, `endpoints:${bot.id}`, `start:${bot.id}`])
    expect(cdp.closes).toBeGreaterThanOrEqual(1)
    const openItem = (await runner.items(run.id)).find((i) => i.kind === 'tool' && (i as any).toolName === 'open_page') as any
    expect(openItem.state).toBe('done')
    expect(openItem.output).toMatchObject({ url: 'https://www.youtube.com' })
  })

  it("13. when the PC can't be brought back, the tool error says why in plain words instead of a bare \"fetch failed\"", async () => {
    const { host } = makeFakeHost({ endpoints: FAKE_ENDPOINTS })
    let starts = 0
    const originalStart = host.start.bind(host)
    host.start = async (botId) => {
      starts++
      if (starts > 1) throw new BotHostError('engine-not-running', "The Deskmates engine isn't running. Open the setup wizard to start it.")
      return originalStart(botId)
    }
    const model = scriptedModel([
      toolCallChunks('c1', 'open_page', { url: 'https://www.youtube.com' }),
      textChunks('text-1', "I couldn't reach my PC.")
    ])
    const runner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(model),
      dataDir,
      maxSteps: 5,
      createAgentClient: () => new FakeAgentClient(),
      createCdpClient: () => new UnreachableOnceCdpClient()
    })
    const bot = repos.bots.create('Browser bot', '')
    const run = repos.runs.create(bot.id, 'go to youtube.com', join(dataDir, 'runs', 'run-13'))

    await runner.start(run, bot)
    await runner.whenIdle(run.id)

    const openItem = (await runner.items(run.id)).find((i) => i.kind === 'tool' && (i as any).toolName === 'open_page') as any
    expect(openItem.state).toBe('error')
    expect(openItem.error).toBe(
      "This bot's PC stopped responding and couldn't be started again: The Deskmates engine isn't running. Open the setup wizard to start it."
    )
  })
})
