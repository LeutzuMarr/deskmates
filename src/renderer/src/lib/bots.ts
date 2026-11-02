import type { EngineStep, EngineStepState, HandoffState, PcState, RunState } from '../../../shared/protocol'

export function pcStateLabel(state: PcState): string {
  switch (state) {
    case 'absent':
      return 'Not created yet'
    case 'stopped':
      return 'Stopped'
    case 'starting':
      return 'Starting…'
    case 'running':
      return 'Running'
    case 'error':
      return 'Error'
  }
}

export function runStateLabel(state: RunState): string {
  switch (state) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'waiting-approval':
      return 'Waiting for approval'
    case 'done':
      return 'Done'
    case 'error':
      return 'Error'
    case 'stopped':
      return 'Stopped'
  }
}

export function handoffStateLabel(state: HandoffState): string {
  switch (state) {
    case 'pending':
      return 'Queued for the bot'
    case 'running':
      return 'Running'
    case 'done':
      return 'Done'
    case 'error':
      return 'Error'
  }
}

export const ENGINE_STEP_ORDER: readonly EngineStep[] = ['wsl', 'distro', 'docker', 'image']

/** True when bot PCs run inside a WSL distro this app has to create, which is Windows-only: on
 *  Linux and macOS they run on the host's own Docker, so the first two steps don't exist. Read from
 *  the preload-exposed platform rather than `navigator`, which can't tell the user agents apart. */
export const USES_WSL_ENGINE = window.deskmates.platform === 'win32'

/** The setup steps that apply on this platform. On Windows that's all four; elsewhere it's Docker and
 *  the image, since there's no distro to create or WSL to enable. */
export const ENGINE_STEPS: readonly EngineStep[] = USES_WSL_ENGINE ? ENGINE_STEP_ORDER : ['docker', 'image']

export const ENGINE_STEP_LABELS: Record<EngineStep, string> = {
  wsl: 'Windows Subsystem for Linux',
  distro: 'Deskmates engine',
  docker: 'Docker',
  image: 'Bot PC image'
}

export function engineStepNote(state: EngineStepState): string | null {
  switch (state) {
    case 'needs-admin':
      // Only ever reached on Windows — off it, nothing needs elevation, so the prompt never appears.
      return 'This step needs your permission — Windows will show an administrator prompt.'
    case 'needs-restart':
      return 'Restart your PC to finish this step, then reopen Deskmates and continue setup.'
    default:
      return null
  }
}

/** Whole-megabyte bounds `pcs.update` accepts for a PC's memory cap (matches the core handler). */
export const MEMORY_MB_MIN = 512
export const MEMORY_MB_MAX = 8192

/** Whole-minute bounds `pcs.update` accepts for the idle-stop timer; 0 means "keep running". */
export const IDLE_STOP_MIN = 0
export const IDLE_STOP_MAX = 1440

/** Tool names a bot's runs are most likely to need sign-off for, offered as quick-add suggestions
 *  next to the free-form "allowed without asking" field. The exact identifiers the runner uses
 *  aren't set yet (bots/runner.ts and bots/tools/** are being built alongside this UI), so the
 *  field also accepts any typed name rather than only these. */
export const SUGGESTED_AUTO_APPROVE_TOOLS: readonly { name: string; hint: string }[] = [
  { name: 'whatsapp_send', hint: 'Send a WhatsApp message' },
  { name: 'handoff', hint: 'Hand work to another bot' },
  { name: 'write', hint: "Write files on the bot's PC" }
]

const CRON_PRESETS: readonly { label: string; cron: string }[] = [
  { label: 'Daily at 08:00', cron: '0 8 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' }
]
export { CRON_PRESETS }

/** Loose E.164 check for `Settings.whatsappTo`: a `+`, then 7–15 digits, no spaces or punctuation.
 *  An empty string (not set up yet) is valid — it just means bots have nowhere to send to yet. */
const WHATSAPP_NUMBER_RE = /^\+[1-9]\d{6,14}$/
export function isValidWhatsAppNumber(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || WHATSAPP_NUMBER_RE.test(trimmed)
}
