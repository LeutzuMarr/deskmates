import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../src/core/events'
import { ChangeLog } from '../../src/core/fs/change-log'
import { TaskRunner, type ModelResolver } from '../../src/core/engine/runner'
import { KeyStore } from '../../src/core/models/keys'
import { ModelService } from '../../src/core/models/providers'
import { createHandlers } from '../../src/core/server/handlers'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import { buildTools } from '../../src/core/tools'
import type { EngineService, PcService, RunService, ScheduleService } from '../../src/core/bots/services'
import type { Bot, BotPc, BotRun, CoreEvent, EngineStatus, RpcMethod } from '../../src/shared/protocol'

type TestApi = Record<RpcMethod, (params: any) => any>

/** A fake PcService: tracks every call and keeps just enough state to make start-after-create realistic. */
function makeFakePc() {
  const pcs = new Map<string, BotPc>()
  const calls: string[] = []
  // Bot ids whose delete() should throw, simulating the engine being unreachable (e.g. WSL/Docker down).
  const failDeleteIds = new Set<string>()
  const service: PcService = {
    async create(botId, options) {
      calls.push(`create:${botId}`)
      const pc: BotPc = {
        botId,
        state: 'running',
        containerId: `container-${botId}`,
        memoryMb: options.memoryMb,
        idleStopMinutes: options.idleStopMinutes,
        lastUsedAt: 1000,
        error: null
      }
      pcs.set(botId, pc)
      return pc
    },
    async start(botId) {
      calls.push(`start:${botId}`)
      const current = pcs.get(botId)
      if (!current) throw new Error("This bot's PC hasn't been created yet.")
      const next: BotPc = { ...current, state: 'running', lastUsedAt: 2000 }
      pcs.set(botId, next)
      return next
    },
    async stop(botId) {
      calls.push(`stop:${botId}`)
      const current = pcs.get(botId)
      if (!current) throw new Error('Unknown PC.')
      const next: BotPc = { ...current, state: 'stopped' }
      pcs.set(botId, next)
      return next
    },
    async reset(botId) {
      calls.push(`reset:${botId}`)
      const next: BotPc = { botId, state: 'absent', containerId: null, memoryMb: 0, idleStopMinutes: 0, lastUsedAt: null, error: null }
      pcs.set(botId, next)
      return next
    },
    async delete(botId) {
      calls.push(`delete:${botId}`)
      if (failDeleteIds.has(botId)) throw new Error("The Deskmates engine isn't running. Open the setup wizard to start it.")
      pcs.delete(botId)
    },
    async endpoints(botId) {
      calls.push(`endpoints:${botId}`)
      const current = pcs.get(botId)
      if (!current || current.state !== 'running') return null
      return { novnc: 'http://127.0.0.1:6901', agent: 'http://127.0.0.1:8701', cdp: 'http://127.0.0.1:9221', token: 'agent-secret' }
    },
    setMode(mode) {
      calls.push(`mode:${mode}`)
    },
    updatePcOptions(botId, patch) {
      calls.push(`options:${botId}:${JSON.stringify(patch)}`)
    }
  }
  return { service, calls, failDeleteIds }
}

/** A fake EngineService whose setup() reports two progress steps before finishing. */
function makeFakeEngine() {
  const calls: string[] = []
  const base: EngineStatus = {
    ready: false,
    virtualization: true,
    steps: {
      wsl: { state: 'missing', detail: 'WSL is not installed.' },
      distro: { state: 'missing', detail: '' },
      docker: { state: 'missing', detail: '' },
      image: { state: 'missing', detail: '' }
    }
  }
  const service: EngineService = {
    async status() {
      calls.push('status')
      return base
    },
    async setup(onProgress) {
      calls.push('setup')
      const working: EngineStatus = { ...base, steps: { ...base.steps, wsl: { state: 'working', detail: 'Installing WSL…' } } }
      onProgress(working)
      const done: EngineStatus = { ...working, ready: true, steps: { ...working.steps, wsl: { state: 'ok', detail: 'Installed' } } }
      onProgress(done)
      return done
    }
  }
  return { service, calls }
}

