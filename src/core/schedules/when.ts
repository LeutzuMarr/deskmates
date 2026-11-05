import type { When } from '../../shared/when'
import { cronFor, parseTime, validateWhen } from '../../shared/when'
import { nextRunAt, parseCron } from '../scheduler/cron'

/** The next local time strictly after `from` that `when` fires, or null (a past one-time, or an invalid `when`). */
export function nextOccurrence(when: When, from: Date): Date | null {
  if (validateWhen(when)) return null
  if (when.frequency === 'once') {
    const t = parseTime(when.time)!
    const [y, m, d] = when.date!.split('-').map(Number)
    const at = new Date(y!, m! - 1, d!, t.hour, t.minute, 0, 0)
    return at.getTime() > from.getTime() ? at : null
  }
  return nextRunAt(parseCron(cronFor(when)!), from)
}

/** The most recent time `when` fired at or before `now`, after `since` (for "missed while off"). */
export function lastOccurrenceBetween(when: When, since: Date, now: Date): Date | null {
  let last: Date | null = null
  let cursor = since
  for (let i = 0; i < 500; i++) {
    const next = nextOccurrence(when, cursor)
    if (!next || next.getTime() > now.getTime()) break
    last = next
    cursor = next
  }
  return last
}
