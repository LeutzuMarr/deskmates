/**
 * How hard the pen is "pressing". Apple Pencil reports real pressure; the Logitech Crayon (and a
 * finger) don't, so for those it's made from how fast the pen moves (fast = lighter) and, for the
 * pencil, how far it's tilted (on its side = wider and softer, like a real pencil).
 */

export interface PenSample {
  /** Screen position, CSS pixels. */
  x: number
  y: number
  time: number
  pressure: number
  tiltX: number
  tiltY: number
  pointerType: string
}

/** The pen's angle from the screen in radians: π/2 standing straight up, toward 0 lying flat. */
export function altitude(sample: Pick<PenSample, 'tiltX' | 'tiltY'>): number {
  const tx = Math.tan((sample.tiltX * Math.PI) / 180)
  const ty = Math.tan((sample.tiltY * Math.PI) / 180)
  const lean = Math.sqrt(tx * tx + ty * ty)
  return lean === 0 ? Math.PI / 2 : Math.atan(1 / lean)
}

/** 0 when upright, 1 when lying almost flat. Pens without tilt report 0 tilt, so 0. */
export function tiltAmount(sample: Pick<PenSample, 'tiltX' | 'tiltY'>): number {
  const a = altitude(sample)
  return Math.min(1, Math.max(0, (Math.PI / 2 - a) / (Math.PI / 2 - 0.35)))
}

/** Applies the user's response curve: below 1 makes light strokes heavier, above 1 lighter. */
export function applyCurve(pressure: number, curve: number): number {
  const p = Math.min(1, Math.max(0, pressure))
  return Math.pow(p, curve)
}

export interface PressureOptions {
  /** Real pressure is used when the device reports it. */
  devicePressure: boolean
  /** How much speed thins the line (0 = none). */
  speedEffect: number
  curve: number
}

/** Works out pressure point by point for one stroke. */
export class PressureTracker {
  private last: PenSample | null = null
  private smoothed = 0.6
  private speed = 0
  /** Set once the pen reports pressures that change (a pressure-sensitive pen). */
  sawRealPressure = false
  private firstPressure: number | null = null

  constructor(private readonly options: PressureOptions) {}

  next(sample: PenSample): number {
    if (sample.pointerType === 'pen' && sample.pressure > 0) {
      if (this.firstPressure === null) this.firstPressure = sample.pressure
      else if (Math.abs(sample.pressure - this.firstPressure) > 0.03) this.sawRealPressure = true
    }
    let raw: number
    if ((this.options.devicePressure || this.sawRealPressure) && sample.pointerType === 'pen' && sample.pressure > 0) {
      raw = sample.pressure
    } else {
      if (this.last) {
        // Events can arrive a fraction of a millisecond apart (or batched with one time): a floor on
        // the time step keeps a tiny gap from reading as a huge speed, and the speed is smoothed.
        const dt = Math.max(6, sample.time - this.last.time)
        const instant = Math.hypot(sample.x - this.last.x, sample.y - this.last.y) / dt
        this.speed = this.speed * 0.7 + instant * 0.3
      }
      // ~0 px/ms is a slow, heavy line; ~3 px/ms and faster is light.
      raw = 0.9 - Math.min(1, this.speed / 3) * 0.5 * this.options.speedEffect
    }
    // Smooth it so the width flows instead of jittering; the first point starts from a middle
    // weight, so the line doesn't begin with a blob.
    this.smoothed = this.last ? this.smoothed * 0.7 + raw * 0.3 : 0.7 * 0.5 + raw * 0.5
    this.last = sample
    return applyCurve(this.smoothed, this.options.curve)
  }
}
