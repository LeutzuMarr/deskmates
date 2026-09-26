/** Wrong codes one device may enter before it is blocked. */
export const MAX_TRIES_PER_DEVICE = 5
/** Wrong codes from all devices together before every new sign-in is paused (stops guessing from many addresses). */
export const MAX_TRIES_TOTAL = 20
/** How long a block lasts, and how far back wrong codes are counted. */
export const LOCK_MS = 15 * 60_000

export type GuardVerdict = { allowed: true } | { allowed: false; retryAfterMs: number }

/** What a wrong code just caused, so the caller can warn the user on the computer once. */
export type FailOutcome =
  | { locked: false; triesLeft: number }
  | { locked: true; scope: 'device' | 'all'; retryAfterMs: number }

/**
 * Brute-force protection for the phone pairing code: six digits are only a million guesses, so wrong
 * codes are counted per device (remote address) and in total over a sliding window, and a device —
 * or, past the total limit, every new sign-in — is refused until the window passes. A fresh code
 * restarts the phone server and with it this guard, which is how the user reopens the door early.
 */
export class SignInGuard {
  private readonly failures = new Map<string, number[]>()
  private readonly lockedUntil = new Map<string, number>()
  private allLockedUntil = 0

  constructor(private readonly now: () => number = Date.now) {}

  check(device: string): GuardVerdict {
    const at = this.now()
    const until = Math.max(this.allLockedUntil, this.lockedUntil.get(device) ?? 0)
    return until > at ? { allowed: false, retryAfterMs: until - at } : { allowed: true }
  }

  fail(device: string): FailOutcome {
    const at = this.now()
    const recent = (this.failures.get(device) ?? []).filter((t) => at - t < LOCK_MS)
    recent.push(at)
    this.failures.set(device, recent)

    let total = 0
    for (const [key, times] of this.failures) {
      const kept = times.filter((t) => at - t < LOCK_MS)
      if (kept.length === 0) this.failures.delete(key)
      else this.failures.set(key, kept)
      total += kept.length
    }

    if (total >= MAX_TRIES_TOTAL && this.allLockedUntil <= at) {
      this.allLockedUntil = at + LOCK_MS
      return { locked: true, scope: 'all', retryAfterMs: LOCK_MS }
    }
    if (recent.length >= MAX_TRIES_PER_DEVICE) {
      this.lockedUntil.set(device, at + LOCK_MS)
      this.failures.delete(device)
      return { locked: true, scope: 'device', retryAfterMs: LOCK_MS }
    }
    return { locked: false, triesLeft: MAX_TRIES_PER_DEVICE - recent.length }
  }

  succeed(device: string): void {
    this.failures.delete(device)
  }
}
