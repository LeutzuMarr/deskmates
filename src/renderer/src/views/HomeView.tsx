import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Clapperboard, Code2, Folder, FolderPlus, PenTool } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '../lib/store'
import { BrandMark } from '../components/Mascot'
import { Composer } from '../components/Composer'
import { TaskStatusMark } from '../components/TaskStatusMark'
import { formatClock, formatDay, greeting } from '../lib/format'
import { useDismissableMenu } from '../lib/useMenu'
import { AddProjectDialog } from './AddProjectDialog'
import { isCliProvider, isLocalProvider } from '../../../shared/protocol'
import type { Project } from '../../../shared/protocol'

interface Starter {
  label: string
  prompt: string
}

interface StarterGroup {
  id: 'code' | 'design' | 'video'
  label: string
  Icon: LucideIcon
  starters: Starter[]
}

/** Starting points for the three kinds of work Deskmates is used for day to day. Each fills the box; nothing sends by itself. */
const STARTERS: StarterGroup[] = [
  {
    id: 'code',
    label: 'Code',
    Icon: Code2,
    starters: [
      { label: 'Explain this codebase', prompt: 'Read through this project and explain how it is put together: the main parts, how they talk to each other, and where I should start reading.' },
      { label: 'Find and fix a bug', prompt: 'Something is broken: ' },
      { label: 'Run the tests and fix failures', prompt: 'Run this project’s tests. For each failure, find the cause and fix it, then run them again until they pass.' },
      { label: 'Review my uncommitted changes', prompt: 'Review my uncommitted git changes for bugs, missed edge cases and anything that reads unclearly. List what you find, most serious first.' }
    ]
  },
  {
    id: 'design',
    label: 'Design',
    Icon: PenTool,
    starters: [
      { label: 'Audit a UI for polish', prompt: 'Look at the UI code in this project and list the places where spacing, type, colour or states are inconsistent. Suggest exact fixes.' },
      { label: 'Build a style guide', prompt: 'Collect the colours, fonts, spacing and components used in this project into a one-page style guide (style-guide.md).' },
      { label: 'Organise my assets', prompt: 'Sort the images, icons and exports in this folder into a clear folder structure with consistent names. Show me the plan before moving anything.' },
      { label: 'Write UX copy', prompt: 'Rewrite the user-facing text in this project so it is short, plain and consistent. Show me before and after.' }
    ]
  },
  {
    id: 'video',
    label: 'Video',
    Icon: Clapperboard,
    starters: [
      { label: 'Rough cut a recording', prompt: 'In DaVinci Resolve, take the current timeline and cut out silences, false starts and long pauses so it plays tight. Keep a copy of the original timeline.' },
      { label: 'Clean up dialogue audio', prompt: 'In DaVinci Resolve, clean up the dialogue on the current timeline: reduce noise and hum, level the voice, and duck the music under it.' },
      { label: 'Export for every platform', prompt: 'In DaVinci Resolve, render the current timeline for YouTube (16:9), Instagram Reels (9:16) and LinkedIn (1:1) with the right sizes and loudness.' },
      { label: 'Add markers for chapters', prompt: 'In DaVinci Resolve, watch the current timeline’s transcript and add a marker at the start of each topic, named as a chapter title.' }
    ]
  }
]

function lastActivity(project: Project, tasksByProject: Record<string, { updatedAt: number }[]>): number {
  const tasks = tasksByProject[project.id] ?? []
  return tasks.reduce((latest, t) => Math.max(latest, t.updatedAt), project.createdAt)
}

