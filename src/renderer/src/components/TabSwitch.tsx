import { useEffect, useRef } from 'react'
import { TabBar } from 'glisse'
import { useStore } from '../lib/store'
import type { Tab } from '../lib/store'
import { TAB_SHORTCUTS } from '../lib/shortcuts'

/** In the phone and iPad web app, the notes app is one more tab; it's its own page, so it opens there. */
const NOTES = 'notes'
const ON_DEVICE = window.deskmates.platform === 'other'

const TABS: { value: Tab | typeof NOTES; label: string }[] = [
  { value: 'duo', label: 'Duo' },
  { value: 'work', label: 'Work' },
  { value: 'design', label: 'Design' },
  { value: 'bots', label: 'Bots' },
  { value: 'agents', label: 'Agents' },
  { value: 'extras', label: 'Extras' },
  ...(ON_DEVICE ? [{ value: NOTES, label: 'Notes' } as const] : [])
]

const MOD = window.deskmates.platform === 'darwin' ? '⌘' : 'Ctrl+'

/**
 * The section tabs, on glass: the selection springs between them, follows a drag, and lifts into a
 * lens while held. Arrow keys, Home and End move between tabs.
 */
export function TabSwitch() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const barRef = useRef<HTMLDivElement>(null)

  // The bar draws its own buttons, so each one's id (`tab-work`…) and shortcut hint are set here.
  useEffect(() => {
    const buttons = barRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
    buttons.forEach((button, index) => {
      const item = TABS[index]
      if (!item) return
      button.id = `tab-${item.value}`
      button.title = item.value === NOTES ? item.label : `${item.label} (${MOD}${TAB_SHORTCUTS[item.value]})`
    })
  }, [])

  return (
    <div ref={barRef} className="section-tabs no-drag">
      <TabBar aria-label="Sections" items={TABS} value={tab} onValueChange={(value) => (value === NOTES ? location.assign('/notes') : setTab(value as Tab))} />
    </div>
  )
}
