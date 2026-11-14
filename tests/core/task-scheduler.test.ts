import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'
import { EventBus } from '../../src/core/events'
import { TaskScheduler } from '../../src/core/schedules/task-scheduler'

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()

function setup(options: { cli?: boolean; now: number }) {
  const repos = createRepos(openDatabase(':memory:'))
  const project = repos.projects.create('Velosyntech', 'C:/tmp/velo')
  let now = options.now
  const sent: Array<{ taskId: string; text: string }> = []
  const notes: string[] = []
  const scheduler = new TaskScheduler({
    repos,
    bus: new EventBus(),
    send: async (taskId, text) => {
      sent.push({ taskId, text })
    },
    whenIdle: async () => undefined,
    isRunning: () => false,
    isCliProject: () => options.cli === true,
    notify: (title) => notes.push(title),
    now: () => now
  })
  return { repos, project, scheduler, sent, notes, setNow: (t: number) => (now = t) }
}

describe('scheduled tasks', () => {
  it('api model run creates and sends a task at its time', async () => {
    const t = setup({ now: local(2026, 11, 5, 7, 0) })
    const schedule = t.scheduler.create({ projectId: t.project.id, name: 'Morning check', instruction: 'Check the inbox', when: { frequency: 'weekdays', time: '07:30' } })
    expect(schedule.nextRunAt).toBe(local(2026, 11, 5, 7, 30))

    await t.scheduler.tick(local(2026, 11, 5, 7, 20))
    expect(t.sent).toHaveLength(0)

    t.setNow(local(2026, 11, 5, 7, 30, ))
    await t.scheduler.tick(local(2026, 11, 5, 7, 30))
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]!.text).toContain('Check the inbox')
    expect(t.sent[0]!.text).toContain('Every weekday at 07:30')
    const task = t.repos.tasks.require(t.sent[0]!.taskId)
    expect(task.title).toMatch(/^Morning check · 5 Nov/)
    // Thursday → Friday next.
    expect(t.repos.taskSchedules.require(schedule.id).nextRunAt).toBe(local(2026, 11, 6, 7, 30))

    // The same moment again starts nothing more.
    await t.scheduler.tick(local(2026, 11, 5, 7, 31))
    expect(t.sent).toHaveLength(1)
  })

  it('cli model makes a start card not a run', async () => {
    const t = setup({ cli: true, now: local(2026, 11, 5, 7, 0) })
    const schedule = t.scheduler.create({ projectId: t.project.id, name: 'Brief', instruction: 'Do it', when: { frequency: 'daily', time: '07:30' } })
    await t.scheduler.tick(local(2026, 11, 5, 7, 30))
    expect(t.sent).toHaveLength(0)
    expect(t.repos.taskSchedules.require(schedule.id).pendingSince).toBe(local(2026, 11, 5, 7, 30))
    expect(t.notes).toEqual(['Ready to run: Brief'])

    const started = await t.scheduler.startPending(schedule.id)
    expect(started?.taskId).toBeTruthy()
    expect(t.sent).toHaveLength(1)
    expect(t.repos.taskSchedules.require(schedule.id).pendingSince).toBeNull()
  })

  it('start is a no-op when not pending, so a second tap runs nothing', async () => {
    const t = setup({ cli: true, now: local(2026, 11, 5, 7, 0) })
    const schedule = t.scheduler.create({ projectId: t.project.id, name: 'Brief', instruction: 'Do it', when: { frequency: 'daily', time: '07:30' } })
    expect(await t.scheduler.startPending(schedule.id)).toBeNull()
    await t.scheduler.tick(local(2026, 11, 5, 7, 30))
    const [first, second] = await Promise.all([t.scheduler.startPending(schedule.id), t.scheduler.startPending(schedule.id)])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect(t.sent).toHaveLength(1)
  })

  it('missed CLI run makes one late card', async () => {
    const t = setup({ cli: true, now: local(2026, 11, 2, 6, 0) })
    const schedule = t.scheduler.create({ projectId: t.project.id, name: 'Brief', instruction: 'Do it', when: { frequency: 'daily', time: '07:30' } })
    // The PC was off from Monday to Thursday 11:00.
    await t.scheduler.tick(local(2026, 11, 5, 11, 0))
    await t.scheduler.tick(local(2026, 11, 5, 11, 1))
    expect(t.notes).toEqual(['Ready to run: Brief'])
    const after = t.repos.taskSchedules.require(schedule.id)
    expect(after.nextRunAt).toBe(local(2026, 11, 6, 7, 30))
    expect(after.pendingSince).not.toBeNull()
    expect(t.sent).toHaveLength(0)
  })

  it('a missed run set to skip is skipped', async () => {
    const t = setup({ now: local(2026, 11, 2, 6, 0) })
    t.scheduler.create({ projectId: t.project.id, name: 'Report', instruction: 'Do it', when: { frequency: 'daily', time: '07:30' }, missed: 'skip' })
    await t.scheduler.tick(local(2026, 11, 2, 9, 0))
    expect(t.sent).toHaveLength(0)
  })

  it('a one-time task runs once and then turns off', async () => {
    const t = setup({ now: local(2026, 11, 5, 19, 0) })
    const schedule = t.scheduler.create({ projectId: t.project.id, name: 'Once', instruction: 'Do it', when: { frequency: 'once', time: '19:35', date: '2026-11-05' } })
    await t.scheduler.tick(local(2026, 11, 5, 19, 35))
    const after = t.repos.taskSchedules.require(schedule.id)
    expect(t.sent).toHaveLength(1)
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeNull()
  })

  it('invalid when is refused with reason', () => {
    const t = setup({ now: local(2026, 11, 5, 19, 0) })
    expect(() => t.scheduler.create({ projectId: t.project.id, name: 'X', instruction: 'Y', when: { frequency: 'weekly', time: '09:00', days: [] } })).toThrow(/days/)
    expect(() => t.scheduler.create({ projectId: t.project.id, name: 'X', instruction: 'Y', when: { frequency: 'once', time: '09:00', date: '2026-11-01' } })).toThrow(/past/)
  })
})
