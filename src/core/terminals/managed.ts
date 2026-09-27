import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPrimer, isContextReset, OnboardingTracker } from '../agents/onboarding'
import type { ProcessSpawner, SpawnedProcess } from './process'
import type { TerminalOnboardingState, TerminalSession, TerminalTool, TimelineItem, ToolItem, ToolItemState } from '../../shared/protocol'

/** The user's working free OpenCode model on this machine (see the job's brief). Only a default —
 *  `terminals.sessions.start` accepts any `model` string. */
export const OPENCODE_DEFAULT_MODEL = 'opencode/big-pickle'

function assistantItem(text: string, at = Date.now()): TimelineItem {
  return { kind: 'assistant', id: randomUUID(), at, text }
}

function toolItem(toolName: string, input: unknown, state: ToolItemState, extra?: Partial<ToolItem>): ToolItem {
  return { kind: 'tool', id: randomUUID(), at: Date.now(), toolName, input, state, ...extra }
}

/** One line of a managed-mode CLI's JSON stream, turned into (at most) one timeline item, plus the
 *  CLI's own session/conversation id when the line carries one. Unrecognized shapes still produce a
 *  generic gray tool item — see the module doc below — so a schema change on the CLI's side never
 *  silently drops output. */
interface ParsedLine {
  sessionId?: string
  item?: TimelineItem
}

/**
 * OpenCode's `run --format json` stream. Verified against a real run of this machine's OpenCode
 * (`opencode run --format json -m opencode/big-pickle --dir . "Reply with PONG"`), which emitted
 * exactly three line shapes: `step_start`, `text` (the reply, in `part.text`) and `step_finish`
 * (token/cost stats). Anything else — most likely a tool-call part on a less trivial prompt — is
 * shown generically rather than dropped, since its exact shape wasn't captured.
 */
export function parseOpenCodeLine(raw: string): ParsedLine | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let event: any
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }
  const sessionId = typeof event?.sessionID === 'string' ? event.sessionID : undefined
  const at = typeof event?.timestamp === 'number' ? event.timestamp : Date.now()
  const part = event?.part

  if (event?.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
    return { sessionId, item: assistantItem(part.text, at) }
  }
  // Turn boundaries carry no user-facing content of their own (step_finish's token/cost stats are
  // shown nowhere in this beta).
  if (event?.type === 'step_start' || event?.type === 'step_finish') {
    return { sessionId }
  }
  // Unrecognized event (most likely a tool-call part): surfaced as a generic gray line instead of
  // silently dropped.
  return { sessionId, item: toolItem(part?.type ?? event?.type ?? 'opencode', part ?? event, 'done') }
}

/**
 * agy's `--output-format stream-json` stream. Verified against a real (if incomplete — see the
 * job's report) run of this machine's agy, which emitted an `init` event (session metadata) and
 * repeated `step_update` events with `step_type: "user_input"` and `step_type: "error_message"`.
 * No successful completion line was captured, so the assistant-reply shape below is a defensive
 * best guess (any string field plausibly named `text`/`message`/`content` on a non-running,
 * non-error step); anything that doesn't match becomes a generic gray line, same as OpenCode above.
 */
export function parseAgyLine(raw: string): ParsedLine | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let event: any
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (event?.event === 'init' && event.init) {
    const toolCount = Array.isArray(event.init.tools) ? event.init.tools.length : undefined
    return {
      sessionId: typeof event.conversation_id === 'string' ? event.conversation_id : undefined,
      item: toolItem('session', { tools: toolCount, permissionMode: event.init.permission_mode, cwd: event.init.cwd }, 'done')
    }
  }

  if (event?.event === 'step_update' && event.step_update) {
    const step = event.step_update
    const sessionId = typeof step.conversation_id === 'string' ? step.conversation_id : undefined
    if (step.step_type === 'user_input') return { sessionId } // echoes what we just sent

    if (step.step_type === 'error_message') {
      const detail =
        typeof step.message === 'string'
          ? step.message
          : typeof step.error === 'string'
            ? step.error
            : `agy step ${step.step_index ?? '?'} failed.`
      return { sessionId, item: toolItem('agy', step, 'error', { error: detail }) }
    }

    const text =
      typeof step.text === 'string'
        ? step.text
        : typeof step.message === 'string'
          ? step.message
          : typeof step.content === 'string'
            ? step.content
            : undefined
    if (text && step.state !== 'RUNNING') return { sessionId, item: assistantItem(text) }

    const state: ToolItemState = step.state === 'DONE' ? 'done' : step.state === 'ERROR' ? 'error' : step.state === 'RUNNING' ? 'running' : 'done'
    return { sessionId, item: toolItem(step.step_type ?? 'step', step, state) }
  }

  return { item: toolItem(event?.event ?? 'agy', event, 'done') }
}

