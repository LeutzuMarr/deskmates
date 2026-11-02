import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Bot,
  Folder,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sun,
  Terminal
} from 'lucide-react'
import { useStore } from '../lib/store'
import type { Tab } from '../lib/store'
import { setPrefs, getPrefs } from '../lib/prefs'
import { startNewTask } from '../lib/shortcuts'

interface Entry {
  id: string
  group: 'Actions' | 'Tasks' | 'Projects' | 'Designs' | 'Bots'
  label: string
  detail?: string
  shortcut?: string
  Icon: LucideIcon
  run: () => void
}

/** Every word of the query appears somewhere in the label or detail, in any order. */
function matches(entry: Entry, words: string[]): boolean {
  if (words.length === 0) return true
  const hay = `${entry.label} ${entry.detail ?? ''} ${entry.group}`.toLowerCase()
  return words.every((word) => hay.includes(word))
}

const MAX_PER_GROUP = 8

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const bots = useStore((s) => s.bots)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    // The palette mounts and focuses in the same frame the shortcut fired.
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const entries = useMemo((): Entry[] => {
    const store = useStore.getState
    const go = (tab: Tab, after?: () => void) => () => {
      store().setTab(tab)
      after?.()
    }
    const actions: Entry[] = [
      { id: 'new-task', group: 'Actions', label: 'New task', shortcut: 'Ctrl+N', Icon: Plus, run: () => void startNewTask() },
      {
        id: 'new-design',
        group: 'Actions',
        label: 'New design',
        Icon: Palette,
        run: go('design', () => store().navigate({ name: 'design-home' }))
      },
      { id: 'tab-work', group: 'Actions', label: 'Go to Work', shortcut: 'Ctrl+1', Icon: MessageSquare, run: go('work') },
      { id: 'tab-design', group: 'Actions', label: 'Go to Design', shortcut: 'Ctrl+2', Icon: Palette, run: go('design') },
      { id: 'tab-bots', group: 'Actions', label: 'Go to Bots', shortcut: 'Ctrl+3', Icon: Bot, run: go('bots') },
      { id: 'tab-agents', group: 'Actions', label: 'Go to Agents', shortcut: 'Ctrl+4', Icon: Terminal, run: go('agents') },
      { id: 'tab-extras', group: 'Actions', label: 'Go to Extras', shortcut: 'Ctrl+5', Icon: Puzzle, run: go('extras') },
      {
        id: 'settings',
        group: 'Actions',
        label: 'Open settings',
        shortcut: 'Ctrl+,',
        Icon: Settings,
        run: () => store().navigate({ name: 'settings' })
      },
      {
        id: 'sidebar',
        group: 'Actions',
        label: 'Toggle sidebar',
        shortcut: 'Ctrl+B',
        Icon: PanelLeft,
        run: () => setPrefs({ sidebarCollapsed: !getPrefs().sidebarCollapsed })
      },
      { id: 'theme-light', group: 'Actions', label: 'Use light theme', Icon: Sun, run: () => setPrefs({ theme: 'light' }) },
      { id: 'theme-dark', group: 'Actions', label: 'Use dark theme', Icon: Moon, run: () => setPrefs({ theme: 'dark' }) },
      { id: 'theme-system', group: 'Actions', label: 'Use system theme', Icon: Monitor, run: () => setPrefs({ theme: 'system' }) }
    ]

    const projectName = new Map(projects.map((p) => [p.id, p.name]))
    const tasks: Entry[] = projects
      .filter((p) => p.kind === 'work')
      .flatMap((p) => (tasksByProject[p.id] ?? []).map((task) => ({ task, projectId: p.id })))
      .sort((a, b) => b.task.updatedAt - a.task.updatedAt)
      .map(({ task, projectId }) => ({
        id: `task-${task.id}`,
        group: 'Tasks' as const,
        label: task.title.trim() || 'Untitled task',
        detail: projectName.get(projectId),
        Icon: MessageSquare,
        run: go('work', () => store().navigate({ name: 'task', projectId, taskId: task.id }))
      }))

    const work: Entry[] = projects
      .filter((p) => p.kind === 'work')
      .map((p) => ({
        id: `project-${p.id}`,
        group: 'Projects' as const,
        label: p.name,
        detail: p.folder,
        Icon: Folder,
        run: go('work', () => store().navigate({ name: 'project', projectId: p.id }))
      }))

    const designs: Entry[] = projects
      .filter((p) => p.kind === 'design')
      .map((p) => ({
        id: `design-${p.id}`,
        group: 'Designs' as const,
        label: p.name,
        Icon: Palette,
        run: go('design', () => store().navigate({ name: 'design', projectId: p.id }))
      }))

    const botEntries: Entry[] = bots.map((b) => ({
      id: `bot-${b.id}`,
      group: 'Bots' as const,
      label: b.name,
      Icon: Bot,
      run: go('bots', () => store().navigate({ name: 'bot', botId: b.id }))
    }))

    return [...actions, ...tasks, ...work, ...designs, ...botEntries]
  }, [projects, tasksByProject, bots])

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const counts: Record<string, number> = {}
    return entries.filter((entry) => {
      if (!matches(entry, words)) return false
      counts[entry.group] = (counts[entry.group] ?? 0) + 1
      return counts[entry.group] <= MAX_PER_GROUP
    })
  }, [entries, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const choose = (entry: Entry | undefined): void => {
    if (!entry) return
    onClose()
    entry.run()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(visible.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      choose(visible[active])
    }
  }

  const rows: ReactNode[] = []
  let lastGroup = ''
  visible.forEach((entry, index) => {
    if (entry.group !== lastGroup) {
      lastGroup = entry.group
      rows.push(
        <div key={`h-${entry.group}`} className="caption px-3 pb-1 pt-3">
          {entry.group}
        </div>
      )
    }
    const { Icon } = entry
    rows.push(
      <button
        key={entry.id}
        type="button"
        role="option"
        data-index={index}
        aria-selected={index === active}
        className="menu-item"
        onMouseMove={() => setActive(index)}
        onClick={() => choose(entry)}
      >
        <Icon size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
        <span className="min-w-0 truncate">{entry.label}</span>
        {entry.detail && <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{entry.detail}</span>}
        {entry.shortcut && <kbd className="kbd ml-auto">{entry.shortcut}</kbd>}
      </button>
    )
  })

  return (
    <div className="palette-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search and commands" className="palette" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b border-rule px-4">
          <Search size={16} aria-hidden="true" className="shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks, projects, designs, bots or commands"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div id="palette-list" ref={listRef} role="listbox" className="scroll-area max-h-[50vh] overflow-y-auto p-1.5">
          {rows.length > 0 ? rows : <p className="px-3 py-6 text-center text-[13px] text-ink-faint">Nothing matches “{query}”.</p>}
        </div>
      </div>
    </div>
  )
}
