import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner, RunOptions } from '../../src/core/bots/command-runner'
import type { RunService } from '../../src/core/bots/services'
import { DEFAULT_CATCH_UP_THRESHOLD_MS, planSchedule } from '../../src/core/scheduler/catch-up'
import { computeNextRun, nextRunAt, parseCron } from '../../src/core/scheduler/cron'
import { Scheduler } from '../../src/core/scheduler/scheduler'
import { buildTaskXml, taskNameFor, WakeTimerManager } from '../../src/core/scheduler/wake-timers'
import { EventBus } from '../../src/core/events'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import type { Bot, BotRun, CoreEvent, Schedule, TimelineItem } from '../../src/shared/protocol'

// ---- fakes ----

/** Canned, call-order responses for `schtasks`, so tests can assert both the exact argv and how the code reacts to a failure — never real Task Scheduler. */
class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ file: string; args: string[] }> = []
  private readonly queued: Array<Partial<CommandResult>> = []

  queueResponse(result: Partial<CommandResult>): void {
    this.queued.push(result)
  }

  async run(file: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ file, args })
    const next = this.queued.length > 0 ? this.queued.shift()! : {}
    return { code: 0, stdout: '', stderr: '', ...next }
  }
}

class FakeRunService implements RunService {
  readonly starts: Array<{ run: BotRun; bot: Bot }> = []
  async start(run: BotRun, bot: Bot): Promise<void> {
    this.starts.push({ run, bot })
  }
  async stop(): Promise<void> {}
  async respond(): Promise<void> {}
  async items(): Promise<TimelineItem[]> {
    return []
  }
  setTakenOver(): void {}
}

// ---- shared helpers ----

function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function readWakeTaskXml(dataDir: string, scheduleId: string): string {
  const path = join(dataDir, 'scheduler', 'wake-tasks', `${scheduleId}.xml`)
  const buf = readFileSync(path)
  expect(buf[0]).toBe(0xff) // UTF-16LE BOM, matching the <?xml ... encoding="UTF-16"?> declaration.
  expect(buf[1]).toBe(0xfe)
  return buf.subarray(2).toString('utf16le')
}

// ==== cron.ts ====

