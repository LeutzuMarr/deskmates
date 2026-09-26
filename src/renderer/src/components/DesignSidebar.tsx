import { useState } from 'react'
import { Ellipsis, Plus, Settings } from 'lucide-react'
import { useStore } from '../lib/store'
import { core } from '../lib/rpc'
import { TaskStatusMark } from './TaskStatusMark'
import { designsByActivity, latestTask } from '../lib/design'
import { useDismissableMenu } from '../lib/useMenu'
import type { Project, TaskStatus } from '../../../shared/protocol'

export function DesignSidebar() {
  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const designs = designsByActivity(projects, tasksByProject)
  const selectedProjectId = view.name === 'design' ? view.projectId : null

  const rename = async (project: Project, name: string): Promise<void> => {
    setRenamingId(null)
    const trimmed = name.trim()
    if (!trimmed || trimmed === project.name) return
    try {
      await core.call('projects.update', { id: project.id, name: trimmed })
    } catch (error) {
      showToast(`Couldn't rename the design: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const remove = async (project: Project): Promise<void> => {
    setMenuFor(null)
    if (!window.confirm(`Delete "${project.name}"? This removes the design and its files.`)) return
    try {
      await core.call('projects.delete', { id: project.id })
      if (selectedProjectId === project.id) navigate({ name: 'design-home' })
    } catch (error) {
      showToast(`Couldn't delete the design: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-sidebar">
      <div className="scroll-area flex flex-1 flex-col overflow-y-auto p-2">
        <div className="sidebar-nav">
          <button type="button" className="sidebar-row" onClick={() => navigate({ name: 'design-home' })}>
            <Plus size={16} aria-hidden="true" />
            <span>New design</span>
          </button>
        </div>

        <div className="caption mt-4 px-3">Designs</div>
        <div className="sidebar-nav mt-1">
          {designs.map((project) => (
            <DesignRow
              key={project.id}
              project={project}
              active={selectedProjectId === project.id}
              status={latestTask(tasksByProject[project.id] ?? [])?.status}
              renaming={renamingId === project.id}
              menuOpen={menuFor === project.id}
              onOpen={() => navigate({ name: 'design', projectId: project.id })}
              onStartRename={() => {
                setMenuFor(null)
                setRenamingId(project.id)
              }}
              onCommitRename={(name) => void rename(project, name)}
              onToggleMenu={() => setMenuFor((current) => (current === project.id ? null : project.id))}
              onCloseMenu={() => setMenuFor(null)}
              onDelete={() => void remove(project)}
            />
          ))}
          {designs.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-faint">No designs yet.</p>}
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

interface DesignRowProps {
  project: Project
  active: boolean
  status: TaskStatus | undefined
  renaming: boolean
  menuOpen: boolean
  onOpen: () => void
  onStartRename: () => void
  onCommitRename: (name: string) => void
  onToggleMenu: () => void
  onCloseMenu: () => void
  onDelete: () => void
}

function DesignRow({
  project,
  active,
  status,
  renaming,
  menuOpen,
  onOpen,
  onStartRename,
  onCommitRename,
  onToggleMenu,
  onCloseMenu,
  onDelete
}: DesignRowProps) {
  const [draft, setDraft] = useState(project.name)
  const menuRef = useDismissableMenu<HTMLDivElement>(menuOpen, onCloseMenu)

  if (renaming) {
    return (
      <div className="px-3 py-1.5">
        <label className="sr-only" htmlFor={`design-rename-${project.id}`}>
          Design name
        </label>
        <input
          id={`design-rename-${project.id}`}
          autoFocus
          className="input"
          defaultValue={project.name}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommitRename(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommitRename(draft)
            if (event.key === 'Escape') onCommitRename(project.name)
          }}
        />
      </div>
    )
  }

  return (
    <div className="relative">
      <div
        className={`sidebar-row ${active ? 'sidebar-row-active' : ''}`}
        onContextMenu={(event) => {
          event.preventDefault()
          onToggleMenu()
        }}
      >
        <button type="button" className="sidebar-row-main" onClick={onOpen} title={project.name}>
          {status && <TaskStatusMark status={status} />}
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
        </button>
        <button
          type="button"
          className="btn-icon shrink-0"
          aria-label={`More options for ${project.name}`}
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      </div>
      {menuOpen && (
        <div ref={menuRef} role="menu" aria-label={`${project.name} options`} className="menu" style={{ top: '100%', right: 8 }}>
          <button type="button" role="menuitem" className="menu-item" onClick={onStartRename}>
            Rename
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
