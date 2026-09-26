/**
 * The receiving side of the handoff tool (design spec 5.9): scans `<dataDir>/shared/handoffs/*.json`
 * for tasks other bots left, runs each one through the same `RunService` a schedule or a manual
 * `bots.run` uses, and records the outcome back on the handoff row. The tool writes the file; this
 * service reads it and runs it — see the tool's own module doc for the split.
 *
 * It never deletes the handoff files (the sender may be watching them), so a scan must not treat a
 * file it has already seen as new: `HandoffsRepo.upsertFromRecord` inserts only the first time and
 * reports whether it did, which is the signal for emitting `handoff.updated`.
 */
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot, BotRun, CoreEvent, Handoff } from '../../shared/protocol'
import type { EventBus } from '../events'
import type { Repos } from '../store/repos'
import type { RunService } from './services'
import type { HandoffRecord } from './tools/handoff'

export interface HandoffServiceDeps {
  repos: Repos
  bus: EventBus
  /** The app's data folder; the inbox is `<dataDir>/shared/handoffs/` and runs write to `<dataDir>/runs/<runId>/`. */
  dataDir: string
  /** Starts a picked-up run. Left unset, scan/pickup still reconcile rows but start nothing — lets the service be constructed before the run machinery exists. */
  run?: RunService
  /** How often to scan the inbox. Default 30 seconds, same as the scheduler. */
  scanIntervalMs?: number
}

export class HandoffService {
  private readonly deps: HandoffServiceDeps
  private timer: ReturnType<typeof setInterval> | null = null
  private unsub: (() => void) | null = null
  private ticking = false

  constructor(deps: HandoffServiceDeps) {
    this.deps = deps
    this.resubscribe()
  }

  private resubscribe(): void {
    if (this.unsub) return
    this.unsub = this.deps.bus.on((event) => void this.onEvent(event))
  }

  /** Starts the periodic scan, running one immediately so anything left while the app was closed is caught up. Safe to call more than once. */
  start(): void {
    if (this.timer) return
    this.resubscribe()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.scanIntervalMs ?? 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsub?.()
    this.unsub = null
  }

  /**
   * One pass over the inbox: import new handoff files, finish any run that ended while we weren't
   * looking (e.g. across a restart, where `repos.runs.resetInterrupted()` reconciled its run to
   * `error`), then start runs for the pending ones whose bot is free. Exposed directly (not just
   * through `start`'s interval) so tests can drive it deterministically.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.scanInbox()
      await this.reconcileRunning()
      await this.pickUpPending()
    } finally {
      this.ticking = false
    }
  }

  // ---- the three phases of a tick ----

  private async scanInbox(): Promise<void> {
    const folder = join(this.deps.dataDir, 'shared', 'handoffs')
    let files: string[]
    try {
      files = readdirSync(folder).filter((f) => f.endsWith('.json'))
    } catch {
      return // no inbox yet — nothing to do
    }
    for (const file of files) {
      let record: HandoffRecord
      try {
        record = JSON.parse(readFileSync(join(folder, file), 'utf8')) as HandoffRecord
      } catch {
        continue // a corrupt handoff file shouldn't block the rest of the inbox
      }
      if (typeof record.id !== 'string' || typeof record.toBotId !== 'string' || typeof record.task !== 'string') continue
      if (!Array.isArray(record.files)) record.files = []
      // The receiving bot may have been deleted since the file was written — the FK on
      // to_bot_id would reject the insert, so skip it altogether.
      if (!this.deps.repos.bots.get(record.toBotId)) continue
      const { handoff, inserted } = this.deps.repos.handoffs.upsertFromRecord(record)
      if (inserted) this.deps.bus.emit({ type: 'handoff.updated', handoff })
    }
  }

  /** Handoffs whose run ended while this service wasn't listening (shutdown, or a missed event) get their outcome written now. */
  private async reconcileRunning(): Promise<void> {
    for (const handoff of this.deps.repos.handoffs.list()) {
      if (handoff.state !== 'running') continue
      const run = handoff.runId ? this.deps.repos.runs.get(handoff.runId) : undefined
      if (run && (run.state === 'queued' || run.state === 'running' || run.state === 'waiting-approval')) continue
      await this.finish(handoff, run)
    }
  }

  /** Starts the task on every pending handoff whose bot exists and isn't already busy with a run —
   *  one run per bot per pass, so handoffs to the same bot act as a queue. */
  private async pickUpPending(): Promise<void> {
    const startedThisPass = new Set<string>()
    for (const handoff of this.deps.repos.handoffs.list()) {
      if (handoff.state !== 'pending') continue
      const bot = this.deps.repos.bots.get(handoff.toBotId)
      if (!bot) continue
      if (startedThisPass.has(bot.id) || this.deps.repos.runs.isActive(bot.id)) continue
      startedThisPass.add(bot.id)
      await this.startRun(handoff, bot)
    }
  }

  private async startRun(handoff: Handoff, bot: Bot): Promise<void> {
    const id = randomUUID()
    const run = this.deps.repos.runs.create(bot.id, handoff.task, join(this.deps.dataDir, 'runs', id), null, id)
    this.deps.bus.emit({ type: 'run.updated', run })
    const updated = this.deps.repos.handoffs.markRunning(handoff.id, run.id)
    this.deps.bus.emit({ type: 'handoff.updated', handoff: updated })
    // Marked running before start so the run-end handler can find the handoff by run id; a start
    // that throws (or a run that fails instantly) lands on the normal run-end path.
    if (this.deps.run) void this.deps.run.start(run, bot).catch(() => {})
  }

  // ---- run-end ----

  private async onEvent(event: CoreEvent): Promise<void> {
    if (event.type !== 'run.updated') return
    if (event.run.state !== 'done' && event.run.state !== 'error' && event.run.state !== 'stopped') return
    try {
      const handoff = this.deps.repos.handoffs.byRun(event.run.id)
      if (!handoff || handoff.state !== 'running') return
      await this.finish(handoff, event.run)
    } catch (error) {
      console.error('[handoffs] marking a finished run failed:', error instanceof Error ? error.message : error)
    }
  }

  /** Writes a handoff's final outcome and surfaces it. The result comes from the run's own log
   *  (the last assistant line) on success, or the run's error on failure. */
  private async finish(handoff: Handoff, run: BotRun | undefined): Promise<void> {
    let state: 'done' | 'error'
    let result: string
    if (run && run.state === 'done') {
      state = 'done'
      result = (await this.lastReply(run.id)) ?? 'Done.'
    } else {
      state = 'error'
      result = run?.error ?? 'Stopped because Deskmates was closed.'
    }
    const updated = this.deps.repos.handoffs.finish(handoff.id, state, result)
    this.deps.bus.emit({ type: 'handoff.updated', handoff: updated })
  }

  /** The run's final reply: the last assistant line in its log. Absent without a run service, or when the bot never said anything. */
  private async lastReply(runId: string): Promise<string | null> {
    const items = await this.deps.run?.items(runId)
    if (!items) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'assistant' && item.text.trim()) return item.text.trim()
    }
    return null
  }
}