export function HomeView() {
  const allProjects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const keyStatus = useStore((s) => s.keyStatus)
  const defaultModel = useStore((s) => s.settings?.defaultModel)
  const connectors = useStore((s) => s.connectors)
  const navigate = useStore((s) => s.navigate)
  const [addOpen, setAddOpen] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [group, setGroup] = useState<StarterGroup['id']>('code')
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)

  const projects = useMemo(
    () =>
      allProjects
        .filter((p) => p.kind === 'work')
        .sort((a, b) => lastActivity(b, tasksByProject) - lastActivity(a, tasksByProject)),
    [allProjects, tasksByProject]
  )

  // Default to the most recently used project, and follow it if the chosen one is removed.
  useEffect(() => {
    if (projects.length === 0) setProjectId(null)
    else if (!projectId || !projects.some((p) => p.id === projectId)) setProjectId(projects[0].id)
  }, [projects, projectId])

  const recent = useMemo(
    () =>
      projects
        .flatMap((p) => (tasksByProject[p.id] ?? []).map((task) => ({ task, project: p })))
        .sort((a, b) => b.task.updatedAt - a.task.updatedAt)
        .slice(0, 5),
    [projects, tasksByProject]
  )

  const resolveConnected = connectors.some((c) => c.enabled && /resolve|davinci/i.test(c.name))

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

  const project = projects.find((p) => p.id === projectId) ?? projects[0]
  const active = STARTERS.find((g) => g.id === group) ?? STARTERS[0]

  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col px-8 pb-10 pt-[12vh]">
        <div className="greet-in flex items-center justify-center gap-4">
          <span className="greet-mark inline-block">
            <BrandMark size={40} />
          </span>
          <h1 className="font-serif text-[42px] leading-[1.1] tracking-[-0.01em]">{greeting(new Date())}</h1>
        </div>

        <div className="greet-in greet-in-1 mt-10">
          <Composer key={project.id} projectId={project.id} autoFocus seed={seed} placeholder="How can I help you today?" />
          <div className="mt-2 flex items-center justify-between gap-2 px-1">
            <ProjectPicker projects={projects} current={project} onPick={setProjectId} onAdd={() => setAddOpen(true)} />
            <span className="hidden text-[12px] text-ink-faint sm:inline">
              Drop files to add their path · <kbd className="kbd">Ctrl+K</kbd> to search
            </span>
          </div>
        </div>

        <div className="greet-in greet-in-2 mt-8">
          <div className="flex flex-wrap items-center justify-center gap-2" role="tablist" aria-label="Starting points">
            {STARTERS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={group === id}
                className={`starter-tab ${group === id ? 'starter-tab-active' : ''}`}
                onClick={() => setGroup(id)}
              >
                <Icon size={14} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" role="tabpanel" aria-label={`${active.label} starting points`}>
            {active.starters.map((starter) => (
              <button
                key={starter.label}
                type="button"
                className="starter-card"
                onClick={() => setSeed({ text: starter.prompt, nonce: Date.now() })}
              >
                {starter.label}
              </button>
            ))}
          </div>
          {group === 'video' && !resolveConnected && (
            <p className="mt-3 text-center text-[12px] text-ink-muted">
              These need the DaVinci Resolve connector.{' '}
              <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => useStore.getState().setTab('extras')}>
                Set it up in Extras
              </button>
              , then turn on Preferences → System → General → External scripting: Local in Resolve.
            </p>
          )}
        </div>

        {recent.length > 0 && (
          <section className="greet-in greet-in-3 mt-12">
            <h2 className="caption px-1">Recent tasks</h2>
            <ul className="mt-2 flex flex-col">
              {recent.map(({ task, project: p }) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="recent-row"
                    onClick={() => navigate({ name: 'task', projectId: p.id, taskId: task.id })}
                  >
                    <TaskStatusMark status={task.status} />
                    <span className="min-w-0 flex-1 truncate">{task.title.trim() || 'Untitled task'}</span>
                    <span className="shrink-0 truncate text-[12px] text-ink-faint">{p.name}</span>
                    <span className="w-[120px] shrink-0 text-right text-[12px] text-ink-faint">
                      {formatDay(task.updatedAt)} {formatClock(task.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </main>
  )
}

function ProjectPicker({
  projects,
  current,
  onPick,
  onAdd
}: {
  projects: Project[]
  current: Project
  onPick: (id: string) => void
  onAdd: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false))
  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-ink-muted hover:bg-oat hover:text-ink"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Project: ${current.name}`}
        title={current.folder}
        onClick={() => setOpen((v) => !v)}
      >
        <Folder size={13} aria-hidden="true" className="shrink-0" />
        <span className="max-w-[240px] truncate">{current.name}</span>
        <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
      </button>
      {open && (
        <div className="menu left-0 top-full mt-1 w-[300px]" role="menu" aria-label="Projects">
          <div className="scroll-area max-h-[260px] overflow-y-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === current.id}
                aria-selected={p.id === current.id}
                className="menu-item"
                onClick={() => {
                  onPick(p.id)
                  setOpen(false)
                }}
              >
                <Folder size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
                <span className="min-w-0">
                  <span className="block truncate">{p.name}</span>
                  <span className="block truncate font-mono text-[11px] text-ink-faint">{p.folder}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-rule pt-1">
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false)
                onAdd()
              }}
            >
              <FolderPlus size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
              New project folder…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
