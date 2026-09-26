import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'

let repos: Repos

beforeEach(() => {
  repos = createRepos(openDatabase(':memory:'))
})

describe('bots migration', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('adds bots, bot_pcs, schedules and runs to a database built at the previous version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deskmates-bots-migration-'))
    dirs.push(dir)
    const file = join(dir, 'previous.db')

    // The bots migration is no longer the last one (extensions were added after it), so build a
    // database up to the one right before it — "the previous version" the bots migration upgrades.
    const botsIndex = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE bots'))
    expect(botsIndex).toBeGreaterThan(0)

    const previous = new DatabaseSync(file)
    previous.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    for (let i = 0; i < botsIndex; i++) {
      previous.exec('BEGIN')
      previous.exec(MIGRATIONS[i]!)
      previous.exec(`PRAGMA user_version = ${i + 1}`)
      previous.exec('COMMIT')
    }
    const { user_version: before } = previous.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(before).toBe(botsIndex)
    expect(() => previous.prepare('SELECT * FROM bots').get()).toThrow()
    previous.close()

    // Reopening through openDatabase() must apply exactly the remaining migrations up to and including bots.
    const upgraded = openDatabase(file)
    const { user_version: after } = upgraded.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(after).toBe(MIGRATIONS.length)

    const upgradedRepos = createRepos(upgraded)
    const bot = upgradedRepos.bots.create('Digest bot')
    upgradedRepos.botPcs.create(bot.id)
    expect(upgradedRepos.botPcs.require(bot.id)).toMatchObject({ state: 'absent', memoryMb: 1024, idleStopMinutes: 30 })
    upgraded.close()

    // Reopening again must be a no-op (idempotent): user_version stays put and data survives.
    const reopened = openDatabase(file)
    const { user_version: again } = reopened.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(again).toBe(MIGRATIONS.length)
    expect(createRepos(reopened).bots.require(bot.id).name).toBe('Digest bot')
    reopened.close()
  })
})

describe('BotsRepo', () => {
  it('creates with defaults, requires, lists in creation order and deletes', () => {
    expect(() => repos.bots.require('missing')).toThrow('Bot not found: missing')

    const a = repos.bots.create('Digest bot')
    expect(a).toMatchObject({ name: 'Digest bot', avatar: null, instructions: '', model: null, autoApprove: [] })
    expect(a.createdAt).toBe(a.updatedAt)

    const b = repos.bots.create('News bot', 'Summarize the news.', { provider: 'google', modelId: 'gemini-flash' })
    expect(b.instructions).toBe('Summarize the news.')
    expect(b.model).toEqual({ provider: 'google', modelId: 'gemini-flash' })

    expect(repos.bots.list().map((bot) => bot.id)).toEqual([a.id, b.id])
    expect(repos.bots.get(a.id)).toEqual(a)

    repos.bots.delete(a.id)
    expect(repos.bots.get(a.id)).toBeUndefined()
    expect(repos.bots.list().map((bot) => bot.id)).toEqual([b.id])
  })

  it('updates only the given fields and can clear avatar/model back to null', () => {
    const bot = repos.bots.create('Digest bot', 'Old instructions')
    const withAvatar = repos.bots.update(bot.id, { avatar: 'data:image/png;base64,x', model: { provider: 'openai', modelId: 'gpt-x' } })
    expect(withAvatar.avatar).toBe('data:image/png;base64,x')
    expect(withAvatar.updatedAt).toBeGreaterThanOrEqual(bot.updatedAt)

    // Omitting a field leaves it untouched; explicit null clears it.
    const renamed = repos.bots.update(bot.id, { name: 'Renamed bot' })
    expect(renamed.instructions).toBe('Old instructions')
    expect(renamed.avatar).toBe('data:image/png;base64,x')
    expect(renamed.model).toEqual({ provider: 'openai', modelId: 'gpt-x' })

    const cleared = repos.bots.update(bot.id, { avatar: null, model: null, autoApprove: ['whatsapp_send'] })
    expect(cleared.avatar).toBeNull()
    expect(cleared.model).toBeNull()
    expect(cleared.autoApprove).toEqual(['whatsapp_send'])
  })
})

describe('BotPcsRepo', () => {
  it('creates the default absent row, saves a live snapshot and updates settings independently', () => {
    const bot = repos.bots.create('Digest bot')
    expect(() => repos.botPcs.require(bot.id)).toThrow(`PC not found for bot: ${bot.id}`)

    const created = repos.botPcs.create(bot.id)
    expect(created).toEqual({
      botId: bot.id,
      state: 'absent',
      containerId: null,
      memoryMb: 1024,
      idleStopMinutes: 30,
      lastUsedAt: null,
      error: null
    })
    expect(repos.botPcs.list()).toEqual([created])

    const live = repos.botPcs.save({ botId: bot.id, state: 'running', containerId: 'c1', lastUsedAt: 5000, error: null })
    expect(live).toMatchObject({ state: 'running', containerId: 'c1', lastUsedAt: 5000, memoryMb: 1024, idleStopMinutes: 30 })

    const configured = repos.botPcs.updateSettings(bot.id, { memoryMb: 2048 })
    expect(configured).toMatchObject({ memoryMb: 2048, idleStopMinutes: 30, state: 'running', containerId: 'c1' })

    const errored = repos.botPcs.save({ botId: bot.id, state: 'error', containerId: null, lastUsedAt: 5000, error: 'Out of memory' })
    expect(errored).toMatchObject({ state: 'error', error: 'Out of memory', memoryMb: 2048 })
  })

  it('is removed when its bot is deleted', () => {
    const bot = repos.bots.create('Digest bot')
    repos.botPcs.create(bot.id)
    repos.bots.delete(bot.id)
    expect(repos.botPcs.get(bot.id)).toBeUndefined()
  })
})

