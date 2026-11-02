import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Copy, Minus, PanelLeft, Search, Square, X } from 'lucide-react'
import { BrandMark } from './Mascot'
import { TabSwitch } from './TabSwitch'
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs'

const api = window.deskmates

/** Windows draws these itself via `titleBarOverlay`; everywhere else the app supplies them. A phone
 *  browser viewing the app has no window to control, and its stand-in API has no `window` at all. */
const NEEDS_WINDOW_CONTROLS = api.platform !== 'win32' && api.window !== undefined

/**
 * Minimize / maximize / close, drawn in the header on the OSes whose frame can't. `-webkit-app-region:
 * no-drag` on the container keeps the header's drag region from swallowing the clicks, and `no-drag`
 * on each button keeps them individually clickable.
 */
function WindowControls(): ReactNode {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => api.window.onMaximizeChange(setMaximized), [])

  const button =
    'flex h-full w-11 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-ink/8 hover:text-ink'

  return (
    <div className="no-drag -mr-3 flex h-full shrink-0 self-stretch">
      <button type="button" className={button} title="Minimize" aria-label="Minimize" onClick={() => api.window.minimize()}>
        <Minus size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className={button}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => api.window.toggleMaximize()}
      >
        {maximized ? <Copy size={13} strokeWidth={1.75} /> : <Square size={13} strokeWidth={1.75} />}
      </button>
      <button
        type="button"
        className={`${button} hover:bg-brick hover:text-card`}
        title="Close"
        aria-label="Close"
        onClick={() => api.window.close()}
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  )
}

const MOD = api.platform === 'darwin' ? '⌘' : 'Ctrl+'

export function TitleBar({ onSearch }: { onSearch: () => void }) {
  const style = { WebkitAppRegion: 'drag' } as CSSProperties
  const { sidebarCollapsed } = usePrefs()
  return (
    <header className="drag-region flex h-10 shrink-0 items-center gap-3 px-3" style={style}>
      <button
        type="button"
        className="btn-icon no-drag -ml-1"
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-expanded={!sidebarCollapsed}
        title={`${sidebarCollapsed ? 'Show' : 'Hide'} sidebar (${MOD}B)`}
        onClick={() => setPrefs({ sidebarCollapsed: !getPrefs().sidebarCollapsed })}
      >
        <PanelLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <BrandMark size={16} />
      <span className="text-[13px] font-semibold tracking-tight text-ink">Deskmates</span>
      <TabSwitch />
      <button
        type="button"
        className="titlebar-search no-drag"
        aria-label="Search and commands"
        title={`Search and commands (${MOD}K)`}
        onClick={onSearch}
      >
        <Search size={13} aria-hidden="true" />
        <span className="hidden md:inline">Search</span>
        <kbd className="kbd hidden md:inline">{MOD}K</kbd>
      </button>
      {/* Room for Windows' own overlay buttons, which sit on top of this header. */}
      {NEEDS_WINDOW_CONTROLS ? (
        <div className="ml-auto flex h-full items-center">
          <WindowControls />
        </div>
      ) : api.platform === 'win32' ? (
        <div className="no-drag ml-auto h-full w-[140px] shrink-0" />
      ) : null}
    </header>
  )
}
