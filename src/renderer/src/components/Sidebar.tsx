import { useState } from 'react'
import { Ellipsis, FolderPlus, Plus, Settings } from 'lucide-react'
import { useStore } from '../lib/store'
import { core } from '../lib/rpc'
import { useDismissableMenu } from '../lib/useMenu'
import { startNewTask } from '../lib/shortcuts'
import { AddProjectDialog } from '../views/AddProjectDialog'
import { TaskStatusMark } from './TaskStatusMark'
import type { Task } from '../../../shared/protocol'

export function Sidebar() {
  const allProjects = useStore((s) => s.projects)
  const projects = allProjects.filter((p) => p.kind === 'work')
  const tasksByProject = useStore((s) => s.tasksByProject)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)
  const [addOpen, setAddOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const selectedProjectId =
    view.name === 'project' || view.name === 'task' || view.name === 'project-settings' ? view.projectId : null
  const selectedTaskId = view.name === 'task' ? view.taskId : null

  const goSettings = (): void => navigate({ name: 'settings' })

  const toggleProject = (projectId: string): void => {
    if (view.name === 'project' && view.projectId === projectId) navigate({ name: 'home' })
    else navigate({ name: 'project', projectId })
  }

  const openTask = (projectId: string, taskId: string): void => {
    if (selectedTaskId !== taskId) navigate({ name: 'task', projectId, taskId })
  }

  const rename = async (task: Task, title: string): Promise<void> => {
    setRenamingId(null)
    const trimmed = title.trim()
    if (!trimmed || trimmed === task.title) return
    try {
      await core.call('tasks.rename', { id: task.id, title: trimmed })
    } catch (error) {
      showToast(`Couldn't rename the task: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const remove = async (task: Task, projectId: string): Promise<void> => {
    setMenuFor(null)
    const name = task.title.trim() || 'Untitled task'
    if (!window.confirm(`Delete "${name}"? Its conversation is removed. Files it changed stay as they are.`)) return
    try {
      if (selectedTaskId === task.id) navigate({ name: 'project', projectId })
      await core.call('tasks.delete', { id: task.id })
    } catch (error) {
      showToast(`Couldn't delete the task: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-sidebar">
      <div className="flex flex-1 flex-col overflow-y-auto scroll-area p-2">
        <div className="sidebar-nav">
          <button type="button" className="sidebar-row" onClick={startNewTask} title="New task (Ctrl+N)">
            <Plus size={16} aria-hidden="true" />
            <span>New task</span>
          </button>
        </div>

        <div className="caption mt-4 px-3">Projects</div>
        <div className="sidebar-nav mt-1">
          {projects.map((project) => {
            const isSelected = selectedProjectId === project.id
            const tasks = tasksByProject[project.id] ?? []
            const running = tasks.some((t) => t.status === 'running' || t.status === 'waiting-approval')
            return (
              <div key={project.id}>
                <button
                  type="button"
                  className={`sidebar-row ${isSelected && !selectedTaskId ? 'sidebar-row-active' : ''}`}
                  onClick={() => toggleProject(project.id)}
                  title={project.folder}
                  aria-expanded={isSelected}
                >
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {!isSelected && running && <span className="mark-dot pulse-txt" style={{ background: 'var(--clay)' }} aria-label="Working" />}
                  {isSelected && tasks.length > 0 && (
                    <span className="text-[12px] text-ink-faint">{tasks.length}</span>
                  )}
                </button>
                {isSelected && (
                  <div className="ml-3 border-l border-rule pl-2">
                    {tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        active={selectedTaskId === task.id}
                        renaming={renamingId === task.id}
                        menuOpen={menuFor === task.id}
                        onOpen={() => openTask(project.id, task.id)}
                        onToggleMenu={() => setMenuFor((current) => (current === task.id ? null : task.id))}
                        onCloseMenu={() => setMenuFor(null)}
                        onStartRename={() => {
                          setMenuFor(null)
                          setRenamingId(task.id)
                        }}
                        onCommitRename={(title) => void rename(task, title)}
                        onDelete={() => void remove(task, project.id)}
                      />
                    ))}
                    {tasks.length === 0 && <p className="px-3 py-1.5 text-[13px] text-ink-faint">No tasks yet.</p>}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="sidebar-nav mt-1">
          <button type="button" className="sidebar-row" onClick={() => setAddOpen(true)}>
            <FolderPlus size={16} aria-hidden="true" />
            <span>Add project</span>
          </button>
        </div>
      </div>

      <div className="sidebar-nav border-t border-rule p-2">
        <button type="button" className="sidebar-row" onClick={goSettings}>
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>

      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </aside>
  )
}

interface TaskRowProps {
  task: Task
  active: boolean
  renaming: boolean
  menuOpen: boolean
  onOpen: () => void
  onToggleMenu: () => void
  onCloseMenu: () => void
  onStartRename: () => void
  onCommitRename: (title: string) => void
  onDelete: () => void
}

function TaskRow({
  task,
  active,
  renaming,
  menuOpen,
  onOpen,
  onToggleMenu,
  onCloseMenu,
  onStartRename,
  onCommitRename,
  onDelete
}: TaskRowProps) {
  const [draft, setDraft] = useState(task.title)
  const menuRef = useDismissableMenu<HTMLDivElement>(menuOpen, onCloseMenu)
  const name = task.title.trim() || 'Untitled task'

  if (renaming) {
    return (
      <div className="px-1 py-1">
        <label className="sr-only" htmlFor={`task-rename-${task.id}`}>
          Task title
        </label>
        <input
          id={`task-rename-${task.id}`}
          autoFocus
          className="input"
          defaultValue={task.title}
          maxLength={120}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommitRename(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommitRename(draft)
            if (event.key === 'Escape') onCommitRename(task.title)
          }}
        />
      </div>
    )
  }

  return (
    <div className="group relative">
      <div
        className={`sidebar-row gap-2.5 py-1.5 pr-1.5 ${active ? 'sidebar-row-active' : ''}`}
        onContextMenu={(event) => {
          event.preventDefault()
          onToggleMenu()
        }}
      >
        <button
          type="button"
          className="sidebar-row-main"
          onClick={onOpen}
          onDoubleClick={onStartRename}
          title={name}
          aria-current={active ? 'page' : undefined}
        >
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <TaskStatusMark status={task.status} />
        </button>
        <button
          type="button"
          className={`btn-icon shrink-0 ${menuOpen || active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
          aria-label={`More options for ${name}`}
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      </div>
      {menuOpen && (
        <div ref={menuRef} role="menu" aria-label={`${name} options`} className="menu" style={{ top: '100%', right: 4 }}>
          <button type="button" role="menuitem" className="menu-item" onClick={onStartRename}>
            Rename
          </button>
          <button type="button" role="menuitem" className="menu-item text-brick" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
