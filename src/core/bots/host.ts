import type { BotPc, PcMode } from '../../shared/protocol'

/** Resource caps and the idle policy for a bot's PC, given when it's first created. */
export interface CreatePcOptions {
  /** RAM cap in megabytes. */
  memoryMb: number
  /** CPU cap, in number of CPUs (may be fractional, e.g. 1.5). */
  cpuLimit: number
  /** Minutes of inactivity before the PC stops on its own; 0 keeps it running. */
  idleStopMinutes: number
}

/** Where to reach a running PC, all bound to 127.0.0.1, plus the token its agent service requires. */
export interface PcEndpoints {
  novnc: string
  agent: string
  cdp: string
  token: string
}

export interface ExecOptions {
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number
  /** Text written to the command's stdin. */
  input?: string
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type BotHostErrorCode =
  | 'engine-not-running'
  | 'image-missing'
  | 'port-taken'
  | 'container-died'
  | 'not-responding'
  | 'not-created'
  | 'not-running'
  | 'unknown'

/**
 * A BotHost failure with a plain sentence for the UI. The raw process output, when there is
 * any, goes in `cause` for the log — never folded into `message`.
 */
export class BotHostError extends Error {
  readonly code: BotHostErrorCode

  constructor(code: BotHostErrorCode, message: string, cause?: string) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BotHostError'
    this.code = code
  }
}

/**
 * Creates, runs and talks to each bot's PC. `LocalWslHost` implements this over Docker inside
 * the app's own WSL distro; a future `CloudHost` can implement the same interface against a
 * Docker server on the network, so callers never need to know which one they're using.
 *
 * Every method below is keyed by `botId`. In `own` PC mode a bot's PC is its own container; in
 * `shared` mode, `start`/`stop`/`status`/`endpoints`/`exec`/`copyIn`/`copyOut` resolve to one PC
 * shared by every bot instead — from the caller's side, nothing about the call changes, except
 * that a bot still waiting its turn in the queue is reported as not running (`status` reports
 * `starting`, `endpoints` returns `null`) even while the shared PC is genuinely running for
 * whichever bot currently holds it.
 * `create`, `reset` and `delete` always act on the bot's own container, in either mode, since
 * that's the dedicated environment kept (stopped) for it while a shared PC is in use.
 */
export interface BotHost {
  /**
   * Idempotently provisions this bot's own PC and leaves it running: creates its container if
   * it doesn't exist yet, starts it if it exists but is stopped, and simply returns it if it's
   * already running.
   */
  create(botId: string, options: CreatePcOptions): Promise<BotPc>

  /** Makes sure the PC this bot currently uses is running and answering, waiting its turn first if that PC is shared and busy. */
  start(botId: string): Promise<BotPc>

  /** Stops the PC this bot currently uses (in shared mode: gives up its turn, letting the next bot in the queue take over). */
  stop(botId: string): Promise<BotPc>

  /** Removes this bot's own container and storage, but keeps the bot and its port allocation. */
  reset(botId: string): Promise<BotPc>

  /** Removes everything for this bot: its container, its storage, and its port allocation. */
  delete(botId: string): Promise<void>

  /** Reads the current state of the PC this bot uses. Never throws — failures come back as `state: 'error'`. */
  status(botId: string): Promise<BotPc>

  /** Live-view and control URLs plus the token its agent service requires, or `null` when that PC isn't running. */
  endpoints(botId: string): Promise<PcEndpoints | null>

  /** Runs a command inside the PC this bot uses. */
  exec(botId: string, command: string, args: string[], options?: ExecOptions): Promise<ExecResult>

  /** Copies a local file or folder into the PC this bot uses. */
  copyIn(botId: string, localPath: string, containerPath: string): Promise<void>

  /** Copies a file or folder out of the PC this bot uses. */
  copyOut(botId: string, containerPath: string, localPath: string): Promise<void>

  /** Fetches the bot PC image from the registry. */
  pull(image?: string): Promise<void>

  /** Builds the bot PC image locally from `bot-image/`, for when the registry can't be reached. */
  buildLocal(contextDir: string, image?: string): Promise<void>
}

/** Re-exported so callers that only need the mode type don't have to reach into `shared/protocol`. */
export type { PcMode }