/** agy prints a structured `AGY_ERROR: {...}` line to stderr when a turn fails on an agent or model
 *  API error (confirmed in agy's own 1.2.6 changelog) — for example when a free-tier quota runs out.
 *  Parsed separately from stdout since it's a stderr-only signal. */
export function parseAgyStderrLine(raw: string): ToolItem | null {
  const match = /^AGY_ERROR:\s*(.+)$/.exec(raw.trim())
  if (!match) return null
  let payload: unknown
  try {
    payload = JSON.parse(match[1])
  } catch {
    payload = match[1]
  }
  const summary =
    payload && typeof payload === 'object' && 'error' in (payload as Record<string, unknown>)
      ? String((payload as Record<string, unknown>).error)
      : 'agy reported an error running this prompt.'
  return toolItem('agy', payload, 'error', { error: summary })
}

/** Builds the argument list for one OpenCode `run` call: a fresh call when `sessionId` is null,
 *  a continuation of the same conversation otherwise (`-s <id>`), per OpenCode's own `run --help`.
 *  `--auto` is required for a non-interactive run to work at all: without it OpenCode auto-approves
 *  nothing and denies every tool (including the primer's own guide read) instead of prompting. */
export function buildOpenCodeArgs(options: { folder: string; model: string; sessionId: string | null; prompt: string; files?: string[] }): string[] {
  const args = ['run', '--format', 'json', '--auto', '-m', options.model, '--dir', options.folder]
  if (options.sessionId) args.push('-s', options.sessionId)
  args.push(options.prompt)
  // After the message: `-f` takes every following value, so anything behind it would become a file.
  if (options.files && options.files.length > 0) args.push('-f', ...options.files)
  return args
}

/** Longer prompts go through a file: Windows refuses command lines over ~32,000 characters. */
export const MAX_INLINE_PROMPT = 8000

/**
 * Moves a long prompt into a file. OpenCode gets it attached (`-f`, kept in the temp folder); agy
 * has no attach option, so it is told to read the file, which sits in the project folder where
 * it may read. `cleanup` deletes the file once the run is over.
 */
export function spillPrompt(tool: TerminalTool, folder: string, prompt: string): { prompt: string; files: string[]; cleanup(): void } {
  if (prompt.length <= MAX_INLINE_PROMPT) return { prompt, files: [], cleanup: () => undefined }
  const dir = tool === 'opencode' ? join(tmpdir(), 'deskmates-prompts') : join(folder, '.deskmates')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `prompt-${randomUUID()}.md`)
  writeFileSync(file, prompt, 'utf8')
  const cleanup = (): void => rmSync(file, { force: true })
  return tool === 'opencode'
    ? {
        prompt: "Your complete instructions and the user's request are in the attached file. Read all of it, follow those instructions, and answer the request at the end of it.",
        files: [file],
        cleanup
      }
    : {
        prompt: `Your complete instructions and the user's request are in the file ${file}. Read all of it first, follow those instructions, and answer the request at the end of it.`,
        files: [],
        cleanup
      }
}

/** Builds the argument list for one agy `-p` call: a fresh call when `sessionId` is null, a
 *  continuation otherwise (`--conversation <id>`, more precise than `--continue`'s "most recent").
 *  The prompt must be the LAST argument — `agy`'s flag parser otherwise consumes the next token as
 *  the value of whichever flag precedes `-p` (verified: `-p --output-format stream-json "<prompt>"`
 *  fails with "-p took --output-format as its prompt"). */
export function buildAgyArgs(options: { model: string | null; sessionId: string | null; prompt: string }): string[] {
  const args = ['--output-format', 'stream-json']
  if (options.model) args.push('--model', options.model)
  if (options.sessionId) args.push('--conversation', options.sessionId)
  args.push('-p', options.prompt)
  return args
}

