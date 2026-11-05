import { useEffect } from 'react'
import { useStore } from './store'
import type { Tab } from './store'
import { getPrefs, setPrefs } from './prefs'

/** Asks whichever composer is on screen to take the keyboard focus. */
export const FOCUS_COMPOSER_EVENT = 'deskmates:focus-composer'

export function focusComposer(): void {
  // After React has rendered the view the caller just navigated to.
  requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT)))
}

/**
 * Opens an empty composer, the way a chat app's "New chat" does: the task itself is only created
 * once there's something to send, so abandoned clicks don't leave "Untitled task" rows behind.
 * Inside a project it stays in that project; anywhere else it goes to Home, whose composer picks one.
 */
export function startNewTask(): void {
  const store = useStore.getState()
  if (store.tab !== 'work') store.setTab('work')
  const view = useStore.getState().view
  const projectId =
    view.name === 'project' || view.name === 'task' || view.name === 'project-settings' ? view.projectId : null
  store.navigate(projectId ? { name: 'project', projectId } : { name: 'home' })
  focusComposer()
}

const TAB_KEYS: Record<string, Tab> = { '1': 'work', '2': 'design', '3': 'bots', '4': 'agents', '5': 'extras', '0': 'duo' }

/** App-wide keyboard shortcuts. Ctrl on Windows and Linux, Cmd on macOS. */
export function useGlobalShortcuts(openPalette: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = window.deskmates.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (!mod || event.altKey || event.isComposing) return
      const key = event.key.toLowerCase()
      const store = useStore.getState()
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault()
        openPalette()
      } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        if (store.tab === 'design') store.navigate({ name: 'design-home' })
        else startNewTask()
      } else if (key === 'b' && !event.shiftKey) {
        event.preventDefault()
        setPrefs({ sidebarCollapsed: !getPrefs().sidebarCollapsed })
      } else if (key === ',') {
        event.preventDefault()
        store.navigate({ name: 'settings' })
      } else if (TAB_KEYS[key] && !event.shiftKey) {
        event.preventDefault()
        store.setTab(TAB_KEYS[key])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openPalette])
}
