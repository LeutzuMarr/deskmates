/**
 * Task 29's acceptance test: the "daily website digest to WhatsApp" template, proving the whole
 * chain from the design spec's main use case (section 2) with fakes only — no Docker, WSL or
 * network. `createBotFromTemplate` builds the bot; a real `Scheduler` fires it on a controlled
 * clock; a real `BotRunner` drives a real `MockLanguageModelV4` through the real bot tools; only
 * the PC host, the browser (CDP) and the wake-timer command runner are faked. The one deliberate
 * departure from `bot-runner.test.ts`'s usual in-memory `FakeAgentClient` is `DiskBackedAgentClient`
 * below: it really reads and writes the bot's PC storage on disk, so this test can prove
 * `createBotFromTemplate`'s seed memory file and a run's own read_pc_file/write_pc_file calls are
 * genuinely the same file — the same thing a real container's bind mount guarantees in production
 * (see `host-paths.ts`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { BotRunner } from '../../src/core/bots/runner'
import type { CommandResult, CommandRunner, RunOptions } from '../../src/core/bots/command-runner'
import type { BotHost, PcEndpoints } from '../../src/core/bots/host'
import { pcStorageDir } from '../../src/core/bots/host-paths'
import type { ScheduleService } from '../../src/core/bots/services'
import { createBotFromTemplate, DAILY_WEBSITE_DIGEST_TEMPLATE } from '../../src/core/bots/templates'
import type { AgentClient, AgentExecResult, InputAction } from '../../src/core/bots/tools/agent-client'
import type { CdpClient, CdpTargetInfo, PageContent } from '../../src/core/bots/tools/cdp-client'
import { EventBus } from '../../src/core/events'
import { Scheduler } from '../../src/core/scheduler/scheduler'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import type { Bot, CoreEvent, Schedule } from '../../src/shared/protocol'

// ---- MockLanguageModelV4 chunk helpers, the same shapes proven in bot-runner.test.ts / runner.test.ts ----

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
const SITE_URL = 'https://news.example/daily'
const WHATSAPP_TO = '+1 555 000 9999'
const WHATSAPP_TO_DIGITS = WHATSAPP_TO.replace(/\D/g, '')

// ---- fakes: PC host, wake-timer command runner (no Docker, WSL, Task Scheduler or network) ----

/** BotRunner only ever calls start()/endpoints(); every other method throws if it's ever reached — same contract as bot-runner.test.ts's own fake host. */
function makeFakeHost(): { host: BotHost; calls: string[] } {
  const calls: string[] = []
  const notUsed = (name: string) => (): never => {
    throw new Error(`BotRunner should not call BotHost.${name} in this test`)
  }
  const host: BotHost = {
    create: notUsed('create'),
    async start(botId) {
      calls.push(`start:${botId}`)
      return { botId, state: 'running', containerId: `c-${botId}`, memoryMb: 1024, idleStopMinutes: 30, lastUsedAt: 1, error: null }
    },
    stop: notUsed('stop'),
    reset: notUsed('reset'),
    delete: notUsed('delete'),
    status: notUsed('status'),
    async endpoints(botId) {
      calls.push(`endpoints:${botId}`)
      return FAKE_ENDPOINTS
    },
    exec: notUsed('exec'),
    copyIn: notUsed('copyIn'),
    copyOut: notUsed('copyOut'),
    pull: notUsed('pull'),
    buildLocal: notUsed('buildLocal')
  }
  return { host, calls }
}

/** Canned schtasks responses, in the spirit of scheduler.test.ts's own FakeCommandRunner — never real Task Scheduler. */
class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ file: string; args: string[] }> = []
  async run(file: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ file, args })
    return { code: 0, stdout: '', stderr: '' }
  }
}

const WHATSAPP_PREFIX = 'https://web.whatsapp.com/'

/**
 * A fake Chromium serving two different pages by URL, exactly the way a bot's one real browser
 * does across a run: the digest's target site (its text from a callback, so a test can change
 * what it says between "days") and WhatsApp Web's send-deep-link flow (see `whatsapp.ts`).
 */
class FakeCdpClient implements CdpClient {
  readonly calls: string[] = []
  readonly sentWhatsAppMessages: Array<{ to: string; text: string }> = []
  private nextId = 1
  private readonly pages = new Map<string, string>() // targetId -> current url

  constructor(private readonly siteText: () => string) {}

