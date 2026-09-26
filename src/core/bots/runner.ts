/**
 * BotRunner: runs a bot's task end to end with the same AI SDK tool-calling loop as the Work-tab
 * assistant (see `engine/runner.ts`), but with the bot's own instructions, model and pre-approved
 * actions, driving its PC's browser/screen/files through the injected `BotHost`. It owns each
 * run's state transitions and its own display log, mirroring `engine/live.ts`'s live-timeline
 * pattern but writing to `<dataDir>/runs/<runId>/log.jsonl` instead of SQLite — bot run history
 * is file-based by design (see the design spec, section 6: "Run logs and screenshots are stored
 * as files").
 *
 * `respond()` is reached through the `runs.respond` RPC method (`handlers.ts`), which the Bots
 * tab's `Conversation`/`ApprovalCard` call for a bot run's timeline — kept separate from the Work
 * tab's task-scoped `approvals.respond`, since a run id was never a task id. Pending approvals
 * live only in `this.live`, in memory: a run stuck at `waiting-approval` across an app restart is
 * reconciled to `error` at startup instead (see `repos.runs.resetInterrupted()`, called from
 * `main.ts`), since nothing could otherwise ever resume or stop it.
 *
 * `setTakenOver()` is reached through the `pcs.takeOver` RPC method, called when the user opens or
 * releases "Take over" on the PC panel (spec 5.8: "'Take over' pauses the bot and gives you its
 * mouse and keyboard"). While a bot is taken over, every tool that would touch its PC directly —
 * its screen, its browser, its on-disk files — refuses to run (see `guardPcTools` below) instead
 * of colliding with whatever the human is doing on the same PC.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStepCount, ToolLoopAgent, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai'
import type { Bot, BotRun, ProviderId, RunState, TimelineItem, ToolItem } from '../../shared/protocol'
import { PROVIDER_LABELS } from '../../shared/protocol'
import { compactHistory } from '../engine/history'
import { friendlyError, type ModelResolver } from '../engine/runner'
import type { EventBus } from '../events'
import type { SkillsService } from '../extensions/skills'
import type { McpConnectorManager } from '../connectors'
import type { Repos } from '../store/repos'
import type { BotHost, PcEndpoints } from './host'
import type { RunService } from './services'
import { HttpAgentClient, type AgentClient } from './tools/agent-client'
import { ChromeCdpClient, type CdpClient } from './tools/cdp-client'
import { approvalForBotTool, botTools } from './tools'
import { patientModel } from '../models/patience'
import { redactToolInputForLog } from './tools/redaction'
import { PcUnreachableError, type SaveScreenshot } from './tools/types'

export interface BotRunnerDeps {
  repos: Repos
  bus: EventBus
  /** Reaches each bot's PC: start it, and get the agent/CDP endpoints to build tool clients from. */
  host: BotHost
  models: ModelResolver
  /** The app's data folder; runs write to `<dataDir>/runs/<runId>/`. */
  dataDir: string
  maxSteps?: number
  now?: () => number
  /** Overrides how the agent HTTP client is built from a PC's endpoints. Defaults to a real `HttpAgentClient`; tests inject a fake. */
  createAgentClient?: (endpoints: PcEndpoints) => AgentClient
  /** Overrides how the CDP client is built from a PC's endpoints. Defaults to a real `ChromeCdpClient`; tests inject a fake. */
  createCdpClient?: (endpoints: PcEndpoints) => CdpClient
  /** The skills library, when skills are set up on this machine; absent otherwise. */
  skills?: SkillsService
  /** MCP connectors (spec 5.6); absent until that task is wired up, so bot runs get no connector tools then. */
  connectors?: McpConnectorManager
}

interface ApprovalAnswer {
  approvalId: string
  approved: boolean
  toolName: string
}

/** Everything kept in memory for a run between its first `start()` and its terminal state. Survives an approval pause; discarded once the run finishes, errors or is stopped. */
interface RunLiveState {
  messages: ModelMessage[]
  /** Set only while a pass is actively streaming. `stop()` only has an effect then — same as TaskRunner. */
  controller: AbortController | null
  pendingApprovals: Map<string, { toolCallId: string; toolName: string }>
  answers: ApprovalAnswer[]
  toolMap: Map<string, ToolItem>
  currentTextId: string | null
  currentText: string
  textCounter: number
  lastEmitTime: number
  screenshotCounter: number
}

function newLiveState(): RunLiveState {
  return {
    messages: [],
    controller: null,
    pendingApprovals: new Map(),
    answers: [],
    toolMap: new Map(),
    currentTextId: null,
    currentText: '',
    textCounter: 0,
    lastEmitTime: 0,
    screenshotCounter: 0
  }
}

