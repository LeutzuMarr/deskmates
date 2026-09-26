/**
 * Windows Task Scheduler wake timers, registered through `schtasks.exe` via the injected
 * `CommandRunner` (see `command-runner.ts`) — never a raw shell string: the task definition is
 * always a generated XML file, and every `schtasks` call is a plain argv array. One task per
 * schedule, named for it, holding a single one-shot trigger for that schedule's next run time
 * minus a short lead (see the design spec, 5.7: "a couple of minutes early"); each `upsert` call
 * overwrites the previous trigger time as the schedule moves to its next occurrence, and `remove`
 * deletes the task outright — there is never more than one task per schedule.
 *
 * The task's own action is a deliberate no-op (`cmd.exe /c exit`): its only job is `WakeToRun`,
 * pulling the PC out of sleep so Deskmates — already running in the tray — can act on its own
 * schedule tick. A wake timer cannot revive a PC that's fully shut down (only sleep/hibernate);
 * that case is what `catch-up.ts`'s "missed" policy is for.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../bots/command-runner'

export interface WakeTaskParams {
  scheduleId: string
  botId: string
  /** Local wall-clock time the task should fire — already lead-adjusted by the caller. */
  runAt: Date
}

/** Grouped under one Task Scheduler folder so they're easy to find (and to tell apart from anything else on the machine). */
export function taskNameFor(scheduleId: string): string {
  return `\\Deskmates\\Schedule-${scheduleId}`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local wall-clock ISO 8601 with no timezone suffix — how Task Scheduler XML expects a local `StartBoundary`. */
function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * The Task Scheduler XML for one schedule's wake task. Pure and dependency-free by design, so its
 * exact contents are directly assertable in tests without touching the filesystem or `schtasks`.
 * The task text deliberately excludes the schedule's own task instructions (arbitrary user text) —
 * only ids go in, since this file is readable by anything on the machine that can browse Task
 * Scheduler.
 */
export function buildTaskXml(params: WakeTaskParams): string {
  const { scheduleId, botId, runAt } = params
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>Wakes this PC to run a Deskmates bot schedule (schedule ${escapeXml(scheduleId)}, bot ${escapeXml(botId)}).</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    `      <StartBoundary>${toLocalIso(runAt)}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <WakeToRun>true</WakeToRun>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>%windir%\\System32\\cmd.exe</Command>',
    '      <Arguments>/c exit</Arguments>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    ''
  ].join('\r\n')
}

function toUtf16LEWithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

export interface WakeTimerDeps {
  runner: CommandRunner
  /** Each schedule's generated XML is written under `<dataDir>/scheduler/wake-tasks/` before being handed to schtasks. */
  dataDir: string
  /** Minutes before the run time the wake task should fire. Default 2, per the design spec (5.7). */
  leadMinutes?: number
}

/** Registers and removes each schedule's wake task, entirely through the injected `CommandRunner` — real Task Scheduler is never touched in tests. */
export class WakeTimerManager {
  constructor(private readonly deps: WakeTimerDeps) {}

  private xmlDir(): string {
    return join(this.deps.dataDir, 'scheduler', 'wake-tasks')
  }

  private xmlPath(scheduleId: string): string {
    return join(this.xmlDir(), `${scheduleId}.xml`)
  }

  /** Creates or overwrites this schedule's wake task, timed `leadMinutes` before `nextRunAtMs`. */
  async upsert(scheduleId: string, botId: string, nextRunAtMs: number): Promise<void> {
    const leadMs = (this.deps.leadMinutes ?? 2) * 60_000
    const runAt = new Date(nextRunAtMs - leadMs)
    const xml = buildTaskXml({ scheduleId, botId, runAt })
    const path = this.xmlPath(scheduleId)
    mkdirSync(this.xmlDir(), { recursive: true })
    writeFileSync(path, toUtf16LEWithBom(xml))
    const result = await this.deps.runner.run('schtasks', ['/Create', '/TN', taskNameFor(scheduleId), '/XML', path, '/F'])
    if (result.code !== 0) {
      throw new Error(`Couldn't register this schedule's wake timer: ${result.stderr.trim() || `schtasks exited with code ${result.code}`}`)
    }
  }

  /** Removes this schedule's wake task. A task that's already gone (never registered, or removed by hand) is not an error. */
  async remove(scheduleId: string): Promise<void> {
    const result = await this.deps.runner.run('schtasks', ['/Delete', '/TN', taskNameFor(scheduleId), '/F'])
    if (result.code !== 0 && !/cannot find|does not exist/i.test(result.stderr)) {
      throw new Error(`Couldn't remove this schedule's wake timer: ${result.stderr.trim() || `schtasks exited with code ${result.code}`}`)
    }
  }
}
