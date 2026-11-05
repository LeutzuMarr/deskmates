/**
 * When something runs: the structured form agents and the user fill in ("every weekday at 07:30"),
 * shared by Deskmates' scheduled tasks and Duo. Code turns it into the schedule, so nobody parses
 * dates out of free text.
 */
export type Frequency = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly'

export interface When {
  frequency: Frequency
  /** Local time, 24-hour "HH:MM". */
  time: string
  /** For `once`: the local date, "YYYY-MM-DD". */
  date?: string
  /** For `weekly`: days of the week, 0 = Sunday … 6 = Saturday. */
  days?: number[]
  /** For `monthly`: the day of the month, 1–31 (months without it are skipped). */
  dayOfMonth?: number
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function parseTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** Why `when` isn't usable, or null when it is. */
export function validateWhen(when: When): string | null {
  if (!['once', 'daily', 'weekdays', 'weekly', 'monthly'].includes(when.frequency)) return 'frequency must be once, daily, weekdays, weekly or monthly.'
  if (!parseTime(when.time ?? '')) return 'time must be HH:MM in 24-hour time, like 07:30 or 19:35.'
  if (when.frequency === 'once') {
    if (!when.date || !/^\d{4}-\d{2}-\d{2}$/.test(when.date)) return 'a one-time schedule needs date as YYYY-MM-DD.'
    const [y, m, d] = when.date.split('-').map(Number)
    const check = new Date(y!, m! - 1, d!)
    if (check.getFullYear() !== y || check.getMonth() !== m! - 1 || check.getDate() !== d) return `${when.date} is not a real date.`
  }
  if (when.frequency === 'weekly') {
    if (!when.days || when.days.length === 0) return 'a weekly schedule needs days (0 = Sunday … 6 = Saturday).'
    if (when.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'days must be numbers from 0 (Sunday) to 6 (Saturday).'
  }
  if (when.frequency === 'monthly') {
    if (!Number.isInteger(when.dayOfMonth) || when.dayOfMonth! < 1 || when.dayOfMonth! > 31) return 'a monthly schedule needs dayOfMonth from 1 to 31.'
  }
  return null
}

/** "Every weekday at 07:30", "Once on 6 Nov 2026 at 19:35". */
export function describeWhen(when: When): string {
  const at = `at ${when.time}`
  switch (when.frequency) {
    case 'once': {
      const [y, m, d] = (when.date ?? '').split('-').map(Number)
      const date = y ? new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : when.date
      return `Once on ${date} ${at}`
    }
    case 'daily':
      return `Every day ${at}`
    case 'weekdays':
      return `Every weekday ${at}`
    case 'weekly': {
      const days = [...new Set(when.days ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d])
      return `Every ${days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}` : days[0]} ${at}`
    }
    case 'monthly':
      return `On day ${when.dayOfMonth} of every month ${at}`
  }
}

/** The five-field cron for a repeating `when`; null for `once`. */
export function cronFor(when: When): string | null {
  const t = parseTime(when.time)
  if (!t) return null
  const base = `${t.minute} ${t.hour}`
  switch (when.frequency) {
    case 'once':
      return null
    case 'daily':
      return `${base} * * *`
    case 'weekdays':
      return `${base} * * 1-5`
    case 'weekly':
      return `${base} * * ${[...new Set(when.days ?? [])].sort().join(',')}`
    case 'monthly':
      return `${base} ${when.dayOfMonth} * *`
  }
}
