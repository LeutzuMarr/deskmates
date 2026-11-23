/**
 * Calmer liquid glass for the phone/iPad web app. Glisse's springs are fixed in the library and quite
 * lively (a tap on a tool makes the bar jump); this build step slows every spring down and damps it
 * close to critical, so controls still flow like glass but settle without bouncing. The desktop app
 * keeps Glisse as it is.
 */
import type { Plugin } from 'vite'

const SPRING = /function createSpring\(value, stiffness, damping, paint\) \{\s*const s = \{\s*value,\s*target: value,\s*velocity: 0,\s*stiffness,\s*damping,/

/** Rewrites Glisse's spring constructor: slower (less stiff) and damped to ~90 % of critical at least. */
export function calmSprings(source: string): string {
  if (!SPRING.test(source)) throw new Error('calm-glisse: Glisse changed; check scripts/calm-glisse.ts')
  return source.replace(
    SPRING,
    'function createSpring(value, stiffness, damping, paint) {\n\tstiffness = stiffness * 0.45;\n\tdamping = Math.max(damping * 1.2, 1.8 * Math.sqrt(stiffness));\n\tconst s = {\n\t\tvalue,\n\t\ttarget: value,\n\t\tvelocity: 0,\n\t\tstiffness,\n\t\tdamping,'
  )
}

export function calmGlisse(): Plugin {
  return {
    name: 'deskmates-calm-glisse',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]glisse[\\/]dist[\\/]index\.js$/.test(id)) return null
      return { code: calmSprings(code), map: null }
    }
  }
}
