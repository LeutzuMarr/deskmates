import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'
import { EventBus } from '../../src/core/events'
import { TaskScheduler } from '../../src/core/schedules/task-scheduler'
import { scheduleTools } from '../../src/core/tools/schedules'

function setup(cli = false) {
  const repos = createRepos(openDatabase(':memory:'))
  const project = repos.projects.create('School', 'C:/tmp/school')
  const scheduler = new TaskScheduler({
    repos,
    bus: new EventBus(),
    send: async () => undefined,
    whenIdle: async () => undefined,
    isRunning: () => false,
    isCliProject: () => cli,
    notify: () => undefined,
    now: () => new Date(2026, 10, 5, 12, 0).getTime()
  })
  const tools = scheduleTools({ scheduler, projectId: project.id, waitsForStart: () => cli })
  const run = <T>(name: keyof typeof tools, input: T): Promise<string> =>
    (tools[name] as unknown as { execute: (input: T, o: unknown) => Promise<string> }).execute(input, { toolCallId: 'x', messages: [] })
  return { run, scheduler }
}

describe('schedule tools', () => {
  it('create returns description and next run', async () => {
    const { run } = setup()
    const text = await run('schedule_create', { name: 'Homework check', instruction: 'Read the school site', when: { frequency: 'weekdays', time: '16:00' }, missed: 'run-late' })
    expect(text).toContain('Every weekday at 16:00')
    expect(text).toMatch(/Next: Thu.*5 Nov/)
    expect(await run('schedule_list', {})).toContain('Homework check')
  })

  it('invalid when is refused with reason', async () => {
    const { run } = setup()
    await expect(run('schedule_create', { name: 'X', instruction: 'Y', when: { frequency: 'monthly', time: '09:00' }, missed: 'run-late' })).rejects.toThrow(/dayOfMonth/)
  })

  it('says it waits for Start on a command-line model', async () => {
    const { run } = setup(true)
    const text = await run('schedule_create', { name: 'Brief', instruction: 'Brief me', when: { frequency: 'daily', time: '07:30' }, missed: 'run-late' })
    expect(text).toContain('press Start')
  })

  it('update and delete only touch this project', async () => {
    const { run, scheduler } = setup()
    await run('schedule_create', { name: 'A', instruction: 'B', when: { frequency: 'daily', time: '07:30' }, missed: 'run-late' })
    const id = scheduler.list()[0]!.id
    expect(await run('schedule_update', { id, enabled: false })).toContain('off')
    expect(await run('schedule_delete', { id })).toContain('Deleted "A"')
    await expect(run('schedule_delete', { id: 'nope' })).rejects.toThrow(/no scheduled task/)
  })
})
