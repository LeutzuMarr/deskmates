import { createServer } from 'node:net'
import type { ProcessSpawner } from './process'
import type { SessionContextUsage } from '../../shared/protocol'
import { openCodePromptToolsConfig } from './prompt-tools-config'

/** The operating prompt's tools for the servers Deskmates starts, unless the user set their own
 *  OPENCODE_CONFIG_CONTENT, which is left as it is. */
function promptToolsEnv(): Record<string, string> {
  if (process.env.OPENCODE_CONFIG_CONTENT) return {}
  const config = openCodePromptToolsConfig()
  return config ? { OPENCODE_CONFIG_CONTENT: config } : {}
}

/**
 * A long-lived `opencode serve` per project folder, and the one conversation Deskmates reuses across
 * every prompt in that folder.
 *
 * ## Why this exists
 *
 * The Work tab used to run one `opencode run` process per prompt. Three things made that expensive,
 * all measured on the development machine:
 *
 *  1. Every process cold-booted the whole agent — MCP servers, plugins, model resolution. Measured
 *     at 9.9s for a trivial "reply PONG", against 1.6s for the same reply through a server that was
 *     already up.
 *  2. The Work tab's system prompt is `prompts/claude-cowork/claude-cowork.md` — 175KB. That is far
 *     past `MAX_INLINE_PROMPT` (8000), so every prompt was spilled to a temp file and the model was
 *     told "your instructions are in the attached file, read all of it". It dutifully re-read its
 *     entire 175KB system prompt on every question, which is where the "20 tool calls to answer what
 *     model are you" came from.
 *  3. `sessionId` was always null, so no two prompts shared a conversation. The model had no memory
 *     of having already answered, and re-derived an answer — and a file to write — from scratch.
 *
 * Driving the server instead fixes all three: the process outlives the turn, the system block is sent
 * once as `system` on the session's first message and then lives in the conversation, and every later
 * prompt is a short follow-up turn on the same session.
 *
 * ## The wire contract
 *
 * Verified against opencode 1.18.18 — from the `/doc` OpenAPI spec and a live capture of the event
 * stream, both in `tests/core/opencode-server.test.ts`:
 *
 *  - `GET  /event`                     SSE. First frame `server.connected`, then a busy stream of
 *                                      `plugin.added` / `session.updated` / `server.heartbeat` noise
 *                                      that has to be filtered by `properties.sessionID`.
 *  - `POST /session`                   `{ title? }` → `{ id }`.
 *  - `POST /session/:id/prompt_async`  `{ model, system?, parts }` → 204, does not wait for the reply.
 *  - `POST /session/:id/abort`         Stops the in-flight turn.
 *  - `GET  /global/health`             `{ healthy, version }`.
 *
 * A turn ends when `session.idle` arrives for that session — it carries its own `sessionID` and lands
 * after the last part. It does *not* end at the first completed assistant message: a prompt that uses
 * a tool produces one assistant message per step, each closed by its own `info.time.completed`. A
 * single `read` in a live capture produced two of them, with the answer the user asked for arriving
 * only in the second. A text part arrives as `message.part.updated` with the *whole* text so far,
 * re-sent every time it grows — so the delta handed to the caller is computed here rather than trusted
 * from the wire. (The server also sends `message.part.delta`, which is ignored on purpose: the
 * cumulative part is the same text, and handling both would double-count.)
 */

/** What one turn produced, as it happens. Mapped to timeline items by the caller. */
export type OpenCodeEvent =
  | { kind: 'text'; text: string }
  | { kind: 'step-start' }
  | {
      kind: 'tool'
      id: string
      tool: string
      input: unknown
      state: 'running' | 'done' | 'error'
      error?: string
    }

export interface OpenCodeTurnOptions {
  /** `provider/model`, as opencode's `-m` flag spells it. */
  model: string
  /** The user's message. */
  prompt: string
  /** Delivered as the message's `system` field, and only on the session's first turn. */
  system?: string
  signal?: AbortSignal
  onEvent?: (event: OpenCodeEvent) => void
  /** No activity at all for this long means wedged, not working. */
  stallMs: number
  /** Absolute ceiling on one turn. */
  timeoutMs: number
}

export interface OpenCodeTurnResult {
  text: string
  error?: string
  stopped?: boolean
}

/** How much of a conversation's context window is in use, as the server itself reports it. Alias of the
 *  shared wire type so the renderer and the pool cannot drift apart on what a meter may be told. */
