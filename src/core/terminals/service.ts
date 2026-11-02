import { spawn } from 'node:child_process'
import type { CommandRunner } from '../bots/command-runner'
import type { EventBus } from '../events'
import { detectTerminalAgents } from './detect'
import type { CliRunOptions, CliRunResult } from './managed'
import { ManagedTerminalRunner } from './managed'
import type { OpenCodeUsage } from './opencode-server'
import type { ProcessSpawner } from './process'
import { AttachTerminalRunner } from './attach'
import { FreebuffPool } from './freebuff-pool'
import type { FreebuffStatus } from '../../shared/freebuff'
import type { AttachHelperSpawner } from './attach'
import type {
  AttachedTerminalSession,
  DetectedTerminalAgent,
  TerminalSession,
  TerminalTool,
  TimelineItem
} from '../../shared/protocol'

/**
 * Terminal-agent detection, managed mode (the terminal-agents task), and attach mode (typing into a
 * terminal the user already has open), exposed as one small interface so `HandlerServices` can
 * carry it the same way it carries `PcService`/`RunService` — optional, so the `terminals.*`
 * handlers answer with a clear error until this is wired up.
 */
export interface TerminalsService {
  detect(): Promise<DetectedTerminalAgent[]>
  list(): TerminalSession[]
  start(tool: TerminalTool, folder: string, model?: string): TerminalSession
  send(id: string, text: string): void
  stop(id: string): void
  items(id: string): TimelineItem[]

  /** Runs one bounded CLI turn, with no visible session or primer, for tasks routed to a CLI-backed
   *  model provider. Resolves with the assistant's reply text, or the parsed error when the run
   *  failed.
   *
   *  `runOptions.system` carries the caller's standing instructions. OpenCode delivers it as the
   *  conversation's `system` block — once, on the first turn — so the Work tab's 175KB prompt is
   *  neither re-sent nor re-read before every question; agy has no session to persist into, so it is
   *  prepended to the prompt instead.
   *
   *  `runOptions.signal` cancels the turn — this is how the Work tab's Stop button reaches a
   *  CLI-backed provider, whose turn has no tool loop for the task runner's AbortController to
   *  interrupt. */
  execute(
    tool: TerminalTool,
    folder: string,
    prompt: string,
    model?: string,
    runOptions?: CliRunOptions
  ): Promise<CliRunResult>

  /** Releases the background processes this service owns — currently the per-folder `opencode serve`
   *  behind the Work tab. Called once at shutdown, so no server outlives the app. */
  dispose(): void

  /** Whether `folder` already has a warm OpenCode conversation, so the Work tab can skip its
   *  cold-start notice. False for agy, which always spawns a fresh process. */
  warm(folder: string): boolean

  /** How much of the model's context window the folder's conversation is using. Null when there is
   *  no conversation, or the server won't report a number. */
  usage(folder: string): Promise<OpenCodeUsage | null>

  /** Replaces the conversation's history with a summary of itself, on the same session and in the
   *  same model, and returns the usage afterwards. Throws when there is nothing to compact. */
  compact(folder: string): Promise<OpenCodeUsage | null>

  /** Attaches to a terminal the user already has open (spec 5.14) and returns its session. */
  attach(pid: number, tool: TerminalTool): AttachedTerminalSession
  attachedList(): AttachedTerminalSession[]
  attachSend(id: string, text: string): void
  attachRetry(id: string): void
  attachAnswer(id: string, key: string, option: string): void
  attachStop(id: string): void

  /** Opens a new terminal window running an attach-only tool in `folder`, for the user to attach to. */
  launch(tool: TerminalTool, folder: string): void

  /** What the hidden Freebuff behind the Work tab shows about its session; null when none runs. */
  freebuffStatus(folder?: string): FreebuffStatus | null
}

const TOOL_NAMES: Record<TerminalTool, string> = { opencode: 'OpenCode', agy: 'Antigravity', freebuff: 'Freebuff' }

/**
 * Opens a visible terminal window running Freebuff in `folder`. A window of its own, not a hidden
 * child: Freebuff is interactive only, and attach mode needs a real console to type into and read.
 * Goes through `cmd start` and the `freebuff` command on PATH (npm's shim), which also keeps
 * Freebuff's own auto-update working.
 */
