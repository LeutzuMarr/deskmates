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
import { extractImageUrl, prettyJSON, summarizeActivity, toolLabel } from '../lib/format'
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
  notify_user: Bell
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
  if (lower.includes('browser')) return Globe
  if (lower.includes('screen')) return Monitor
  return Wrench
}

function StatusMark({ state }: { state: ToolItemState }) {
  if (state === 'done') return <Check size={13} aria-hidden="true" style={{ color: 'var(--olive)' }} />
  if (state === 'error') return <OctagonX size={13} aria-hidden="true" style={{ color: 'var(--brick)' }} />
  if (state === 'denied') return <span className="italic text-ink-faint">denied</span>
  if (state === 'running') return <span className="mark-dot pulse-txt" style={{ background: 'var(--ink-muted)' }} />
  return null
}

export function ActivityGroup({ items }: { items: ToolItem[] }) {
  const [expanded, setExpanded] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const summary = summarizeActivity(items)

  return (
    <div className="msg-in">
      <button
        type="button"
        className="activity-line"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {summary.running ? (
          <Loader2 size={13} className="spin shrink-0" style={{ color: 'var(--ink-muted)' }} aria-hidden="true" />
        ) : expanded ? (
          <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
        )}
        <span className={summary.running ? 'pulse-txt min-w-0' : 'min-w-0'}>
          {summary.text}
          {summary.failed > 0 && <span style={{ color: 'var(--brick)' }}>{` · ${summary.failed} failed`}</span>}
          {summary.denied > 0 && <span style={{ color: 'var(--brick)' }}>{` · ${summary.denied} denied`}</span>}
        </span>
      </button>

      {expanded && (
        <div className="mb-2 flex flex-col">
          {items.map((item) => {
            const Icon = iconFor(item.toolName)
            const isOpen = opened === item.id
            const imageUrl = extractImageUrl(item.output)
            return (
              <div key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-lg px-1 py-1.5 text-left font-mono text-[13px] text-ink hover:bg-oat"
                  aria-expanded={isOpen}
                  aria-label={toolLabel(item.toolName, item.input)}
                  onClick={() => setOpened(isOpen ? null : item.id)}
                >
                  <Icon size={13} className="mt-0.5 shrink-0 text-ink-faint" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words">{toolLabel(item.toolName, item.input)}</span>
                  <span className="shrink-0">
                    <StatusMark state={item.state} />
                  </span>
                </button>
                {isOpen && (
                  <div className="ml-6 mb-1 rounded-xl border border-rule bg-card p-2">
                    {item.state === 'error' && item.error && (
                      <div className="mb-1 font-sans text-[13px]" style={{ color: 'var(--brick)' }}>
                        {item.error}
                      </div>
                    )}
                    {imageUrl && (
                      <img
                        src={imageUrl}
                        alt={`Screenshot from ${toolLabel(item.toolName, item.input)}`}
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