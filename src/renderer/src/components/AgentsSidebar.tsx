import { useState } from 'react'
import { LayoutGrid, Plus } from 'lucide-react'
import { useStore } from '../lib/store'
import { StartTerminalSessionDialog } from './StartTerminalSessionDialog'
import { SidebarEmpty, SidebarFrame, SidebarGroup, SidebarRow } from './SidebarParts'
import { strongestMark, terminalMark } from './StatusMark'
import type { MarkKind } from './StatusMark'
import { TOOL_LABELS, folderName, groupSessionsByFolder } from '../lib/terminals'
import type { AttachedTerminalSession } from '../../../shared/protocol'

/** A terminal that is showing a permission question is waiting for the user, whatever else it is doing. */
function attachedMark(session: AttachedTerminalSession): MarkKind {
  return session.permission ? 'attention' : terminalMark(session.state)
}

export function AgentsSidebar() {
  const sessions = useStore((s) => s.terminalSessions)
  const attached = useStore((s) => s.attachedTerminalSessions)
  const detected = useStore((s) => s.detectedAgents)
  const unread = useStore((s) => s.unread)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  // null: closed. A string: open, starting in that folder ('' lets the dialog ask for one).
  const [startIn, setStartIn] = useState<string | null>(null)

  const selectedSessionId = view.name === 'agents-session' ? view.sessionId : null
  const selectedAttachId = view.name === 'agents-attach' ? view.sessionId : null
  const groups = groupSessionsByFolder(sessions, attached, detected)

  return (
    <SidebarFrame>
      <div className="sidebar-nav">
        <button
          type="button"
          className={`sidebar-row ${view.name === 'agents-home' ? 'sidebar-row-active' : ''}`}
          onClick={() => navigate({ name: 'agents-home' })}
        >
          <LayoutGrid size={16} aria-hidden="true" />
          <span>Overview</span>
        </button>
        <button type="button" className="sidebar-row" onClick={() => setStartIn('')}>
          <Plus size={16} aria-hidden="true" />
          <span>New session</span>
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {groups.map((group) => {
          const marks = [
            ...group.sessions.map((session) => terminalMark(session.state, unread[session.id])),
            ...group.attached.map(attachedMark)
          ]
          return (
            <SidebarGroup
              key={group.id}
              id={`agents:${group.id}`}
              label={group.folder ? folderName(group.folder) : 'Other terminals'}
              title={group.folder ?? 'Attached terminals whose folder is not known'}
              mark={strongestMark(marks)}
              actions={
                group.folder ? (
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`New session in ${folderName(group.folder)}`}
                    title="New session in this folder"
                    onClick={() => setStartIn(group.folder ?? '')}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                ) : undefined
              }
            >
              {group.sessions.map((session) => (
                <SidebarRow
                  key={session.id}
                  label={TOOL_LABELS[session.tool]}
                  detail={session.model ?? undefined}
                  title={`${TOOL_LABELS[session.tool]} · ${session.folder}`}
                  active={selectedSessionId === session.id}
                  mark={terminalMark(session.state, unread[session.id])}
                  onOpen={() => navigate({ name: 'agents-session', sessionId: session.id })}
                />
              ))}
              {group.attached.map((item) => (
                <SidebarRow
                  key={item.id}
                  label={TOOL_LABELS[item.tool]}
                  detail={`pid ${item.pid}`}
                  title={`${TOOL_LABELS[item.tool]} · attached to pid ${item.pid}`}
                  active={selectedAttachId === item.id}
                  mark={attachedMark(item)}
                  onOpen={() => navigate({ name: 'agents-attach', sessionId: item.id })}
                />
              ))}
            </SidebarGroup>
          )
        })}
        {groups.length === 0 && <SidebarEmpty>No sessions yet. Start one, or attach to a terminal from the overview.</SidebarEmpty>}
      </div>

      <StartTerminalSessionDialog open={startIn !== null} initialFolder={startIn ?? ''} onClose={() => setStartIn(null)} />
    </SidebarFrame>
  )
}