  private contentFor(url: string): PageContent {
    if (url.startsWith(WHATSAPP_PREFIX)) {
      return { url, title: 'WhatsApp', text: 'Chat\nType a message', links: [], hasPasswordField: false }
    }
    return { url, title: 'Example Daily News', text: this.siteText(), links: [], hasPasswordField: false }
  }

  async listTargets(): Promise<CdpTargetInfo[]> {
    return [...this.pages.entries()].map(([targetId, url]) => ({ targetId, url, title: this.contentFor(url).title }))
  }

  async newTab(url: string): Promise<CdpTargetInfo> {
    this.calls.push(`newTab:${url}`)
    const targetId = `t${this.nextId++}`
    this.pages.set(targetId, url)
    return { targetId, url, title: this.contentFor(url).title }
  }

  async navigate(targetId: string, url: string): Promise<CdpTargetInfo> {
    this.calls.push(`navigate:${targetId}:${url}`)
    if (!this.pages.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    this.pages.set(targetId, url)
    return { targetId, url, title: this.contentFor(url).title }
  }

  async closeTab(targetId: string): Promise<void> {
    this.pages.delete(targetId)
  }

  async readPage(targetId: string): Promise<PageContent> {
    const url = this.pages.get(targetId)
    if (url === undefined) throw new Error('No open tab with that id. Use tabs to see what is open.')
    return this.contentFor(url)
  }

  async click(targetId: string, selector: string): Promise<void> {
    this.calls.push(`click:${targetId}:${selector}`)
    if (!this.pages.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
  }

  /** Mirrors whatsapp.ts's real compose-box selector so a genuine `whatsapp_send` call is captured here, not guessed at. */
  async typeText(targetId: string, selector: string, text: string): Promise<void> {
    this.calls.push(`typeText:${targetId}:${selector}`)
    const url = this.pages.get(targetId)
    if (url === undefined) throw new Error('No open tab with that id. Use tabs to see what is open.')
    if (url.startsWith(WHATSAPP_PREFIX) && selector === 'footer [contenteditable="true"]') {
      this.sentWhatsAppMessages.push({ to: new URL(url).searchParams.get('phone') ?? '', text })
    }
  }

  async screenshot(targetId: string): Promise<Buffer> {
    if (!this.pages.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    return Buffer.from('fake-page-png')
  }

  async close(): Promise<void> {}
}

/**
 * A fake agent.py that really reads and writes the bot's PC storage on disk (under the same
 * `pcStorageDir` a running container bind-mounts as `/home/bot/data`), instead of the in-memory
 * map `bot-runner.test.ts` uses — so this test can prove `createBotFromTemplate`'s seed memory
 * file and a run's own read_pc_file/write_pc_file calls are genuinely the same file. Only
 * "data/..." paths are exercised by this template, so that's all this fake supports.
 */
class DiskBackedAgentClient implements AgentClient {
  readonly calls: string[] = []

  constructor(private readonly dataRoot: string) {}

  private resolve(path: string): string {
    if (!path.startsWith('data/')) throw new Error(`test fake only supports "data/..." paths, got "${path}"`)
    return join(this.dataRoot, path.slice('data/'.length))
  }

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
    const abs = this.resolve(path)
    if (!existsSync(abs)) throw new Error('file not found')
    return readFileSync(abs)
  }

  async writeFile(path: string, data: Buffer | string): Promise<{ bytes: number }> {
    this.calls.push(`writeFile:${path}`)
    const abs = this.resolve(path)
    mkdirSync(dirname(abs), { recursive: true })
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    writeFileSync(abs, buf)
    return { bytes: buf.length }
  }
}

describe('daily website digest template, end to end', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'deskmates-daily-digest-'))
    repos.settings.update({ whatsappTo: WHATSAPP_TO })
  })

  afterEach(() => {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  /** The last `run.updated` event's run id for a bot — how this test finds the run a `scheduler.tick()` just fired without racing `RunsRepo`'s wall-clock ordering (see the class doc above `Scheduler.startRun`: it's fire-and-forget, but it emits `run.updated` before returning). */
  function latestRunId(botId: string): string {
    const matches = events.filter((e): e is Extract<CoreEvent, { type: 'run.updated' }> => e.type === 'run.updated' && e.run.botId === botId)
    const last = matches[matches.length - 1]
    if (!last) throw new Error(`No run.updated event for bot ${botId} yet.`)
    return last.run.id
  }

  interface Harness {
    bot: Bot
    schedule: Schedule
    botRunner: BotRunner
    scheduler: Scheduler
    cdp: FakeCdpClient
    agent: DiskBackedAgentClient
    hostCalls: string[]
    commandRunner: FakeCommandRunner
  }

  /** Creates the digest bot from the template, then wires a real Scheduler + real BotRunner around it against fakes — the one thing this needs that `createBotFromTemplate` itself can't provide up front, since building `BotRunner`'s fakes needs the bot's own id, which the template call produces (see the inline comment below). */
  async function setUp(opts: {
    model: MockLanguageModelV4
    siteText: () => string
    startNow: number
    params?: { missed?: 'run-late' | 'skip' }
  }): Promise<Harness> {
    const created = await createBotFromTemplate({ repos, dataDir }, DAILY_WEBSITE_DIGEST_TEMPLATE, {
      site: SITE_URL,
      time: '08:00',
      whatToReport: 'new articles',
      ...opts.params
    })

    const clock = { now: opts.startNow }
    const { host, calls: hostCalls } = makeFakeHost()
    const cdp = new FakeCdpClient(opts.siteText)
    const agent = new DiskBackedAgentClient(pcStorageDir(dataDir, created.bot.id))
    const botRunner = new BotRunner({
      repos,
      bus,
      host,
      models: makeModels(opts.model),
      dataDir,
      maxSteps: 10,
      now: () => clock.now,
      createAgentClient: () => agent,
      createCdpClient: () => cdp
    })
    const commandRunner = new FakeCommandRunner()
    const scheduler = new Scheduler({ repos, bus, runner: commandRunner, dataDir, run: botRunner, now: () => clock.now, wakeLeadMinutes: 2 })

    // The app-wide Scheduler doesn't exist yet at the point above where createBotFromTemplate ran
    // (it needs `botRunner`, which needs the new bot's own id to scope its fakes to) — sync once
    // here instead, exactly what schedules.create's own `if (services.schedule)` branch does in
    // handlers.ts. In production this is a non-issue: the Scheduler is a single instance built once
    // at app boot, long before any particular bot exists, so a real `bots.createFromTemplate`
    // handler can simply pass it straight into `createBotFromTemplate`'s `deps.schedule`.
    const { nextRunAt } = await scheduler.sync(created.schedule)
    const schedule = repos.schedules.update(created.schedule.id, { nextRunAt })

    return { bot: created.bot, schedule, botRunner, scheduler, cdp, agent, hostCalls, commandRunner }
  }

  it('1. createBotFromTemplate creates the bot, its PC row, its schedule and its seed memory in one call, with instructions covering every rule the template must enforce', async () => {
    const fakeSchedule: ScheduleService = {
      sync: async () => ({ nextRunAt: 999_000 }),
      unsync: async () => {}
    }

    const result = await createBotFromTemplate(
      { repos, dataDir, bus, schedule: fakeSchedule },
      DAILY_WEBSITE_DIGEST_TEMPLATE,
      { site: 'https://news.example/daily', time: '08:00', whatToReport: 'new articles' }
    )

    expect(result.bot.name).toBe('Daily digest: news.example/daily')
    expect(result.bot.autoApprove).toEqual(['whatsapp_send']) // pre-approved so a scheduled run never stalls waiting for a click nobody's there to make
    expect(result.pc.botId).toBe(result.bot.id)
    expect(result.schedule).toMatchObject({ botId: result.bot.id, cron: '0 8 * * *', missed: 'run-late', enabled: true, nextRunAt: 999_000 })
    expect(result.schedule.task).toContain('news.example/daily')
    expect(result.warnings).toEqual([]) // a WhatsApp number is already set in beforeEach

    // The instructions cover every rule the task asked for, in the bot's own words:
    expect(result.bot.instructions).toContain('read_page, not a screenshot') // text over screenshots
    expect(result.bot.instructions).toContain('not already in that list') // works out what's new from memory
    expect(result.bot.instructions).toContain('short summary') // keeps the message short
    expect(result.bot.instructions).toContain('never re-list anything already in data/reported.json') // never repeats
    expect(result.bot.instructions).toContain('Never log in anywhere') // never logs in...
    expect(result.bot.instructions).toContain('Take Over') // ...points at Take Over instead

    // Its memory already exists on disk before its first run, at the same path a running PC bind-mounts as /home/bot/data.
    const memoryPath = join(pcStorageDir(dataDir, result.bot.id), 'reported.json')
    expect(existsSync(memoryPath)).toBe(true)
    expect(readFileSync(memoryPath, 'utf8')).toBe('[]\n')

    // Everything was actually persisted, not just returned.
    expect(repos.bots.require(result.bot.id)).toEqual(result.bot)
    expect(repos.schedules.list(result.bot.id)).toEqual([result.schedule])
    expect(repos.botPcs.require(result.bot.id)).toEqual(result.pc)

    expect(events.some((e) => e.type === 'bot.updated' && e.bot.id === result.bot.id)).toBe(true)
    expect(events.some((e) => e.type === 'pc.updated' && e.pc.botId === result.bot.id)).toBe(true)
    expect(events.some((e) => e.type === 'schedule.updated' && e.schedule.id === result.schedule.id)).toBe(true)
  })

  it('2. warns instead of blocking when no WhatsApp number is set in Settings yet', async () => {
    repos.settings.update({ whatsappTo: '' })

    const result = await createBotFromTemplate({ repos, dataDir }, DAILY_WEBSITE_DIGEST_TEMPLATE, { site: 'https://news.example', time: '08:00' })

    expect(result.warnings).toEqual(["No WhatsApp number is set in Settings yet — add one before this bot can send messages."])
    expect(repos.bots.require(result.bot.id)).toBeTruthy() // still fully created
    expect(repos.schedules.list(result.bot.id)).toHaveLength(1)
  })

  it('3. validates before creating anything: an empty site or a badly formatted time throws, and leaves no bot behind', async () => {
    await expect(createBotFromTemplate({ repos, dataDir }, DAILY_WEBSITE_DIGEST_TEMPLATE, { site: '   ', time: '08:00' })).rejects.toThrow(
      'Give the site to check.'
    )
    await expect(
      createBotFromTemplate({ repos, dataDir }, DAILY_WEBSITE_DIGEST_TEMPLATE, { site: 'https://news.example', time: '8am' })
    ).rejects.toThrow('Give the time as 24-hour HH:MM')

    expect(repos.bots.list()).toEqual([])
  })

  it('4. the scheduler fires the bot at its cron time on a controlled clock; it reads the site, remembers what it reported, WhatsApps only the configured number, and the next day does not repeat what it already sent', async () => {
    let siteText = 'Front page, 10 June:\n- Article A: things happened\n- Article B: more things'
    const startNow = new Date(2027, 5, 10, 7, 0, 0).getTime() // 07:00 local, before today's 08:00 run

    const model = scriptedModel([
      // Day 1 (10 June): nothing reported yet.
      toolCallChunks('d1-open', 'open_page', { url: SITE_URL }),
      toolCallChunks('d1-read', 'read_page', {}),
      toolCallChunks('d1-memory', 'read_pc_file', { path: 'data/reported.json' }),
      toolCallChunks('d1-send', 'whatsapp_send', { to: WHATSAPP_TO, message: 'Today: Article A, Article B.' }),
      toolCallChunks('d1-remember', 'write_pc_file', { path: 'data/reported.json', content: JSON.stringify(['Article A', 'Article B']) }),
      textChunks('d1-done', 'Checked the site and WhatsApped Article A and Article B.'),

      // Day 2 (11 June): the site now also has Article C.
      toolCallChunks('d2-open', 'open_page', { url: SITE_URL }),
      toolCallChunks('d2-read', 'read_page', {}),
      toolCallChunks('d2-memory', 'read_pc_file', { path: 'data/reported.json' }),
      toolCallChunks('d2-send', 'whatsapp_send', { to: WHATSAPP_TO, message: 'Today: Article C.' }),
      toolCallChunks('d2-remember', 'write_pc_file', {
        path: 'data/reported.json',
        content: JSON.stringify(['Article A', 'Article B', 'Article C'])
      }),
      textChunks('d2-done', 'Only Article C was new — already reported A and B, so I left them out.')
    ])

    const h = await setUp({ model, siteText: () => siteText, startNow })
    expect(h.schedule.nextRunAt).toBe(new Date(2027, 5, 10, 8, 0, 0).getTime())
    expect(h.commandRunner.calls.some((c) => c.file === 'schtasks' && c.args.includes('/Create'))).toBe(true) // the wake timer really got registered

    // ---- Day 1, 08:00 ----
    await h.scheduler.tick(h.schedule.nextRunAt! + 30_000) // 30s late — an ordinary on-time tick, not a catch-up
    const run1Id = latestRunId(h.bot.id)
    await h.botRunner.whenIdle(run1Id)

    const run1 = repos.runs.require(run1Id)
    expect(run1.state).toBe('done')
    expect(run1.error).toBeNull()
    expect(h.hostCalls).toEqual([`start:${h.bot.id}`, `endpoints:${h.bot.id}`]) // the PC really "started" for this run

    expect(existsSync(join(run1.folder, 'log.jsonl'))).toBe(true) // the run's log is really on disk
    const items1 = await h.botRunner.items(run1Id)
    const toolItems1 = items1.filter((i) => i.kind === 'tool') as any[]
    expect(toolItems1.map((i) => i.toolName)).toEqual(['open_page', 'read_page', 'read_pc_file', 'whatsapp_send', 'write_pc_file'])
    expect(toolItems1.every((i) => i.state === 'done')).toBe(true)

    // The very first run could already read the memory createBotFromTemplate seeded before any run happened.
    const readMemory1 = toolItems1.find((i) => i.toolName === 'read_pc_file')!
    expect(readMemory1.output).toMatchObject({ content: '[]\n' })

    // whatsapp_send's own proof screenshot is really on disk under the run's folder.
    const sendItem1 = toolItems1.find((i) => i.toolName === 'whatsapp_send')!
    expect(sendItem1.output.screenshot.path).toMatch(/^whatsapp-\d+\.png$/)
    expect(existsSync(join(run1.folder, sendItem1.output.screenshot.path))).toBe(true)

    // The message really only ever reached the number configured in Settings.
    expect(h.cdp.sentWhatsAppMessages).toEqual([{ to: WHATSAPP_TO_DIGITS, text: 'Today: Article A, Article B.' }])

    // The seed memory was genuinely replaced by the run's own write, at the same disk path.
    const memoryPath = join(pcStorageDir(dataDir, h.bot.id), 'reported.json')
    expect(JSON.parse(readFileSync(memoryPath, 'utf8'))).toEqual(['Article A', 'Article B'])

    // ---- Day 2, next 08:00 — the site now has a new item too ----
    siteText = 'Front page, 11 June:\n- Article A: things happened\n- Article B: more things\n- Article C: brand new'
    const schedAfterDay1 = repos.schedules.require(h.schedule.id)
    expect(schedAfterDay1.nextRunAt).toBe(new Date(2027, 5, 11, 8, 0, 0).getTime()) // advanced to tomorrow, not queued for later today

    await h.scheduler.tick(schedAfterDay1.nextRunAt! + 30_000)
    const run2Id = latestRunId(h.bot.id)
    expect(run2Id).not.toBe(run1Id)
    await h.botRunner.whenIdle(run2Id)

    const run2 = repos.runs.require(run2Id)
    expect(run2.state).toBe('done')
    expect(h.hostCalls).toEqual([`start:${h.bot.id}`, `endpoints:${h.bot.id}`, `start:${h.bot.id}`, `endpoints:${h.bot.id}`])

    const items2 = await h.botRunner.items(run2Id)
    const toolItems2 = items2.filter((i) => i.kind === 'tool') as any[]
    const readMemory2 = toolItems2.find((i) => i.toolName === 'read_pc_file')!
    // Genuinely retrieved, through the real read_pc_file tool, exactly what day 1's real write_pc_file persisted — not just asserted from the script.
    expect(readMemory2.output).toMatchObject({ content: JSON.stringify(['Article A', 'Article B']) })

    // Day 2's message covers the new item and never repeats yesterday's — memory did its job.
    expect(h.cdp.sentWhatsAppMessages).toHaveLength(2)
    const sentDay2 = h.cdp.sentWhatsAppMessages[1]!
    expect(sentDay2.to).toBe(WHATSAPP_TO_DIGITS)
    expect(sentDay2.text).toContain('Article C')
    expect(sentDay2.text).not.toContain('Article A')
    expect(sentDay2.text).not.toContain('Article B')

    expect(JSON.parse(readFileSync(memoryPath, 'utf8'))).toEqual(['Article A', 'Article B', 'Article C'])
  })

  it('5. a run missed while the PC was off is still caught up, per the schedule\'s "run-late" policy — and "skip" genuinely starts nothing', async () => {
    const startNow = new Date(2027, 5, 10, 7, 0, 0).getTime()

    const runLateModel = scriptedModel([
      toolCallChunks('c-open', 'open_page', { url: SITE_URL }),
      toolCallChunks('c-read', 'read_page', {}),
      toolCallChunks('c-memory', 'read_pc_file', { path: 'data/reported.json' }),
      toolCallChunks('c-send', 'whatsapp_send', { to: WHATSAPP_TO, message: 'Catching up on today.' }),
      toolCallChunks('c-remember', 'write_pc_file', { path: 'data/reported.json', content: '["Caught up"]' }),
      textChunks('c-done', "The PC was off at 08:00, so I'm only checking now.")
    ])
    const runLate = await setUp({
      model: runLateModel,
      siteText: () => 'Front page: nothing unusual.',
      startNow,
      params: { missed: 'run-late' }
    })

    // The PC was off straight through 08:00 and only comes back hours later — well past the 5-minute catch-up threshold.
    const lateNow = runLate.schedule.nextRunAt! + 3 * 3600 * 1000
    await runLate.scheduler.tick(lateNow)

    const runs = repos.runs.list(runLate.bot.id)
    expect(runs).toHaveLength(1) // caught up exactly once, not once per missed hour
    await runLate.botRunner.whenIdle(runs[0]!.id)

    expect(repos.runs.require(runs[0]!.id).state).toBe('done')
    expect(runLate.hostCalls).toEqual([`start:${runLate.bot.id}`, `endpoints:${runLate.bot.id}`]) // the PC genuinely started for the catch-up run
    expect(runLate.cdp.sentWhatsAppMessages).toHaveLength(1)

    const updatedSchedule = repos.schedules.require(runLate.schedule.id)
    expect(updatedSchedule.lastRunAt).toBe(lateNow)
    // Resumes its normal cadence from now, not the missed time — doesn't queue up extra runs for the gap.
    expect(updatedSchedule.nextRunAt).toBe(new Date(2027, 5, 11, 8, 0, 0).getTime())

    // Contrast: identically late, but "skip" starts nothing at all — proving this is genuinely the schedule's own policy, not always-catch-up.
    const skipHarness = await setUp({
      model: scriptedModel([]),
      siteText: () => 'irrelevant',
      startNow,
      params: { missed: 'skip' }
    })
    await skipHarness.scheduler.tick(skipHarness.schedule.nextRunAt! + 3 * 3600 * 1000)
    expect(repos.runs.list(skipHarness.bot.id)).toHaveLength(0)
    expect(skipHarness.hostCalls).toEqual([]) // the PC was never even started
  })

  it('6. whatsapp_send only ever reaches the number configured in Settings, even through a full scheduled run — a wrong number is refused without breaking the run', async () => {
    const startNow = new Date(2027, 5, 10, 7, 0, 0).getTime()
    const WRONG_NUMBER = '+44 20 7946 0958'

    const model = scriptedModel([
      toolCallChunks('w-open', 'open_page', { url: SITE_URL }),
      toolCallChunks('w-read', 'read_page', {}),
      toolCallChunks('w-memory', 'read_pc_file', { path: 'data/reported.json' }),
      toolCallChunks('w-send', 'whatsapp_send', { to: WRONG_NUMBER, message: 'oops, wrong number' }),
      textChunks('w-done', 'Something went wrong sending that.')
    ])
    const h = await setUp({ model, siteText: () => 'Front page: one small update.', startNow })

    await h.scheduler.tick(h.schedule.nextRunAt! + 30_000)
    const runId = latestRunId(h.bot.id)
    await h.botRunner.whenIdle(runId)

    // A refused tool call is not a broken run — same recovery bot-runner.test.ts proves for a blocked password field.
    expect(repos.runs.require(runId).state).toBe('done')

    const items = await h.botRunner.items(runId)
    const sendItem = items.find((i) => i.kind === 'tool' && (i as any).toolName === 'whatsapp_send') as any
    expect(sendItem.state).toBe('error')
    expect(sendItem.error).toBe('whatsapp_send can only message the number configured for this bot.')

    // And genuinely never touched WhatsApp for it — no tab was opened toward that number.
    expect(h.cdp.sentWhatsAppMessages).toEqual([])
    expect(h.cdp.calls.some((c) => c.includes('web.whatsapp.com'))).toBe(false)
  })
})
