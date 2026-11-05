import { describe, expect, it } from 'vitest'
import { cronFor, describeWhen, validateWhen } from '../../src/shared/when'
import { lastOccurrenceBetween, nextOccurrence } from '../../src/core/schedules/when'

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)

describe('when', () => {
  it('weekdays skips saturday and sunday', () => {
    // Friday 6 Nov 2026, 08:00 → next weekday 07:30 is Monday 9 Nov.
    const next = nextOccurrence({ frequency: 'weekdays', time: '07:30' }, local(2026, 11, 6, 8, 0))
    expect(next).toEqual(local(2026, 11, 9, 7, 30))
  })

  it('daily at 07:30 from 08:00 is tomorrow, from 07:00 is today', () => {
    expect(nextOccurrence({ frequency: 'daily', time: '07:30' }, local(2026, 11, 5, 8, 0))).toEqual(local(2026, 11, 6, 7, 30))
    expect(nextOccurrence({ frequency: 'daily', time: '07:30' }, local(2026, 11, 5, 7, 0))).toEqual(local(2026, 11, 5, 7, 30))
  })

  it('once in the past is null, in the future is that moment', () => {
    expect(nextOccurrence({ frequency: 'once', time: '19:35', date: '2026-11-05' }, local(2026, 11, 5, 20, 0))).toBeNull()
    expect(nextOccurrence({ frequency: 'once', time: '19:35', date: '2026-11-05' }, local(2026, 11, 5, 19, 0))).toEqual(local(2026, 11, 5, 19, 35))
  })

  it('weekly and monthly', () => {
    // Thursday 5 Nov → next Tue/Sat 09:00 is Saturday 7 Nov.
    expect(nextOccurrence({ frequency: 'weekly', time: '09:00', days: [2, 6] }, local(2026, 11, 5, 10))).toEqual(local(2026, 11, 7, 9, 0))
    expect(nextOccurrence({ frequency: 'monthly', time: '09:00', dayOfMonth: 31 }, local(2026, 11, 5))).toEqual(local(2026, 12, 31, 9, 0))
  })

  it('validates and explains what is wrong', () => {
    expect(validateWhen({ frequency: 'daily', time: '7:30' })).toBeNull()
    expect(validateWhen({ frequency: 'daily', time: '25:00' })).toMatch(/HH:MM/)
    expect(validateWhen({ frequency: 'once', time: '10:00' })).toMatch(/date/)
    expect(validateWhen({ frequency: 'once', time: '10:00', date: '2026-02-30' })).toMatch(/not a real date/)
    expect(validateWhen({ frequency: 'weekly', time: '10:00', days: [] })).toMatch(/days/)
    expect(validateWhen({ frequency: 'monthly', time: '10:00' })).toMatch(/dayOfMonth/)
  })

  it('describes it in plain words and makes the cron', () => {
    expect(describeWhen({ frequency: 'weekdays', time: '07:30' })).toBe('Every weekday at 07:30')
    expect(describeWhen({ frequency: 'weekly', time: '09:00', days: [6, 2] })).toBe('Every Tuesday and Saturday at 09:00')
    expect(cronFor({ frequency: 'weekdays', time: '07:30' })).toBe('30 7 * * 1-5')
    expect(cronFor({ frequency: 'once', time: '07:30', date: '2026-11-06' })).toBeNull()
  })

  it('finds the last missed time while the PC was off', () => {
    const when = { frequency: 'daily', time: '07:30' } as const
    expect(lastOccurrenceBetween(when, local(2026, 11, 3, 8), local(2026, 11, 5, 11))).toEqual(local(2026, 11, 5, 7, 30))
    expect(lastOccurrenceBetween(when, local(2026, 11, 5, 8), local(2026, 11, 5, 11))).toBeNull()
  })
})