function buildBotInstructions(
  bot: Bot,
  now: Date,
  model: { provider: ProviderId; modelId: string },
  skills?: SkillsService
): string {
  const parts: string[] = []
  parts.push(
    `You are ${bot.name}, a Deskmates bot with your own Linux computer, working on the task below without anyone watching unless they choose to.`
  )
  const timeStr = now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  parts.push(`Now: ${timeStr} (${timeZone})`)
  parts.push('')
  parts.push('How to work:')
  parts.push('- Prefer read_page over screenshot: reading a page as text uses far less of your budget than looking at an image.')
  parts.push(
    '- Your own storage is under "data/..." (list_pc_files, read_pc_file, write_pc_file) and survives between runs — use it to remember what you already reported, so you never repeat yourself. "shared/..." is visible to every bot.'
  )
  parts.push(
    "- You never type a password, anywhere. If a site or app needs a login you don't already have, stop and say so plainly, so the user can open Take Over and sign in themselves — don't try to work around it."
  )
  parts.push('- handoff gives another bot a task; reference files under "shared/...", since "data/..." is private to you.')
  parts.push('- Finish with a short, plain summary of what you did and what you found.')
  parts.push('')
  parts.push(`You are running on ${PROVIDER_LABELS[model.provider]} model ${model.modelId}.`)
  const installed = skills?.list().filter((s) => s.enabled).map((s) => s.name).sort() ?? []
  if (installed.length > 0) {
    parts.push('')
    parts.push('Installed skills (load one with load_skill when your task matches it):')
    parts.push(installed.map((name) => `- ${name}`).join('\n'))
  }
  const botInstructions = bot.instructions.trim()
  if (botInstructions) {
    parts.push('')
    parts.push("This bot's instructions:")
    parts.push(botInstructions)
  }
  return parts.join('\n')
}

function logPath(folder: string): string {
  return join(folder, 'log.jsonl')
}

/** Reads a run's display log back into a timeline: one JSON `TimelineItem` per line, later lines updating an earlier item's state by id. */
function readLog(folder: string): TimelineItem[] {
  const path = logPath(folder)
  if (!existsSync(path)) return []
  const byId = new Map<string, TimelineItem>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line) as TimelineItem
      byId.set(item.id, item)
    } catch {
      // A corrupt line shouldn't hide the rest of a run's history.
    }
  }
  return [...byId.values()]
}

function defaultAgentClient(endpoints: PcEndpoints): AgentClient {
  return new HttpAgentClient(endpoints.agent, endpoints.token)
}

function defaultCdpClient(endpoints: PcEndpoints): CdpClient {
  return new ChromeCdpClient(endpoints.cdp)
}

/**
 * Tool names that drive the bot PC directly — its screen (`screen_*`), its browser (the `browserTools`
 * group) or its on-disk storage (the `pcFilesTools` group) — as opposed to tools like `handoff` or
 * `whatsapp_send` that only touch the shared data folder or a single approved chat. Kept as a name
 * list here (rather than in `tools/`) so blocking them while taken over doesn't require editing the
 * tool files themselves.
 */
const PC_TOUCHING_TOOLS: ReadonlySet<string> = new Set([
  'screen_screenshot',
  'screen_click',
  'screen_type',
  'screen_key',
  'screen_scroll',
  'open_page',
  'read_page',
  'click',
  'type_text',
  'screenshot',
  'tabs',
  'list_pc_files',
  'read_pc_file',
  'write_pc_file'
])

/**
 * Wraps every tool in `PC_TOUCHING_TOOLS` so it refuses to run while `isTakenOver()` is true,
 * instead of reaching the bot's screen, browser or files while a human has control of them. Other
 * tools (handoff, WhatsApp) pass through unchanged. The thrown error becomes a normal `tool-error`
 * in the run's log, the same way a blocked password field already does (see `cdp-client.ts`).
 *
 * When a wrapped tool can't reach the PC at all (`PcUnreachableError`: the container stopped, or
 * its engine did), `recoverPc` brings it back up and the tool is retried once. A request that was
 * never answered can't have half-happened, so the retry is safe.
 */
