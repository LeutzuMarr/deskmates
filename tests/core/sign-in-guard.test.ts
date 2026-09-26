import { describe, expect, it } from 'vitest'
import { LOCK_MS, MAX_TRIES_PER_DEVICE, MAX_TRIES_TOTAL, SignInGuard } from '../../src/core/server/sign-in-guard'

function clock() {
  let now = 1_000_000
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('SignInGuard', () => {
  it('blocks one device after five wrong codes, leaving other devices alone', () => {
    const time = clock()
    const guard = new SignInGuard(time.now)
    for (let i = 1; i < MAX_TRIES_PER_DEVICE; i++) {
      expect(guard.fail('10.0.0.5')).toEqual({ locked: false, triesLeft: MAX_TRIES_PER_DEVICE - i })
    }
    expect(guard.fail('10.0.0.5')).toEqual({ locked: true, scope: 'device', retryAfterMs: LOCK_MS })
    expect(guard.check('10.0.0.5')).toEqual({ allowed: false, retryAfterMs: LOCK_MS })
    expect(guard.check('10.0.0.6')).toEqual({ allowed: true })

    time.advance(LOCK_MS)
    expect(guard.check('10.0.0.5')).toEqual({ allowed: true })
  })

  it('pauses every sign-in once wrong codes from all devices reach the total limit', () => {
    const guard = new SignInGuard(clock().now)
    let outcome
    for (let i = 0; i < MAX_TRIES_TOTAL; i++) outcome = guard.fail(`10.0.1.${i}`)
    expect(outcome).toEqual({ locked: true, scope: 'all', retryAfterMs: LOCK_MS })
    expect(guard.check('10.0.9.9').allowed).toBe(false)
  })

  it('forgets old wrong codes and resets a device on a right code', () => {
    const time = clock()
    const guard = new SignInGuard(time.now)
    for (let i = 0; i < MAX_TRIES_PER_DEVICE - 1; i++) guard.fail('a')
    time.advance(LOCK_MS)
    expect(guard.fail('a')).toEqual({ locked: false, triesLeft: MAX_TRIES_PER_DEVICE - 1 })
    guard.succeed('a')
    expect(guard.fail('a')).toEqual({ locked: false, triesLeft: MAX_TRIES_PER_DEVICE - 1 })
  })
})