interface Entry {
  session: TerminalSession
  proc: SpawnedProcess | null
  items: TimelineItem[]
  /** Text observed on the primer run, fed to the onboarding tracker once the run finishes (the CLI
   *  call is one bounded turn, not a long-lived stream, so there's no separate 90s timer — once the
   *  process exits with no ready line in its output, none is coming). */
  primerText: string[]
  /** Set by `stop()` on a turn that is still waiting its turn in the OpenCode queue: the process
   *  doesn't exist yet, so `proc` is null and the kill would go nowhere. Checked before spawning. */
  cancelled: boolean
}

/** Optional handles a caller can use to watch and cut short one CLI run. */
export interface CliRunOptions {
  /** Aborting kills the run and resolves it immediately with whatever text had already arrived,
   *  rather than waiting for the process to close. This is what the Work tab's Stop button needs:
   *  without it `TaskRunner.stop()` aborts a signal nothing is listening to, and the run keeps going
   *  to completion. */
  signal?: AbortSignal
  /** Called with every timeline item the CLI's stream produces, as it arrives. Without this the
   *  caller learns nothing until the process exits, and OpenCode's cold start alone was measured at
   *  15–45s on this machine before the model has even been reached — a run that looks hung. */
  onItem?: (item: TimelineItem) => void
}

export interface CliRunResult {
  text: string
  error?: string
  /** The caller aborted this run, so it is a deliberate stop rather than a failure. A run ended by
   *  a watchdog arrives as an `error` instead, since the user never asked for it. */
  stopped?: boolean
}

/** Hard cap on one CLI run. Generous: a CLI agent reading files and running commands can legitimately
 *  work for many minutes. It exists so a wedged run reports an error instead of leaving the task
 *  `running` forever. */
export const CLI_RUN_TIMEOUT_MS = 15 * 60_000

/** A run that has gone this long without a single line of output is wedged, not working. OpenCode
 *  emits a line as it starts and as each step finishes, so a genuine long stretch with nothing at all
 *  means the process is stuck. This is what catches the deadlock below, minutes before the hard cap. */
export const CLI_RUN_STALL_MS = 5 * 60_000

/** How long a killed run may hold the OpenCode slot while waiting for its process to actually
 *  disappear. Killing is asynchronous, so the slot has to outlive the kill by a moment; the ceiling
 *  stops a process that never closes from blocking OpenCode forever. */
export const PROCESS_EXIT_GRACE_MS = 15_000


export interface ManagedTerminalRunnerOptions {
  spawner: ProcessSpawner
  /** Path the primer tells the agent to read; passed to `buildPrimer`. */
  guidePath: string
  /** Absolute path of the mounted claude-code prompt, told to agents by the primer. */
  promptPath?: string
  /** The guide's current version and check phrase (see src/core/agents/guide.ts), used to prime and
   *  to recognize the ready line. */
  guideVersion: string
  phrase: string
  onSessionUpdated: (session: TerminalSession) => void
  onItem: (sessionId: string, item: TimelineItem) => void
}

/**
 * Runs managed-mode sessions for OpenCode and agy: one child process per turn (the CLIs are
 * one-shot-per-call, not long-lived servers), continuing the same CLI conversation across turns via
 * each tool's own session flag. Every external process goes through the injected `ProcessSpawner` —
 * never a direct `child_process` call here — so tests run against a fake.
 */
export class ManagedTerminalRunner {
  private readonly entries = new Map<string, Entry>()
  private readonly onboarding = new OnboardingTracker()
  /** Whether an OpenCode run holds the slot, and the runs waiting for it — see `acquireOpenCode`. */
  private opencodeBusy = false
  private readonly opencodeWaiters: Array<() => void> = []

  constructor(private readonly options: ManagedTerminalRunnerOptions) {}

  /**
   * Claims the single OpenCode slot and returns the function that gives it back, waiting first if
   * another run holds it. Other tools have no such constraint and skip this entirely.
   *
   * OpenCode deadlocks when two `run` processes overlap — reproduced on this machine: launched
   * together, the second one prints its full reply and then simply never exits, hanging the caller
   * forever. Since OpenCode is both a selectable provider (the Work tab spawns one per turn) and a
   * managed session (the Agents tab spawns one per turn), the two could collide on their own, and
   * nothing in the app prevented it. One slot at a time makes the second call wait its turn rather
   * than hang.
   *
   * Returns the release function directly when the slot is free, so an uncontended run spawns
   * synchronously exactly as it did before; only a contended one waits.
   */
  private acquireOpenCode(): (() => void) | Promise<() => void> {
    if (!this.opencodeBusy) {
      this.opencodeBusy = true
      return () => this.releaseOpenCode()
    }
    return new Promise<() => void>((resolve) => {
      this.opencodeWaiters.push(() => resolve(() => this.releaseOpenCode()))
    })
  }

