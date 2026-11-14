import { describe, expect, it } from 'vitest'
import {
  compactBlockedReason,
  compactWorthwhile,
  contextMeter,
  formatElapsed,
  formatTokens
} from '../../src/renderer/src/lib/format'
import type { SessionContextUsage } from '../../src/shared/protocol'

const usage = (over: Partial<SessionContextUsage> = {}): SessionContextUsage => ({
  used: 20_000,
  limit: 200_000,
  summarized: false,
  ...over
})

describe('formatElapsed', () => {
  it('shows sub-second precision under 10 seconds', () => {
    expect(formatElapsed(0)).toBe('0.0 s')
    expect(formatElapsed(3_200)).toBe('3.2 s')
    expect(formatElapsed(9_900)).toBe('9.9 s')
  })

  it('switches to whole seconds from 10 seconds', () => {
    expect(formatElapsed(10_000)).toBe('10 s')
    expect(formatElapsed(59_499)).toBe('59 s')
  })

  it('formats minutes and seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
    expect(formatElapsed(59 * 60_000 + 40_000)).toBe('59m 40s')
  })

  it('formats hours and minutes', () => {
    expect(formatElapsed(60 * 60_000)).toBe('1h 00m')
    expect(formatElapsed(62 * 60_000 + 7_000)).toBe('1h 02m')
  })

  it('never returns a negative value', () => {
    expect(formatElapsed(-1)).toBe('0.0 s')
  })
})

describe('formatTokens', () => {
  it('keeps small counts exact and shortens the rest', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(847)).toBe('847')
    expect(formatTokens(18_412)).toBe('18.4k')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(1_240_000)).toBe('1.2M')
  })
})

describe('contextMeter', () => {
  it('reads as a percentage of the model limit', () => {
    expect(contextMeter(usage({ used: 50_000, limit: 200_000 }))).toEqual({ label: '50k of 200k', percent: 25 })
  })

  it('clamps a context that has gone past the limit, rather than reporting 140%', () => {
    expect(contextMeter(usage({ used: 280_000, limit: 200_000 }))?.percent).toBe(100)
  })

  it('draws nothing when there is no conversation', () => {
    expect(contextMeter(null)).toBeNull()
  })

  it('draws nothing rather than a false 0% when the model reports no limit', () => {
    // The one wrong answer this panel must never give: a nearly-full context shown as empty.
    expect(contextMeter(usage({ used: 190_000, limit: null }))).toBeNull()
  })
})

describe('compactWorthwhile', () => {
  it('leaves a barely-used context alone rather than spending a model call on it', () => {
    expect(compactWorthwhile(usage({ used: 1_000, limit: 200_000 }))).toBe(false)
    expect(compactWorthwhile(usage({ used: 20_000, limit: 200_000 }))).toBe(true)
  })

  it('never offers to compact a context it cannot measure', () => {
    expect(compactWorthwhile(null)).toBe(false)
    expect(compactWorthwhile(usage({ limit: null }))).toBe(false)
  })
})

describe('compactBlockedReason', () => {
  it('explains the button is disabled rather than leaving it mute', () => {
    expect(compactBlockedReason(null, false, false)).toMatch(/send a prompt first/i)
    expect(compactBlockedReason(usage(), false, true)).toMatch(/wait for the current reply/i)
    expect(compactBlockedReason(usage({ summarized: true }), false, false)).toMatch(/already compacted/i)
    expect(compactBlockedReason(usage({ used: 500 }), false, false)).toMatch(/nothing worth compacting/i)
  })

  it('says what it is doing while a compaction is in flight', () => {
    expect(compactBlockedReason(usage(), true, false)).toMatch(/compacting/i)
  })

  it('leaves the button enabled when there is real context to fold in', () => {
    expect(compactBlockedReason(usage(), false, false)).toBeNull()
  })
})