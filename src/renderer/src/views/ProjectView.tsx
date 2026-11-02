import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { Composer } from '../components/Composer'
import { TaskStatusMark } from '../components/TaskStatusMark'
import { FreebuffStatusLine } from '../components/FreebuffStatusLine'
import { compactBlockedReason, compactWorthwhile, contextMeter, formatClock, formatDay, statusLabel } from '../lib/format'
import type { SessionContextUsage, Task } from '../../../shared/protocol'

/** How often the context meter re-reads the server's own token count. Slow enough to be free, quick
 *  enough that a conversation which fills up while you're reading it doesn't look frozen. */
const USAGE_POLL_MS = 20_000

/** The button and the meter it belongs to.
 *
 *  Both live on the project rather than the task, because the conversation is the project folder's:
 *  every prompt in this project continues the same OpenCode session, so that is the context that
 *  eventually runs out. */
function ContextMeter({
  folder,
  provider,
  busy
}: {
  folder: string
  provider: string | undefined
  busy: boolean
}) {
  const loadSessionUsage = useStore((s) => s.loadSessionUsage)
  const compactSession = useStore((s) => s.compactSession)
  const [usage, setUsage] = useState<SessionContextUsage | null>(null)
  const [compacting, setCompacting] = useState(false)

  // Only OpenCode keeps a conversation to compact; agy is a fresh process per turn, so a meter there
  // would describe something that doesn't exist.
  const applicable = provider === 'opencode'

  useEffect(() => {
    if (!applicable) return
    let live = true
    // Read once immediately rather than after the first tick: a conversation the user has been working
    // in for an hour should not sit on an empty meter for 20 seconds.
    const read = (): void => {
      void loadSessionUsage(folder).then((next) => {
        if (live) setUsage(next)
      })
    }
    read()
    const timer = setInterval(read, USAGE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [applicable, folder, loadSessionUsage])

  const compact = useCallback(async (): Promise<void> => {
    setCompacting(true)
    try {
      const next = await compactSession(folder)
      if (next) setUsage(next)
    } finally {
      setCompacting(false)
    }
  }, [compactSession, folder])

  if (!applicable) return null

  const meter = contextMeter(usage)
  const blocked = compactBlockedReason(usage, compacting, busy)
  const enabled = blocked === null && compactWorthwhile(usage)

  return (
    <div className="flex shrink-0 items-center gap-3">
      {meter && (
        <div className="flex items-center gap-2" title={`Context used: ${meter.label}`}>
          <div className="h-1 w-16 overflow-hidden rounded-full bg-rule" role="presentation">
            <div
              className="h-full rounded-full bg-ink-faint transition-[width] duration-300"
              style={{ width: `${meter.percent}%` }}
            />
          </div>
          <span className="font-mono text-[11px] text-ink-faint tabular-nums">{meter.percent}%</span>
        </div>
      )}
      <button
        type="button"
        className="btn btn-outline"
        onClick={() => void compact()}
        disabled={!enabled}
        title={blocked ?? 'Replace this conversation with a summary of itself, keeping the thread going.'}
      >
        {compacting ? 'Compacting…' : 'Compact context'}
      </button>
    </div>
  )
}

export function ProjectView({ projectId }: { projectId: string }) {
  const projects = useStore((s) => s.projects)
  const tasks = useStore((s) => s.tasksByProject[projectId])
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)

  const defaultModel = useStore((s) => s.settings?.defaultModel ?? null)

  const project = projects.find((p) => p.id === projectId)
  const busy = (tasks ?? []).some((task: Task) => task.status === 'running')
  // The project's own model, or the default it falls back to.
  const model = project?.model ?? defaultModel

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
          <div className="flex shrink-0 items-center gap-2">
            {model?.provider === 'freebuff' && <FreebuffStatusLine folder={project.folder} modelId={model.modelId} />}
            <ContextMeter folder={project.folder} provider={project.model?.provider} busy={busy} />
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