function guardPcTools(tools: ToolSet, isTakenOver: () => boolean, recoverPc: () => Promise<void>): ToolSet {
  const guarded: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(tools)) {
    const original = (def as { execute?: (...args: unknown[]) => unknown }).execute
    if (!PC_TOUCHING_TOOLS.has(name) || typeof original !== 'function') {
      guarded[name] = def
      continue
    }
    guarded[name] = {
      ...(def as object),
      execute: async (...args: unknown[]) => {
        if (isTakenOver()) {
          throw new Error("The user has taken over this bot's PC — wait until they give control back before using it.")
        }
        try {
          return await original.apply(def, args)
        } catch (error) {
          if (!(error instanceof PcUnreachableError)) throw error
          try {
            await recoverPc()
          } catch (recoverError) {
            throw new Error(`This bot's PC stopped responding and couldn't be started again: ${friendlyError(recoverError)}`)
          }
          return original.apply(def, args)
        }
      }
    }
  }
  return guarded as ToolSet
}

export class BotRunner implements RunService {
  private readonly deps: BotRunnerDeps
  private readonly live = new Map<string, RunLiveState>()
  private readonly idleWaiters = new Map<string, Array<() => void>>()
  /** Bot ids currently taken over by a human — see `setTakenOver` and `guardPcTools`. */
  private readonly takenOverBots = new Set<string>()

  constructor(deps: BotRunnerDeps) {
    this.deps = deps
  }

  /** Sets or clears whether a human has taken over this bot's PC (see the class doc and `guardPcTools`). */
  setTakenOver(botId: string, on: boolean): void {
    if (on) this.takenOverBots.add(botId)
    else this.takenOverBots.delete(botId)
  }

  async start(run: BotRun, bot: Bot): Promise<void> {
    if (this.live.has(run.id)) throw new Error('This run is already working.')
    this.live.set(run.id, newLiveState())
    void this.executeRun(run, bot)
  }

  async stop(runId: string): Promise<void> {
    this.live.get(runId)?.controller?.abort()
  }

  /** Stops every in-flight run and waits for each to actually go idle. Mirrors `TaskRunner.stopAll()`; used by shutdown. */
  async stopAll(): Promise<void> {
    const runIds = [...this.live.keys()]
    for (const runId of runIds) this.live.get(runId)?.controller?.abort()
    await Promise.all(runIds.map((id) => this.whenIdle(id)))
  }

  async items(runId: string): Promise<TimelineItem[]> {
    const run = this.deps.repos.runs.require(runId)
    return readLog(run.folder)
  }

  /** Answers a pending approval, resuming the run once every approval from the same step is answered. See the class doc for why this isn't on `RunService` yet. */
  async respond(runId: string, approvalId: string, approved: boolean, always = false): Promise<void> {
    const run = this.deps.repos.runs.require(runId)
    const state = this.live.get(runId)
    if (run.state !== 'waiting-approval' || !state) throw new Error("That run isn't waiting for approval.")
    const pending = state.pendingApprovals.get(approvalId)
    if (!pending || state.answers.some((a) => a.approvalId === approvalId)) {
      throw new Error('That approval is no longer pending.')
    }

    state.answers.push({ approvalId, approved, toolName: pending.toolName })
    this.markAnswered(run, state, approvalId, approved)

    if (always && approved) {
      const bot = this.deps.repos.bots.require(run.botId)
      if (!bot.autoApprove.includes(pending.toolName)) {
        const updatedBot = this.deps.repos.bots.update(bot.id, { autoApprove: [...bot.autoApprove, pending.toolName] })
        this.deps.bus.emit({ type: 'bot.updated', bot: updatedBot })
      }
      for (const [id, entry] of state.pendingApprovals) {
        if (entry.toolName === pending.toolName && !state.answers.some((a) => a.approvalId === id)) {
          state.answers.push({ approvalId: id, approved: true, toolName: entry.toolName })
          this.markAnswered(run, state, id, true)
        }
      }
    }

    const unanswered = [...state.pendingApprovals.keys()].filter((id) => !state.answers.some((a) => a.approvalId === id))
    if (unanswered.length > 0) return

    state.messages.push({
      role: 'tool',
      content: state.answers.map((a) => ({ type: 'tool-approval-response' as const, approvalId: a.approvalId, approved: a.approved }))
    } as ModelMessage)
    state.answers = []
    state.pendingApprovals.clear()

    const bot = this.deps.repos.bots.require(run.botId)
    void this.executeRun(this.deps.repos.runs.require(runId), bot)
  }

  /** Resolves once the run isn't actively streaming a pass — a no-op if it's already idle (including while waiting for approval). For tests, mirroring `TaskRunner.whenIdle`. */
  async whenIdle(runId: string): Promise<void> {
    if (!this.live.get(runId)?.controller) return
    return new Promise((resolve) => {
      if (!this.idleWaiters.has(runId)) this.idleWaiters.set(runId, [])
      this.idleWaiters.get(runId)!.push(resolve)
    })
  }

  isRunning(runId: string): boolean {
    return this.live.get(runId)?.controller != null
  }