describe('SchedulesRepo', () => {
  it('creates with defaults, lists per bot, updates and deletes', () => {
    const a = repos.bots.create('Digest bot')
    const b = repos.bots.create('Other bot')

    const schedule = repos.schedules.create(a.id, '0 8 * * *', 'Summarize today’s posts')
    expect(schedule).toMatchObject({ botId: a.id, cron: '0 8 * * *', enabled: true, missed: 'run-late', lastRunAt: null, nextRunAt: null })

    repos.schedules.create(b.id, '0 9 * * *', 'Other task', 'skip')
    expect(repos.schedules.list().length).toBe(2)
    expect(repos.schedules.list(a.id).map((s) => s.id)).toEqual([schedule.id])

    const updated = repos.schedules.update(schedule.id, { enabled: false, nextRunAt: 123456 })
    expect(updated).toMatchObject({ enabled: false, nextRunAt: 123456, cron: '0 8 * * *' })

    expect(() => repos.schedules.require('missing')).toThrow('Schedule not found: missing')

    repos.schedules.delete(schedule.id)
    expect(repos.schedules.get(schedule.id)).toBeUndefined()
  })

  it('is removed when its bot is deleted', () => {
    const bot = repos.bots.create('Digest bot')
    const schedule = repos.schedules.create(bot.id, '0 8 * * *', 'Task')
    repos.bots.delete(bot.id)
    expect(repos.schedules.get(schedule.id)).toBeUndefined()
  })
})

describe('RunsRepo', () => {
  it('creates with defaults, lists newest-first per bot with a limit, and updates state', () => {
    const bot = repos.bots.create('Digest bot')
    const run1 = repos.runs.create(bot.id, 'Task 1', '/data/runs/r1')
    expect(run1).toMatchObject({ botId: bot.id, scheduleId: null, state: 'queued', task: 'Task 1', finishedAt: null, error: null })

    const schedule = repos.schedules.create(bot.id, '0 8 * * *', 'Scheduled task')
    const run2 = repos.runs.create(bot.id, 'Task 2', '/data/runs/r2', schedule.id)
    expect(run2.scheduleId).toBe(schedule.id)
    expect(run2.startedAt).toBeGreaterThanOrEqual(run1.startedAt)

    expect(repos.runs.list(bot.id).map((r) => r.id)).toEqual([run2.id, run1.id])
    expect(repos.runs.list(bot.id, 1).map((r) => r.id)).toEqual([run2.id])
    expect(repos.runs.list().length).toBe(2)

    expect(() => repos.runs.require('missing')).toThrow('Run not found: missing')

    const finished = repos.runs.update(run1.id, { state: 'done', finishedAt: 9999 })
    expect(finished).toMatchObject({ state: 'done', finishedAt: 9999, task: 'Task 1' })

    const failed = repos.runs.update(run2.id, { state: 'error', error: 'The model rejected the request.' })
    expect(failed.error).toBe('The model rejected the request.')
  })

  it('is removed when its bot is deleted, and keeps its schedule_id set null when only the schedule is deleted', () => {
    const bot = repos.bots.create('Digest bot')
    const schedule = repos.schedules.create(bot.id, '0 8 * * *', 'Task')
    const run = repos.runs.create(bot.id, 'Task', '/data/runs/r1', schedule.id)

    repos.schedules.delete(schedule.id)
    expect(repos.runs.require(run.id).scheduleId).toBeNull()

    repos.bots.delete(bot.id)
    expect(repos.runs.get(run.id)).toBeUndefined()
  })

  it('resetInterrupted() moves "running" and "waiting-approval" runs to "error" with a plain message, and leaves finished runs alone', () => {
    const bot = repos.bots.create('Digest bot')
    const running = repos.runs.create(bot.id, 'Task A', '/data/runs/r1')
    repos.runs.update(running.id, { state: 'running' })
    const waiting = repos.runs.create(bot.id, 'Task B', '/data/runs/r2')
    repos.runs.update(waiting.id, { state: 'waiting-approval' })
    const queued = repos.runs.create(bot.id, 'Task C', '/data/runs/r3') // never started
    const done = repos.runs.create(bot.id, 'Task D', '/data/runs/r4')
    repos.runs.update(done.id, { state: 'done', finishedAt: 5000 })

    const reset = repos.runs.resetInterrupted()

    expect(reset.map((r) => r.id).sort()).toEqual([running.id, waiting.id].sort())
    expect(repos.runs.require(running.id)).toMatchObject({ state: 'error', error: 'Stopped because Deskmates was closed.' })
    expect(repos.runs.require(running.id).finishedAt).not.toBeNull()
    expect(repos.runs.require(waiting.id)).toMatchObject({ state: 'error', error: 'Stopped because Deskmates was closed.' })

    // Untouched: a run that was never started, and one that already finished cleanly.
    expect(repos.runs.require(queued.id)).toMatchObject({ state: 'queued', error: null })
    expect(repos.runs.require(done.id)).toMatchObject({ state: 'done', finishedAt: 5000, error: null })

    // Idempotent: nothing left to reset the second time around.
    expect(repos.runs.resetInterrupted()).toEqual([])
  })
})

describe('SettingsRepo PC mode', () => {
  it('defaults to own and round-trips shared', () => {
    expect(repos.settings.getPcMode()).toBe('own')
    expect(repos.settings.setPcMode('shared')).toBe('shared')
    expect(repos.settings.getPcMode()).toBe('shared')
    // Not part of the regular Settings shape.
    expect(repos.settings.get()).not.toHaveProperty('pcMode')
  })
})
