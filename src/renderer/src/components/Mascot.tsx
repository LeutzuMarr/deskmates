import { useEffect, useRef } from 'react'
import lottie from 'lottie-web/build/player/lottie_light'
import type { AnimationItem } from 'lottie-web'
import { useStore } from '../lib/store'
import { registerAnimationFonts } from '../lib/appearance'
import type { AnimationChoice } from '../../../shared/protocol'

interface BrandMarkProps {
  size?: number
  working?: boolean
}

export function Mascot({ size = 48, working = false }: BrandMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g className={working ? 'mascot-straw' : undefined}>
        <line x1="38" y1="26" x2="48" y2="8" stroke="#87867f" strokeWidth="3" strokeLinecap="round" />
      </g>
      <rect x="14" y="22" width="36" height="36" rx="10" fill="var(--clay)" />
      <rect x="14" y="44" width="36" height="5" fill="#f5e3c7" />
      <ellipse cx="26" cy="35" rx="2.4" ry="3" fill="#141413" />
      <ellipse cx="38" cy="35" rx="2.4" ry="3" fill="#141413" />
      <path
        d="M 27 43 Q 32 47 37 43"
        stroke="#141413"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      {working && (
        <g className="mascot-steam">
          <circle cx="33" cy="8" r="2" fill="var(--ink-faint)" />
          <circle cx="40" cy="12" r="2.2" fill="var(--ink-faint)" />
          <circle cx="47" cy="8" r="1.8" fill="var(--ink-faint)" />
        </g>
      )}
    </svg>
  )
}

export function BrandMark({ size = 48, working }: BrandMarkProps) {
  const appearance = useStore((s) => s.settings?.appearance)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const active = working ?? anyTaskRunning(tasksByProject)

  if (appearance?.logo) {
    return (
      <img
        src={appearance.logo}
        alt=""
        width={size}
        height={size}
        className={active ? 'brandmark-img brandmark-working' : 'brandmark-img'}
        style={{ width: size, height: size }}
      />
    )
  }

  const animation = active ? (appearance?.workingAnimation ?? appearance?.idleAnimation) : appearance?.idleAnimation
  if (animation) return <LottieMark animation={animation} size={size} />

  return <Mascot size={size} working={active} />
}

function LottieMark({ animation, size }: { animation: AnimationChoice; size: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { json, fonts } = animation
  const fontKey = fonts.map((font) => font.name).join('\u0000')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let anim: AnimationItem | null = null
    let disposed = false
    void (async () => {
      await registerAnimationFonts(fonts)
      if (disposed || !container.isConnected) return
      try {
        anim = lottie.loadAnimation({
          container,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: JSON.parse(json)
        })
      } catch {
        // A broken animation renders as an empty spot rather than crashing.
      }
    })()
    return () => {
      disposed = true
      anim?.destroy()
      anim = null
    }
  }, [json, fontKey])

  return <div ref={containerRef} className="brandmark-lottie" style={{ width: size, height: size }} />
}

function anyTaskRunning(tasksByProject: Record<string, { status: string }[]>): boolean {
  return Object.values(tasksByProject).some((tasks) => tasks.some((task) => task.status === 'running'))
}