/** A fake RunService that records what it was asked to start/stop, without doing any real work. */
function makeFakeRun() {
  const calls: string[] = []
  const started: Array<{ run: BotRun; bot: Bot }> = []
  const service: RunService = {
    async start(run, bot) {
      calls.push(`start:${run.id}`)
      started.push({ run, bot })
    },
    async stop(runId) {
      calls.push(`stop:${runId}`)
    },
    async items(runId) {
      calls.push(`items:${runId}`)
      return [{ kind: 'assistant', id: 'i1', at: 1, text: 'Sent the WhatsApp message.' }]
    },
    async respond(runId, approvalId, approved, always) {
      calls.push(`respond:${runId}:${approvalId}:${approved}:${always ?? false}`)
    },
    setTakenOver(botId, on) {
      calls.push(`takeOver:${botId}:${on}`)
    }
  }
  return { service, calls, started }
}

/** A fake ScheduleService: rejects the sentinel cron `'not a cron'`, otherwise returns a fixed nextRunAt. Unsync fails for ids in `failUnsyncIds`. */
function makeFakeSchedule() {
  const calls: string[] = []
  const failUnsyncIds = new Set<string>()
  const service: ScheduleService = {
    async sync(schedule) {
      calls.push(`sync:${schedule.id}`)
      if (schedule.cron === 'not a cron') throw new Error("That isn't a valid cron expression.")
      return { nextRunAt: 111111 }
    },
    async unsync(scheduleId) {
      calls.push(`unsync:${scheduleId}`)
      if (failUnsyncIds.has(scheduleId)) throw new Error('Access is denied.')
    }
  }
  return { service, calls, failUnsyncIds }
}

interface Fixture {
  db: DatabaseSync
  repos: Repos
  events: CoreEvent[]
  api: TestApi
  pc: ReturnType<typeof makeFakePc>
  engine: ReturnType<typeof makeFakeEngine>
  run: ReturnType<typeof makeFakeRun>
  schedule: ReturnType<typeof makeFakeSchedule>
  cleanup(): void
}

let fixtures: Fixture[] = []

/** withServices=false leaves engine/pc/run/schedule unset, to exercise the "not set up" answers. */
function makeFixture(withServices: boolean): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-bots-handlers-')))
  const db = openDatabase(':memory:')
  const repos = createRepos(db)
  const bus = new EventBus()
  const keys = new KeyStore()
  const modelService = new ModelService(keys, () => repos.settings.get())
  const changes = new ChangeLog(repos.changes, join(base, 'snapshots'))
  // Bots handler tests never exercise tasks.send, so the Work-tab model resolver is never called.
  const unusedModels: ModelResolver = {
    resolve: () => {
      throw new Error('Not used in bots handler tests.')
    }
  }
  const runner = new TaskRunner({ repos, bus, models: unusedModels, changes, createTools: buildTools })

  const pc = makeFakePc()
  const engine = makeFakeEngine()
  const run = makeFakeRun()
  const schedule = makeFakeSchedule()

  const handlers = createHandlers({
    repos,
    bus,
    runner,
    changes,
    models: modelService,
    keys,
    version: '0.1.0',
    dataDir: base,
    ...(withServices ? { pc: pc.service, engine: engine.service, run: run.service, schedule: schedule.service } : {})
  })

  const events: CoreEvent[] = []
  bus.on((event) => events.push(event))

  const fixture: Fixture = {
    db,
    repos,
    events,
    api: handlers as unknown as TestApi,
    pc,
    engine,
    run,
    schedule,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    fixture.cleanup()
  }
})