export type OpenCodeUsage = SessionContextUsage

/** The parts of an opencode message this module reads. Captured from opencode 1.18.18; the server
 *  sends more than this and everything else here is deliberately ignored. */
interface OpenCodeMessageInfo {
  role?: string
  time?: { created?: number; completed?: number }
  /** Only true on the assistant message a compaction produces. A user message carries an unrelated
   *  object here, so this is compared strictly rather than tested for truthiness. */
  summary?: unknown
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

/** How long a server may sit with nothing to do before Deskmates shuts it down — long enough that
 *  stepping away from a task and coming back to it is still warm. */
export const SERVER_IDLE_TIMEOUT_MS = 10 * 60_000

/** The context meter is a background read that nothing waits on, so it gets a short leash: a server
 *  too slow to answer this quickly is a server not worth blocking the UI over. */
const USAGE_TIMEOUT_MS = 5_000

/** Compaction is a real model call — the server writes a summary of the whole conversation before
 *  it returns — so it gets a turn's worth of time rather than a request's. */
const SUMMARIZE_TIMEOUT_MS = 120_000

/** Only reached if a server holds a conversation whose model was never recorded, which `run` does not
 *  allow. Spelled out here rather than imported from `managed.ts`, which imports this file. */
const FALLBACK_MODEL = 'opencode/big-pickle'

/** A server that never prints its address is a broken install, not a slow one. */
export const SERVER_STARTUP_TIMEOUT_MS = 60_000

/** How long the wire must be quiet after `session.idle` before the turn is called done. Only session
 *  metadata — `session.updated`, `session.diff` — ever trails idle; a frame arriving inside this
 *  window pushes the ending out rather than getting lost. */
const SETTLE_MS = 250

/** How long a finished turn may go without `session.idle` before it is ended anyway, so a server that
 *  never reports idle costs a moment rather than the whole stall watchdog. */
const IDLE_GRACE_MS = 2_500

/**
 * The permissions Deskmates runs opencode under.
 *
 * `"*": "allow"` is what `--auto` did on the old `opencode run` path: approve anything not explicitly
 * denied, so a turn never stalls on an approval prompt nobody is there to answer. The `edit` rule is
 * the one hard constraint. The Work tab's base prompt is a captured Anthropic system prompt that
 * contains example user turns — including `"/…/claude-cowork.md" this one is pretty outdated, please
 * update to current, don't overwrite just create new file` — and the model has been acting on them,
 * writing a fresh `claude-cowork-<date>.md` provenance copy into the user's project folder, unbidden,
 * in response to questions as simple as "what model are you". Denying writes to that filename stops
 * it at the tool call, instead of relying on the prompt asking nicely.
 *
 * Passed through the environment rather than a config file so it is scoped to the servers Deskmates
 * starts, and leaves the user's own `opencode.json` — and its MCP servers — untouched.
 */
export const DESKMATES_OPENCODE_PERMISSIONS = JSON.stringify({
  '*': 'allow',
  edit: { '*': 'allow', '*claude-cowork*.md': 'deny' }
})

/** `opencode server listening on http://127.0.0.1:4711` — the only place the chosen port appears.
 *  Note the server defaults to 4096 whether or not `--port 0` is passed, which is why a free port is
 *  found up front instead. */
const LISTENING = /listening on (https?:\/\/[^\s/]+):(\d+)/

interface ServerHandle {
  folder: string
  proc: { kill(): void } | null
  baseUrl: string | null
  /** In-flight startup, shared so concurrent callers start the server once. */
  starting: Promise<void> | null
  sessionId: string | null
  sessionModel: string | null
  /** Whether `system` has already been delivered to this session. */
  primed: boolean
  stream: EventStream | null
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Set by the turn in flight so a server dying under it ends the turn at once, rather than leaving
   *  it waiting on events that will never arrive until the stall watchdog fires. */
  onServerGone: (() => void) | null
  /** One turn at a time per server. A second concurrent turn on one session is the overlap that
   *  deadlocked the old two-`run`-processes-at-once case, and nothing in the app prevented it. */
  busy: boolean
  waiters: Array<() => void>
  /** Bumped on every start, so events from a replaced server can't resolve the current turn. */
  generation: number
}

/** The server's event stream, parsed into the frames a turn actually cares about. */
class EventStream {
  private readonly controller = new AbortController()
  private task: Promise<void> | null = null
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()