describe('parseCron / nextRunAt', () => {
  it('1. parses a plain daily schedule and finds the next occurrence', () => {
    expect(computeNextRun('0 8 * * *', new Date(2027, 5, 10, 7, 59))).toEqual(new Date(2027, 5, 10, 8, 0))
    expect(computeNextRun('0 8 * * *', new Date(2027, 5, 10, 8, 0))).toEqual(new Date(2027, 5, 11, 8, 0))
    expect(computeNextRun('0 8 * * *', new Date(2027, 5, 10, 8, 1))).toEqual(new Date(2027, 5, 11, 8, 0))
  })

  it('2. supports ranges, steps and comma lists together', () => {
    expect(computeNextRun('*/15 * * * *', new Date(2027, 0, 1, 10, 2))).toEqual(new Date(2027, 0, 1, 10, 15))
    expect(computeNextRun('0 1,2,5-7 * * *', new Date(2027, 0, 1, 3, 0))).toEqual(new Date(2027, 0, 1, 5, 0))
    expect(computeNextRun('0-10/5 9 * * *', new Date(2027, 0, 1, 9, 2))).toEqual(new Date(2027, 0, 1, 9, 5))
  })

  it('3. throws a plain error on a malformed expression instead of guessing', () => {
    expect(() => parseCron('a b c')).toThrow('needs exactly 5 fields')
    expect(() => parseCron('* * * *')).toThrow('needs exactly 5 fields')
    expect(() => parseCron('60 0 * * *')).toThrow('minute value out of range (0-59)')
    expect(() => parseCron('0 0 32 * *')).toThrow('day-of-month value out of range')
    expect(() => parseCron('0 0 * 13 *')).toThrow('month value out of range')
    expect(() => parseCron('0 0 * * 8')).toThrow('day-of-week value out of range')
    expect(() => parseCron('0 0 * * */0')).toThrow('Invalid step')
  })

  it('4. day-of-month and day-of-week combine with OR, each able to win depending on which comes sooner', () => {
    // April 2027: the 1st is a Thursday, so the 3rd is a Saturday and the 5th is the next Monday.
    expect(new Date(2027, 3, 3).getDay()).toBe(6) // Saturday
    expect(new Date(2027, 3, 5).getDay()).toBe(1) // Monday

    // "9am on the 15th, or any Monday" — the next Monday (the 5th) is sooner than the 15th.
    expect(computeNextRun('0 9 15 * 1', new Date(2027, 3, 2, 0, 0))).toEqual(new Date(2027, 3, 5, 9, 0))
    // "9am on the 3rd, or any Monday" — the 3rd (a Saturday) is sooner than the next Monday.
    expect(computeNextRun('0 9 3 * 1', new Date(2027, 3, 2, 0, 0))).toEqual(new Date(2027, 3, 3, 9, 0))
    // With only one of the two fields restricted, it's a plain AND against "*" — no OR kicks in.
    expect(computeNextRun('0 9 * * 1', new Date(2027, 3, 2, 0, 0))).toEqual(new Date(2027, 3, 5, 9, 0))
  })

  describe('DST handling (America/New_York, 2027)', () => {
    let originalTz: string | undefined

    beforeAll(() => {
      originalTz = process.env.TZ
      process.env.TZ = 'America/New_York'
    })

    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    })

    it('5. spring-forward (Mar 14, clocks jump 2:00am -> 3:00am) shortens one daily gap to 23 hours, and skips a firing time that falls in the gap', () => {
      const day1 = computeNextRun('0 8 * * *', new Date(2027, 2, 12, 23, 59))!
      const day2 = computeNextRun('0 8 * * *', day1)!
      expect(day1).toEqual(new Date(2027, 2, 13, 8, 0))
      expect(day2).toEqual(new Date(2027, 2, 14, 8, 0))
      expect(day2.getTime() - day1.getTime()).toBe(23 * 3600 * 1000)

      // 2:30am doesn't exist on March 14th (2:00-3:00am is skipped that night) — that day's run is skipped entirely.
      const skipped = computeNextRun('30 2 * * *', new Date(2027, 2, 13, 12, 0))
      expect(skipped).toEqual(new Date(2027, 2, 15, 2, 30))
    })

    it('6. fall-back (Nov 7, clocks repeat 1:00am-2:00am) lengthens one daily gap to 25 hours', () => {
      const day1 = computeNextRun('0 8 * * *', new Date(2027, 10, 5, 23, 59))!
      const day2 = computeNextRun('0 8 * * *', day1)!
      expect(day1).toEqual(new Date(2027, 10, 6, 8, 0))
      expect(day2).toEqual(new Date(2027, 10, 7, 8, 0))
      expect(day2.getTime() - day1.getTime()).toBe(25 * 3600 * 1000)
    })
  })
})

// ==== catch-up.ts ====

describe('planSchedule', () => {
  const base: Schedule = {
    id: 's1',
    botId: 'b1',
    cron: '0 8 * * *',
    task: 'Summarize',
    enabled: true,
    missed: 'run-late',
    lastRunAt: null,
    nextRunAt: 100_000
  }

  it('7. distinguishes "not due", "on time", "missed + run-late", "missed + skip", disabled and unscheduled', () => {
    expect(planSchedule({ ...base, nextRunAt: 200_000 }, 100_000)).toEqual({ action: 'none', isCatchUp: false })
    expect(planSchedule(base, base.nextRunAt! + 1_000)).toEqual({ action: 'run', isCatchUp: false })
    expect(planSchedule(base, base.nextRunAt! + DEFAULT_CATCH_UP_THRESHOLD_MS + 1)).toEqual({ action: 'run', isCatchUp: true })
    expect(planSchedule({ ...base, missed: 'skip' }, base.nextRunAt! + DEFAULT_CATCH_UP_THRESHOLD_MS + 1)).toEqual({
      action: 'skip',
      isCatchUp: true
    })
    expect(planSchedule({ ...base, enabled: false }, base.nextRunAt! + DEFAULT_CATCH_UP_THRESHOLD_MS + 1)).toEqual({
      action: 'none',
      isCatchUp: false
    })
    expect(planSchedule({ ...base, nextRunAt: null }, 999_999)).toEqual({ action: 'none', isCatchUp: false })
    // Exactly at the threshold still counts as on-time — only strictly past it is a catch-up.
    expect(planSchedule(base, base.nextRunAt! + DEFAULT_CATCH_UP_THRESHOLD_MS)).toEqual({ action: 'run', isCatchUp: false })
  })
})

