import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ListChecks, Undo2 } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { formatClock, formatDay, statusLabel } from '../lib/format'
import { Composer } from '../components/Composer'
import { Conversation } from '../components/Conversation'
import type { FileChange, PlanItem, Task } from '../../../shared/protocol'

export function TaskView({ projectId, taskId }: { projectId: string; taskId: string }) {
  const projects = useStore((s) => s.projects)
  const tasks = useStore((s) => s.tasksByProject[projectId])
  const timelines = useStore((s) => s.timelines)
  const changes = useStore((s) => s.changes)
  const showToast = useStore((s) => s.showToast)
  const [panelOpen, setPanelOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')

  const project = projects.find((p) => p.id === projectId)
  const task = (tasks ?? []).find((t) => t.id === taskId)
  const timeline = timelines[taskId] ?? []
  const taskChanges = changes[taskId] ?? []

  useEffect(() => {
    if (task && task.plan.length > 0) setPanelOpen(true)
  }, [task?.plan.length])

  const startRename = (): void => {
    if (!task) return
    setDraft(task.title)
    setRenaming(true)
  }

  const saveRename = async (): Promise<void> => {
    const title = draft.trim()
    setRenaming(false)
    if (!title || !task || title === task.title) return
    try {
      await core.call('tasks.rename', { id: taskId, title })
    } catch (error) {
      showToast(`Couldn't rename the task: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') void saveRename()
    if (event.key === 'Escape') setRenaming(false)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-rule px-8 py-3">
        <div className="min-w-0">
          {renaming ? (
            <label className="field">
              <span className="sr-only">Task title</span>
              <input
                autoFocus
                className="input w-[280px]"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => void saveRename()}
                onKeyDown={onRenameKeyDown}
              />
            </label>
          ) : (
            <h1
              className="truncate font-serif text-[24px] leading-tight"
              title="Double-click to rename"
              onDoubleClick={startRename}
            >
              {task?.title.trim() === '' ? 'Untitled task' : task?.title}
            </h1>
          )}
          <div className="mt-0.5 flex items-center gap-2">
            <span className="truncate font-mono text-[12px] text-ink-muted">{project?.name}</span>
            <span className="text-[12px] text-ink-faint">
              • {task ? statusLabel(task.status) : 'missing'} • Updated {formatDay(task?.updatedAt ?? 0)} at{' '}
              {formatClock(task?.updatedAt ?? 0)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-expanded={panelOpen}
            className="btn btn-outline"
            onClick={() => setPanelOpen((open) => !open)}
          >
            <ListChecks size={14} aria-hidden="true" className="mr-1.5" />
            Plan and changes
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Conversation
          taskId={taskId}
          timeline={timeline}
          running={task?.status === 'running'}
          emptyHint="No messages yet — ask something in the box below."
        />

        {panelOpen && (
          <aside className="w-[300px] shrink-0 border-l border-rule bg-card">
            <div className="scroll-area h-full overflow-y-auto p-4">
              <section>
                <h2 className="caption">Plan</h2>
                {task && task.plan.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-2.5">
                    {task.plan.map((item, index) => (
                      <PlanRow key={`${item.text}-${index}`} item={item} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[13px] text-ink-faint">No plan yet.</p>
                )}
              </section>
              <section className="mt-7">
                <div className="flex items-center justify-between">
                  <h2 className="caption">Changes</h2>
                  {taskChanges.some((change) => !change.undone) && (
                    <button type="button" className="btn btn-text px-0 text-[13px]" onClick={() => void undoAll(taskId)}>
                      Undo all
                    </button>
                  )}
                </div>
                {taskChanges.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {taskChanges.map((change) => (
                      <ChangeRow key={change.id} change={change} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[13px] text-ink-faint">No changes yet.</p>
                )}
              </section>
            </div>
          </aside>
        )}
      </div>

      <footer className="shrink-0 border-t border-rule">
        <div className="mx-auto w-full max-w-[720px] px-8 pb-5 pt-4">
          {task?.status === 'error' && task.error && (
            <div className="error-bar mb-3" role="alert">
              {task.error}
            </div>
          )}
          <Composer projectId={projectId} taskId={taskId} />
        </div>
      </footer>
    </div>
  )
}

function PlanRow({ item }: { item: PlanItem }) {
  const done = item.status === 'done'
  return (
    <li className={`flex items-start gap-2 text-[13px] leading-snug ${done ? 'text-ink-faint' : 'text-ink'}`}>
      <PlanMark status={item.status} />
      <span className="whitespace-pre-wrap">{item.text}</span>
    </li>
  )
}

function PlanMark({ status }: { status: PlanItem['status'] }) {
  if (status === 'done') return <span className="plan-mark plan-done" aria-hidden="true" />
  if (status === 'in_progress') return <span className="plan-mark plan-half" aria-hidden="true" />
  return <span className="plan-mark" aria-hidden="true" />
}

function ChangeRow({ change }: { change: FileChange }) {
  const showToast = useStore((s) => s.showToast)
  const label = ((): string => {
    if (change.kind === 'create') return `Created ${change.path}`
    if (change.kind === 'modify') return `Modified ${change.path}`
    if (change.kind === 'delete') return `Deleted ${change.path}`
    return `Moved ${change.path} → ${change.movedTo ?? '?'}`
  })()
  const undo = async (): Promise<void> => {
    try {
      await core.call('changes.undo', { id: change.id })
    } catch (error) {
      showToast(`Couldn't undo: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <li className="flex items-start justify-between gap-3">
      <span className={`break-words font-mono text-[12px] leading-relaxed ${change.undone ? 'text-ink-faint' : 'text-ink-muted'}`}>
        {label}
        {change.undone && ' · undone'}
      </span>
      {!change.undone && (
        <button type="button" className="btn btn-text shrink-0 px-0 text-[13px]" onClick={() => void undo()}>
          <Undo2 size={12} aria-hidden="true" className="mr-1" />
          Undo
        </button>
      )}
    </li>
  )
}

async function undoAll(taskId: string): Promise<void> {
  try {
    await core.call('changes.undoAll', { taskId })
  } catch (error) {
    useStore.getState().showToast(`Couldn't undo: ${error instanceof Error ? error.message : String(error)}`)
  }
}