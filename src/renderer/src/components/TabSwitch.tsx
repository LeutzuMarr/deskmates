import { useLayoutEffect, useRef, useState } from 'react'
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
  const listRef = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)

  // The selected tab's background is one shared pill that slides between tabs.
  useLayoutEffect(() => {
    const measure = (): void => {
      const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    void document.fonts?.ready.then(measure)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [tab])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = TABS.findIndex((t) => t.id === tab)
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length
    setTab(TABS[nextIndex].id)
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Sections"
      className={`segmented no-drag ${pill ? 'segmented-sliding' : ''}`}
      onKeyDown={onKeyDown}
    >
      {pill && (
        <span
          aria-hidden="true"
          className="segmented-indicator"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)` }}
        />
      )}
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={tab === t.id}
          tabIndex={tab === t.id ? 0 : -1}
          className="segmented-item"
          title={`${t.label} (${window.deskmates.platform === 'darwin' ? '⌘' : 'Ctrl+'}${TABS.indexOf(t) + 1})`}
          onClick={() => setTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
