import type {
  AttachedTerminalState,
  TerminalOnboardingState,
  TerminalSessionState,
  TerminalTool
} from '../../../shared/protocol'

export const TOOL_LABELS: Record<TerminalTool, string> = {
  opencode: 'OpenCode',
  agy: 'Antigravity'
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