  // ---- one pass of the loop ----

  private async executeRun(run: BotRun, bot: Bot): Promise<void> {
    const state = this.live.get(run.id)
    if (!state) return
    const controller = new AbortController()
    state.controller = controller
    const now = this.deps.now ?? Date.now

    try {
      this.updateRunState(run.id, 'running')
      mkdirSync(run.folder, { recursive: true })

      if (state.messages.length === 0) {
        state.messages.push({ role: 'user', content: run.task })
        this.emitItem(run.id, run.folder, { kind: 'user', id: 'task', at: now(), text: run.task })
      }

      // Resolved before starting the PC: a bot with no model (or a rejected API key) should fail
      // fast rather than spend a container startup on a run that can't proceed anyway.
      const { model, provider, modelId, cli } = this.deps.models.resolve(bot.model)
      if (cli) {
        throw new Error(
          `${PROVIDER_LABELS[provider]} runs through a local CLI session, which can't drive this bot's PC. Pick an API-backed model for this bot instead.`
        )
      }
      const instructions = buildBotInstructions(bot, new Date(now()), { provider, modelId }, this.deps.skills)

      const pc = await this.deps.host.start(bot.id)
      if (pc.state !== 'running') throw new Error("This bot's PC didn't start.")
      const endpoints = await this.deps.host.endpoints(bot.id)
      if (!endpoints) throw new Error("This bot's PC isn't reachable right now.")

      const agentClient = (this.deps.createAgentClient ?? defaultAgentClient)(endpoints)
      const cdpClient = (this.deps.createCdpClient ?? defaultCdpClient)(endpoints)

      const saveScreenshot: SaveScreenshot = async (png, label) => {
        state.screenshotCounter += 1
        const name = `${label}-${state.screenshotCounter}.png`
        writeFileSync(join(run.folder, name), png)
        return { path: name, bytes: png.length }
      }

      const tools = botTools({
        agent: agentClient,
        cdp: cdpClient,
        saveScreenshot,
        dataDir: this.deps.dataDir,
        botId: bot.id,
        lookup: this.deps.repos.bots,
        skills: this.deps.skills,
        connectors: this.deps.connectors,
        whatsappTo: this.deps.repos.settings.get().whatsappTo
      })
      // Shared, so parallel tool calls that all hit a stopped PC restart it once, not once each.
      let recovering: Promise<void> | null = null
      const recoverPc = (): Promise<void> =>
        (recovering ??= (async () => {
          const restarted = await this.deps.host.start(bot.id)
          if (restarted.state !== 'running') throw new Error("This bot's PC didn't start.")
          // Tab connections from before the restart point at a browser that no longer exists.
          await cdpClient.close()
        })().finally(() => {
          recovering = null
        }))
      const guardedTools = guardPcTools(tools, () => this.takenOverBots.has(bot.id), recoverPc)

      const agent = new ToolLoopAgent({
        model: patientModel(model),
        instructions,
        tools: guardedTools,
        toolApproval: ({ toolCall }: { toolCall: { toolName: string } }) => approvalForBotTool(toolCall.toolName, bot.autoApprove),
        stopWhen: isStepCount(this.deps.maxSteps ?? 40)
      })

      const result = await agent.stream({ messages: compactHistory(state.messages), abortSignal: controller.signal })

      let firstError: unknown = null
      for await (const part of result.stream) {
        this.applyPart(run, state, part as TextStreamPart<ToolSet>)
        const p = part as any
        if (p.type === 'finish-step') {
          const usage = p.usage
          this.deps.repos.usage.add(
            provider,
            1,
            usage?.inputTokens?.total ?? usage?.inputTokens ?? 0,
            usage?.outputTokens?.total ?? usage?.outputTokens ?? 0
          )
        }
        if (p.type === 'error' && !firstError) firstError = p.error
      }
      this.flushText(run, state)

      try {
        const responseMessages = await result.responseMessages
        if (responseMessages?.length) state.messages.push(...(responseMessages as ModelMessage[]))
      } catch {
        // Best-effort: the run's outcome below doesn't depend on capturing the raw response messages.
      }

      try {
        await cdpClient.close()
      } catch {
        // Closing the browser sockets is cleanup, not part of the run's outcome.
      }

      if (controller.signal.aborted) {
        this.finishRun(run.id, 'stopped', 'Stopped.')
      } else if (firstError) {
        this.finishRun(run.id, 'error', friendlyError(firstError))
      } else if (state.pendingApprovals.size > 0) {
        this.updateRunState(run.id, 'waiting-approval')
      } else {
        this.finishRun(run.id, 'done', null)
      }
    } catch (err) {
      this.finishRun(run.id, 'error', friendlyError(err))
    } finally {
      state.controller = null
      const waiters = this.idleWaiters.get(run.id)
      if (waiters) {
        this.idleWaiters.delete(run.id)
        for (const resolve of waiters) resolve()
      }
    }
  }

