import { useState } from 'react'
import { useStore } from '../lib/store'
import { BrandMark } from '../components/Mascot'
import { formatClock, formatDay, greeting } from '../lib/format'
import { AddProjectDialog } from './AddProjectDialog'
import { isCliProvider, isLocalProvider } from '../../../shared/protocol'

export function HomeView() {
  const allProjects = useStore((s) => s.projects)
  const projects = allProjects.filter((p) => p.kind === 'work')
  const tasksByProject = useStore((s) => s.tasksByProject)
  const keyStatus = useStore((s) => s.keyStatus)
  const defaultModel = useStore((s) => s.settings?.defaultModel)
  const navigate = useStore((s) => s.navigate)
  const createTask = useStore((s) => s.createTask)
  const [addOpen, setAddOpen] = useState(false)

  const lastTaskTime = (projectId: string): number | null => {
    const tasks = tasksByProject[projectId] ?? []
    if (tasks.length === 0) return null
    return Math.max(...tasks.map((t) => t.updatedAt))
  }

  const mostRecentProject = (): (typeof projects)[number] | undefined => {
    const sorted = [...projects].sort((a, b) => (lastTaskTime(b.id) ?? 0) - (lastTaskTime(a.id) ?? 0))
    return sorted[0]
  }

  const newTask = async (): Promise<void> => {
    const project = mostRecentProject()
    if (!project) return
    const task = await createTask(project.id)
    if (task) navigate({ name: 'task', projectId: project.id, taskId: task.id })
  }

  // No API key is needed when the default model runs through a local CLI provider (OpenCode/agy)
  // or a local model server (Ollama/LM Studio).
  const usesKeylessModel = defaultModel
    ? isCliProvider(defaultModel.provider) || isLocalProvider(defaultModel.provider)
    : false
  if (keyStatus.length === 0 && !usesKeylessModel) {
    return (
      <main className="flex h-full items-center justify-center p-8">
        <div className="max-w-[440px] text-center">
          <div className="flex justify-center">
            <BrandMark size={64} />
          </div>
          <h1 className="mt-6 font-serif text-[24px] leading-tight">Add an API key to get started</h1>
          <p className="mt-2 text-[14px] text-ink-muted">Deskmates uses your own key. It's stored encrypted on this PC.</p>
          <button type="button" className="btn btn-ivory mt-8" onClick={() => navigate({ name: 'settings' })}>
            Open settings
          </button>
        </div>
      </main>
    )
  }

  if (projects.length === 0) {
    return (
      <main className="flex h-full items-center justify-center p-8">
        <div className="max-w-[440px] text-center">
          <div className="flex justify-center">
            <BrandMark size={64} />
          </div>
          <h1 className="mt-6 font-serif text-[24px] leading-tight">Pick a folder for Deskmates to work in</h1>
          <p className="mt-2 text-[14px] text-ink-muted">It can read and change files only inside that folder.</p>
          <button type="button" className="btn btn-ivory mt-8" onClick={() => setAddOpen(true)}>
            Add project
          </button>
        </div>
        <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
      </main>
    )
  }

  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 py-10">
        <section className="flex items-center gap-6 rounded-3xl bg-manilla p-12">
          <div className="shrink-0">
            <BrandMark size={48} />
          </div>
          <h1 className="font-serif text-[44px] leading-[1.1]">{greeting(new Date())}</h1>
        </section>

        <div className="mt-12 flex items-center justify-between">
          <h2 className="caption">Projects</h2>
          <button type="button" className="btn btn-outline" onClick={() => void newTask()}>
            New task
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-3">
          {projects.map((project) => {
            const lastAt = lastTaskTime(project.id)
            return (
              <button
                type="button"
                key={project.id}
                className="rounded-3xl border border-rule bg-card p-6 text-left hover:bg-oat"
                onClick={() => navigate({ name: 'project', projectId: project.id })}
              >
                <div className="font-serif text-[20px]">{project.name}</div>
                <div className="mt-1 truncate font-mono text-[12px] text-ink-muted">{project.folder}</div>
                <div className="mt-3 text-[12px] text-ink-faint">
                  {lastAt !== null ? `Last task ${formatDay(lastAt)} at ${formatClock(lastAt)}` : 'No tasks yet'}
                </div>
              </button>
            )
          })}
        </div>
      </div>
      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </main>
  )
}