// ==== wake-timers.ts ====

describe('wake timers', () => {
  it('8. taskNameFor groups every schedule under one Task Scheduler folder, and buildTaskXml sets WakeToRun without leaking the schedule\'s own task text', () => {
    expect(taskNameFor('abc-123')).toBe('\\Deskmates\\Schedule-abc-123')

    const xml = buildTaskXml({ scheduleId: 'sched & 1', botId: 'bot<1>', runAt: new Date(2027, 3, 5, 7, 58, 0) })
    expect(xml).toContain('<WakeToRun>true</WakeToRun>')
    expect(xml).toContain('<StartBoundary>2027-04-05T07:58:00</StartBoundary>')
    expect(xml).toContain('<Command>%windir%\\System32\\cmd.exe</Command>')
    // Ids are escaped for XML...
    expect(xml).toContain('schedule sched &amp; 1, bot bot&lt;1&gt;')
    // ...and nothing about what the schedule actually does (arbitrary user text) is ever written to this system-visible file.
    expect(xml).not.toContain('Summarize')
  })

  describe('WakeTimerManager', () => {
    let dataDir: string
    let runner: FakeCommandRunner
    let manager: WakeTimerManager

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'deskmates-wake-timers-'))
      runner = new FakeCommandRunner()
      manager = new WakeTimerManager({ runner, dataDir, leadMinutes: 2 })
    })

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('9. upsert calls schtasks /Create with the exact argv and writes the lead-adjusted XML as UTF-16LE with a BOM', async () => {
      const nextRunAtMs = new Date(2027, 3, 5, 8, 0, 0).getTime()
      await manager.upsert('sched-1', 'bot-1', nextRunAtMs)

      const xmlPath = join(dataDir, 'scheduler', 'wake-tasks', 'sched-1.xml')
      expect(runner.calls).toEqual([{ file: 'schtasks', args: ['/Create', '/TN', '\\Deskmates\\Schedule-sched-1', '/XML', xmlPath, '/F'] }])

      const xml = readWakeTaskXml(dataDir, 'sched-1')
      expect(xml).toContain(`<StartBoundary>${localIso(new Date(2027, 3, 5, 7, 58, 0))}</StartBoundary>`)
    })

    it('10. remove calls schtasks /Delete with the exact argv, tolerates "not found", and surfaces a genuine failure', async () => {
      await manager.remove('sched-1')
      expect(runner.calls).toEqual([{ file: 'schtasks', args: ['/Delete', '/TN', '\\Deskmates\\Schedule-sched-1', '/F'] }])

      // Deleting an already-gone task (schtasks' real "not found" wording) is not an error.
      runner.queueResponse({ code: 1, stderr: 'ERROR: The system cannot find the file specified.\r\n' })
      await expect(manager.remove('sched-1')).resolves.toBeUndefined()

      // A genuine failure (e.g. Task Scheduler service disabled, permissions) is surfaced.
      runner.queueResponse({ code: 5, stderr: 'ERROR: Access is denied.\r\n' })
      await expect(manager.remove('sched-1')).rejects.toThrow('Access is denied')
    })
  })
})

// ==== Scheduler ====