export function launchFreebuffWindow(folder: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') throw new Error('Starting Freebuff from Deskmates works on Windows only. Run `freebuff` in a terminal, then attach.')
  // Verbatim, quoted by hand: `start` reads its first quoted argument as the window title, which
  // Node's own argument quoting would escape into a literal. Windows paths can't contain `"`.
  const command = `/c start "Freebuff" /D "${folder}" cmd.exe /k freebuff --cwd "${folder}"`
  const child = spawn('cmd.exe', [command], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
  child.on('error', (error) => console.error('[core] could not start Freebuff', error))
  child.unref()
}

export interface TerminalsManagerOptions {
  runner: CommandRunner
  spawner: ProcessSpawner
  attachSpawner: AttachHelperSpawner
  bus: EventBus
  guidePath: string
  guideVersion: string
  phrase: string
  /** Absolute path of the mounted claude-code prompt, told to agents by the primer. */
  promptPath?: string
}

/** The real `TerminalsService`: process detection through `CommandRunner`, managed sessions through
 *  `ManagedTerminalRunner`, attach sessions through `AttachTerminalRunner`, all wired to emit their
 *  updates on the shared bus. */
export class TerminalsManager implements TerminalsService {
  private readonly runner: CommandRunner
  private readonly managed: ManagedTerminalRunner
  private readonly attached: AttachTerminalRunner
  private readonly freebuff = new FreebuffPool()

  constructor(options: TerminalsManagerOptions) {
    this.runner = options.runner
    this.managed = new ManagedTerminalRunner({
      spawner: options.spawner,
      guidePath: options.guidePath,
      guideVersion: options.guideVersion,
      phrase: options.phrase,
      promptPath: options.promptPath,
      onSessionUpdated: (session) => options.bus.emit({ type: 'terminals.session.updated', session }),
      onItem: (sessionId, item) => options.bus.emit({ type: 'terminals.session.item', sessionId, item })
    })
    this.attached = new AttachTerminalRunner({
      spawner: options.attachSpawner,
      guidePath: options.guidePath,
      guideVersion: options.guideVersion,
      phrase: options.phrase,
      promptPath: options.promptPath,
      onSessionUpdated: (session) => options.bus.emit({ type: 'terminals.attach.updated', session }),
      onPermission: (session, prompt) =>
        options.bus.emit({
          type: 'notify',
          title: `${TOOL_NAMES[session.tool] ?? 'Your agent'} is asking for permission`,
          body: prompt.title.slice(0, 180)
        })
    })
  }

  detect(): Promise<DetectedTerminalAgent[]> {
    return detectTerminalAgents(this.runner)
  }

  list(): TerminalSession[] {
    return this.managed.list()
  }

  start(tool: TerminalTool, folder: string, model?: string): TerminalSession {
    return this.managed.start(tool, folder, model)
  }

  send(id: string, text: string): void {
    this.managed.send(id, text)
  }

  stop(id: string): void {
    this.managed.stop(id)
  }

  items(id: string): TimelineItem[] {
    return this.managed.items(id)
  }

  execute(tool: TerminalTool, folder: string, prompt: string, model?: string, runOptions?: CliRunOptions): Promise<CliRunResult> {
    // Freebuff has no non-interactive mode, so its turns go to a hidden Freebuff instead of a CLI call.
    if (tool === 'freebuff') return this.freebuff.execute(folder, prompt, model, runOptions)
    return this.managed.execute(tool, folder, prompt, model, runOptions)
  }

  freebuffStatus(folder?: string): FreebuffStatus | null {
    return this.freebuff.status(folder)
  }

  /** Releases the background processes this service owns: the per-folder `opencode serve` and hidden
   *  Freebuffs behind the Work tab. Called once at shutdown, so none outlives the app. */
  dispose(): void {
    this.managed.dispose()
    this.freebuff.dispose()
  }

  warm(folder: string): boolean {
    return this.managed.warm(folder) || this.freebuff.status(folder) !== null
  }

  usage(folder: string): Promise<OpenCodeUsage | null> {
    return this.managed.usage(folder)
  }

  compact(folder: string): Promise<OpenCodeUsage | null> {
    return this.managed.compact(folder)
  }

  attach(pid: number, tool: TerminalTool): AttachedTerminalSession {
    return this.attached.attach(pid, tool)
  }

  attachedList(): AttachedTerminalSession[] {
    return this.attached.list()
  }

  attachSend(id: string, text: string): void {
    this.attached.send(id, text)
  }

  attachRetry(id: string): void {
    this.attached.retry(id)
  }

  attachAnswer(id: string, key: string, option: string): void {
    this.attached.answer(id, key, option)
  }

  attachStop(id: string): void {
    this.attached.stop(id)
  }

  launch(tool: TerminalTool, folder: string): void {
    if (tool !== 'freebuff') throw new Error(`${TOOL_NAMES[tool]} runs as a managed session instead. Use New session.`)
    launchFreebuffWindow(folder)
  }
}