describe('createHandlers (bots)', () => {
  it('1. bots.create validates the name, creates a default PC row, and emits bot.updated + pc.updated', async () => {
    const f = makeFixture(false)

    expect(() => f.api['bots.create']({ name: '   ' })).toThrow("The bot's name can't be empty.")
    expect(() => f.api['bots.create']({ name: 'x'.repeat(121) })).toThrow('120 characters')

    const bot = await f.api['bots.create']({ name: '  Digest bot  ', instructions: 'Summarize the site.' })
    expect(bot.name).toBe('Digest bot')
    expect(bot.instructions).toBe('Summarize the site.')

    expect(f.repos.botPcs.require(bot.id)).toMatchObject({ state: 'absent', memoryMb: 1024, idleStopMinutes: 30 })
    expect(f.events.some((e) => e.type === 'bot.updated' && e.bot.id === bot.id)).toBe(true)
    expect(f.events.some((e) => e.type === 'pc.updated' && e.pc.botId === bot.id)).toBe(true)
  })

  it('2. bots.update validates the name when given and patches only the given fields', async () => {
    const f = makeFixture(false)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    expect(() => f.api['bots.update']({ id: bot.id, name: '  ' })).toThrow("The bot's name can't be empty.")

    const updated = await f.api['bots.update']({ id: bot.id, instructions: 'New instructions' })
    expect(updated.name).toBe('Digest bot')
    expect(updated.instructions).toBe('New instructions')

    const cleared = await f.api['bots.update']({ id: bot.id, avatar: null, autoApprove: ['whatsapp_send'] })
    expect(cleared.avatar).toBeNull()
    expect(cleared.autoApprove).toEqual(['whatsapp_send'])
    expect(f.events.filter((e) => e.type === 'bot.updated').length).toBeGreaterThanOrEqual(3)
  })

  it('3. bots.delete removes the PC and storage by default, cascades its rows, and emits bot.deleted', async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })
    const schedule = await f.api['schedules.create']({ botId: bot.id, cron: '0 8 * * *', task: 'Summarize' })

    // deletePc defaults to true: omitting it still tears down the PC, matching the confirmation dialog's promise.
    const result = await f.api['bots.delete']({ id: bot.id })

    expect(f.pc.calls).toContain(`delete:${bot.id}`)
    expect(result).toEqual({ pcWarning: null })
    expect(f.repos.bots.get(bot.id)).toBeUndefined()
    expect(f.repos.botPcs.get(bot.id)).toBeUndefined()
    expect(f.repos.schedules.list(bot.id)).toEqual([])
    // The schedule's Windows wake timer is unregistered before the cascade removes the row — otherwise an orphaned task is left waking the machine for a schedule that no longer exists.
    expect(f.schedule.calls).toContain(`unsync:${schedule.id}`)
    expect(f.events.some((e) => e.type === 'bot.deleted' && e.botId === bot.id)).toBe(true)
  })

  it('3b. bots.delete(deletePc: false) never asks the PC service to remove anything', async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })
    const result = await f.api['bots.delete']({ id: bot.id, deletePc: false })
    expect(result).toEqual({ pcWarning: null })
    expect(f.pc.calls).not.toContain(`delete:${bot.id}`)
    expect(f.repos.bots.get(bot.id)).toBeUndefined()
  })

  it("3e. bots.delete still deletes the bot, with a warning, when a wake-timer unsync fails", async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })
    const schedule = await f.api['schedules.create']({ botId: bot.id, cron: '0 8 * * *', task: 'Summarize' })
    const schedule2 = await f.api['schedules.create']({ botId: bot.id, cron: '0 9 * * *', task: 'Other' })
    f.schedule.failUnsyncIds.add(schedule.id)

    const result = await f.api['bots.delete']({ id: bot.id })

    // Deleting the bot must not block on a wake-timer teardown that can't happen; it's reported instead.
    expect(result.pcWarning).toContain("A wake timer couldn't be removed: Access is denied.")
    expect(f.repos.bots.get(bot.id)).toBeUndefined()
    // Every schedule was still asked to unsync, even after one failed.
    expect(f.schedule.calls).toContain(`unsync:${schedule.id}`)
    expect(f.schedule.calls).toContain(`unsync:${schedule2.id}`)
  })

  it('3c. bots.delete still deletes the bot, with a plain warning, when bot PCs aren\'t set up at all', async () => {
    const fNoServices = makeFixture(false)
    const orphan = await fNoServices.api['bots.create']({ name: 'Digest bot' })

    const result = await fNoServices.api['bots.delete']({ id: orphan.id, deletePc: true })

    expect(result.pcWarning).toContain("Bot PCs aren't set up on this computer yet.")
    // The bot record itself is gone regardless — a teardown that can't happen must never block deletion.
    expect(fNoServices.repos.bots.get(orphan.id)).toBeUndefined()
  })

  it("3d. bots.delete still deletes the bot, with a plain warning naming what's left, when the PC teardown itself fails", async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })
    f.pc.failDeleteIds.add(bot.id)

    const result = await f.api['bots.delete']({ id: bot.id })

    expect(result.pcWarning).toContain("Couldn't remove Digest bot's PC and storage")
    expect(result.pcWarning).toContain("The Deskmates engine isn't running.")
    expect(f.repos.bots.get(bot.id)).toBeUndefined()
    expect(f.events.some((e) => e.type === 'bot.deleted' && e.botId === bot.id)).toBe(true)
  })

  it('4. bots.run, bots.stopRun and runs.items answer with "not set up" when the run service is absent', async () => {
    const f = makeFixture(false)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    expect(() => f.api['bots.run']({ botId: bot.id, task: 'Do it' })).toThrow("Bot runs aren't set up on this computer yet.")
    await expect(f.api['bots.stopRun']({ runId: 'whatever' })).rejects.toThrow("Bot runs aren't set up on this computer yet.")
    await expect(f.api['runs.items']({ runId: 'whatever' })).rejects.toThrow("Bot runs aren't set up on this computer yet.")
    await expect(f.api['runs.respond']({ runId: 'whatever', approvalId: 'a1', approved: true })).rejects.toThrow(
      "Bot runs aren't set up on this computer yet."
    )
  })

  it('4b. runs.respond requires a real run and otherwise hands off to the run service — this is the RPC method the Bots tab must call for a paused run, never approvals.respond', async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })
    const run = await f.api['bots.run']({ botId: bot.id, task: 'Do it' })

    await expect(f.api['runs.respond']({ runId: 'missing', approvalId: 'a1', approved: true })).rejects.toThrow(
      'Run not found: missing'
    )

    expect(await f.api['runs.respond']({ runId: run.id, approvalId: 'a1', approved: true, always: true })).toBeNull()
    expect(f.run.calls).toContain(`respond:${run.id}:a1:true:true`)

    expect(await f.api['runs.respond']({ runId: run.id, approvalId: 'a2', approved: false })).toBeNull()
    expect(f.run.calls).toContain(`respond:${run.id}:a2:false:false`)
  })

  it('5. bots.run validates the task, creates a queued run, emits run.updated, and hands off to the run service', async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    expect(() => f.api['bots.run']({ botId: bot.id, task: '   ' })).toThrow('Tell the bot what to do.')

    const run = await f.api['bots.run']({ botId: bot.id, task: "Summarize today's posts" })
    expect(run).toMatchObject({ botId: bot.id, state: 'queued', task: "Summarize today's posts" })
    expect(run.folder).toContain(run.id)
    expect(f.repos.runs.require(run.id)).toEqual(run)
    expect(f.events.some((e) => e.type === 'run.updated' && e.run.id === run.id)).toBe(true)
    // The fake run service has no internal await, so the fire-and-forget hand-off has already landed.
    expect(f.run.calls).toContain(`start:${run.id}`)
    expect(f.run.started[0]?.bot.id).toBe(bot.id)

    await f.api['bots.stopRun']({ runId: run.id })
    expect(f.run.calls).toContain(`stop:${run.id}`)

    const items = await f.api['runs.items']({ runId: run.id })
    expect(items).toEqual([{ kind: 'assistant', id: 'i1', at: 1, text: 'Sent the WhatsApp message.' }])

    await expect(f.api['bots.stopRun']({ runId: 'missing' })).rejects.toThrow('Run not found: missing')
  })

  it('6. runs.list filters by bot and respects the limit', async () => {
    const f = makeFixture(true)
    const bot1 = await f.api['bots.create']({ name: 'Bot 1' })
    const bot2 = await f.api['bots.create']({ name: 'Bot 2' })
    await f.api['bots.run']({ botId: bot1.id, task: 'A' })
    await f.api['bots.run']({ botId: bot1.id, task: 'B' })
    await f.api['bots.run']({ botId: bot2.id, task: 'C' })

    expect((await f.api['runs.list']({ botId: bot1.id })).length).toBe(2)
    expect((await f.api['runs.list']({ botId: bot1.id, limit: 1 })).length).toBe(1)
    expect((await f.api['runs.list']({})).length).toBe(3)
  })

  it('7. pcs.start/stop/reset/endpoints answer with "not set up" when the PC service is absent; pcs.list/update do not need it', async () => {
    const f = makeFixture(false)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    await expect(f.api['pcs.start']({ botId: bot.id })).rejects.toThrow("Bot PCs aren't set up on this computer yet.")
    await expect(f.api['pcs.stop']({ botId: bot.id })).rejects.toThrow("Bot PCs aren't set up on this computer yet.")
    await expect(f.api['pcs.reset']({ botId: bot.id })).rejects.toThrow("Bot PCs aren't set up on this computer yet.")
    await expect(f.api['pcs.endpoints']({ botId: bot.id })).rejects.toThrow("Bot PCs aren't set up on this computer yet.")

    expect(await f.api['pcs.list']({})).toEqual([f.repos.botPcs.require(bot.id)])
    const updated = await f.api['pcs.update']({ botId: bot.id, memoryMb: 2048 })
    expect(updated.memoryMb).toBe(2048)
  })

  it('8. pcs.start creates the PC the first time and starts it afterwards; pcs.endpoints strips the token', async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    const started = await f.api['pcs.start']({ botId: bot.id })
    expect(f.pc.calls).toEqual([`create:${bot.id}`])
    expect(started).toMatchObject({ state: 'running', memoryMb: 1024, idleStopMinutes: 30 })
    expect(f.events.some((e) => e.type === 'pc.updated' && e.pc.botId === bot.id && e.pc.state === 'running')).toBe(true)

    await f.api['pcs.stop']({ botId: bot.id })
    await f.api['pcs.start']({ botId: bot.id })
    expect(f.pc.calls).toEqual([`create:${bot.id}`, `stop:${bot.id}`, `start:${bot.id}`])

    const endpoints = await f.api['pcs.endpoints']({ botId: bot.id })
    expect(endpoints).toEqual({ novnc: 'http://127.0.0.1:6901', agent: 'http://127.0.0.1:8701', cdp: 'http://127.0.0.1:9221' })
    expect(endpoints).not.toHaveProperty('token')

    const reset = await f.api['pcs.reset']({ botId: bot.id })
    expect(reset.state).toBe('absent')
  })

  it('9. pcs.update validates memory and idle bounds and best-effort propagates to the PC service', async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    expect(() => f.api['pcs.update']({ botId: bot.id, memoryMb: 256 })).toThrow(/between 512 and 8192/)
    expect(() => f.api['pcs.update']({ botId: bot.id, memoryMb: 8193 })).toThrow(/between 512 and 8192/)
    expect(() => f.api['pcs.update']({ botId: bot.id, memoryMb: 1024.5 })).toThrow(/between 512 and 8192/)
    expect(() => f.api['pcs.update']({ botId: bot.id, idleStopMinutes: -1 })).toThrow(/between 0 and 1440/)
    expect(() => f.api['pcs.update']({ botId: bot.id, idleStopMinutes: 1441 })).toThrow(/between 0 and 1440/)
    expect(() => f.api['pcs.update']({ botId: 'missing', memoryMb: 1024 })).toThrow('PC not found for bot: missing')

    const updated = await f.api['pcs.update']({ botId: bot.id, memoryMb: 4096, idleStopMinutes: 60 })
    expect(updated).toMatchObject({ memoryMb: 4096, idleStopMinutes: 60 })
    expect(f.pc.calls).toContain(`options:${bot.id}:${JSON.stringify({ memoryMb: 4096, idleStopMinutes: 60 })}`)
  })

  it('10. pcs.mode.get/set persist through the settings repo, validate the value, and best-effort propagate', async () => {
    const f = makeFixture(true)
    expect(await f.api['pcs.mode.get']({})).toBe('own')

    expect(() => f.api['pcs.mode.set']({ mode: 'nope' })).toThrow("PC mode must be 'own' or 'shared'.")

    const mode = await f.api['pcs.mode.set']({ mode: 'shared' })
    expect(mode).toBe('shared')
    expect(await f.api['pcs.mode.get']({})).toBe('shared')
    expect(f.pc.calls).toContain('mode:shared')
  })

  it('10b. pcs.takeOver requires the run service and an existing PC row, and otherwise forwards straight through', async () => {
    const fNoServices = makeFixture(false)
    const orphan = await fNoServices.api['bots.create']({ name: 'Digest bot' })
    expect(() => fNoServices.api['pcs.takeOver']({ botId: orphan.id, on: true })).toThrow(
      "Bot runs aren't set up on this computer yet."
    )

    const f = makeFixture(true)
    expect(() => f.api['pcs.takeOver']({ botId: 'missing', on: true })).toThrow('PC not found for bot: missing')

    const bot = await f.api['bots.create']({ name: 'Digest bot' })
    expect(f.api['pcs.takeOver']({ botId: bot.id, on: true })).toBeNull()
    expect(f.run.calls).toContain(`takeOver:${bot.id}:true`)

    expect(f.api['pcs.takeOver']({ botId: bot.id, on: false })).toBeNull()
    expect(f.run.calls).toContain(`takeOver:${bot.id}:false`)
  })

  it('11. engine.status/setup answer with "not set up" when absent, and setup forwards progress as engine.progress events', async () => {
    const fNoServices = makeFixture(false)
    await expect(fNoServices.api['engine.status']({})).rejects.toThrow("Bot PCs aren't set up on this computer yet.")
    await expect(fNoServices.api['engine.setup']({})).rejects.toThrow("Bot PCs aren't set up on this computer yet.")

    const f = makeFixture(true)
    const status = await f.api['engine.status']({})
    expect(status.ready).toBe(false)

    const result = await f.api['engine.setup']({})
    expect(result.steps.wsl.state).toBe('ok')
    const progressEvents = f.events.filter((e) => e.type === 'engine.progress')
    expect(progressEvents).toHaveLength(2)
    expect(progressEvents[0].status.steps.wsl.state).toBe('working')
    expect(progressEvents[1].status.steps.wsl.state).toBe('ok')
  })

  it('12. schedules.create/update validate cron and task and work without a schedule service (nextRunAt stays null)', async () => {
    const f = makeFixture(false)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    await expect(f.api['schedules.create']({ botId: bot.id, cron: '  ', task: 'Summarize' })).rejects.toThrow(
      'The schedule needs a cron expression.'
    )
    await expect(f.api['schedules.create']({ botId: bot.id, cron: '0 8 * * *', task: '  ' })).rejects.toThrow(
      'Tell the bot what to do on this schedule.'
    )
    await expect(f.api['schedules.create']({ botId: 'missing', cron: '0 8 * * *', task: 'Summarize' })).rejects.toThrow(
      'Bot not found: missing'
    )

    const schedule = await f.api['schedules.create']({ botId: bot.id, cron: '0 8 * * *', task: 'Summarize' })
    expect(schedule.nextRunAt).toBeNull()
    expect(f.events.some((e) => e.type === 'schedule.updated' && e.schedule.id === schedule.id)).toBe(true)

    await expect(f.api['schedules.update']({ id: schedule.id, cron: '  ' })).rejects.toThrow('The schedule needs a cron expression.')
    const updated = await f.api['schedules.update']({ id: schedule.id, enabled: false })
    expect(updated).toMatchObject({ enabled: false, nextRunAt: null })

    await f.api['schedules.delete']({ id: schedule.id })
    expect(f.repos.schedules.get(schedule.id)).toBeUndefined()
    expect(f.events.some((e) => e.type === 'schedule.deleted' && e.scheduleId === schedule.id)).toBe(true)
    await expect(f.api['schedules.delete']({ id: schedule.id })).rejects.toThrow(`Schedule not found: ${schedule.id}`)
  })

  it('13. schedules.create/update compute nextRunAt through a schedule service, and delete unsyncs first', async () => {
    const f = makeFixture(true)
    const bot = await f.api['bots.create']({ name: 'Digest bot' })

    const schedule = await f.api['schedules.create']({ botId: bot.id, cron: '0 8 * * *', task: 'Summarize' })
    expect(schedule.nextRunAt).toBe(111111)
    expect(f.schedule.calls).toContain(`sync:${schedule.id}`)

    await expect(f.api['schedules.update']({ id: schedule.id, cron: 'not a cron' })).rejects.toThrow(
      "That isn't a valid cron expression."
    )

    await f.api['schedules.delete']({ id: schedule.id })
    expect(f.schedule.calls).toContain(`unsync:${schedule.id}`)
  })

  it('14. schedules.list filters by bot', async () => {
    const f = makeFixture(false)
    const bot1 = await f.api['bots.create']({ name: 'Bot 1' })
    const bot2 = await f.api['bots.create']({ name: 'Bot 2' })
    await f.api['schedules.create']({ botId: bot1.id, cron: '0 8 * * *', task: 'A' })
    await f.api['schedules.create']({ botId: bot2.id, cron: '0 9 * * *', task: 'B' })

    expect((await f.api['schedules.list']({ botId: bot1.id })).length).toBe(1)
    expect((await f.api['schedules.list']({})).length).toBe(2)
  })

  it('15. handoffs.list filters by receiving bot, and handoffs.item requires a real id — plain repo reads, no service needed', async () => {
    const f = makeFixture(false)
    const bot1 = await f.api['bots.create']({ name: 'Bot 1' })
    const bot2 = await f.api['bots.create']({ name: 'Bot 2' })
    f.repos.handoffs.upsertFromRecord({ id: 'h1', fromBotId: bot2.id, toBotId: bot1.id, task: 'A', files: [], createdAt: 1 })
    f.repos.handoffs.upsertFromRecord({ id: 'h2', fromBotId: bot1.id, toBotId: bot2.id, task: 'B', files: ['shared/note.md'], createdAt: 2 })

    const forBot1 = (await f.api['handoffs.list']({ botId: bot1.id })) as Array<{ id: string }>
    expect(forBot1.map((h) => h.id)).toEqual(['h1'])

    const all = (await f.api['handoffs.list']({})) as Array<{ id: string }>
    expect(all.some((h) => h.id === 'h1')).toBe(true)
    expect(all.some((h) => h.id === 'h2')).toBe(true)

    const item = await f.api['handoffs.item']({ id: 'h2' })
    expect(item).toMatchObject({ id: 'h2', toBotId: bot2.id, task: 'B', files: ['shared/note.md'], state: 'pending' })
    expect(() => f.api['handoffs.item']({ id: 'missing' })).toThrow('Handoff not found: missing')
  })
})
