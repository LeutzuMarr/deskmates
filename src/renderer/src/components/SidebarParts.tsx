import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, Ellipsis, Settings } from 'lucide-react'
import { Glass } from 'glisse'
import { useStore } from '../lib/store'
import { toggleGroup, usePrefs } from '../lib/prefs'
import { useDismissableMenu } from '../lib/useMenu'
import { StatusMark } from './StatusMark'
import type { MarkKind } from './StatusMark'

/** The sidebar's glass panel on its own, for a sidebar that lays out its own contents. */
export function SidebarPanel({ children }: { children: ReactNode }) {
  return (
    <aside className="sidebar-aside">
      <Glass className="sidebar">{children}</Glass>
    </aside>
  )
}

/** The column every tab's sidebar shares: a scrolling list, and Settings pinned underneath. */
export function SidebarFrame({ children }: { children: ReactNode }) {
  const navigate = useStore((s) => s.navigate)
  const inSettings = useStore((s) => s.view.name === 'settings')
  return (
    <SidebarPanel>
      <div className="scroll-area flex min-h-0 flex-1 flex-col overflow-y-auto p-2">{children}</div>
      <div className="sidebar-nav sidebar-foot p-2">
        <button
          type="button"
          className={`sidebar-row ${inSettings ? 'sidebar-row-active' : ''}`}
          onClick={() => navigate({ name: 'settings' })}
        >
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
    </SidebarPanel>
  )
}

interface SidebarGroupProps {
  /** Stable id the folded state is remembered under, e.g. `work:<projectId>`. */
  id: string
  label: string
  /** Hover text, usually the folder. */
  title?: string
  /** Shown beside the name while the group is folded, so a busy project stays visible. */
  mark?: MarkKind
  /** Highlights the header: the group's own page is the one on screen. */
  active?: boolean
  /** Opens the group's own page. Without it, the name folds and unfolds the group like the arrow does. */
  onOpen?: () => void
  /** Buttons revealed on hover, at the end of the header (new task, options). */
  actions?: ReactNode
  children: ReactNode
}

/**
 * A named, foldable block of rows: one project and its tasks, one folder and its sessions. Every
 * group stays open at once, so work in one never hides work in another.
 */
export function SidebarGroup({ id, label, title, mark = 'idle', active = false, onOpen, actions, children }: SidebarGroupProps) {
  const { collapsedGroups } = usePrefs()
  const collapsed = collapsedGroups.includes(id)
  const bodyId = `group-${id}`
  return (
    <section className="sidebar-group">
      <div className={`sidebar-group-head group ${active ? 'sidebar-row-active' : ''}`}>
        <button
          type="button"
          className="sidebar-group-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`}
          onClick={() => toggleGroup(id)}
        >
          <ChevronRight size={13} strokeWidth={2} aria-hidden="true" className={`sidebar-group-caret ${collapsed ? '' : 'sidebar-group-caret-open'}`} />
        </button>
        <button
          type="button"
          className="sidebar-group-name"
          title={title ?? label}
          aria-current={active ? 'page' : undefined}
          onClick={onOpen ?? (() => toggleGroup(id))}
        >
          <span className="min-w-0 truncate">{label}</span>
        </button>
        {collapsed && <StatusMark kind={mark} quietIdle />}
        {actions && <div className="sidebar-group-actions">{actions}</div>}
      </div>
      <div id={bodyId} className={`sidebar-group-body ${collapsed ? 'sidebar-group-body-collapsed' : ''}`} inert={collapsed}>
        <div className="sidebar-group-rows">{children}</div>
      </div>
    </section>
  )
}

export interface RowMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

interface SidebarRowProps {
  label: string
  title?: string
  active: boolean
  mark: MarkKind
  /** Small grey text after the name (a tool, a pid). */
  detail?: string
  onOpen: () => void
  /** Double-clicking the name starts a rename when the row has one. */
  onRename?: (name: string) => void
  /** The current name to edit, when it differs from `label` (an untitled task shows a stand-in). */
  renameValue?: string
  menu?: RowMenuItem[]
}

/** One openable row: its name, a trailing status mark, and an options menu that appears on hover. */
export function SidebarRow({ label, title, active, mark, detail, onOpen, onRename, renameValue, menu = [] }: SidebarRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const menuRef = useDismissableMenu<HTMLDivElement>(menuOpen, () => setMenuOpen(false))
  const items: RowMenuItem[] = onRename ? [{ label: 'Rename', onSelect: () => setRenaming(true) }, ...menu] : menu

  if (renaming && onRename) {
    return (
      <RenameField
        label={`Rename ${label}`}
        initial={renameValue ?? label}
        onDone={(name) => {
          setRenaming(false)
          if (name !== null) onRename(name)
        }}
      />
    )
  }

  return (
    <div className="group relative">
      <div
        className={`sidebar-row sidebar-row-item ${active ? 'sidebar-row-active' : ''}`}
        onContextMenu={(event) => {
          if (items.length === 0) return
          event.preventDefault()
          setMenuOpen((open) => !open)
        }}
      >
        <button
          type="button"
          className="sidebar-row-main"
          onClick={onOpen}
          onDoubleClick={onRename ? () => setRenaming(true) : undefined}
          title={title ?? label}
          aria-current={active ? 'page' : undefined}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {detail && <span className="shrink-0 text-[12px] text-ink-faint">{detail}</span>}
        </button>
        <span className={`sidebar-row-mark ${items.length > 0 ? 'sidebar-row-mark-swaps' : ''} ${menuOpen ? 'sidebar-row-mark-hidden' : ''}`}>
          <StatusMark kind={mark} quietIdle />
        </span>
        {items.length > 0 && (
          <button
            type="button"
            className={`sidebar-row-more btn-icon ${menuOpen ? 'sidebar-row-more-open' : ''}`}
            aria-label={`More options for ${label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {menuOpen && (
        <div ref={menuRef} role="menu" aria-label={`${label} options`} className="menu" style={{ top: '100%', right: 4 }}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`menu-item ${item.danger ? 'text-brick' : ''}`}
              onClick={() => {
                setMenuOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** An inline name editor. Enter or leaving the field saves; Escape hands back null. */
function RenameField({ label, initial, onDone }: { label: string; initial: string; onDone: (name: string | null) => void }) {
  const [draft, setDraft] = useState(initial)
  // Escape removes the field, which also blurs it: without this the blur would save what Escape threw away.
  const settled = useRef(false)
  const finish = (name: string | null): void => {
    if (settled.current) return
    settled.current = true
    const trimmed = name?.trim() ?? ''
    onDone(trimmed && trimmed !== initial ? trimmed : null)
  }
  return (
    <div className="px-1 py-1">
      <input
        autoFocus
        aria-label={label}
        className="input"
        value={draft}
        maxLength={120}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') finish(draft)
          if (event.key === 'Escape') finish(null)
        }}
      />
    </div>
  )
}

export function SidebarEmpty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-1.5 text-[13px] text-ink-faint">{children}</p>
}
