import { closeSync, openSync, readlinkSync, writeSync } from 'node:fs'
import type { CommandRunner } from '../bots/command-runner'
import type { AttachCommand, AttachEvent, AttachHelper } from './attach'
import type { TerminalKey } from './permission'

/** Terminals announce the permission prompts with VT sequences, so these are the ones worth sending. */
const VT_KEYS: Record<string, string> = {
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  space: ' ',
  left: '\x1b[D',
  up: '\x1b[A',
  right: '\x1b[C',
  down: '\x1b[B'
}

/** One keystroke as the terminal should receive it. */
export function keySequence(key: TerminalKey): string {
  const named = VT_KEYS[key.toLowerCase()]
  if (named) return named
  if (key.length === 1) return key
  throw new Error(`Unknown key: ${key}`)
}

export interface LinuxAttachDeps {
  runner: CommandRunner
  /** The terminal a pid is attached to, e.g. `/dev/pts/7`. Injected so tests need no real process. */
  ttyOf?: (pid: number) => string
  /** Writes text into a tty device. */
  write?: (tty: string, text: string) => void
}

/**
 * Attach mode on Linux (spec 5.14~5.16): typing into a terminal the user already has open, and
 * mirroring its screen back.
 *
 * Writing needs no API — the target's terminal is a character device, so typing is a write to
 * `/proc/<pid>/fd/0`'s target. Reading the screen has no general answer: X11 and Wayland terminals
 * keep their own buffers that another process cannot see. `tmux` does expose a pane's text, so a
 * terminal running inside tmux is mirrored for real; anything else says so plainly instead of
 * showing a blank screen, because the ready line and the permission prompts are both read off it.
 */
export class LinuxAttachHelper implements AttachHelper {
  private readonly eventListeners = new Set<(event: AttachEvent) => void>()
  private readonly exitListeners = new Set<(code: number | null) => void>()
  private tty: string | null = null
  /** `ready` is announced once, even when typing resolved the tty before the first poll. */
  private greeted = false
  private pane: string | null = null
  private exited = false

  constructor(private readonly pid: number, private readonly deps: LinuxAttachDeps) {}

  send(command: AttachCommand): void {
    if (this.exited) return
    if (command.cmd === 'exit') {
      this.fireExit(0)
      return
    }
    try {
      if (command.cmd === 'type') {
        // Line breaks flatten to spaces, same as the Windows helper: a literal Enter mid-text would
        // submit early. One trailing Enter submits the whole prompt.
        const flat = command.text.replace(/[\r\n]/g, ' ')
        this.write(`${flat}\r`)
        return
      }
      if (command.cmd === 'keys') {
        for (const key of command.keys) this.write(keySequence(key))
        return
      }
      void this.poll()
    } catch (error) {
      this.emit({ event: 'error', message: message(error) })
    }
  }

  onEvent(listener: (event: AttachEvent) => void): void {
    this.eventListeners.add(listener)
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.add(listener)
  }

  kill(): void {
    this.fireExit(null)
  }

  /** Resolves the tty and the tmux pane once, then reports the screen on every poll. */
  private async poll(): Promise<void> {
    try {
      if (!this.tty) this.requireTty()
    } catch (error) {
      this.emit({ event: 'error', message: `Couldn't find that terminal's device: ${message(error)}` })
      return
    }
    if (!this.greeted) {
      this.greeted = true
      this.emit({ event: 'ready' })
    }
    if (!this.pane) {
      const found = await this.findPane()
      if (!found) {
        // Reported on every poll on purpose: the runner keeps a session alive on a screen it can
        // read, so this has to be visible rather than a one-off the user never sees.
        this.emit({
          event: 'screen',
          text: `[This terminal isn't running inside tmux, so its screen can't be read. Start it in tmux to mirror it — typing still works.]`
        })
        return
      }
      this.pane = found
    }
    const result = await this.deps.runner.run('tmux', ['capture-pane', '-p', '-t', this.pane], { timeoutMs: 5_000 })
    if (result.code !== 0) {
      this.emit({ event: 'error', message: (result.stderr || result.stdout).trim().slice(0, 200) || 'tmux capture-pane failed.' })
      return
    }
    this.emit({ event: 'screen', text: result.stdout.replace(/\s+$/, '') })
  }

  /** The tmux pane whose terminal is the same device the target pid is attached to. */
  private async findPane(): Promise<string | null> {
    const list = await this.deps.runner.run('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}'], { timeoutMs: 5_000 })
    if (list.code !== 0) return null
    for (const line of list.stdout.split('\n')) {
      const [pane, tty] = line.trim().split(/\s+/)
      if (pane && tty && tty === this.tty) return pane
    }
    return null
  }

  /** The tty, resolved on first use: typing can arrive before the first poll, so it can't wait for
   *  the poll path to have resolved it. */
  private requireTty(): string {
    if (!this.tty) this.tty = (this.deps.ttyOf ?? ttyOfPid)(this.pid)
    return this.tty
  }

  private write(text: string): void {
    const tty = this.requireTty()
    if (this.deps.write) {
      this.deps.write(tty, text)
      return
    }
    const fd = openSync(tty, 'w')
    try {
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
  }

  private emit(event: AttachEvent): void {
    if (this.exited) return
    this.eventListeners.forEach((listener) => listener(event))
  }

  private fireExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitListeners.forEach((listener) => listener(code))
  }
}

/** The terminal device a pid is attached to, read off its standard input symlink in `/proc`. */
export function ttyOfPid(pid: number): string {
  const link = readlinkSync(`/proc/${pid}/fd/0`)
  if (!link.startsWith('/dev/pts/')) throw new Error(`pid ${pid} isn't attached to a terminal (${link}).`)
  return link
}

/** Creates Linux attach helpers; `AttachTerminalRunner` only ever sees the `AttachHelper` interface. */
export class LinuxAttachHelperSpawner {
  constructor(private readonly runner: CommandRunner) {}

  spawnHelper(targetPid: number): AttachHelper {
    const deps: LinuxAttachDeps = {
      runner: this.runner,
      write: (tty, text) => {
        const fd = openSync(tty, 'w')
        try {
          writeSync(fd, text)
        } finally {
          closeSync(fd)
        }
      }
    }
    return new LinuxAttachHelper(targetPid, deps)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