  private releaseOpenCode(): void {
    // The slot passes straight to the next waiter, so it stays busy; only an empty queue frees it.
    const next = this.opencodeWaiters.shift()
    if (next) next()
    else this.opencodeBusy = false
  }

  list(): TerminalSession[] {
    return [...this.entries.values()].map((entry) => entry.session)
  }

  items(id: string): TimelineItem[] {
    return this.entries.get(id)?.items ?? []
  }

  start(tool: TerminalTool, folder: string, model?: string): TerminalSession {
    const id = randomUUID()
    const now = Date.now()
    const session: TerminalSession = {
      id,
      tool,
      folder,
      model: model?.trim() || (tool === 'opencode' ? OPENCODE_DEFAULT_MODEL : null),
      cliSessionId: null,
      state: 'starting',
      onboarding: 'unknown',
      error: null,
      createdAt: now,
      updatedAt: now
    }
    this.entries.set(id, { session, proc: null, items: [], primerText: [], cancelled: false })
    this.options.onSessionUpdated(session)

    this.onboarding.markPrimed(id, this.options.guideVersion, now)
    const primer = buildPrimer({ guidePath: this.options.guidePath, promptPath: this.options.promptPath })
    this.run(id, primer, { visible: false, isPrimer: true })
    return session
  }

  /** Sends a real prompt. A literal `/new`/`/clear`/`/reset` starts a fresh CLI conversation and
   *  re-primes it first, matching spec 5.14's "fresh conversation" trigger. */
  send(id: string, text: string): void {
    const entry = this.requireEntry(id)
    if (isContextReset(text)) {
      entry.session.cliSessionId = null
      entry.session.onboarding = 'unknown'
      this.options.onSessionUpdated(entry.session)
      this.onboarding.markPrimed(id, this.options.guideVersion, Date.now())
      entry.primerText = []
      const primer = buildPrimer({ guidePath: this.options.guidePath, promptPath: this.options.promptPath })
      this.run(id, primer, { visible: false, isPrimer: true }, () => this.run(id, text, { visible: true, isPrimer: false }))
      return
    }
    this.run(id, text, { visible: true, isPrimer: false })
  }

