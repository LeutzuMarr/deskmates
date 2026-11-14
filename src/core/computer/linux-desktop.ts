import { spawn } from 'node:child_process'
import type { CommandRunner } from '../bots/command-runner'
import type { Desktop, MouseButton, Screenshot } from './desktop'

/** Screenshot tools, best first: each must write a JPEG of the whole screen to a file. */
const CAPTURE_TOOLS: readonly { file: string; args: (out: string) => string[] }[] = [
  { file: 'import', args: (out) => ['-window', 'root', '-resize', '%d%', '-quality', '75', 'jpeg:' + out] },
  { file: 'scrot', args: (out) => ['-o', '-q', '80', '-Z', '%d%', out] },
  { file: 'gnome-screenshot', args: (out) => ['-f', '-q', '75', '-w', '-F', out] }
]

/** X11 keysym names for the keys the model sends, which are named the Windows way. */
const KEYSYMS: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'space',
  capslock: 'Caps_Lock',
  printscreen: 'Print'
}

const XDOTOOL_BUTTON: Record<MouseButton, string> = { left: '1', right: '3', middle: '2' }

/** X11 has no modifiers of its own, so "win" is the same physical key as "super". */
const MODIFIERS: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  win: 'super',
  super: 'super',
  meta: 'super',
  cmd: 'super',
  command: 'super'
}

export interface LinuxDesktopDeps {
  runner: CommandRunner
  env?: Record<string, string | undefined>
  readFile: (path: string) => Buffer
  removeFile: (path: string) => void
  now?: () => number
}

/**
 * Drives the desktop on Linux through X11 tools: `xdotool` for the mouse and keyboard, and one of
 * ImageMagick's `import`, `scrot` or `gnome-screenshot` for the screen. Nothing is compiled or run
 * with privileges, so it works on a stock Ubuntu desktop; the tools are the usual X11 utilities and
 * `import`/`scrot` are only needed while a session is running.
 *
 * Wayland does not let any other program move the pointer or read the screen, so `xdotool` cannot
 * reach it. The session fails with that explained rather than pretending to work; running the app
 * under XWayland (`XDG_SESSION_TYPE=x11`, `QT_QPA_PLATFORM=xcb`) is the way through.
 */
export class LinuxDesktop implements Desktop {
  private readonly env: Record<string, string | undefined>
  private screen: { width: number; height: number } | null = null

