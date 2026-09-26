/**
 * A small five-field cron parser (minute hour day-of-month month day-of-week, all in local time —
 * see the design spec, section 5.7) plus next-run computation. No named months/weekdays, just the
 * numeric syntax (a wildcard, a single value, a range like `1-5`, a step such as every 15 units,
 * or a comma list of any of those) — enough for every schedule the app itself creates and anything
 * a user is likely to type.
 *
 * `nextRunAt` walks forward in local wall-clock fields (year/month/day/hour/minute), re-reading each
 * field after every jump instead of trusting what it asked for. That one habit is what makes it
 * DST-correct for free: setting an hour that doesn't exist (the spring-forward gap) lands on
 * whatever `Date` normalizes it to, which then simply fails that iteration's match and keeps
 * searching — so a schedule whose only firing time falls in the gap is skipped for that day, and
 * every other schedule just sees its usual local time shifted by the one-hour jump, same as a
 * clock on the wall.
 */

export interface CronFields {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  /** Cron's day-of-month/day-of-week OR rule (see `dayMatches`) only kicks in when both fields are restricted; these record which ones are. */
  domRestricted: boolean
  dowRestricted: boolean
}

interface FieldSpec {
  name: string
  min: number
  max: number
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // 0 and 7 both mean Sunday, the common cron convention; parseField folds 7 into 0.
  { name: 'day-of-week', min: 0, max: 7 }
]

const PART_PATTERN = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    const match = PART_PATTERN.exec(trimmed)
    if (!match) throw new Error(`Invalid ${spec.name} value in cron expression: "${trimmed}"`)
    const [, range, stepRaw] = match
    const step = stepRaw ? Number(stepRaw) : 1
    if (step <= 0) throw new Error(`Invalid step in ${spec.name} value: "${trimmed}"`)

    let lo: number
    let hi: number
    if (range === '*') {
      lo = spec.min
      hi = spec.max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number)
      lo = a
      hi = b
    } else {
      lo = hi = Number(range)
    }
    if (lo > hi || lo < spec.min || hi > spec.max) {
      throw new Error(`${spec.name} value out of range (${spec.min}-${spec.max}): "${trimmed}"`)
    }
    for (let v = lo; v <= hi; v += step) values.add(spec.name === 'day-of-week' && v === 7 ? 0 : v)
  }
  return values
}

/** Parses a five-field cron expression. Throws with a plain message on anything invalid. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`A cron expression needs exactly 5 fields (minute hour day-of-month month day-of-week): "${expr}"`)
  }
  const [minute, hour, dom, month, dow] = parts
  return {
    minutes: parseField(minute, FIELD_SPECS[0]),
    hours: parseField(hour, FIELD_SPECS[1]),
    daysOfMonth: parseField(dom, FIELD_SPECS[2]),
    months: parseField(month, FIELD_SPECS[3]),
    daysOfWeek: parseField(dow, FIELD_SPECS[4]),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*'
  }
}

/** Standard (if slightly odd) cron rule: when BOTH day fields are restricted, a day matches either one (OR); otherwise both must agree, which is trivially true for whichever field is still "*". */
function dayMatches(cron: CronFields, d: Date): boolean {
  const domOk = cron.daysOfMonth.has(d.getDate())
  const dowOk = cron.daysOfWeek.has(d.getDay())
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

function startOfNextMinute(d: Date): Date {
  const next = new Date(d.getTime())
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)
  return next
}

function stepMinute(d: Date): Date {
  const next = new Date(d.getTime())
  next.setMinutes(next.getMinutes() + 1)
  return next
}

function startOfNextHour(d: Date): Date {
  const next = new Date(d.getTime())
  next.setMinutes(0, 0, 0)
  next.setHours(next.getHours() + 1)
  return next
}

function startOfNextDay(d: Date): Date {
  const next = new Date(d.getTime())
  next.setHours(0, 0, 0, 0)
  next.setDate(next.getDate() + 1)
  return next
}

function startOfNextMonth(d: Date): Date {
  const next = new Date(d.getTime())
  next.setHours(0, 0, 0, 0)
  next.setDate(1)
  next.setMonth(next.getMonth() + 1)
  return next
}

/** Safety valve for an expression that can never match (e.g. day-of-month 31 in a month field restricted to February) — bounds the search instead of looping forever. */
const MAX_ITERATIONS = 100_000
const MAX_YEARS_AHEAD = 8

/** The next local time strictly after `from` that matches `cron`, or `null` if none exists within a reasonable horizon. */
export function nextRunAt(cron: CronFields, from: Date): Date | null {
  let candidate = startOfNextMinute(from)
  const limit = new Date(from.getTime())
  limit.setFullYear(limit.getFullYear() + MAX_YEARS_AHEAD)

  for (let i = 0; i < MAX_ITERATIONS && candidate <= limit; i++) {
    if (!cron.months.has(candidate.getMonth() + 1)) {
      candidate = startOfNextMonth(candidate)
      continue
    }
    if (!dayMatches(cron, candidate)) {
      candidate = startOfNextDay(candidate)
      continue
    }
    if (!cron.hours.has(candidate.getHours())) {
      candidate = startOfNextHour(candidate)
      continue
    }
    if (!cron.minutes.has(candidate.getMinutes())) {
      candidate = stepMinute(candidate)
      continue
    }
    return candidate
  }
  return null
}

/** Convenience: parses and computes in one call, for callers that don't need the parsed fields themselves. Throws on an invalid cron. */
export function computeNextRun(cronExpr: string, from: Date): Date | null {
  return nextRunAt(parseCron(cronExpr), from)
}
