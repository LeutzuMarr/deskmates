import type {
  AttachedTerminalSession,
  AttachedTerminalState,
  DetectedTerminalAgent,
  TerminalOnboardingState,
  TerminalSession,
  TerminalSessionState,
  TerminalTool
} from '../../../shared/protocol'

export const TOOL_LABELS: Record<TerminalTool, string> = {
  opencode: 'OpenCode',
  agy: 'Antigravity',
  freebuff: 'Freebuff'
}

export function sessionStateLabel(state: TerminalSessionState): string {
  switch (state) {
    case 'starting':
      return 'Starting'
    case 'busy':
      return 'Busy'
    case 'idle':
      return 'Idle'
    case 'error':
      return 'Error'
  }
}

export function attachStateLabel(state: AttachedTerminalState): string {
  switch (state) {
    case 'attaching':
      return 'Connecting'
    case 'priming':
      return 'Checking in'
    case 'connected':
      return 'Connected'
    case 'closed':
      return 'Detached'
    case 'error':
      return 'Error'
  }
}

export function onboardingLabel(state: TerminalOnboardingState): string {
  switch (state) {
    case 'confirmed':
      return 'Knows Deskmates'
    case 'failed':
      return "Didn't confirm"
    case 'primed':
      return 'Checking in…'
    case 'unknown':
      return ''
  }
}

/** Relative "since when" text for a detected process or session, coarse enough not to need a timer tick. */
export function sinceLabel(epochMs: number | null): string {
  if (epochMs === null) return 'unknown start time'
  const minutes = Math.max(0, Math.round((Date.now() - epochMs) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/** The last part of a path: the name a folder goes by in a list. */
export function folderName(folder: string): string {
  return folder.split(/[\/]/).filter(Boolean).pop() ?? folder
}

export interface SessionGroup {
  /** The folder, normalised so `C:\Work\app` and `c:/work/app/` land together; `''` when unknown. */
  id: string
  folder: string | null
  sessions: TerminalSession[]
  attached: AttachedTerminalSession[]
}

function folderKey(folder: string): string {
  return folder.replace(/[\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * Sorts every agent session under the folder it works in, the way a sidebar lists projects.
 * A managed session knows its folder. An attached terminal only knows its pid, so its folder comes
 * from the running process with that pid; when that isn't known it goes in a last, folder-less group.
 * The order is stable: folders by name, sessions oldest first, so rows never jump while agents work.
 */
export function groupSessionsByFolder(
  sessions: TerminalSession[],
  attached: AttachedTerminalSession[],
  detected: DetectedTerminalAgent[]
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  const groupFor = (folder: string | null): SessionGroup => {
    const id = folder ? folderKey(folder) : ''
    let group = groups.get(id)
    if (!group) {
      group = { id, folder, sessions: [], attached: [] }
      groups.set(id, group)
    }
    return group
  }
  for (const session of sessions) groupFor(session.folder).sessions.push(session)
  for (const item of attached) {
    const folder = detected.find((process) => process.pid === item.pid && process.tool === item.tool)?.folder ?? null
    groupFor(folder).attached.push(item)
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => a.createdAt - b.createdAt)
    group.attached.sort((a, b) => a.createdAt - b.createdAt)
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.folder || !b.folder) return a.folder ? -1 : b.folder ? 1 : 0
    return folderName(a.folder).localeCompare(folderName(b.folder)) || a.id.localeCompare(b.id)
  })
}
