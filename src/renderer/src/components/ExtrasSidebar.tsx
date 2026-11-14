import { LayoutGrid } from 'lucide-react'
import { useStore } from '../lib/store'
import { SidebarEmpty, SidebarFrame } from './SidebarParts'

export function ExtrasSidebar() {
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)

  return (
    <SidebarFrame>
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
      <SidebarEmpty>Skills, plugins and connectors share this tab.</SidebarEmpty>
    </SidebarFrame>
  )
}
