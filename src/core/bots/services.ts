import type { CreatePcOptions, PcEndpoints } from './host'
import type { Bot, BotPc, BotRun, EngineStatus, PcMode, Schedule, TimelineItem } from '../../shared/protocol'

/**
 * Detects and sets up the WSL engine (the bot-engine task). Optional on `HandlerServices`: while
 * it's missing, the `engine.*` handlers answer with a clear "not set up" error instead of a raw
 * TypeError.
 */
export interface EngineService {
  status(): Promise<EngineStatus>
  /** Performs the next setup step it can. `onProgress` is called with a fresh full status after each step. */
  setup(onProgress: (status: EngineStatus) => void): Promise<EngineStatus>
}

/**
 * Creates, runs and talks to each bot's PC (the BotHost/LocalWslHost task). This is deliberately
 * a subset of `BotHost` (see `host.ts`) plus the two extra methods `LocalWslHost` exposes for mode
 * and live settings changes — chosen so `LocalWslHost` satisfies this interface as-is, with no
 * adapter. Optional on `HandlerServices`.
 */
export interface PcService {
  create(botId: string, options: CreatePcOptions): Promise<BotPc>
  start(botId: string): Promise<BotPc>
  stop(botId: string): Promise<BotPc>
  reset(botId: string): Promise<BotPc>
  delete(botId: string): Promise<void>
  endpoints(botId: string): Promise<PcEndpoints | null>
  setMode(mode: PcMode): void
  updatePcOptions(botId: string, patch: Partial<CreatePcOptions>): void
}

/**
 * Runs a bot's task end to end (the bot-runner task), the same way `TaskRunner` runs a Work-tab
 * task: it owns the run's state transitions and emits `run.updated` / `run.item` on the bus
 * itself, so handlers only need to hand off and read back. Optional on `HandlerServices`.
 */
export interface RunService {
  /** Begins executing an already-created run in the background; progress arrives as bus events. */
  start(run: BotRun, bot: Bot): Promise<void>
  /** Stops a run in progress. */
  stop(runId: string): Promise<void>
  /** Answers an approval the run is waiting on. `always` adds the tool to the bot's auto-approved list. */
  respond(runId: string, approvalId: string, approved: boolean, always?: boolean): Promise<void>
  /** The full timeline recorded for a run, read from its log. */
  items(runId: string): Promise<TimelineItem[]>
  /**
   * Pauses (`on: true`) or resumes (`on: false`) a bot's PC-touching tools — see spec 5.8's "Take
   * over". While paused, tools that reach the bot's screen, browser or on-disk files refuse to run
   * for this bot, in the current run and any future one, until this is called again with `on: false`.
   */
  setTakenOver(botId: string, on: boolean): void
}

/**
 * Cron parsing, next-run computation and Windows wake-timer registration (the scheduler task).
 * Optional on `HandlerServices`: schedule CRUD works without it (a schedule is just data until
 * something acts on it), but `nextRunAt` stays `null` and no wake timer is registered until it's
 * wired up.
 */
export interface ScheduleService {
  /** Validates the cron expression, computes its next run time and (re)registers its wake timer. Throws on an invalid cron. */
  sync(schedule: Schedule): Promise<{ nextRunAt: number | null }>
  /** Unregisters the wake timer before a schedule is deleted. */
  unsync(scheduleId: string): Promise<void>
}
