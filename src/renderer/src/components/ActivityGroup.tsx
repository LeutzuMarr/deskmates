import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowRightLeft,
  Bell,
  BookOpen,
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  Loader2,
  MessageCircle,
  Monitor,
  OctagonX,
  Search,
  Share2,
  Terminal,
  Trash2,
  Wrench
} from 'lucide-react'
import { extractImageUrl, prettyJSON, summarizeActivity } from '../lib/format'
import { stepDiff, stepLabel } from '../lib/steps'
import { StatusMark } from './StatusMark'
import type { ToolItem, ToolItemState } from '../../../shared/protocol'

const TOOL_ICONS: Record<string, LucideIcon> = {
  write_file: FilePen,
  edit_file: FileEdit,
  read_file: FileText,
  read_document: BookOpen,
  list_files: FolderOpen,
  search_files: Search,
  move_path: ArrowRightLeft,
  delete_path: Trash2,
  run_command: Terminal,
  update_plan: ListChecks,
  remember: Bookmark,
  forget: Trash2,
  notify_user: Bell,
  narration: MessageCircle,
  Read: FileText,
  view: FileText,
  Write: FilePen,
  Edit: FileEdit,
  str_replace: FileEdit,
  Bash: Terminal,
  bash_tool: Terminal,
  Glob: Search,
  Grep: Search,
  memory_read: Bookmark,
  memory_list: Bookmark,
  memory_write: Bookmark,
  memory_append: Bookmark,
  memory_str_replace: Bookmark,
  memory_delete: Trash2,
  conversation_search: MessageCircle,
  recent_chats: MessageCircle,
  read_conversation: MessageCircle,
  present_files: FolderOpen
}

function iconFor(toolName: string): LucideIcon {
  if (toolName.startsWith('create_')) return FilePlus
  if (TOOL_ICONS[toolName]) return TOOL_ICONS[toolName]
  // Bot tool names aren't fixed yet (bots/tools/** is being built alongside this UI), so unrecognized
  // names fall back to a keyword guess instead of the generic wrench where a better one is obvious.
  const lower = toolName.toLowerCase()
  if (lower.includes('screenshot')) return Camera
  if (lower.includes('whatsapp')) return MessageCircle
  if (lower.includes('handoff')) return Share2
  if (lower.includes('browser') || lower.includes('web') || lower.includes('weather') || lower.includes('places') || lower.includes('sports')) return Globe
  if (lower.includes('screen')) return Monitor
  return Wrench
}

/** The colour family a step's icon is tinted with, so a run's kinds of work are told apart at a glance. */
function tintFor(toolName: string): string {
  const name = toolName.toLowerCase()
  if (name.startsWith('memory_') || name === 'remember' || name === 'forget') return 'var(--tint-memory)'
  if (/(display_v0|show_widget|chart|image_search|artifact|recommendation|compose)/.test(name)) return 'var(--tint-visual)'
  if (/(bash|command|shell|script|workflow)/.test(name)) return 'var(--tint-shell)'
  if (/(web|browser|fetch|search_mcp|weather|places|sports|url)/.test(name)) return 'var(--tint-web)'
  if (/(file|read|write|edit|str_replace|view|list|glob|grep|path|document|create_)/.test(name)) return 'var(--tint-file)'
  return 'var(--ink-faint)'
}

function StepMark({ state }: { state: ToolItemState }) {
  if (state === 'done')
    return (
      <span className="step-mark-done" aria-label="Done">
        <Check size={11} strokeWidth={3} aria-hidden="true" />
      </span>
    )
  if (state === 'error')
    return (
      <span className="step-failed">
        <OctagonX size={13} aria-hidden="true" />
        Failed
      </span>
    )
  if (state === 'denied') return <span className="step-failed">Denied</span>
  if (state === 'running') return <StatusMark kind="working" />
  return null
}

/** "+12 −3", green and red, for a step that changed a file. */
function DiffCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <span className="step-diff" aria-label={`${added} lines added, ${removed} removed`}>
      {added > 0 && <span className="diff-added">+{added.toLocaleString()}</span>}
      {removed > 0 && <span className="diff-removed">−{removed.toLocaleString()}</span>}
    </span>
  )
}

export function ActivityGroup({ items }: { items: ToolItem[] }) {
  // Open while the steps are live, so you can watch the work happen; folded once they finish,
  // unless you opened or closed it yourself.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const summary = summarizeActivity(items)
  const expanded = chosen ?? summary.running
  const total = items.reduce(
    (sum, item) => {
      const diff = stepDiff(item)
      return diff ? { added: sum.added + diff.added, removed: sum.removed + diff.removed } : sum
    },
    { added: 0, removed: 0 }
  )

  return (
    <div className="msg-in">
      <button
        type="button"
        className="activity-line"
        aria-expanded={expanded}
        onClick={() => setChosen(!expanded)}
      >
        {summary.running ? (
          <Loader2 size={13} className="spin step-spinner shrink-0" aria-hidden="true" />
        ) : expanded ? (
          <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
        )}
        <span className={summary.running ? 'pulse-txt min-w-0' : 'min-w-0'}>
          {summary.text}
          {summary.failed > 0 && <span style={{ color: 'var(--bad)' }}>{` · ${summary.failed} failed`}</span>}
          {summary.denied > 0 && <span style={{ color: 'var(--bad)' }}>{` · ${summary.denied} denied`}</span>}
          <DiffCount added={total.added} removed={total.removed} />
        </span>
      </button>

      {expanded && (
        <div className="steps mb-2 flex flex-col">
          {items.map((item) => {
            const Icon = iconFor(item.toolName)
            const isOpen = opened === item.id
            const imageUrl = extractImageUrl(item.output)
            const diff = stepDiff(item)
            return (
              <div key={item.id} className={`step msg-in ${item.state === 'error' ? 'step-row-failed' : ''}`}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-lg px-1 py-1.5 text-left font-mono text-[13px] text-ink hover:bg-oat"
                  aria-expanded={isOpen}
                  aria-label={stepLabel(item)}
                  onClick={() => setOpened(isOpen ? null : item.id)}
                >
                  {item.state === 'running' ? (
                    <Loader2 size={13} className="spin step-spinner mt-0.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <Icon size={13} className="mt-0.5 shrink-0" style={{ color: item.state === 'error' ? 'var(--bad)' : tintFor(item.toolName) }} aria-hidden="true" />
                  )}
                  <span className={`step-label min-w-0 flex-1 break-words ${item.state === 'running' ? 'shimmer-txt' : ''}`}>
                    {stepLabel(item)}
                    {diff && <DiffCount added={diff.added} removed={diff.removed} />}
                  </span>
                  <span className="shrink-0">
                    <StepMark state={item.state} />
                  </span>
                </button>
                {isOpen && (
                  <div className="ml-6 mb-1 rounded-xl border border-rule bg-card p-2">
                    {item.state === 'error' && item.error && (
                      <div className="mb-1 font-sans text-[13px]" style={{ color: 'var(--bad)' }}>
                        {item.error}
                      </div>
                    )}
                    {imageUrl && (
                      <img
                        src={imageUrl}
                        alt={`Screenshot from ${stepLabel(item)}`}
                        className="mb-2 max-h-[280px] max-w-full rounded-lg border border-rule"
                      />
                    )}
                    <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-muted">
                      {prettyJSON(item.input)}
                      {item.output !== undefined && !imageUrl ? `\n\n${prettyJSON(item.output, 4000)}` : ''}
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}