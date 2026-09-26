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
}

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

  constructor(private readonly options: ManagedTerminalRunnerOptions) {}

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
    this.entries.set(id, { session, proc: null, items: [], primerText: [] })
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
    entry?.proc?.kill()
  }

  /** Runs one bounded CLI turn and resolves with the assistant's reply text (or an error). This is
   *  the "run a prompt through the CLI like a model provider" path: no visible session, no primer,
   *  no onboarding — just spawn, parse, resolve. A non-zero exit or a parsed error line rejects. */
  execute(tool: TerminalTool, folder: string, prompt: string, model?: string): Promise<{ text: string; error?: string }> {
    return new Promise((resolve) => {
      const spilled = spillPrompt(tool, folder, prompt)
      const args =
        tool === 'opencode'
          ? buildOpenCodeArgs({ folder, model: model?.trim() || OPENCODE_DEFAULT_MODEL, sessionId: null, prompt: spilled.prompt, files: spilled.files })
          : buildAgyArgs({ model: model?.trim() || null, sessionId: null, prompt: spilled.prompt })
      const proc = this.options.spawner.spawn(tool, args, { cwd: folder })
      proc.onExit(() => spilled.cleanup())
      const parts: string[] = []
      let error: string | undefined
      let sawError = false

      proc.onStdoutLine((line) => {
        const parsed = tool === 'opencode' ? parseOpenCodeLine(line) : parseAgyLine(line)
        if (!parsed) return
        if (parsed.item?.kind === 'assistant') parts.push(parsed.item.text)
        if (parsed.item?.kind === 'tool' && parsed.item.state === 'error') {
          sawError = true
          if (parsed.item.error) error = parsed.item.error
        }
      })

      proc.onStderrLine((line) => {
        if (tool !== 'agy') return
        const item = parseAgyStderrLine(line)
        if (item) {
          sawError = true
          if (item.error) error = item.error
        }
      })

      proc.onExit((code) => {
        if (sawError || (code !== null && code !== 0)) {
          if (!error) error = 'The CLI run failed. See the console for details.'
        }
        resolve({ text: parts.join('\n').trim(), error })
      })
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
    })
  }
}
