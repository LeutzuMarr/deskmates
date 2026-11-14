import { useSyncExternalStore } from 'react'
import type { ThemeChoice } from '../../../shared/desktop-api'

/**
 * Per-window interface preferences: things that only change how this window looks, so they live in
 * the browser's storage rather than in the core's settings (a phone viewing the same app keeps its own).
 */
export interface UiPrefs {
  theme: ThemeChoice
  sidebarCollapsed: boolean
  /** Sidebar groups (a project, a folder of sessions) the user folded shut, by group id. */
  collapsedGroups: string[]
}

const KEY = 'deskmates:ui-prefs'
// On a phone-sized screen the sidebar starts closed; it opens as a drawer over the page.
const NARROW = typeof window !== 'undefined' && window.innerWidth < 700
const DEFAULTS: UiPrefs = { theme: 'system', sidebarCollapsed: NARROW, collapsedGroups: [] }

function read(): UiPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      collapsedGroups: Array.isArray(parsed.collapsedGroups)
        ? parsed.collapsedGroups.filter((id): id is string => typeof id === 'string')
        : []
    }
  } catch {
    return DEFAULTS
  }
}

let current = read()
const listeners = new Set<() => void>()

export function getPrefs(): UiPrefs {
  return current
}

export function setPrefs(patch: Partial<UiPrefs>): void {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Storage can be unavailable (private mode); the preference still holds for this session.
  }
  if (patch.theme !== undefined) applyTheme(current.theme)
  for (const listener of listeners) listener()
}

export function usePrefs(): UiPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getPrefs
  )
}

/** Folds or unfolds one sidebar group. */
export function toggleGroup(id: string): void {
  const collapsed = current.collapsedGroups
  setPrefs({ collapsedGroups: collapsed.includes(id) ? collapsed.filter((other) => other !== id) : [...collapsed, id] })
}

/** Hands the choice to Electron, which flips prefers-color-scheme for the page and recolours the frame. */
export function applyTheme(theme: ThemeChoice): void {
  void window.deskmates.appearance.setTheme?.(theme)?.catch(() => undefined)
}
