import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../../src/renderer/src/lib/format'

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