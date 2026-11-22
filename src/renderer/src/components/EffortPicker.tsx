import { useState } from 'react'
import { Check, ChevronDown, Gauge } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { useDismissableMenu } from '../lib/useMenu'
import { DEFAULT_EFFORT, EFFORT_HINTS, EFFORT_LABELS, EFFORT_LEVELS, isEffortLevel, type EffortLevel } from '../../../shared/effort'
import { THINKING_MODES, type ThinkingMode } from '../../../shared/protocol'

/**
 * The composer's effort chip, next to the model: how hard every agent thinks (the operating prompt's
 * effort levels). It is one setting for the whole app; the next message uses the new level.
 */
export function EffortPicker() {
  const stored = useStore((s) => s.settings?.effort)
  const showToast = useStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  // Opens upward like the model menu, or downward when the message box sits near the top.
  const [below, setBelow] = useState(false)
  const menuRef = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false))
  const current: EffortLevel = isEffortLevel(stored) ? stored : DEFAULT_EFFORT
  const storedThinking = useStore((s) => s.settings?.thinking)
  const thinking: ThinkingMode = storedThinking === 'on' || storedThinking === 'off' ? storedThinking : 'auto'
  const chooseThinking = async (mode: ThinkingMode): Promise<void> => {
    if (mode === thinking) return
    try {
      await core.call('settings.update', { thinking: mode })
    } catch (error) {
      showToast(`Couldn't change extended thinking: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const choose = async (effort: EffortLevel): Promise<void> => {
    setOpen(false)
    if (effort === current) return
    try {
      await core.call('settings.update', { effort })
    } catch (error) {
      showToast(`Couldn't change the effort: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        className="no-drag r-concentric flex items-center gap-1 border border-rule px-2.5 py-1 text-[12px] text-ink-muted hover:bg-oat hover:text-ink"
        style={concentricVars(8)}
        aria-label={`Effort: ${EFFORT_LABELS[current]}, extended thinking ${THINKING_LABELS[thinking].toLowerCase()}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Effort: ${EFFORT_LABELS[current]}. ${EFFORT_HINTS[current]}.`}
        onClick={(event) => {
          setBelow(event.currentTarget.getBoundingClientRect().top < 400)
          setOpen((v) => !v)
        }}
      >
        <Gauge size={12} aria-hidden="true" className="shrink-0" />
        <span>{EFFORT_LABELS[current]}</span>
        {thinking !== 'auto' && <span className="text-ink-faint">· {thinking === 'on' ? 'Thinking' : 'No thinking'}</span>}
        <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
      </button>
      {open && (
        <div className={`menu ${below ? 'top-full mt-2' : 'bottom-full mb-2'} left-0 z-50 w-[260px]`} role="dialog" aria-label="Choose the effort">
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-ink-faint">Effort, for every agent</div>
          <div role="listbox" aria-label="Effort levels">
            {EFFORT_LEVELS.map((level) => {
              const selected = level === current
              return (
                <button key={level} type="button" role="option" aria-selected={selected} className="menu-item" onClick={() => void choose(level)}>
                  <span className="flex w-[14px] shrink-0 justify-center">{selected && <Check size={13} aria-hidden="true" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-ink">{EFFORT_LABELS[level]}</span>
                    <span className="block truncate text-[12px] text-ink-faint">{EFFORT_HINTS[level]}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="mx-2.5 my-1.5 border-t border-rule" />
          <div className="px-2.5 pb-1 text-[12px] text-ink-faint">Extended thinking</div>
          <div className="flex gap-1 px-2 pb-2" role="radiogroup" aria-label="Extended thinking">
            {THINKING_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={thinking === mode}
                title={THINKING_HINTS[mode]}
                className={`flex-1 rounded-md border px-2 py-1 text-[12px] ${thinking === mode ? 'border-ink/40 bg-oat text-ink' : 'border-rule text-ink-muted hover:bg-oat'}`}
                onClick={() => void chooseThinking(mode)}
              >
                {THINKING_LABELS[mode]}
              </button>
            ))}
          </div>
          <div className="px-2.5 pb-1.5 text-[12px] text-ink-faint">{THINKING_HINTS[thinking]}</div>
        </div>
      )}
    </div>
  )
}

const THINKING_LABELS: Record<ThinkingMode, string> = { auto: 'Auto', on: 'On', off: 'Off' }
const THINKING_HINTS: Record<ThinkingMode, string> = {
  auto: 'The model decides when to think first',
  on: 'Thinks before every reply (slower, more careful)',
  off: 'Answers straight away'
}
