import { useState } from 'react'
import { FolderPlus, Plus, Settings } from 'lucide-react'
import { useStore } from '../lib/store'
import { AddProjectDialog } from '../views/AddProjectDialog'
import { TaskStatusMark } from './TaskStatusMark'

export function Sidebar() {
  const allProjects = useStore((s) => s.projects)
  const projects = allProjects.filter((p) => p.kind === 'work')
  const tasksByProject = useStore((s) => s.tasksByProject)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const createTask = useStore((s) => s.createTask)
  const [addOpen, setAddOpen] = useState(false)

  const selectedProjectId =
    view.name === 'project' || view.name === 'task' || view.name === 'project-settings' ? view.projectId : null

  const goHome = (): void => navigate({ name: 'home' })
  const goSettings = (): void => navigate({ name: 'settings' })

  const newTask = async (): Promise<void> => {
    const projectId = selectedProjectId ?? projects[0]?.id
    if (!projectId) {
      goHome()
      return
    }
    const task = await createTask(projectId)
    if (task) navigate({ name: 'task', projectId, taskId: task.id })
  }

  const toggleProject = (projectId: string): void => {
    if (view.name === 'project' && view.projectId === projectId) goHome()
    else navigate({ name: 'project', projectId })
  }

  const toggleTask = (projectId: string, taskId: string): void => {
    if (view.name === 'task' && view.taskId === taskId) navigate({ name: 'project', projectId })
    else navigate({ name: 'task', projectId, taskId })
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-sidebar">
      <div className="flex flex-1 flex-col overflow-y-auto scroll-area p-2">
        <div className="sidebar-nav">
          <button type="button" className="sidebar-row" onClick={() => void newTask()}>
            <Plus size={16} aria-hidden="true" />
            <span>New task</span>
          </button>
        </div>

        <div className="caption mt-4 px-3">Projects</div>
        <div className="sidebar-nav mt-1">
          {projects.map((project) => {
            const isSelected = selectedProjectId === project.id
            const tasks = tasksByProject[project.id] ?? []
            return (
              <div key={project.id}>
                <button
                  type="button"
                  className={`sidebar-row ${isSelected ? 'sidebar-row-active' : ''}`}
                  onClick={() => toggleProject(project.id)}
                  title={project.folder}
                >
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {isSelected && tasks.length > 0 && (
                    <span className="text-[12px] text-ink-faint">{tasks.length}</span>
                  )}
                </button>
                {isSelected && (
                  <div className="ml-3 border-l border-rule pl-2">
                    {tasks.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        className="sidebar-row gap-2.5"
                        onClick={() => toggleTask(project.id, task.id)}
                      >
                        <span className="min-w-0 flex-1 truncate">{task.title || 'Untitled task'}</span>
                        <TaskStatusMark status={task.status} />
                      </button>
                    ))}
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