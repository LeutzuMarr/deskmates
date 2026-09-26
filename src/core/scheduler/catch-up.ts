/**
 * The catch-up policy for a schedule the ticker finds due (see `scheduler.ts`). A schedule is
 * "due" the moment `nextRunAt` is in the past, which happens on every ordinary firing too — the
 * ticker runs at least as often as `catchUpThresholdMs`, so an on-time firing is only ever a few
 * seconds or minutes late. A firing that's late by more than that can only mean the PC was asleep
 * or off (or Deskmates itself wasn't running) straight through its scheduled moment, which is what
 * the design spec (5.7) calls a run "missed because the laptop was off" — and only then does the
 * schedule's own `missed` choice ('run-late' or 'skip') apply.
 */
import type { Schedule } from '../../shared/protocol'

/** Counts as "missed" (PC was off/asleep through it) rather than an on-time tick past its threshold. */
export const DEFAULT_CATCH_UP_THRESHOLD_MS = 5 * 60 * 1000

export interface SchedulePlan {
  /** 'run' starts a run now; 'skip' advances the schedule without starting one; 'none' means nothing is due. */
  action: 'run' | 'skip' | 'none'
  /** True when this firing arrived late enough to count as a missed run rather than an on-time tick. */
  isCatchUp: boolean
}

/** Pure decision for one schedule at one instant — no I/O, so `scheduler.ts`'s tick loop is the only place that needs a fake clock or fake repo to test around. */
export function planSchedule(schedule: Schedule, now: number, thresholdMs = DEFAULT_CATCH_UP_THRESHOLD_MS): SchedulePlan {
  if (!schedule.enabled || schedule.nextRunAt == null || schedule.nextRunAt > now) {
    return { action: 'none', isCatchUp: false }
  }
  const lateMs = now - schedule.nextRunAt
  const isCatchUp = lateMs > thresholdMs
  if (isCatchUp && schedule.missed === 'skip') return { action: 'skip', isCatchUp: true }
  return { action: 'run', isCatchUp }
}