  stop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    // A turn still queued behind another OpenCode run has no process to kill yet, so mark it and
    // let the queue drop it on arrival — otherwise Stop would be a no-op for exactly the turns that
    // look most stuck.
    entry.cancelled = true
    entry.proc?.kill()
  }

  /** Runs one bounded CLI turn and resolves with the assistant's reply text (or an error). This is
   *  the "run a prompt through the CLI like a model provider" path: no visible session, no primer,
   *  no onboarding — just spawn, parse, resolve. A non-zero exit or a parsed error line rejects.
   *
   *  The run is watchable (`onItem`) and cuttable (`signal`), and is always bounded: a caller that
   *  passes neither still gets a resolution, because both watchdogs below fire on their own. */
  execute(
    tool: TerminalTool,
    folder: string,
    prompt: string,
    model?: string,
    runOptions?: CliRunOptions
  ): Promise<CliRunResult> {
    const spawnAndRun = (releaseSlot?: () => void): Promise<CliRunResult> =>
      new Promise((resolve) => {
        // Checked before anything is created: a run cancelled on the way in shouldn't start a CLI
        // process just to kill it a moment later.
        if (runOptions?.signal?.aborted) {
          releaseSlot?.()
          resolve({ text: '', stopped: true })
          return
        }

        const spilled = spillPrompt(tool, folder, prompt)
        const args =
          tool === 'opencode'
            ? buildOpenCodeArgs({ folder, model: model?.trim() || OPENCODE_DEFAULT_MODEL, sessionId: null, prompt: spilled.prompt, files: spilled.files })
            : buildAgyArgs({ model: model?.trim() || null, sessionId: null, prompt: spilled.prompt })
        const proc = this.options.spawner.spawn(tool, args, { cwd: folder })
        const parts: string[] = []
        let error: string | undefined
        let sawError = false
        let settled = false

        // One timer for each watchdog, both cleared the moment the run settles. The cap is only
        // armed once we know the run is actually going ahead.
        let capTimer: ReturnType<typeof setTimeout> | undefined
        let stallTimer: ReturnType<typeof setTimeout> | undefined

        const clearTimers = (): void => {
          if (capTimer) clearTimeout(capTimer)
          if (stallTimer) clearTimeout(stallTimer)
        }

        /** Frees the OpenCode slot once the process is genuinely gone.
         *
         *  A stop resolves the caller straight away — waiting for a process to be reaped is what made
         *  Stop feel dead — but the slot must not come back at the same moment, because killing is
         *  asynchronous: `taskkill` returns before the tree has actually died. Releasing there let
         *  the next run spawn straight on top of the dying one, and OpenCode deadlocks on exactly
         *  that overlap (reproduced: the following run then printed nothing for minutes). So the
         *  caller is let go immediately while the slot waits for the real exit.
         *
         *  The grace timer is the backstop for the case this whole mechanism exists for — a process
         *  that never closes. Without it, one wedged run would hold the slot forever. */
        const releaseWhenGone = (): void => {
          let released = false
          const release = (): void => {
            if (released) return
            released = true
            clearTimeout(grace)
            releaseSlot?.()
          }
          const grace = setTimeout(release, PROCESS_EXIT_GRACE_MS)
          grace.unref?.()
          proc.onExit(release)
        }

        /** The single exit point. Resolves immediately on a stop: waiting for the child to actually
         *  close after killing it would make Stop feel broken all over again. */
        function finish(code: number | null, failure?: string, stopped = false): void {
          if (settled) return
          settled = true
          clearTimers()
          spilled.cleanup()
          proc.kill()
          runOptions?.signal?.removeEventListener('abort', onAbort)
          releaseWhenGone()
          if (sawError && !error) error = 'The CLI reported an error running this prompt.'
          if (failure) error = failure
          else if (code !== null && code !== 0 && !error) {
            error = 'The CLI run failed. See the console for details.'
          }
          resolve({ text: parts.join('\n').trim(), ...(error ? { error } : {}), ...(stopped ? { stopped: true } : {}) })
        }

        /** The stall watchdog resets on every line the CLI prints. */
        const resetStall = (): void => {
          if (stallTimer) clearTimeout(stallTimer)
          stallTimer = setTimeout(() => {
            finish(null, `The ${tool} run stopped responding, so it was stopped. Try again, or use a different model.`)
          }, CLI_RUN_STALL_MS)
          stallTimer.unref?.()
        }

        function onAbort(): void {
          finish(null, undefined, true)
        }

        capTimer = setTimeout(() => {
          finish(null, `The ${tool} run went over ${Math.round(CLI_RUN_TIMEOUT_MS / 60_000)} minutes without finishing, so it was stopped.`)
        }, CLI_RUN_TIMEOUT_MS)
        capTimer.unref?.()
        runOptions?.signal?.addEventListener('abort', onAbort, { once: true })
        resetStall()

        proc.onStdoutLine((line) => {
          resetStall()
          const parsed = tool === 'opencode' ? parseOpenCodeLine(line) : parseAgyLine(line)
          if (!parsed) return
          if (parsed.item) {
            if (parsed.item.kind === 'assistant') parts.push(parsed.item.text)
            if (parsed.item.kind === 'tool' && parsed.item.state === 'error') {
              sawError = true
              if (parsed.item.error) error = parsed.item.error
            }
            runOptions?.onItem?.(parsed.item)
          }
        })

        proc.onStderrLine((line) => {
          resetStall()
          if (tool !== 'agy') return
          const item = parseAgyStderrLine(line)
          if (item) {
            sawError = true
            if (item.error) error = item.error
            runOptions?.onItem?.(item)
          }
        })

        proc.onExit((code) => {
          if (settled) return
          settled = true
          clearTimers()
          spilled.cleanup()
          releaseSlot?.()
          if (sawError && !error) error = 'The CLI reported an error running this prompt.'
          if (code !== null && code !== 0 && !error) {
            error = 'The CLI run failed. See the console for details.'
          }
          resolve({ text: parts.join('\n').trim(), ...(error ? { error } : {}) })
        })
      })

    // OpenCode only — see acquireOpenCode. Aborting while queued drops the run before it spawns.
    if (tool !== 'opencode') return spawnAndRun()
    const claim = this.acquireOpenCode()
    if (typeof claim === 'function') return spawnAndRun(claim)
    return claim.then((releaseSlot) => {
      if (runOptions?.signal?.aborted) {
        releaseSlot()
        return { text: '', stopped: true } as CliRunResult
      }
      return spawnAndRun(releaseSlot)
    })
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error("That managed session doesn't exist (it may have been cleared).")
    return entry
  }

  private pushItem(entry: Entry, item: TimelineItem): void {
    entry.items.push(item)
    this.options.onItem(entry.session.id, item)
  }

  private updateSession(entry: Entry, patch: Partial<TerminalSession>): void {
    Object.assign(entry.session, patch, { updatedAt: Date.now() })
    this.options.onSessionUpdated(entry.session)
  }

  private run(id: string, prompt: string, flags: { visible: boolean; isPrimer: boolean }, onDone?: () => void): void {
    const entry = this.requireEntry(id)
    if (flags.visible) this.pushItem(entry, { kind: 'user', id: randomUUID(), at: Date.now(), text: prompt })
    this.updateSession(entry, { state: 'busy' })
    entry.cancelled = false

    const turn = (release?: () => void): Promise<void> => this.runTurn(id, prompt, flags, onDone, release)
    // OpenCode only — see acquireOpenCode: a session turn overlapping any other OpenCode run
    // deadlocks the CLI, so this one waits its turn rather than hanging.
    if (entry.session.tool !== 'opencode') {
      void turn()
      return
    }
    const claim = this.acquireOpenCode()
    if (typeof claim === 'function') {
      void turn(claim)
      return
    }
    void claim.then((release) => turn(release))
  }

  /** One session turn, from spawn to exit. `release` hands the OpenCode slot back once the process
   *  is done, so the next queued run can start. */
  private runTurn(
    id: string,
    prompt: string,
    flags: { visible: boolean; isPrimer: boolean },
    onDone?: () => void,
    release?: () => void
  ): Promise<void> {
    return new Promise((resolve) => {
      // The session may have been cleared, or stopped while queued, while this turn waited its turn.
      const entry = this.entries.get(id)
      if (!entry) {
        release?.()
        resolve()
        return
      }
      if (entry.cancelled) {
        release?.()
        this.updateSession(entry, { state: 'idle' })
        resolve()
        return
      }

      const { session } = entry
      const file = session.tool
      const spilled = spillPrompt(session.tool, session.folder, prompt)
      const args =
        session.tool === 'opencode'
          ? buildOpenCodeArgs({ folder: session.folder, model: session.model ?? OPENCODE_DEFAULT_MODEL, sessionId: session.cliSessionId, prompt: spilled.prompt, files: spilled.files })
          : buildAgyArgs({ model: session.model, sessionId: session.cliSessionId, prompt: spilled.prompt })

      let sawError = false
      const proc = this.options.spawner.spawn(file, args, { cwd: session.folder })
      proc.onExit(() => spilled.cleanup())
      entry.proc = proc

      proc.onStdoutLine((line) => {
        const parsed = session.tool === 'opencode' ? parseOpenCodeLine(line) : parseAgyLine(line)
        if (!parsed) return
        if (parsed.sessionId && !session.cliSessionId) session.cliSessionId = parsed.sessionId
        if (parsed.item) {
          if (flags.isPrimer && parsed.item.kind === 'assistant') entry.primerText.push(parsed.item.text)
          if (parsed.item.kind === 'tool' && parsed.item.state === 'error') sawError = true
          // The primer's own request and reply (including the raw "DESKMATES READY ..." line) stay out
          // of the visible transcript — only the onboarding badge reflects its outcome.
          if (!flags.isPrimer) this.pushItem(entry, parsed.item)
        }
      })

      proc.onStderrLine((line) => {
        if (session.tool !== 'agy') return
        const item = parseAgyStderrLine(line)
        if (item) {
          sawError = true
          this.pushItem(entry, item)
        }
      })

      proc.onExit((code) => {
        entry.proc = null
        release?.()
        const failed = sawError || (code !== null && code !== 0)
        if (flags.isPrimer) {
          const observed = this.onboarding.observe(id, entry.primerText.join('\n'), this.options.phrase, Date.now())
          const onboardingState: TerminalOnboardingState = observed === 'confirmed' ? 'confirmed' : 'failed'
          this.updateSession(entry, {
            state: failed ? 'error' : 'idle',
            onboarding: onboardingState,
            error: failed ? "The agent's check-in run didn't finish cleanly. See the transcript above." : null
          })
        } else {
          this.updateSession(entry, {
            state: failed ? 'error' : 'idle',
            error: failed ? 'The last prompt failed. See the transcript above.' : null
          })
        }
        onDone?.()
        resolve()
      })
    })
  }
}