describe('Scheduler', () => {
  let db: DatabaseSync
  let repos: Repos
  let bus: EventBus
  let events: CoreEvent[]
  let dataDir: string
  let runner: FakeCommandRunner
  let runService: FakeRunService

  beforeEach(() => {
    db = openDatabase(':memory:')
    repos = createRepos(db)
    bus = new EventBus()
    events = []
    bus.on((event) => events.push(event))
    dataDir = mkdtempSync(join(tmpdir(), 'deskmates-scheduler-'))
    runner = new FakeCommandRunner()
    runService = new FakeRunService()
  })

  afterEach(() => {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function makeScheduler(overrides: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}): Scheduler {
    return new Scheduler({ repos, bus, runner, dataDir, run: runService, now: () => Date.now(), ...overrides })
  }

  function makeBot(name = 'Digest Bot'): Bot {
    return repos.bots.create(name)
  }

  function makeSchedule(
    botId: string,
    opts: {
      cron?: string
      task?: string
      missed?: 'run-late' | 'skip'
      enabled?: boolean
      nextRunAt?: number | null
      lastRunAt?: number | null
    } = {}
  ): Schedule {
    const created = repos.schedules.create(botId, opts.cron ?? '0 8 * * *', opts.task ?? 'Summarize the site', opts.missed ?? 'run-late')
    return repos.schedules.update(created.id, {
      enabled: opts.enabled ?? true,
      nextRunAt: opts.nextRunAt ?? null,
      lastRunAt: opts.lastRunAt ?? null
    })
  }

  it('11. sync() computes nextRunAt and registers a wake timer end to end, lead time and all', async () => {
    const bot = makeBot()
    const schedule = repos.schedules.create(bot.id, '0 8 * * *', 'Summarize')
    const fixedNow = new Date(2027, 5, 10, 7, 0, 0).getTime()
    const scheduler = makeScheduler({ now: () => fixedNow, wakeLeadMinutes: 2 })

    const result = await scheduler.sync(schedule)

    expect(result.nextRunAt).toBe(new Date(2027, 5, 10, 8, 0, 0).getTime())
    const xml = readWakeTaskXml(dataDir, schedule.id)
    expect(xml).toContain(`<StartBoundary>${localIso(new Date(2027, 5, 10, 7, 58, 0))}</StartBoundary>`)
    expect(runner.calls).toEqual([
      { file: 'schtasks', args: ['/Create', '/TN', taskNameFor(schedule.id), '/XML', join(dataDir, 'scheduler', 'wake-tasks', `${schedule.id}.xml`), '/F'] }
    ])
  })

  it('12. sync() throws on an invalid cron and never calls schtasks', async () => {
    const bot = makeBot()
    const schedule = repos.schedules.create(bot.id, 'not a cron', 'Summarize')
    const scheduler = makeScheduler()

    await expect(scheduler.sync(schedule)).rejects.toThrow('needs exactly 5 fields')
    expect(runner.calls).toEqual([])
  })

  it('13. sync() on a disabled schedule returns a null nextRunAt and removes its wake timer instead of creating one', async () => {
    const bot = makeBot()
    const schedule = { ...repos.schedules.create(bot.id, '0 8 * * *', 'Summarize'), enabled: false }
    const scheduler = makeScheduler()

    const result = await scheduler.sync(schedule)

    expect(result.nextRunAt).toBeNull()
    expect(runner.calls).toEqual([{ file: 'schtasks', args: ['/Delete', '/TN', taskNameFor(schedule.id), '/F'] }])
  })

  it('14. sync() swallows a wake-timer registration failure and still returns the computed nextRunAt', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bot = makeBot()
    const schedule = repos.schedules.create(bot.id, '0 8 * * *', 'Summarize')
    const fixedNow = new Date(2027, 5, 10, 7, 0, 0).getTime()
    const scheduler = makeScheduler({ now: () => fixedNow })
    runner.queueResponse({ code: 5, stderr: 'ERROR: Access is denied.\r\n' })

    const result = await scheduler.sync(schedule)

    expect(result.nextRunAt).toBe(new Date(2027, 5, 10, 8, 0, 0).getTime())
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('15. unsync() removes the wake timer and is safe to call again once it is already gone', async () => {
    const scheduler = makeScheduler()
    await scheduler.unsync('sched-x')
    await scheduler.unsync('sched-x')
    expect(runner.calls).toEqual([
      { file: 'schtasks', args: ['/Delete', '/TN', taskNameFor('sched-x'), '/F'] },
      { file: 'schtasks', args: ['/Delete', '/TN', taskNameFor('sched-x'), '/F'] }
    ])
  })

  it('16. unsync() propagates a genuine schtasks failure instead of silently leaving the task behind', async () => {
    const scheduler = makeScheduler()
    runner.queueResponse({ code: 5, stderr: 'ERROR: Access is denied.\r\n' })
    await expect(scheduler.unsync('sched-x')).rejects.toThrow('Access is denied')
  })

  it('17. tick() starts an on-time due run through the RunService and advances the schedule to its next occurrence', async () => {
    const bot = makeBot()
    const eightAm10 = new Date(2027, 5, 10, 8, 0, 0).getTime()
    const schedule = makeSchedule(bot.id, { nextRunAt: eightAm10 })
    const now = eightAm10 + 30_000 // 30s late — within the catch-up threshold, an ordinary tick.
    const scheduler = makeScheduler()

    await scheduler.tick(now)

    expect(runService.starts).toHaveLength(1)
    expect(runService.starts[0]!.bot.id).toBe(bot.id)
    expect(runService.starts[0]!.run).toMatchObject({ botId: bot.id, scheduleId: schedule.id, task: 'Summarize the site' })
    expect(repos.runs.list(bot.id)).toHaveLength(1)

    const updated = repos.schedules.require(schedule.id)
    expect(updated.lastRunAt).toBe(now)
    expect(updated.nextRunAt).toBe(new Date(2027, 5, 11, 8, 0, 0).getTime())
    expect(events.some((e) => e.type === 'run.updated')).toBe(true)
    expect(events.some((e) => e.type === 'schedule.updated' && e.schedule.id === schedule.id)).toBe(true)
    expect(runner.calls.some((c) => c.args.includes('/Create'))).toBe(true)
  })

  it('18. tick() runs a catch-up when missed is run-late, even hours late', async () => {
    const bot = makeBot()
    const eightAm10 = new Date(2027, 5, 10, 8, 0, 0).getTime()
    const schedule = makeSchedule(bot.id, { nextRunAt: eightAm10, missed: 'run-late' })
    const now = eightAm10 + 3 * 3600 * 1000 // 3 hours late — the PC was asleep.
    const scheduler = makeScheduler()

    await scheduler.tick(now)

    expect(runService.starts).toHaveLength(1)
    const updated = repos.schedules.require(schedule.id)
    expect(updated.lastRunAt).toBe(now)
    expect(updated.nextRunAt).toBe(new Date(2027, 5, 11, 8, 0, 0).getTime())
  })

  it('19. tick() skips a catch-up when missed is skip, advancing the schedule without starting a run or touching lastRunAt', async () => {
    const bot = makeBot()
    const eightAm10 = new Date(2027, 5, 10, 8, 0, 0).getTime()
    const schedule = makeSchedule(bot.id, { nextRunAt: eightAm10, missed: 'skip', lastRunAt: null })
    const now = eightAm10 + 3 * 3600 * 1000
    const scheduler = makeScheduler()

    await scheduler.tick(now)

    expect(runService.starts).toHaveLength(0)
    expect(repos.runs.list(bot.id)).toHaveLength(0)
    const updated = repos.schedules.require(schedule.id)
    expect(updated.lastRunAt).toBeNull()
    expect(updated.nextRunAt).toBe(new Date(2027, 5, 11, 8, 0, 0).getTime())
    expect(events.some((e) => e.type === 'schedule.updated' && e.schedule.id === schedule.id)).toBe(true)
  })

  it('20. tick() leaves disabled and not-yet-due schedules untouched', async () => {
    const bot = makeBot()
    const eightAm10 = new Date(2027, 5, 10, 8, 0, 0).getTime()
    const disabled = makeSchedule(bot.id, { nextRunAt: eightAm10, enabled: false })
    const future = makeSchedule(bot.id, { nextRunAt: eightAm10 + 10 * 24 * 3600 * 1000 })
    const scheduler = makeScheduler()

    await scheduler.tick(eightAm10 + 1_000)

    expect(runService.starts).toHaveLength(0)
    expect(repos.schedules.require(disabled.id)).toEqual(disabled)
    expect(repos.schedules.require(future.id)).toEqual(future)
    expect(runner.calls).toHaveLength(0)
  })

  it('21. start() ticks immediately, then on the configured interval, and stop() ends it cleanly', async () => {
    vi.useFakeTimers()
    try {
      const scheduler = makeScheduler({ tickIntervalMs: 1000 })
      const tickSpy = vi.spyOn(scheduler, 'tick').mockResolvedValue(undefined)

      scheduler.start()
      expect(tickSpy).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(tickSpy).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(tickSpy).toHaveBeenCalledTimes(3)

      scheduler.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(tickSpy).toHaveBeenCalledTimes(3)

      // Calling start() again after stop() resumes normally, and start() is a no-op while already running.
      scheduler.start()
      scheduler.start()
      expect(tickSpy).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
