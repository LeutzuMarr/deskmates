import { LayoutGrid, Settings } from 'lucide-react'
import { useStore } from '../lib/store'

export function ExtrasSidebar() {
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-sidebar">
      <div className="scroll-area flex flex-1 flex-col overflow-y-auto p-2">
        <div className="sidebar-nav">
          <button
            type="button"
            className={`sidebar-row ${view.name === 'extras-home' ? 'sidebar-row-active' : ''}`}
            onClick={() => navigate({ name: 'extras-home' })}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            <span>Overview</span>
          </button>
        </div>
        <div className="caption mt-4 px-3">Extras</div>
        <div className="sidebar-nav mt-1">
          <p className="px-3 py-2 text-[13px] text-ink-faint">
            Skills and plugins share this tab. Connectors arrive here too.
          </p>
        </div>
      </div>

      <div className="sidebar-nav border-t border-rule p-2">
        <button type="button" className="sidebar-row" onClick={() => navigate({ name: 'settings' })}>
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  )
}