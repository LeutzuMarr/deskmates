import { Plus } from 'lucide-react'
import { useStore } from '../lib/store'
import { core } from '../lib/rpc'
import { designsByActivity } from '../lib/design'
import { SidebarEmpty, SidebarFrame, SidebarRow } from './SidebarParts'
import { strongestMark, taskMark } from './StatusMark'
import type { Project } from '../../../shared/protocol'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function DesignSidebar() {
  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const unread = useStore((s) => s.unread)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)

  const designs = designsByActivity(projects, tasksByProject)
  const selectedProjectId = view.name === 'design' ? view.projectId : null

  const rename = async (project: Project, name: string): Promise<void> => {
    try {
      await core.call('projects.update', { id: project.id, name })
    } catch (error) {
      showToast(`Couldn't rename the design: ${errorText(error)}`)
    }
  }

  const remove = async (project: Project): Promise<void> => {
    if (!window.confirm(`Delete "${project.name}"? This removes the design and its files.`)) return
    try {
      await core.call('projects.delete', { id: project.id })
      if (selectedProjectId === project.id) navigate({ name: 'design-home' })
    } catch (error) {
      showToast(`Couldn't delete the design: ${errorText(error)}`)
    }
  }

  return (
    <SidebarFrame>
      <div className="sidebar-nav">
        <button
          type="button"
          className={`sidebar-row ${view.name === 'design-home' ? 'sidebar-row-active' : ''}`}
          onClick={() => navigate({ name: 'design-home' })}
        >
          <Plus size={16} aria-hidden="true" />
          <span>New design</span>
        </button>
      </div>

      <div className="caption mt-4 px-3">Designs</div>
      <div className="sidebar-nav mt-1">
        {designs.map((project) => (
          <SidebarRow
            key={project.id}
            label={project.name}
            active={selectedProjectId === project.id}
            // A design is one conversation made of several tasks; the row shows whichever needs the eye most.
            mark={strongestMark((tasksByProject[project.id] ?? []).map((task) => taskMark(task.status, unread[task.id])))}
            onOpen={() => navigate({ name: 'design', projectId: project.id })}
            onRename={(name) => void rename(project, name)}
            menu={[{ label: 'Delete', danger: true, onSelect: () => void remove(project) }]}
          />
        ))}
        {designs.length === 0 && <SidebarEmpty>No designs yet.</SidebarEmpty>}
      </div>
    </SidebarFrame>
  )
}
