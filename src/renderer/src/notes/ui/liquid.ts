/**
 * Makes a bar feel liquid under a finger: pressed, it swells a little; dragged, it stretches toward
 * the finger with resistance and squeezes the other way; let go, it springs back with a small
 * wobble. Only `transform` changes, so it never slows the page or the pen down. Buttons inside the
 * bar keep working as usual: this only listens.
 */
import { useEffect, type RefObject } from 'react'
import { Spring, prefersReducedMotion, rubberBand } from './spring'

export interface LiquidOptions {
  /** How far (CSS px) the bar can be pulled at most. */
  reach?: number
  /** Swell on press. */
  press?: number
  /** Which way it stretches. */
  axis?: 'x' | 'y' | 'both'
}

export function useLiquid(ref: RefObject<HTMLElement | null>, options: LiquidOptions = {}): void {
  const { reach = 26, press = 0.035, axis = 'both' } = options
  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion()) return
    const swell = new Spring(1, { stiffness: 520, damping: 22 })
    const pullX = new Spring(0, { stiffness: 300, damping: 14 })
    const pullY = new Spring(0, { stiffness: 300, damping: 14 })
    let frame = 0
    let last = 0
    let pointer: number | null = null
    let start: [number, number] = [0, 0]

    const apply = (): void => {
      const w = el.offsetWidth || 1
      const h = el.offsetHeight || 1
      const sx = swell.value * (1 + Math.abs(pullX.value) / w - Math.abs(pullY.value) / h / 3)
      const sy = swell.value * (1 + Math.abs(pullY.value) / h - Math.abs(pullX.value) / w / 3)
      el.style.transform = `translate3d(${pullX.value / 2}px, ${pullY.value / 2}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
    }

    const tick = (now: number): void => {
      const dt = last ? (now - last) / 1000 : 1 / 60
      last = now
      const moving = [swell.step(dt), pullX.step(dt), pullY.step(dt)].some(Boolean)
      apply()
      frame = moving || pointer !== null ? requestAnimationFrame(tick) : 0
      if (!frame) last = 0
    }
    const run = (): void => {
      if (!frame) frame = requestAnimationFrame(tick)
    }

    const down = (e: PointerEvent): void => {
      if (pointer !== null || e.button > 0) return
      pointer = e.pointerId
      start = [e.clientX, e.clientY]
      swell.target = 1 + press
      run()
    }
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return
      const dx = e.clientX - start[0]
      const dy = e.clientY - start[1]
      if (axis !== 'y') pullX.target = rubberBand(dx, reach)
      if (axis !== 'x') pullY.target = rubberBand(dy, reach)
      run()
    }
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return
      pointer = null
      swell.target = 1
      pullX.target = 0
      pullY.target = 0
      run()
    }
    el.addEventListener('pointerdown', down, { passive: true })
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up, { passive: true })
    window.addEventListener('pointercancel', up, { passive: true })
    el.style.willChange = 'transform'
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      el.style.transform = ''
      el.style.willChange = ''
    }
  }, [ref, reach, press, axis])
}
