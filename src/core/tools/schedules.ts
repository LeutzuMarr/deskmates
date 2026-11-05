/**
 * Scheduled-task tools for the Work and Design agents: "every weekday at 7:30, check my inbox and
 * summarise it". The agent fills in a structured `when`; the scheduler does the date maths.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { TaskSchedule, When } from '../../shared/protocol'
import { describeWhen } from '../../shared/when'
import type { TaskScheduler } from '../schedules/task-scheduler'

const whenSchema = z.object({
  frequency: z.enum(['once', 'daily', 'weekdays', 'weekly', 'monthly']).describe('weekdays = Monday to Friday'),
  time: z.string().describe('Local 24-hour time, "HH:MM", like "07:30" or "19:35"'),
  date: z.string().optional().describe('For once: the local date, "YYYY-MM-DD"'),
  days: z.array(z.number().int().min(0).max(6)).optional().describe('For weekly: 0 = Sunday, 1 = Monday … 6 = Saturday'),
  day_of_month: z.number().int().min(1).max(31).optional().describe('For monthly: 1–31')
})

type WhenInput = z.infer<typeof whenSchema>

const toWhen = (input: WhenInput): When => ({
  frequency: input.frequency,
  time: input.time,
  ...(input.date ? { date: input.date } : {}),
  ...(input.days ? { days: input.days } : {}),
  ...(input.day_of_month ? { dayOfMonth: input.day_of_month } : {})
})

export interface ScheduleToolDeps {
  scheduler: TaskScheduler
  projectId: string
  /** Whether this project's model is a command-line tool, so its runs wait for the user's Start. */
  waitsForStart: () => boolean
}

function describe(schedule: TaskSchedule, waits: boolean): string {
  const next = schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not scheduled'
  return [
    `"${schedule.name}" (id ${schedule.id}): ${describeWhen(schedule.when)}, ${schedule.enabled ? 'on' : 'off'}. Next: ${next}.`,
    waits ? 'This project runs on a command-line model, so at that time it waits for the user to press Start in Deskmates (on the PC or the phone).' : ''
  ]
    .filter(Boolean)
    .join(' ')
}

export function scheduleTools(deps: ScheduleToolDeps) {
  const mine = (id: string): TaskSchedule => {
    const schedule = deps.scheduler.list(deps.projectId).find((s) => s.id === id)
    if (!schedule) throw new Error(`There is no scheduled task ${id} in this project. Use schedule_list.`)
    return schedule
  }

  return {
    schedule_create: tool({
      description:
        'Schedule a task to run in this project at set times ("every weekday at 07:30", "once on 2026-11-06 at 19:35"). Confirm the name, the instruction and the time with the user before creating it. The instruction should stand on its own: the run starts fresh, without this conversation. On Freebuff, OpenCode or Antigravity the run waits for the user to press Start instead of starting by itself.',
      inputSchema: z.object({
        name: z.string().min(1).describe('A short name, like "Morning inbox check"'),
        instruction: z.string().min(1).describe('What to do at each run, complete on its own'),
        when: whenSchema,
        missed: z.enum(['run-late', 'skip']).default('run-late').describe('If the PC was off at the time: run late when it is back, or skip that run')
      }),
      execute: async ({ name, instruction, when, missed }) => {
        const created = deps.scheduler.create({ projectId: deps.projectId, name, instruction, when: toWhen(when), missed })
        return `Scheduled. ${describe(created, deps.waitsForStart())}`
      }
    }),

    schedule_list: tool({
      description: "List this project's scheduled tasks with their times and ids.",
      inputSchema: z.object({}),
      execute: async () => {
        const all = deps.scheduler.list(deps.projectId)
        return all.length ? all.map((s) => describe(s, deps.waitsForStart())).join('\n') : 'This project has no scheduled tasks.'
      }
    }),

    schedule_update: tool({
      description: 'Change a scheduled task: its name, instruction, time, or turn it on or off. Confirm with the user first.',
      inputSchema: z.object({
        id: z.string(),
        name: z.string().optional(),
        instruction: z.string().optional(),
        when: whenSchema.optional(),
        enabled: z.boolean().optional()
      }),
      execute: async ({ id, name, instruction, when, enabled }) => {
        mine(id)
        const updated = deps.scheduler.update(id, { name, instruction, enabled, ...(when ? { when: toWhen(when) } : {}) })
        return `Updated. ${describe(updated, deps.waitsForStart())}`
      }
    }),

    schedule_delete: tool({
      description: 'Delete a scheduled task. Confirm with the user first.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const schedule = mine(id)
        await deps.scheduler.delete(id)
        return `Deleted "${schedule.name}".`
      }
    })
  }
}
