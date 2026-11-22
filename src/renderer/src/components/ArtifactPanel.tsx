import { useEffect, useRef, useState } from 'react'
import { AppWindow, ChevronRight, ExternalLink, Maximize2, Minimize2, RotateCw, X } from 'lucide-react'
import { useStore } from '../lib/store'
import type { TimelineItem, ToolItem } from '../../../shared/protocol'

/** What an Artifact call showed: its page in the chat's widget store, its title and project file. */
export function artifactOf(item: TimelineItem): { src: string; title: string; file: string } | null {
  if (item.kind !== 'tool' || item.toolName !== 'Artifact' || item.state !== 'done') return null
  const output = (item.output ?? {}) as { widget?: unknown; title?: unknown; file?: unknown }
  if (typeof output.widget !== 'string' || !output.widget.startsWith('deskmates-preview://widget/')) return null
  const file = typeof output.file === 'string' ? output.file : ''
  return { src: output.widget, title: typeof output.title === 'string' && output.title ? output.title : file || 'Artifact', file }
}

/**
 * An artifact in the chat, as Claude shows one: a card with its title that opens it in the panel
 * beside the chat. A new artifact made while the reply is running opens there by itself.
 */
export function ArtifactCard({ taskId, item, running }: { taskId: string; item: ToolItem; running: boolean }) {
  const artifact = artifactOf(item)
  const open = useStore((s) => s.artifact)
  const setArtifact = useStore((s) => s.setArtifact)
  const opened = useRef(false)
  useEffect(() => {
    if (artifact && running && !opened.current) {
      opened.current = true
      setArtifact({ taskId, itemId: item.id })
    }
  }, [artifact !== null, running])
  if (item.state === 'error') {
    return <div className="msg-in rounded-2xl border border-[color:var(--danger,#b3412f)]/40 px-4 py-3 text-[13px] text-[color:var(--danger,#b3412f)]">Couldn't show the artifact: {typeof item.output === 'string' ? item.output : 'it failed.'}</div>
  }
  if (!artifact) return item.state === 'running' ? <div className="msg-in shimmer-txt text-[13px] text-ink-muted">Making the artifact…</div> : null
  const isOpen = open?.taskId === taskId && open.itemId === item.id
  return (
    <button type="button" className={`artifact-card msg-in ${isOpen ? 'is-open' : ''}`} onClick={() => setArtifact(isOpen ? null : { taskId, itemId: item.id })} aria-pressed={isOpen}>
      <span className="artifact-icon">
        <AppWindow size={16} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[14px] text-ink">{artifact.title}</span>
        <span className="block truncate text-[12px] text-ink-faint">{isOpen ? 'Open beside the chat · click to close' : `${artifact.file || 'Page'} · click to open`}</span>
      </span>
      <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-ink-faint" />
    </button>
  )
}

/**
 * The artifact panel beside the chat: the page full height, its versions in this chat (every time
 * the agent showed the same file again), reload, wider, open the file, close.
 */
export function ArtifactPanel({ timeline, folder }: { timeline: TimelineItem[]; folder: string | null }) {
  const open = useStore((s) => s.artifact)
  const setArtifact = useStore((s) => s.setArtifact)
  const showToast = useStore((s) => s.showToast)
  const [wide, setWide] = useState(false)
  const [reload, setReload] = useState(0)
  const item = open ? timeline.find((t) => t.id === open.itemId) : undefined
  const artifact = item ? artifactOf(item) : null
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && open && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLInputElement)) setArtifact(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setArtifact])
  if (!open || !artifact) return null
  const versions = timeline.filter((t) => {
    const a = artifactOf(t)
    return a !== null && (artifact.file ? a.file === artifact.file : a.title === artifact.title)
  })
  const index = versions.findIndex((v) => v.id === open.itemId)
  const openFile = (): void => {
    if (!folder || !artifact.file) return
    const sep = folder.includes('\\') ? '\\' : '/'
    const path = `${folder.replace(/[\\/]+$/, '')}${sep}${artifact.file.replace(/[\\/]/g, sep)}`
    window.deskmates.openPath(path).catch((error: unknown) => showToast(`Couldn't open the file: ${error instanceof Error ? error.message : String(error)}`))
  }
  return (
    <aside className={`artifact-panel ${wide ? 'is-wide' : ''}`} aria-label={`Artifact: ${artifact.title}`}>
      <header className="artifact-head">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-medium text-ink">{artifact.title}</h2>
          {artifact.file && <p className="truncate text-[12px] text-ink-faint">{artifact.file}</p>}
        </div>
        {versions.length > 1 && (
          <select
            className="artifact-versions"
            aria-label="Version"
            value={open.itemId}
            onChange={(event) => setArtifact({ taskId: open.taskId, itemId: event.target.value })}
          >
            {versions.map((v, n) => (
              <option key={v.id} value={v.id}>
                Version {n + 1}
                {n === versions.length - 1 ? ' (latest)' : ''}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="copy-btn h-8 w-8 justify-center p-0" aria-label="Reload" title="Reload" onClick={() => setReload((n) => n + 1)}>
          <RotateCw size={14} aria-hidden="true" />
        </button>
        <button type="button" className="copy-btn h-8 w-8 justify-center p-0" aria-label={wide ? 'Narrower' : 'Wider'} title={wide ? 'Narrower' : 'Wider'} onClick={() => setWide((v) => !v)}>
          {wide ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
        </button>
        {artifact.file && folder && (
          <button type="button" className="copy-btn h-8 w-8 justify-center p-0" aria-label="Open the file" title="Open the file on this computer" onClick={openFile}>
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="copy-btn h-8 w-8 justify-center p-0" aria-label="Close the artifact" title="Close (Esc)" onClick={() => setArtifact(null)}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>
      {versions.length > 1 && index >= 0 && index < versions.length - 1 && <div className="artifact-note">You're looking at version {index + 1}; a newer one is in the chat.</div>}
      <iframe key={`${open.itemId}-${reload}`} title={artifact.title} src={artifact.src} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals" className="artifact-frame" />
    </aside>
  )
}
