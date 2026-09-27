import { isCliProvider, PROVIDER_LABELS } from '../../../shared/protocol'
import type { ModelRef, TaskStatus, TimelineItem, ToolItem } from '../../../shared/protocol'

const DAY_MS = 86_400_000

export function formatClock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatDay(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = startOfDay(now) - startOfDay(d)
  if (diff === 0) return 'Today'
  if (diff === DAY_MS) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Short relative time for cards: "Just now", "12 min ago", "3 hours ago", then the day. */
export function formatRelative(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return formatDay(at)
}

/** Short processing time for reply badges: "3.2 s", "42 s", "2m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, ms)
  const seconds = total / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} s`
  const whole = Math.round(seconds)
  if (whole < 60) return `${whole} s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'waiting-approval':
      return 'Waiting for approval'
    case 'error':
      return 'Error'
    case 'idle':
      return 'Idle'
  }
}

/** What to say while a run is up but has produced nothing yet. */
export interface StartingNotice {
  label: string
  hint: string
}

/** Whether a run is up but has produced nothing since the prompt — the window in which a CLI-backed
 *  provider is still booting.
 *
 *  Keyed off the shape of the timeline rather than a status flag because the user bubble is persisted
 *  and broadcast *before* the run starts: for the whole of the cold start the transcript holds one
 *  item, the prompt, and nothing after it. */
export function awaitingFirstOutput(timeline: TimelineItem[], running: boolean): boolean {
  if (!running) return false
  for (let k = timeline.length - 1; k >= 0; k--) if (timeline[k].kind === 'user') return k === timeline.length - 1
  // Running with no prompt in this timeline at all (a scheduled bot run, say) is silent by definition.
  return true
}

/** The notice to show for this model's start-up, or null when it doesn't need one.
 *
 *  A CLI-backed provider boots a whole agent process before it says anything, and on a cold start
 *  that is tens of seconds of silence. Naming it stops the wait reading as a hang. API-backed
 *  providers stream a token almost immediately, so they keep the plain working row. */
export function startingNotice(model: ModelRef | null | undefined): StartingNotice | null {
  const provider = model?.provider
  if (!provider || !isCliProvider(provider)) return null
  return {
    label: `Starting ${PROVIDER_LABELS[provider]}…`,
    hint: 'It boots a whole agent process before it replies — this can take a minute.'
  }
}

export function greeting(date: Date): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function toolLabel(toolName: string, input: unknown): string {
  const inputObj = (input ?? {}) as Record<string, unknown>
  const str = (value: unknown): string => (typeof value === 'string' ? value : String(value))
  switch (toolName) {
    case 'write_file':
      return `Wrote ${str(inputObj.path)}`
    case 'edit_file':
      return `Edited ${str(inputObj.path)}`
    case 'read_file':
      return `Read ${str(inputObj.path)}`
    case 'list_files':
      return `Listed ${str(inputObj.path)}`
    case 'read_document':
      return `Read ${str(inputObj.path)}`
    case 'search_files':
      return `Searched for "${str(inputObj.query)}"`
    case 'move_path':
      return `Moved ${str(inputObj.from)} → ${str(inputObj.to)}`
    case 'delete_path':
      return `Delete ${str(inputObj.path)}`
    case 'run_command': {
      const command = str(inputObj.command)
      return `Run: ${command.slice(0, 80)}`
    }
    case 'update_plan':
      return 'Updated the plan'
    case 'remember':
      return 'Saved a memory'
    case 'forget':
      return 'Forgot a memory'
    case 'notify_user':
      return 'Sent a notification'
    default:
      if (toolName.startsWith('create_')) return `Created ${str(inputObj.path)}`
      return humanizeToolName(toolName)
  }
}

/** Turns an unrecognized tool identifier like `browser_open_page` or `screen.click` into "Browser open page". */
function humanizeToolName(toolName: string): string {
  const words = toolName.split(/[_.\-\s]+/).filter(Boolean)
  if (words.length === 0) return toolName
  return words.map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ')
}

/**
 * Pulls an image data URL out of a tool item's output, when there is one — used to show a bot
 * run's screenshots as thumbnails instead of raw JSON. Checks the output itself, then a handful
 * of likely field names, since the exact shape the screen/browser tools return isn't fixed yet.
 */
export function extractImageUrl(output: unknown): string | null {
  const isImageDataUrl = (value: unknown): value is string => typeof value === 'string' && value.startsWith('data:image/')
  if (isImageDataUrl(output)) return output
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    for (const key of ['screenshot', 'image', 'dataUrl', 'png', 'src']) {
      if (isImageDataUrl(obj[key])) return obj[key] as string
    }
  }
  return null
}

export interface ActivitySummary {
  text: string
  failed: number
  denied: number
  running: boolean
}

export function summarizeActivity(tools: ToolItem[]): ActivitySummary {
  const failed = tools.filter((t) => t.state === 'error').length
  const denied = tools.filter((t) => t.state === 'denied').length
  const running = tools.some((t) => t.state === 'running')
  if (running) {
    const lastRunning = [...tools].reverse().find((t) => t.state === 'running')
    return { text: `Working… ${toolLabel(lastRunning?.toolName ?? '', lastRunning?.input)}`, failed, denied, running }
  }
  if (tools.length === 1) {
    return { text: toolLabel(tools[0].toolName, tools[0].input), failed, denied, running }
  }
  const count = (match: (t: ToolItem) => boolean): number => tools.filter(match).length
  const plural = (n: number, one: string): string => (n === 1 ? one : `${one}s`)
  const parts: string[] = []
  const readCount = count((t) => t.toolName === 'read_file' || t.toolName === 'read_document')
  if (readCount > 0) parts.push(`read ${readCount} ${plural(readCount, 'file')}`)
  const searched = count((t) => t.toolName === 'search_files')
  if (searched > 0) parts.push(`searched ${searched} ${plural(searched, 'time')}`)
  const listed = count((t) => t.toolName === 'list_files')
  if (listed > 0) parts.push(`listed ${listed} ${plural(listed, 'folder')}`)
  const wrote = count((t) => t.toolName === 'write_file')
  if (wrote > 0) parts.push(`wrote ${wrote} ${plural(wrote, 'file')}`)
  const edited = count((t) => t.toolName === 'edit_file')
  if (edited > 0) parts.push(`edited ${edited} ${plural(edited, 'file')}`)
  const moved = count((t) => t.toolName === 'move_path')
  if (moved > 0) parts.push(`moved ${moved} ${plural(moved, 'item')}`)
  const deleted = count((t) => t.toolName === 'delete_path')
  if (deleted > 0) parts.push(`deleted ${deleted} ${plural(deleted, 'item')}`)
  const ran = count((t) => t.toolName === 'run_command')
  if (ran > 0) parts.push(`ran ${ran} ${plural(ran, 'command')}`)
  const created = count((t) => t.toolName.startsWith('create_'))
  if (created > 0) parts.push(`created ${created} ${plural(created, 'document')}`)
  if (count((t) => t.toolName === 'update_plan') > 0) parts.push('updated the plan')
  const saved = count((t) => t.toolName === 'remember')
  if (saved > 0) parts.push(`saved ${saved} ${plural(saved, 'memory')}`)
  if (count((t) => t.toolName === 'notify_user') > 0) parts.push('sent a notification')
  const joined = parts.join(', ')
  const text = joined.length > 0 ? joined.charAt(0).toUpperCase() + joined.slice(1) : ''
  return { text, failed, denied, running }
}

export function prettyJSON(value: unknown, max?: number): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (max !== undefined && text.length > max) text = `${text.slice(0, max)}\n[output cut]`
  return text
}