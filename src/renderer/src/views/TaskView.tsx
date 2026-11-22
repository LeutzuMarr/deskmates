import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Download, ListChecks, Undo2 } from 'lucide-react'
import { exportChat } from '../lib/commands'
import { PlanCard, PlanRow } from '../components/PlanCard'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { formatClock, formatDay, statusLabel, startingNotice } from '../lib/format'
import { Composer } from '../components/Composer'
import { Conversation } from '../components/Conversation'
import { FreebuffStatusLine } from '../components/FreebuffStatusLine'
import { DiffChip } from '../components/DiffChip'
import { BrowserSurface, DockBrowserButton } from '../components/BrowserPanel'
import { ArtifactPanel } from '../components/ArtifactPanel'
import type { ChangeStats, FileChange } from '../../../shared/protocol'

/** Provider and folder pairs whose agent has already run once since the app opened. */
const startedOnce = new Set<string>()

export function TaskView({ projectId, taskId }: { projectId: string; taskId: string }) {
  const projects = useStore((s) => s.projects)
  const tasks = useStore((s) => s.tasksByProject[projectId])
  const timelines = useStore((s) => s.timelines)
  const changes = useStore((s) => s.changes)
  const showToast = useStore((s) => s.showToast)
  const defaultModel = useStore((s) => s.settings?.defaultModel ?? null)
  const browserOpen = useStore((s) => s.browserOpen)
  const setBrowserOpen = useStore((s) => s.setBrowserOpen)
  const artifactOpen = useStore((s) => s.artifact?.taskId === taskId)
  const setArtifactHost = useStore((s) => s.setArtifactHost)
  // This view has the artifact panel: artifacts in its chat show as cards that open it.
  useEffect(() => {
    setArtifactHost(taskId)
    return () => setArtifactHost(null)
  }, [taskId, setArtifactHost])
  const [panelOpen, setPanelOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')

  const project = projects.find((p) => p.id === projectId)
  const task = (tasks ?? []).find((t) => t.id === taskId)
  const timeline = timelines[taskId] ?? []
  const taskChanges = changes[taskId] ?? []
  const model = project?.model ?? defaultModel

  // A CLI-backed provider boots a whole agent process before it says anything, and on a cold start
  // that is tens of seconds of silence. Naming it stops the wait reading as a hang — but OpenCode
  // keeps a server per folder alive between turns, so once one is up the next prompt is answered in
  // about a second and a half and the notice is both wrong and alarming. Asked at the moment a run
  // starts, and reset afterwards, since the server can also time itself out while idle.
  const [warm, setWarm] = useState(false)
  const running = task?.status === 'running'
  useEffect(() => {
    if (!running || !project) {
      if (!running) setWarm(false)
      return
    }
    let live = true
    void core
      .call('terminals.warm', { folder: project.folder })
      .then((result) => {
        if (live) setWarm(result.warm)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [running, project?.folder])

  // The start-up notice is for the first run only: once an agent has answered in this folder, later
  // prompts go back to the usual rotating words.
  const startKey = `${model?.provider ?? ''}:${project?.folder ?? ''}`
  useEffect(() => {
    if (!running) return
    return () => {
      startedOnce.add(startKey)
    }
  }, [running, startKey])
  const starting = startedOnce.has(startKey) ? null : startingNotice(project?.model, warm)

  // Lines added and removed so far. Re-counted when a change is recorded or undone, and once more
  // when the run ends, since the last edits can land after the last change was recorded.
  const [stats, setStats] = useState<ChangeStats | null>(null)
  const changeKey = taskChanges.map((change) => `${change.id}:${change.undone ? 1 : 0}`).join(',')
  useEffect(() => {
    let live = true
    if (changeKey === '') {
      setStats(null)
      return
    }
    void core
      .call('changes.stats', { taskId })
      .then((next) => {
        if (live) setStats(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [taskId, changeKey, running])

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
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className="max-w-[50%] shrink-0 truncate font-mono text-[12px] text-ink-muted">{project?.name}</span>
            <span className="min-w-0 truncate whitespace-nowrap text-[12px] text-ink-faint">
              • {task ? statusLabel(task.status) : 'missing'} • Updated {formatDay(task?.updatedAt ?? 0)} at{' '}
              {formatClock(task?.updatedAt ?? 0)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {project && model?.provider === 'freebuff' && <FreebuffStatusLine folder={project.folder} modelId={model.modelId} />}
          {stats && <DiffChip stats={stats} />}
          <DockBrowserButton />
          <button type="button" className="btn btn-outline" title="Save this chat as a Markdown file" onClick={() => exportChat(taskId)}>
            <Download size={14} aria-hidden="true" className="mr-1.5" />
            Export
          </button>
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

      <div className="relative flex min-h-0 flex-1">
        <Conversation
          editable
          taskId={taskId}
          timeline={timeline}
          running={task?.status === 'running'}
          emptyHint="No messages yet — ask something in the box below."
          starting={starting}
          dock={
            <>
              {task?.status === 'error' && task.error && (
                <div className="error-bar mb-3" role="alert">
                  {task.error}
                </div>
              )}
              {/* The task list stays at the end of the chat, above the message box, finished or not. */}
              {task && <PlanCard plan={task.plan} />}
              <Composer projectId={projectId} taskId={taskId} />
            </>
          }
        />

        {/* The artifact the user opened from the chat, beside it. */}
        {artifactOpen && <ArtifactPanel timeline={timeline} folder={project?.folder ?? null} />}

        {/* Deskmates' browser beside the chat: watch the agent work on a site, or sign in for it. */}
        {browserOpen && (
          <aside className="flex w-[46%] min-w-[420px] max-w-[900px] shrink-0 flex-col border-l border-rule bg-canvas" aria-label="Agent browser">
            <BrowserSurface onClose={() => setBrowserOpen(false)} />
          </aside>
        )}

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
                  <h2 className="caption flex items-center gap-2">
                    Changes
                    {stats && <DiffChip stats={stats} />}
                  </h2>
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

    </div>
  )
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