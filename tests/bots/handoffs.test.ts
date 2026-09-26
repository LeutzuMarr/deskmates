import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HandoffService } from '../../src/core/bots/handoffs'
import type { RunService } from '../../src/core/bots/services'
import type { HandoffRecord } from '../../src/core/bots/tools/handoff'
import { EventBus } from '../../src/core/events'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import type { Bot, BotRun, CoreEvent, TimelineItem } from '../../src/shared/protocol'

/** A RunService that records every start; the test drives run-end events itself over the event bus. */
class FakeRunService implements RunService {
  readonly starts: Array<{ run: BotRun; bot: Bot }> = []
  timeline: TimelineItem[] = []
  async start(run: BotRun, bot: Bot): Promise<void> {
    this.starts.push({ run, bot })
  }
  async stop(): Promise<void> {}
  async respond(): Promise<void> {}
  async items(): Promise<TimelineItem[]> {
    return this.timeline
  }
  setTakenOver(): void {}
}

describe('HandoffService', () => {
  let db: DatabaseSync
  let repos: Repos
  let bus: EventBus
  let events: CoreEvent[]
  let dataDir: string
  let runService: FakeRunService

  beforeEach(() => {
    db = openDatabase(':memory:')
    repos = createRepos(db)
    bus = new EventBus()
    events = []
    bus.on((event) => events.push(event))
    dataDir = mkdtempSync(join(tmpdir(), 'deskmates-handoffs-'))
    mkdirSync(join(dataDir, 'shared', 'handoffs'), { recursive: true })
    runService = new FakeRunService()
  })

  afterEach(() => {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function makeService(overrides: Partial<ConstructorParameters<typeof HandoffService>[0]> = {}): HandoffService {
    return new HandoffService({ repos, bus, dataDir, run: runService, ...overrides })
  }

  function makeBot(name = 'Handler'): Bot {
    return repos.bots.create(name)
  }

  /** Writes a handoff file into the inbox the same way the handoff tool would. */
  function dropHandoff(record: Partial<HandoffRecord> & Pick<HandoffRecord, 'id' | 'toBotId' | 'task'>): void {
    const full: HandoffRecord = { fromBotId: 'sender', files: [], createdAt: 1000, ...record }
    writeFileSync(join(dataDir, 'shared', 'handoffs', `${full.id}.json`), JSON.stringify(full), 'utf8')
  }

  const handoffEvents = (): Array<Extract<CoreEvent, { type: 'handoff.updated' }>> =>
    events.filter((e): e is Extract<CoreEvent, { type: 'handoff.updated' }> => e.type === 'handoff.updated')

  it('1. scan imports a handoff file for a busy bot into a pending row, keeps the file, and emits the last import as handoff.updated', async () => {
    const bot = makeBot()
    // A busy bot takes pickUp out of the picture, so after one tick the row is still "pending":
    // a straight look at the scan phase on its own.
    const busy = repos.runs.create(bot.id, 'Busy', join(dataDir, 'runs', 'busy'), null, 'busy')
    repos.runs.update(busy.id, { state: 'running' })
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize the report', files: ['shared/report.md'] })
    const service = makeService()

    await service.tick()

    expect(repos.handoffs.require('h1')).toMatchObject({
      fromBotId: 'sender',
      toBotId: bot.id,
      task: 'Summarize the report',
      files: ['shared/report.md'],
      state: 'pending',
      runId: null,
      result: null
    })
    expect(handoffEvents()).toHaveLength(1)
    expect(handoffEvents()[0]!.handoff.state).toBe('pending')
    // The file is what the sender watches — the scan must never delete it.
    expect(existsSync(join(dataDir, 'shared', 'handoffs', 'h1.json'))).toBe(true)
  })

  it('2. scanning the same file again is a no-op: no duplicate row and no repeat import', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    const service = makeService()

    await service.tick()
    const afterFirstTick = handoffEvents().length
    expect(afterFirstTick).toBe(2) // one import, one pickup mark

    await service.tick()

    expect(repos.handoffs.list()).toHaveLength(1)
    expect(handoffEvents()).toHaveLength(afterFirstTick)
  })

  it('3. scan skips corrupt files and files addressed to a bot that no longer exists', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'good', toBotId: bot.id, task: 'X' })
    writeFileSync(join(dataDir, 'shared', 'handoffs', 'broken.json'), 'not json', 'utf8')
    dropHandoff({ id: 'orphan', toBotId: 'deleted-bot', task: 'X' })
    const service = makeService()

    await service.tick()

    expect(repos.handoffs.list().map((h) => h.id)).toEqual(['good'])
    expect(handoffEvents().every((e) => e.handoff.id === 'good')).toBe(true)
  })

  it('4. pickUp starts a run for a pending handoff, marks it running with the run id, and fires the run service', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    const service = makeService()

    await service.tick()

    const handoff = repos.handoffs.require('h1')
    expect(handoff.state).toBe('running')
    expect(handoff.runId).toBeTruthy()
    const run = repos.runs.require(handoff.runId!)
    expect(run).toMatchObject({ botId: bot.id, task: 'Summarize' })
    expect(run.folder).toContain(run.id)
    expect(runService.starts).toHaveLength(1)
    expect(runService.starts[0]!.run.id).toBe(run.id)
    expect(runService.starts[0]!.bot.id).toBe(bot.id)
    expect(events.some((e) => e.type === 'run.updated' && e.run.id === run.id)).toBe(true)
    expect(handoffEvents().some((e) => e.handoff.state === 'running')).toBe(true)
  })

  it('5. handoffs to different bots are both picked up in the same tick', async () => {
    const a = makeBot('A')
    const b = makeBot('B')
    dropHandoff({ id: 'h1', toBotId: a.id, task: 'For A' })
    dropHandoff({ id: 'h2', toBotId: b.id, task: 'For B' })
    const service = makeService()

    await service.tick()

    expect(runService.starts).toHaveLength(2)
    expect(repos.handoffs.require('h1').state).toBe('running')
    expect(repos.handoffs.require('h2').state).toBe('running')
  })

  it('6. handoffs for the same bot queue up: a busy bot is skipped, and only one run starts per tick once it frees up', async () => {
    const bot = makeBot()
    const busy = repos.runs.create(bot.id, 'Busy', join(dataDir, 'runs', 'busy'), null, 'busy')
    repos.runs.update(busy.id, { state: 'running' })
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'First' })
    dropHandoff({ id: 'h2', toBotId: bot.id, task: 'Second' })
    const service = makeService()

    await service.tick()
    expect(runService.starts).toHaveLength(0)
    expect(repos.handoffs.require('h1').state).toBe('pending')
    expect(repos.handoffs.require('h2').state).toBe('pending')

    // The bot's manual run finishes: the next tick picks one handoff, the other still waits.
    repos.runs.update(busy.id, { state: 'done', finishedAt: 2000 })
    await service.tick()

    expect(runService.starts).toHaveLength(1)
    const states = repos.handoffs.list().map((h) => ({ id: h.id, state: h.state }))
    expect(states.filter((s) => s.state === 'running')).toHaveLength(1)
    expect(states.filter((s) => s.state === 'pending')).toHaveLength(1)
  })

  it('7. when the picked-up run finishes, the handoff becomes done with the run\'s final reply', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    const service = makeService()
    await service.tick()

    const runId = repos.handoffs.require('h1').runId!
    runService.timeline = [
      { kind: 'user', id: 'u', at: 1, text: 'Summarize' },
      { kind: 'assistant', id: 'a1', at: 2, text: 'First draft…' },
      { kind: 'assistant', id: 'a2', at: 3, text: 'Final summary.' }
    ]
    bus.emit({ type: 'run.updated', run: repos.runs.update(runId, { state: 'done', finishedAt: 4 }) })

    await vi.waitFor(() => expect(repos.handoffs.require('h1').state).toBe('done'))
    // The result is the last thing the bot actually said, not the first draft.
    expect(repos.handoffs.require('h1').result).toBe('Final summary.')
    expect(handoffEvents().some((e) => e.handoff.state === 'done')).toBe(true)
  })

  it('8. a picked-up run that errors marks the handoff error with the run\'s message', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    const service = makeService()
    await service.tick()

    const runId = repos.handoffs.require('h1').runId!
    bus.emit({
      type: 'run.updated',
      run: repos.runs.update(runId, { state: 'error', error: "The bot's PC didn't start.", finishedAt: 4 })
    })

    await vi.waitFor(() => expect(repos.handoffs.require('h1').state).toBe('error'))
    expect(repos.handoffs.require('h1').result).toBe("The bot's PC didn't start.")
  })

  it('9. run-end events for ordinary (non-handoff) runs and for non-terminal states are ignored', async () => {
    const bot = makeBot()
    const manual = repos.runs.create(bot.id, 'Manual', join(dataDir, 'runs', 'm'), null, 'm')
    const service = makeService()

    // Not a terminal state — no run handling regardless of whether it's a handoff run.
    bus.emit({ type: 'run.updated', run: repos.runs.update(manual.id, { state: 'running' }) })
    // Terminal, but this run was never a handoff pickup.
    bus.emit({ type: 'run.updated', run: repos.runs.update(manual.id, { state: 'done', finishedAt: 9 }) })
    await vi.waitFor(() => expect(repos.handoffs.list()).toHaveLength(0))
    expect(handoffEvents()).toHaveLength(0)
  })

  it("10. a handoff left running across a restart (its run reconciled to error) is finished, not re-run, on the next tick", async () => {
    const bot = makeBot()
    // What a previous session left behind: a picked-up handoff, a run row the next boot marked error.
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    repos.runs.create(bot.id, 'Summarize', join(dataDir, 'runs', 'old'), null, 'old')
    repos.runs.update('old', { state: 'error', error: 'Stopped because Deskmates was closed.', finishedAt: 5 })
    repos.handoffs.upsertFromRecord({ id: 'h1', fromBotId: 'sender', toBotId: bot.id, task: 'Summarize', files: [], createdAt: 1 })
    repos.handoffs.markRunning('h1', 'old')
    const service = makeService()

    await service.tick()

    const handoff = repos.handoffs.require('h1')
    expect(handoff.state).toBe('error')
    expect(handoff.result).toBe('Stopped because Deskmates was closed.')
    // Once finished it is no longer pending, so nothing starts a fresh run for it.
    expect(runService.starts).toHaveLength(0)
  })

  it('11. without a run service wired up, pickUp still records the run and marks it running but starts nothing', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    const service = makeService({ run: undefined })

    await service.tick()

    const handoff = repos.handoffs.require('h1')
    expect(handoff.state).toBe('running')
    expect(handoff.runId).toBeTruthy()
    expect(repos.runs.require(handoff.runId!).state).toBe('queued')
  })

  it('12. start() ticks immediately then on the interval, stop() ends it, and start() after stop() resumes', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService({ scanIntervalMs: 1000 })
      const tickSpy = vi.spyOn(service, 'tick').mockResolvedValue(undefined)

      service.start()
      expect(tickSpy).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(tickSpy).toHaveBeenCalledTimes(2)

      service.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(tickSpy).toHaveBeenCalledTimes(2)

      // Restarting resumes the loop (and, below, the run-end subscription).
      service.start()
      expect(tickSpy).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('13. stop() unsubscribes from run-end events, so a later run finish no longer touches the handoff', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    const service = makeService()
    await service.tick()

    const runId = repos.handoffs.require('h1').runId!
    service.stop()
    bus.emit({ type: 'run.updated', run: repos.runs.update(runId, { state: 'done', finishedAt: 4 }) })

    await vi.waitFor(() => expect(repos.handoffs.require('h1').state).toBe('running'))
    // A stopped service keeps its state subscription off: the handoff stays running.
    expect(repos.handoffs.require('h1').result).toBeNull()
  })

  it('14. starting again after stop() re-subscribes and finishes a run that ends afterwards', async () => {
    const bot = makeBot()
    dropHandoff({ id: 'h1', toBotId: bot.id, task: 'Summarize' })
    const service = makeService()
    await service.tick()
    const runId = repos.handoffs.require('h1').runId!

    service.stop()
    service.start()
    bus.emit({ type: 'run.updated', run: repos.runs.update(runId, { state: 'done', finishedAt: 4 }) })

    await vi.waitFor(() => expect(repos.handoffs.require('h1').state).toBe('done'))
  })
})