  private updateRunState(runId: string, runState: RunState): void {
    const run = this.deps.repos.runs.update(runId, { state: runState, error: null })
    this.deps.bus.emit({ type: 'run.updated', run })
  }

  private finishRun(runId: string, runState: 'done' | 'error' | 'stopped', error: string | null): void {
    const run = this.deps.repos.runs.update(runId, { state: runState, finishedAt: (this.deps.now ?? Date.now)(), error })
    this.deps.bus.emit({ type: 'run.updated', run })
    this.live.delete(runId)
  }

  private markAnswered(run: BotRun, state: RunLiveState, approvalId: string, approved: boolean): void {
    for (const item of state.toolMap.values()) {
      if (item.approvalId !== approvalId) continue
      item.state = approved ? 'running' : 'denied'
      if (approved) delete item.approvalId
      this.emitItem(run.id, run.folder, item)
      return
    }
  }

  // ---- live stream -> log.jsonl + run.item (mirrors engine/live.ts's LiveTimeline, per run) ----

  private applyPart(run: BotRun, state: RunLiveState, part: TextStreamPart<ToolSet>): void {
    const p = part as any
    const now = this.deps.now ?? Date.now

    switch (p.type) {
      case 'start-step':
        state.currentTextId = null
        state.currentText = ''
        break

      case 'text-delta': {
        if (!state.currentTextId) {
          state.textCounter++
          state.currentTextId = `live-${state.textCounter}`
          state.currentText = ''
        }
        state.currentText += p.text ?? p.delta ?? ''
        const t = now()
        if (t - state.lastEmitTime >= 50) {
          this.emitText(run, state)
          state.lastEmitTime = t
        }
        break
      }

      case 'tool-call': {
        this.flushText(run, state)
        // Redacted here, once, at the point this item is first built: every downstream use (the
        // persisted log.jsonl line below, the run.item bus event, and any later re-emit of this
        // same item on approval/answer) reads from this same object, so nothing further needs to
        // redact separately. See tools/redaction.ts for what's redacted and why.
        const item: ToolItem = {
          kind: 'tool',
          id: p.toolCallId,
          at: now(),
          toolName: p.toolName,
          input: redactToolInputForLog(p.toolName, p.input),
          state: 'running'
        }
        state.toolMap.set(p.toolCallId, item)
        this.emitItem(run.id, run.folder, item)
        break
      }

      case 'tool-approval-request': {
        if (!p.isAutomatic) {
          const toolCallId = p.toolCall?.toolCallId ?? p.toolCallId
          const existing = state.toolMap.get(toolCallId)
          if (existing) {
            existing.state = 'awaiting-approval'
            existing.approvalId = p.approvalId
            state.pendingApprovals.set(p.approvalId, { toolCallId, toolName: existing.toolName })
            this.emitItem(run.id, run.folder, existing)
          }
        }
        break
      }

      case 'tool-result': {
        const existing = state.toolMap.get(p.toolCallId)
        if (existing) {
          existing.state = 'done'
          existing.output = p.output
          this.emitItem(run.id, run.folder, existing)
        }
        break
      }

      case 'tool-error': {
        const existing = state.toolMap.get(p.toolCallId)
        if (existing) {
          existing.state = 'error'
          existing.error = p.error?.message ?? String(p.error)
          this.emitItem(run.id, run.folder, existing)
        }
        break
      }

      case 'tool-output-denied': {
        const existing = state.toolMap.get(p.toolCallId)
        if (existing) {
          existing.state = 'denied'
          this.emitItem(run.id, run.folder, existing)
        }
        break
      }
    }
  }

  private flushText(run: BotRun, state: RunLiveState): void {
    if (state.currentTextId && state.currentText.trim()) this.emitText(run, state)
    state.currentTextId = null
    state.currentText = ''
  }

  private emitText(run: BotRun, state: RunLiveState): void {
    if (!state.currentTextId) return
    this.emitItem(run.id, run.folder, { kind: 'assistant', id: state.currentTextId, at: (this.deps.now ?? Date.now)(), text: state.currentText })
  }

  private emitItem(runId: string, folder: string, item: TimelineItem): void {
    mkdirSync(folder, { recursive: true })
    appendFileSync(logPath(folder), `${JSON.stringify(item)}\n`, 'utf8')
    this.deps.bus.emit({ type: 'run.item', runId, item })
  }
}
