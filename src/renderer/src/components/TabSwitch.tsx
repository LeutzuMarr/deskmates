import type { KeyboardEvent } from 'react'
import { useStore } from '../lib/store'
import type { Tab } from '../lib/store'

const TABS: { id: Tab; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'design', label: 'Design' },
  { id: 'bots', label: 'Bots' },
  { id: 'agents', label: 'Agents' },
  { id: 'extras', label: 'Extras' }
]

export function TabSwitch() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = TABS.findIndex((t) => t.id === tab)
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length
    setTab(TABS[nextIndex].id)
  }

  return (
    <div role="tablist" aria-label="Sections" className="segmented no-drag" onKeyDown={onKeyDown}>
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={tab === t.id}
          tabIndex={tab === t.id ? 0 : -1}
          className="segmented-item"
          onClick={() => setTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
