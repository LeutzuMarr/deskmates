/**
 * A small spring, for the bounce and stretch that make the bars feel liquid. Physically stepped,
 * so a gesture can grab it mid-flight and let go again without a jump.
 */

export interface SpringOptions {
  stiffness?: number
  damping?: number
  mass?: number
}

export class Spring {
  value: number
  velocity = 0
  target: number
  private readonly k: number
  private readonly c: number
  private readonly m: number

  constructor(initial: number, options: SpringOptions = {}) {
    this.value = initial
    this.target = initial
    this.k = options.stiffness ?? 320
    this.c = options.damping ?? 20
    this.m = options.mass ?? 1
  }

  /** Advances by dt seconds; returns true while still moving. */
  step(dt: number): boolean {
    // Small fixed sub-steps keep it stable on slow frames.
    let left = Math.min(dt, 0.064)
    while (left > 0) {
      const h = Math.min(left, 1 / 240)
      const force = -this.k * (this.value - this.target) - this.c * this.velocity
      this.velocity += (force / this.m) * h
      this.value += this.velocity * h
      left -= h
    }
    const resting = Math.abs(this.velocity) < 0.001 && Math.abs(this.value - this.target) < 0.0005
    if (resting) {
      this.value = this.target
      this.velocity = 0
    }
    return !resting
  }
}

/** Rubber-band: a drag of `distance` past a limit moves only part of it, less the further it goes. */
export function rubberBand(distance: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(distance)
  const d = Math.abs(distance)
  return sign * (1 - 1 / ((d * constant) / dimension + 1)) * dimension
}

export const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
