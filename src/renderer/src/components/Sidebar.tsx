import { useState } from 'react'
import { FolderPlus, Plus, SlidersHorizontal } from 'lucide-react'
import { useStore } from '../lib/store'
import { core } from '../lib/rpc'
import { focusComposer } from '../lib/shortcuts'
import { AddProjectDialog } from '../views/AddProjectDialog'
import { SidebarEmpty, SidebarFrame, SidebarGroup, SidebarRow } from './SidebarParts'
import { strongestMark, taskMark } from './StatusMark'
import type { Task } from '../../../shared/protocol'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function Sidebar() {
  const allProjects = useStore((s) => s.projects)
  const projects = allProjects.filter((p) => p.kind === 'work')
  const tasksByProject = useStore((s) => s.tasksByProject)
  const unread = useStore((s) => s.unread)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)
  const [addOpen, setAddOpen] = useState(false)

  const selectedTaskId = view.name === 'task' ? view.taskId : null
  // The project's own page (its new-task box or its settings), as opposed to one of its tasks.
  const openProjectId = view.name === 'project' || view.name === 'project-settings' ? view.projectId : null

  const rename = async (task: Task, title: string): Promise<void> => {
    try {
      await core.call('tasks.rename', { id: task.id, title })
    } catch (error) {
      showToast(`Couldn't rename the task: ${errorText(error)}`)
    }
  }

  const pin = async (task: Task, pinned: boolean): Promise<void> => {
    try {
      await core.call('tasks.pin', { id: task.id, pinned })
    } catch (error) {
      showToast(`Couldn't ${pinned ? 'pin' : 'unpin'} the task: ${errorText(error)}`)
    }
  }

  const remove = async (task: Task): Promise<void> => {
    const name = task.title.trim() || 'Untitled task'
    if (!window.confirm(`Delete "${name}"? Its conversation is removed. Files it changed stay as they are.`)) return
    try {
      if (selectedTaskId === task.id) navigate({ name: 'project', projectId: task.projectId })
      await core.call('tasks.delete', { id: task.id })
    } catch (error) {
      showToast(`Couldn't delete the task: ${errorText(error)}`)
    }
  }

  const newTaskIn = (projectId: string): void => {
    navigate({ name: 'project', projectId })
    focusComposer()
  }

  return (
    <SidebarFrame>
      <div className="sidebar-nav">
        {/* Home: the box that starts a task in any project. Each project's own + starts one there. */}
        <button
          type="button"
          className={`sidebar-row ${view.name === 'home' ? 'sidebar-row-active' : ''}`}
          onClick={() => {
            navigate({ name: 'home' })
            focusComposer()
          }}
        >
          <Plus size={16} aria-hidden="true" />
          <span>New task</span>
        </button>
        <button type="button" className="sidebar-row" onClick={() => setAddOpen(true)}>
          <FolderPlus size={16} aria-hidden="true" />
          <span>Add project</span>
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {projects.map((project) => {
          const tasks = tasksByProject[project.id] ?? []
          return (
            <SidebarGroup
              key={project.id}
              id={`work:${project.id}`}
              label={project.name}
              title={project.folder}
              active={openProjectId === project.id}
              mark={strongestMark(tasks.map((task) => taskMark(task.status, unread[task.id])))}
              onOpen={() => navigate({ name: 'project', projectId: project.id })}
              actions={
                <>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`Settings for ${project.name}`}
                    title="Project settings"
                    onClick={() => navigate({ name: 'project-settings', projectId: project.id })}
                  >
                    <SlidersHorizontal size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`New task in ${project.name}`}
                    title="New task in this project"
                    onClick={() => newTaskIn(project.id)}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                </>
              }
            >
              {tasks.map((task) => (
                <SidebarRow
                  key={task.id}
                  label={task.title.trim() || 'Untitled task'}
                  renameValue={task.title}
                  active={selectedTaskId === task.id}
                  mark={taskMark(task.status, unread[task.id])}
                  detail={task.pinned ? 'Pinned' : undefined}
                  onOpen={() => {
                    if (selectedTaskId !== task.id) navigate({ name: 'task', projectId: project.id, taskId: task.id })
                  }}
                  onRename={(title) => void rename(task, title)}
                  menu={[
                    { label: task.pinned ? 'Unpin' : 'Pin', onSelect: () => void pin(task, !task.pinned) },
                    { label: 'Delete', danger: true, onSelect: () => void remove(task) }
                  ]}
                />
              ))}
              {tasks.length === 0 && <SidebarEmpty>No tasks yet.</SidebarEmpty>}
            </SidebarGroup>
          )
        })}
        {projects.length === 0 && <SidebarEmpty>Add a project folder to start working in it.</SidebarEmpty>}
      </div>

      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </SidebarFrame>
  )
}