  constructor(private readonly baseUrl: string) {}

  start(): void {
    if (this.task) return
    this.task = this.pump()
  }

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener)
    this.start()
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    this.controller.abort()
    this.task = null
    this.listeners.clear()
  }

  private async pump(): Promise<void> {
    // The stream is a long-lived connection, reopened for the life of the server; a single turn is
    // far shorter-lived than that, so reconnecting lives here and not in the turn.
    while (!this.controller.signal.aborted) {
      try {
        const response = await fetch(`${this.baseUrl}/event`, {
          signal: this.controller.signal,
          headers: { accept: 'text/event-stream' }
        })
        if (!response.ok || !response.body) throw new Error(`event stream returned ${response.status}`)
        for await (const frame of readSse(response.body)) {
          if (this.controller.signal.aborted) return
          for (const listener of [...this.listeners]) listener(frame)
        }
      } catch {
        if (this.controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
}

/** Yields one parsed `data:` payload per SSE frame. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim()
        if (data) {
          try {
            const parsed: unknown = JSON.parse(data)
            if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>
          } catch {
            // A frame we can't read is not worth failing a turn over.
          }
        }
        split = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already torn down.
    }
  }
}

/** Asks the OS for a port nobody is using, then hands it to the server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('could not find a free port'))))
    })
  })
}

async function waitForHealth(baseUrl: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) {
        const body = (await response.json()) as { healthy?: boolean }
        if (body.healthy) return
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('OpenCode did not finish starting up. See the console for details.')
}

export interface OpenCodeServerPoolOptions {
  spawner: ProcessSpawner
  idleTimeoutMs?: number
  freePort?: () => Promise<number>
}

/** Owns every `opencode serve` Deskmates has started, keyed by project folder. */
export class OpenCodeServerPool {
  private readonly servers = new Map<string, ServerHandle>()
  private readonly idleTimeoutMs: number
  private readonly freePort: () => Promise<number>

  constructor(private readonly options: OpenCodeServerPoolOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? SERVER_IDLE_TIMEOUT_MS
    this.freePort = options.freePort ?? freePort
  }

  /** True when this folder already has a server up holding a conversation, so the next prompt will be
   *  a warm follow-up rather than a cold boot. */
  isWarm(folder: string): boolean {
    const handle = this.servers.get(folder)
    return Boolean(handle?.baseUrl && handle.sessionId)
  }

  /** Asks this folder's server how much of the model's context window the conversation is using,
   *  read from the newest assistant message's own token report. Null when the folder has no
   *  conversation yet, or no turn has completed to report on — an unknown usage is not a zero, and
   *  showing 0% for a full context would be the one wrong answer this panel must never give. */
  async usage(folder: string): Promise<OpenCodeUsage | null> {
    const handle = this.servers.get(folder)
    if (!handle?.baseUrl || !handle.sessionId) return null
    try {
      const messages = await this.fetchJson<Array<{ info?: OpenCodeMessageInfo }>>(
        `${handle.baseUrl}/session/${handle.sessionId}/message`,
        { timeoutMs: USAGE_TIMEOUT_MS }
      )
      // Not `limit: 1`: probed against opencode 1.18.18, that returns an arbitrary message and the
      // response order is not chronological (with three messages, `limit=2` returned the third and the
      // first). So the whole list is read and the newest message carrying tokens is picked by its own
      // `time.created`, which is the only ordering the server actually guarantees.
      const newest = messages
        .filter((message) => message.info?.role === 'assistant' && message.info.tokens)
        .sort((a, b) => (b.info?.time?.created ?? 0) - (a.info?.time?.created ?? 0))[0]
      const tokens = newest?.info?.tokens
      if (!newest?.info || !tokens) return null
      // The reported `total` counts this turn's own output, which is not carried into the next one.
      // What actually occupies the window is the input plus the cache the server will read back, so
      // that is what the meter shows.
      const used = tokens.input + tokens.cache.read
      return { used, limit: await this.contextLimit(handle), summarized: newest.info.summary === true }
    } catch {
      // A meter that cannot be read is simply not shown; it never blocks a prompt.
      return null
    }
  }

  /** Replaces the conversation's history with a model-written summary of itself, on the same session
   *  and in the same model — which is what makes it safe for a 20k-context agent to keep going. Takes
   *  the folder's slot so a compaction never interleaves with a turn in flight.
   *
   *  Throws on anything it cannot do, because a compaction the user asked for and did not get is
   *  exactly the thing that must be reported rather than swallowed. */
  async compact(folder: string): Promise<OpenCodeUsage | null> {
    const release = await this.acquire(folder)
    try {
      const handle = this.servers.get(folder)
      if (!handle) throw new Error('OpenCode server is not available.')
      this.cancelIdleTimer(handle)
      await this.ensureStarted(handle)
      // Summarizing a conversation that has not started would either fail or invent one, so this is
      // refused up front rather than left to the server's 404.
      if (!handle.sessionId) {
        throw new Error("There's no conversation here to compact yet — send a prompt first.")
      }
      const baseUrl = handle.baseUrl
      const sessionId = handle.sessionId
      // The session's own model, not a default: compacting with a different model than the one
      // answering would summarise in a voice the conversation has never used.
      const model = handle.sessionModel ?? FALLBACK_MODEL
      const response = await fetch(`${baseUrl}/session/${sessionId}/summarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerID: providerOf(model), modelID: modelOf(model) }),
        signal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS)
      })
      if (!response.ok) {
        throw new Error(`OpenCode would not compact the conversation (HTTP ${response.status}).`)
      }
      return await this.usage(folder)
    } finally {
      release()
      const current = this.servers.get(folder)
      if (current && !current.busy) this.armIdleTimer(current)
    }
  }

  /** The model's context window for this conversation's provider, from the server's own config, so
   *  the meter's full scale is the real limit rather than a number guessed here. Null when the
   *  server won't say — an unknown limit means "no meter", not an assumed one. */
  private async contextLimit(handle: ServerHandle): Promise<number | null> {
    if (!handle.baseUrl) return null
    try {
      const config = await this.fetchJson<{
        providers?: Array<{ id?: string; models?: Record<string, { limit?: { context?: number } }> }>
      }>(`${handle.baseUrl}/config/providers`, { timeoutMs: USAGE_TIMEOUT_MS })
      const model = handle.sessionModel ?? FALLBACK_MODEL
      const provider = config.providers?.find((candidate) => candidate.id === providerOf(model))
      const limit = provider?.models?.[modelOf(model)]?.limit?.context
      return typeof limit === 'number' && limit > 0 ? limit : null
    } catch {
      return null
    }
  }

  /** A small JSON GET with a timeout, so a hung server cannot hang the UI on a background meter. */
  private async fetchJson<T>(url: string, options: { timeoutMs: number }): Promise<T> {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  }

  /** Runs one turn on this folder's server, starting it and opening a conversation if this is the
   *  first prompt in the folder. Always resolves — a server that cannot start is a turn that failed,
   *  not an exception for the caller to catch, so it comes back as `error` like every other failure
   *  here. */
  async run(folder: string, options: OpenCodeTurnOptions): Promise<OpenCodeTurnResult> {
    const release = await this.acquire(folder)
    try {
      const handle = this.servers.get(folder)
      if (!handle) throw new Error('OpenCode server is not available.')
      this.cancelIdleTimer(handle)
      await this.ensureStarted(handle)
      return await this.turn(handle, options)
    } catch (thrown) {
      return { text: '', error: thrown instanceof Error ? thrown.message : String(thrown) }
    } finally {
      release()
      const current = this.servers.get(folder)
      // Only re-arm the countdown when nothing else is queued behind this turn.
      if (current && !current.busy) this.armIdleTimer(current)
    }
  }

  /** Stops every server. Called when the app quits so no `opencode serve` outlives it. */
  disposeAll(): void {
    for (const handle of this.servers.values()) this.shutdown(handle)
    this.servers.clear()
  }

  private acquire(folder: string): Promise<() => void> {
    const handle = this.servers.get(folder) ?? this.createHandle(folder)
    if (!handle.busy) {
      handle.busy = true
      return Promise.resolve(() => this.release(handle))
    }
    return new Promise((resolve) => {
      handle.waiters.push(() => resolve(() => this.release(handle)))
    })
  }

  private release(handle: ServerHandle): void {
    // The slot passes straight to the next waiter, so it stays busy; only an empty queue frees it.
    const next = handle.waiters.shift()
    if (next) {
      next()
      return
    }
    handle.busy = false
  }

  private createHandle(folder: string): ServerHandle {
    const handle: ServerHandle = {
      folder,
      proc: null,
      baseUrl: null,
      starting: null,
      sessionId: null,
      sessionModel: null,
      primed: false,
      stream: null,
      idleTimer: null,
      onServerGone: null,
      busy: false,
      waiters: [],
      generation: 0
    }
    this.servers.set(folder, handle)
    return handle
  }

  private armIdleTimer(handle: ServerHandle): void {
    this.cancelIdleTimer(handle)
    handle.idleTimer = setTimeout(() => {
      if (!handle.busy && handle.waiters.length === 0) {
        this.shutdown(handle)
        this.servers.delete(handle.folder)
      }
    }, this.idleTimeoutMs)
    handle.idleTimer.unref?.()
  }

  private cancelIdleTimer(handle: ServerHandle): void {
    if (handle.idleTimer) clearTimeout(handle.idleTimer)
    handle.idleTimer = null
  }

  private shutdown(handle: ServerHandle): void {
    this.cancelIdleTimer(handle)
    handle.stream?.stop()
    handle.stream = null
    handle.proc?.kill()
    handle.proc = null
    handle.baseUrl = null
    handle.sessionId = null
    handle.sessionModel = null
    handle.primed = false
    handle.starting = null
  }

  private async ensureStarted(handle: ServerHandle): Promise<void> {
    if (handle.baseUrl && handle.proc) return
    if (handle.starting) return handle.starting
    handle.starting = this.start(handle).finally(() => {
      handle.starting = null
    })
    return handle.starting
  }

  private async start(handle: ServerHandle): Promise<void> {
    // A server that died between turns is replaced rather than reported: the user did not ask for a
    // failure, and a fresh boot is all it takes.
    this.shutdown(handle)
    const generation = ++handle.generation

    const port = await this.freePort()
    const stderr: string[] = []
    let baseUrl: string | null = null
    let exitMessage: string | null = null

    const proc = this.options.spawner.spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: handle.folder,
      env: { OPENCODE_PERMISSION: DESKMATES_OPENCODE_PERMISSIONS, ...promptToolsEnv() }
    })
    handle.proc = proc

    const onLine = (line: string): void => {
      if (baseUrl) return
      const match = LISTENING.exec(line)
      // Trust the port the server reports over the one we asked for: a shim can rewrite either.
      if (match) baseUrl = `${match[1]}:${match[2]}`
    }
    proc.onStdoutLine(onLine)
    proc.onStderrLine((line) => {
      onLine(line)
      stderr.push(line)
      if (stderr.length > 40) stderr.shift()
    })
    proc.onExit((code) => {
      exitMessage = `OpenCode stopped unexpectedly (exit code ${code ?? 'unknown'}).`
      if (handle.generation !== generation) return
      handle.baseUrl = null
      handle.stream?.stop()
      handle.stream = null
      // A server dying under a turn must end that turn, not leave it waiting on a stream that will
      // never produce another frame.
      handle.onServerGone?.()
    })

    const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS
    while (!baseUrl && !exitMessage && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const detail = stderr.slice(-8).join(' | ')
    if (exitMessage || !baseUrl) {
      this.shutdown(handle)
      throw new Error(
        exitMessage ? `${exitMessage}${detail ? ` ${detail}` : ''}` : `OpenCode did not start.${detail ? ` ${detail}` : ''}`
      )
    }

    const url = baseUrl
    try {
      await waitForHealth(url, deadline)
    } catch (error) {
      this.shutdown(handle)
      throw error
    }
    if (handle.generation !== generation) return

    handle.baseUrl = url
    handle.stream = new EventStream(url)
    handle.stream.start()
  }

  private async ensureSession(handle: ServerHandle, model: string): Promise<string> {
    const baseUrl = handle.baseUrl
    if (!baseUrl) throw new Error('OpenCode server is not available.')
    // A different model is a different conversation: reusing the old session would keep answering in
    // the model the user just switched away from.
    if (handle.sessionId && handle.sessionModel === model) return handle.sessionId

    const response = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Deskmates' })
    })
    if (!response.ok) throw new Error(`OpenCode would not start a conversation (HTTP ${response.status}).`)
    const created = (await response.json()) as { id?: string }
    if (!created.id) throw new Error('OpenCode did not return a conversation id.')
    handle.sessionId = created.id
    handle.sessionModel = model
    handle.primed = false
    return created.id
  }

  private turn(handle: ServerHandle, options: OpenCodeTurnOptions): Promise<OpenCodeTurnResult> {
    const generation = handle.generation
    return new Promise<OpenCodeTurnResult>((resolve) => {
      const stream = handle.stream
      if (!handle.baseUrl || !stream) {
        resolve({ text: '', error: 'OpenCode server is not available.' })
        return
      }

      let settled = false
      let unsubscribe: (() => void) | null = null
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      let capTimer: ReturnType<typeof setTimeout> | undefined
      let finishTimer: ReturnType<typeof setTimeout> | undefined
      let finishDue = 0
      /** Set once the server has reported this session idle. */
      let sawIdle = false
      let error: string | undefined
      /** Text parts in the order the model produced them, each with its final text. */
      const order: string[] = []
      const finalText = new Map<string, string>()
      /** partId → how much of its text the caller has already been given. */
      const emitted = new Map<string, number>()
      /** partId → the tool state last reported, so one tool call isn't announced a dozen times. */
      const reportedTools = new Map<string, string>()
      /** messageId of every message the server has said is *not* the assistant's.
       *
       *  The event stream is a broadcast of the whole session, so the prompt we just POSTed comes
       *  straight back down it: a `message.updated` carrying `role: 'user'`, then a
       *  `message.part.updated` for that same user message holding the prompt text. A part frame has no
       *  role of its own — only a `messageID` pointing back at its message — so the role check that
       *  discards the user's `message.updated` is not enough on its own, and without this the prompt
       *  renders as if the assistant had typed it, immediately above the real answer. */
      const nonAssistant = new Set<string>()

      const answer = (): string => order.map((id) => finalText.get(id) ?? '').join('\n').trim()

      const cleanup = (): void => {
        if (stallTimer) clearTimeout(stallTimer)
        if (capTimer) clearTimeout(capTimer)
        if (finishTimer) clearTimeout(finishTimer)
        if (handle.onServerGone === onServerGone) handle.onServerGone = null
        unsubscribe?.()
        options.signal?.removeEventListener('abort', onAbort)
      }

      const finish = (result: OpenCodeTurnResult): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      const fail = (message: string): void => {
        if (error) return
        error = message
        // A turn we have given up on has to be told to stop, or the server keeps generating into a
        // conversation nobody is listening to — burning the user's tokens after Deskmates gave up.
        askServerToStop()
        finish({ text: answer(), error })
      }

      /** Asks the server to halt the turn. Best effort by design: the caller is resolved either way,
       *  and a stop must not wait on the abort landing. */
      const askServerToStop = (): void => {
        if (!handle.sessionId || !handle.baseUrl) return
        void fetch(`${handle.baseUrl}/session/${handle.sessionId}/abort`, { method: 'POST' }).catch(() => undefined)
      }

      /** Ends the turn once the wire has gone quiet.
       *
       *  A deadline set by a completed *step* is only ever pushed out, never pulled in, so a tool that
       *  is taking its time cannot have the ending moved towards it — a real
       *  `playwright_browser_navigate` left a five second gap between one step completing and the next
       *  beginning. `session.idle` is the one thing allowed to pull it in, because idle is a stronger
       *  signal than a step boundary and should not wait out the grace period. Any event arriving
       *  while an ending is pending pushes it out again, which is what lets a late frame be collected
       *  rather than lost. */
      const scheduleFinish = (delay: number, force = false): void => {
        if (settled) return
        const due = Date.now() + delay
        if (finishTimer) {
          if (!force && due <= finishDue) return
          clearTimeout(finishTimer)
        }
        finishDue = due
        finishTimer = setTimeout(() => {
          finishTimer = undefined
          finish({ text: answer(), ...(error ? { error } : {}) })
        }, delay)
        finishTimer.unref?.()
      }

      /** Any activity at all — text, a tool starting, a tool finishing — means the turn is alive. */
      const resetStall = (): void => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          fail('The OpenCode turn stopped responding, so it was stopped. Try again, or use a different model.')
        }, options.stallMs)
        stallTimer.unref?.()
      }

      function onAbort(): void {
        // Ask the server to stop generating, but resolve the caller at once: waiting for the abort to
        // land is what made Stop feel dead.
        askServerToStop()
        finish({ text: answer(), stopped: true })
      }

      function onServerGone(): void {
        fail('OpenCode stopped while it was working. Try again.')
      }

      // Subscribed before the prompt is sent, so the turn's first event cannot be missed.
      unsubscribe = stream.subscribe((event) => {
        if (settled || handle.generation !== generation) return
        const properties = event.properties as
          | { sessionID?: string; part?: Record<string, any>; info?: Record<string, any>; error?: unknown }
          | undefined
        if (!properties || properties.sessionID !== handle.sessionId) return
        resetStall()
        // A frame of any kind means the turn is still going, so it pushes a pending ending out.
        if (finishTimer) scheduleFinish(sawIdle ? SETTLE_MS : IDLE_GRACE_MS)

        if (event.type === 'session.error') {
          fail(typeof properties.error === 'string' ? properties.error : 'OpenCode reported an error running this prompt.')
          return
        }

        // The end of the turn, as opposed to the end of a step: it carries the session id, so it
        // survives the filter above, and it arrives after the last part.
        if (event.type === 'session.idle') {
          sawIdle = true
          scheduleFinish(SETTLE_MS, true)
          return
        }

        if (event.type === 'message.updated') {
          const info = properties.info
          // Remember non-assistant messages so their parts can be recognised when they arrive: the
          // role lives on the message, and a part only points back at it.
          if (info?.role !== 'assistant' && typeof info?.id === 'string') nonAssistant.add(info.id)
          if (info?.role !== 'assistant') return
          // A completed assistant message closes a *step*. A turn that uses a tool has one per step,
          // and the answer usually lives in the last one, so this only starts a countdown — it must
          // never end the turn on its own.
          if (info.time && typeof info.time.completed === 'number') scheduleFinish(IDLE_GRACE_MS)
          return
        }

        if (event.type !== 'message.part.updated') return
        const part = properties.part
        if (!part || typeof part.id !== 'string') return
        // The user's own prompt, echoed back. Not part of the answer.
        if (typeof part.messageID === 'string' && nonAssistant.has(part.messageID)) return

        if (part.type === 'step-start') {
          options.onEvent?.({ kind: 'step-start' })
          return
        }

        if (part.type === 'text') {
          const whole = typeof part.text === 'string' ? part.text : ''
          if (!whole) return
          const already = emitted.get(part.id) ?? 0
          if (whole.length <= already) return
          if (!finalText.has(part.id)) order.push(part.id)
          finalText.set(part.id, whole)
          emitted.set(part.id, whole.length)
          options.onEvent?.({ kind: 'text', text: whole.slice(already) })
          return
        }

        if (part.type !== 'tool') return
        const state = part.state as { status?: string; input?: unknown; error?: string } | undefined
        const status = state?.status ?? 'running'
        if (status === 'pending') return
        const mapped = status === 'error' ? 'error' : status === 'completed' ? 'done' : 'running'
        // opencode re-sends the whole tool part as it fills in; only report a state the caller has
        // not already seen, or one tool call turns into a dozen gray lines.
        const fingerprint = `${mapped}:${state?.error ?? ''}`
        if (reportedTools.get(part.id) === fingerprint) return
        reportedTools.set(part.id, fingerprint)
        options.onEvent?.({
          kind: 'tool',
          id: part.id,
          tool: typeof part.tool === 'string' ? part.tool : 'opencode',
          input: state?.input ?? {},
          state: mapped,
          ...(state?.error ? { error: state.error } : {})
        })
      })

      handle.onServerGone = onServerGone
      capTimer = setTimeout(() => {
        fail(`The OpenCode turn went over ${Math.round(options.timeoutMs / 60_000)} minutes without finishing, so it was stopped.`)
      }, options.timeoutMs)
      capTimer.unref?.()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      resetStall()

      void (async () => {
        try {
          const sessionId = await this.ensureSession(handle, options.model)
          if (settled) return
          const deliverSystem = !handle.primed && Boolean(options.system)
          const body: Record<string, unknown> = {
            model: { providerID: providerOf(options.model), modelID: modelOf(options.model) },
            parts: [{ type: 'text', text: options.prompt }]
          }
          if (deliverSystem) body.system = options.system
          const response = await fetch(`${handle.baseUrl}/session/${sessionId}/prompt_async`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          if (!response.ok) {
            fail(`OpenCode would not accept the prompt (HTTP ${response.status}).`)
            return
          }
          if (deliverSystem) handle.primed = true
        } catch (thrown) {
          fail(thrown instanceof Error ? thrown.message : 'OpenCode could not be reached.')
        }
      })()
    })
  }
}

/** `provider/model`, as opencode's `-m` flag spells it. */
export function providerOf(model: string): string {
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash) : model
}

export function modelOf(model: string): string {
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(slash + 1) : model
}
