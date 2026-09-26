import { useState } from 'react'
import { LayoutGrid, Plus } from 'lucide-react'
import { useStore } from '../lib/store'
import { TerminalStatusMark } from './TerminalStatusMark'
import { StartTerminalSessionDialog } from './StartTerminalSessionDialog'
import { TOOL_LABELS } from '../lib/terminals'

export function AgentsSidebar() {
  const sessions = useStore((s) => s.terminalSessions)
  const attached = useStore((s) => s.attachedTerminalSessions)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const [startOpen, setStartOpen] = useState(false)

  const selectedSessionId = view.name === 'agents-session' ? view.sessionId : null
  const selectedAttachId = view.name === 'agents-attach' ? view.sessionId : null
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-sidebar">
      <div className="scroll-area flex flex-1 flex-col overflow-y-auto p-2">
        <div className="sidebar-nav">
          <button
            type="button"
            className={`sidebar-row ${view.name === 'agents-home' ? 'sidebar-row-active' : ''}`}
            onClick={() => navigate({ name: 'agents-home' })}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            <span>Overview</span>
          </button>
          <button type="button" className="sidebar-row" onClick={() => setStartOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            <span>New session</span>
          </button>
        </div>

        <div className="caption mt-4 px-3">Attached terminals</div>
        <div className="sidebar-nav mt-1">
          {[...attached]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sidebar-row ${selectedAttachId === item.id ? 'sidebar-row-active' : ''}`}
                onClick={() => navigate({ name: 'agents-attach', sessionId: item.id })}
                title={`pid ${item.pid}`}
              >
                <TerminalStatusMark state={item.state} />
                <span className="min-w-0 flex-1 truncate">{TOOL_LABELS[item.tool]} · pid {item.pid}</span>
              </button>
            ))}
          {attached.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-faint">Nothing attached.</p>}
        </div>

        <div className="caption mt-4 px-3 pt-2">Managed sessions</div>
        <div className="sidebar-nav mt-1">
          {sorted.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`sidebar-row ${selectedSessionId === session.id ? 'sidebar-row-active' : ''}`}
              onClick={() => navigate({ name: 'agents-session', sessionId: session.id })}
              title={session.folder}
            >
              <TerminalStatusMark state={session.state} />
              <span className="min-w-0 flex-1 truncate">
                {TOOL_LABELS[session.tool]} · {session.folder.split(/[\\/]/).filter(Boolean).pop() ?? session.folder}
              </span>
            </button>
          ))}
          {sorted.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-faint">No sessions yet.</p>}
        </div>
      </div>

      <div className="sidebar-nav border-t border-rule p-2">
        <button type="button" className="sidebar-row" onClick={() => navigate({ name: 'settings' })}>
          <span>Settings</span>
        </button>
      </div>

      <StartTerminalSessionDialog open={startOpen} onClose={() => setStartOpen(false)} />
    </aside>
  )
}
