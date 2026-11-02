import type { CommandRunner } from '../bots/command-runner'
import type { Desktop } from '../computer/desktop'
import type { ScreenLook, ScreenMark } from '../../shared/protocol'

/** Screenshots are scaled to this width: enough to read UI text, small enough for a free model. */
export const LOOK_MAX_WIDTH = 1280
export const DEFAULT_MARK_SECONDS = 8
export const MAX_MARK_SECONDS = 60
const MAX_MARKS = 12
const MAX_SAY_CHARS = 2000

/**
 * Speaks the text in `DM_SAY_TEXT` with the Windows system voice. The text travels in an
 * environment variable, so no quoting of it can break the command.
 */
const SAY_SCRIPT =
  "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:DM_SAY_TEXT)"

export interface ScreenGuideOptions {
  createDesktop: () => Desktop
  runner: CommandRunner
  /** Shows marks over the screen (physical pixels) for `seconds`; an empty list clears them. */
  showOverlay: (marks: ScreenMark[], seconds: number) => void
  platform?: NodeJS.Platform
}

/**
 * The screen guide behind the `screen_*` MCP tools: a connected agent (Freebuff, OpenCode, …) looks
 * at the user's screen, points at things on it and talks, the way a person sitting next to them
 * would. It never moves the mouse or types; that is computer use, a different feature.
 */
export class ScreenGuideService {
  private desktop: Desktop | null = null
  /** Physical pixels per screenshot pixel, from the last look; 1 until the agent has looked. */
  private scale = 1

  constructor(private readonly options: ScreenGuideOptions) {}

  async look(): Promise<ScreenLook> {
    this.desktop ??= this.options.createDesktop()
    try {
      const shot = await this.desktop.screenshot(LOOK_MAX_WIDTH)
      this.scale = shot.width > 0 ? shot.screenWidth / shot.width : 1
      return { data: shot.data, width: shot.width, height: shot.height }
    } catch (error) {
      // A helper that died is restarted on the next look rather than reused.
      this.desktop.close()
      this.desktop = null
      throw error
    }
  }

  point(marks: ScreenMark[], seconds?: number): void {
    const clean = marks.slice(0, MAX_MARKS).map((mark) => toPhysical(validMark(mark), this.scale))
    const duration = Math.min(MAX_MARK_SECONDS, Math.max(1, Number.isFinite(seconds) ? Number(seconds) : DEFAULT_MARK_SECONDS))
    this.options.showOverlay(clean, duration)
  }

  clear(): void {
    this.options.showOverlay([], 0)
  }

  async say(text: string): Promise<void> {
    if ((this.options.platform ?? process.platform) !== 'win32') throw new Error('Speaking aloud works on Windows only.')
    const result = await this.options.runner.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SAY_SCRIPT],
      { env: { DM_SAY_TEXT: text.slice(0, MAX_SAY_CHARS) }, timeoutMs: 120_000 }
    )
    if (result.code !== 0) throw new Error(`Couldn't speak: ${result.stderr.trim() || `exit code ${result.code}`}`)
  }

  dispose(): void {
    this.desktop?.close()
    this.desktop = null
  }
}

const KINDS = new Set<ScreenMark['kind']>(['arrow', 'circle', 'box', 'label'])

/** Rejects a mark the overlay can't draw, with a message the agent can act on. */
export function validMark(mark: ScreenMark): ScreenMark {
  if (!mark || !KINDS.has(mark.kind)) throw new Error('Each mark needs a kind: arrow, circle, box or label.')
  if (!Number.isFinite(mark.x) || !Number.isFinite(mark.y)) throw new Error('Each mark needs numeric x and y.')
  if ((mark.kind === 'circle' || mark.kind === 'box') && !(Number(mark.width) > 0 && Number(mark.height) > 0)) {
    throw new Error(`A ${mark.kind} needs a positive width and height.`)
  }
  if (mark.kind === 'label' && !mark.text?.trim()) throw new Error('A label needs text.')
  return mark
}

/** Screenshot pixels to physical screen pixels. */
export function toPhysical(mark: ScreenMark, scale: number): ScreenMark {
  const scaled: ScreenMark = { kind: mark.kind, x: Math.round(mark.x * scale), y: Math.round(mark.y * scale) }
  if (mark.width !== undefined) scaled.width = Math.round(mark.width * scale)
  if (mark.height !== undefined) scaled.height = Math.round(mark.height * scale)
  if (mark.text) scaled.text = mark.text.slice(0, 200)
  return scaled
}