  constructor(private readonly deps: LinuxDesktopDeps) {
    this.env = deps.env ?? process.env
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) this.env.DISPLAY = ':0'
  }

  /** Fails with a readable reason when the tools or the session can't drive the screen. */
  async check(): Promise<void> {
    const session = this.env.XDG_SESSION_TYPE ?? (this.env.WAYLAND_DISPLAY ? 'wayland' : 'x11')
    if (session === 'wayland') {
      throw new Error(
        'Computer use needs an X11 session: on Wayland, only the logged-in desktop may move the mouse or read the screen. Log in with an X11 session (for example Xorg) or set XDG_SESSION_TYPE=x11 and QT_QPA_PLATFORM=xcb.'
      )
    }
    const probe = await this.deps.runner.run('xdotool', ['getdisplaygeometry'], { timeoutMs: 5_000 })
    if (probe.code !== 0) {
      throw new Error(
        `Computer use on Linux needs \`xdotool\` (package xdotool) and an X11 session. ${(probe.stderr || probe.stdout).trim().slice(0, 200)}`.trim()
      )
    }
  }

  async screenshot(maxWidth: number): Promise<Screenshot> {
    const size = await this.screenSize()
    const scaled = size.width > maxWidth ? (maxWidth / size.width) * size.height : size.height
    const out = `/tmp/deskmates-shot-${(this.deps.now ?? Date.now)()}.jpg`
    try {
      let last = ''
      for (const tool of CAPTURE_TOOLS) {
        const result = await this.deps.runner.run(tool.file, tool.args(out), { timeoutMs: 20_000 })
        if (result.code === 0) {
          const height = Math.max(1, Math.round(scaled))
          return {
            data: this.deps.readFile(out).toString('base64'),
            width: size.width > maxWidth ? maxWidth : size.width,
            height,
            screenWidth: size.width,
            screenHeight: size.height
          }
        }
        last = (result.stderr || result.stdout).trim().slice(0, 120)
      }
      throw new Error(`Couldn't take a screenshot: install \`imagemagick\` or \`scrot\`. ${last}`)
    } finally {
      this.deps.removeFile(out)
    }
  }

  /** `xdotool getdisplaygeometry` is cheap but not free, so the answer is kept for the session. */
  private async screenSize(): Promise<{ width: number; height: number }> {
    if (this.screen) return this.screen
    const result = await this.deps.runner.run('xdotool', ['getdisplaygeometry'], { timeoutMs: 5_000 })
    if (result.code !== 0) throw new Error(`Couldn't read the screen size: ${(result.stderr || result.stdout).trim().slice(0, 200)}`.trim())
    const [width, height] = result.stdout.trim().split(/\s+/).map((value) => Number(value))
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`xdotool didn't report a usable screen size ("${result.stdout.trim()}").`)
    }
    this.screen = { width, height }
    return this.screen
  }

  async move(x: number, y: number): Promise<void> {
    await this.xdotool(['mousemove', String(x), String(y)])
  }

  async click(x: number, y: number, button: MouseButton, count: number): Promise<void> {
    const times = Math.max(1, count)
    await this.xdotool(['mousemove', String(x), String(y), 'click', '--repeat', String(times), '--delay', '60', XDOTOOL_BUTTON[button]])
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    // xdotool's mousedown/mouseup around a stepped mousemove, the same shape the Windows helper uses,
    // because a single instant jump is treated as a click and never as a drag.
    await this.xdotool(['mousemove', String(fromX), String(fromY), 'mousedown', '1'])
    for (let step = 1; step <= 12; step++) {
      await this.xdotool(['mousemove', String(Math.round(fromX + ((toX - fromX) * step) / 12)), String(Math.round(fromY + ((toY - fromY) * step) / 12))])
    }
    await this.xdotool(['mouseup', '1'])
  }

  async scroll(x: number, y: number, amount: number): Promise<void> {
    // Positive amount is "scroll down" for the model, which is button 5; 4 scrolls up.
    const button = amount > 0 ? '5' : '4'
    const notches = Math.min(Math.abs(amount), 20)
    await this.xdotool(['mousemove', String(x), String(y), 'click', '--repeat', String(notches), button])
  }

  async type(text: string): Promise<void> {
    await this.xdotool(['type', '--delay', '12', '--clearmodifiers', text.replace(/\r?\n/g, 'Return')])
  }

  async key(combo: string): Promise<void> {
    const parts = combo
      .toLowerCase()
      .replace(/\s+/g, '')
      .split('+')
      .filter(Boolean)
      .map((part) => keysym(part))
    if (parts.length === 0) throw new Error(`Unknown key: ${combo}`)
    await this.xdotool(['key', '--clearmodifiers', parts.join('+')])
  }

  async openUrl(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only web addresses can be opened.')
    // xdg-open hands the address to the default browser; no shell is involved, so nothing in it runs.
    const child = spawn('xdg-open', [parsed.toString()], { detached: true, stdio: 'ignore', env: this.env as NodeJS.ProcessEnv })
    child.on('error', () => undefined)
    child.unref()
  }

  close(): void {
    // Nothing is kept running between actions, so there is nothing to close.
  }

  private async xdotool(args: string[]): Promise<void> {
    const result = await this.deps.runner.run('xdotool', args, { timeoutMs: 15_000, env: this.env as Record<string, string> })
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 200) || 'The desktop action failed.')
  }
}

/** One part of a key combo as an X11 keysym: a named key, a function key, or a single character. */
export function keysym(part: string): string {
  const modifier = MODIFIERS[part]
  if (modifier) return modifier
  const named = KEYSYMS[part]
  if (named) return named
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(part)
  if (functionKey) return functionKey[1]
  if (part.length === 1) return part
  throw new Error(`Unknown key: ${part}`)
}