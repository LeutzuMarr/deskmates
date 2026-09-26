import { useStore } from '../lib/store'
import { Composer } from '../components/Composer'
import { TaskStatusMark } from '../components/TaskStatusMark'
import { formatClock, formatDay, statusLabel } from '../lib/format'
import type { Task } from '../../../shared/protocol'

export function ProjectView({ projectId }: { projectId: string }) {
  const projects = useStore((s) => s.projects)
  const tasks = useStore((s) => s.tasksByProject[projectId])
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)

  const project = projects.find((p) => p.id === projectId)

  if (!project) {
    return (
      <main className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[14px] text-ink-faint">This project was removed.</p>
      </main>
    )
  }

  const openFolder = async (): Promise<void> => {
    try {
      await window.deskmates.openPath(project.folder)
    } catch (error) {
      showToast(`Couldn't open the folder: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-rule px-8 py-4">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate font-serif text-[24px] leading-tight">{project.name}</h1>
            <div className="mt-1 truncate font-mono text-[12px] text-ink-muted">{project.folder}</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" className="btn btn-outline" onClick={() => void openFolder()}>
              Open folder
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => navigate({ name: 'project-settings', projectId: project.id })}
            >
              Project settings
            </button>
          </div>
        </div>
      </header>

      <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-10">
          <h2 className="font-serif text-[32px] leading-[1.15]">What should we work on?</h2>
          <div className="mt-10">
            <Composer projectId={projectId} autoFocus />
          </div>
          <div className="mt-10">
            <h2 className="caption">Tasks</h2>
            {tasks && tasks.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} projectId={projectId} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[13px] text-ink-faint">No tasks yet — ask for something above.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskRow({ task, projectId }: { task: Task; projectId: string }) {
  const navigate = useStore((s) => s.navigate)
  let title = task.title
  if (title === '') title = 'Untitled task'
  return (
    <li>
      <button
        type="button"
        className="w-full rounded-3xl border border-rule bg-card px-5 py-4 text-left hover:bg-oat"
        onClick={() => navigate({ name: 'task', projectId, taskId: task.id })}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="truncate font-serif text-[17px]">{title}</span>
          <span className="shrink-0 text-[12px] text-ink-faint">
            {formatDay(task.updatedAt)} at {formatClock(task.updatedAt)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <TaskStatusMark status={task.status} />
          <span className="text-[12px] text-ink-muted">{statusLabel(task.status)}</span>
        </div>
      </button>
    </li>
  )
}