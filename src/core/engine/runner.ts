/**
 * TaskRunner: orchestrates agent runs with streaming, approvals and stop.
 */
import {
  ToolLoopAgent,
  isStepCount,
  hasToolCall,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet
} from 'ai'
import type { EventBus } from '../events'
import type { ChangeLog } from '../fs/change-log'
import type { Repos } from '../store/repos'
import type { ToolContext } from '../tools/context'
import type { ModelRef, ProviderId, TimelineItem } from '../../shared/protocol'
import type { TerminalsService } from '../terminals/service'
import { patientModel } from '../models/patience'
import { PROVIDER_LABELS } from '../../shared/protocol'
import { approvalFor } from './approvals'
import { compactHistory } from './history'
import { suggestNextMessage } from './suggest'
import { historyBudgetChars, toolsChars } from '../models/context'
import { guardRiskyTools, pickPromptTools } from '../tools/shared-prompt-tools'
import { resolve as resolvePath } from 'node:path'
import { buildInstructions, readProjectInstructions } from './instructions'
import { LiveTimeline } from './live'
import { buildTimeline, danglingToolCalls, pendingApprovals } from './timeline'

/** Model resolver interface — declared locally per job instructions. */
export interface ModelResolver {
  resolve(ref: ModelRef | null): { model: LanguageModel; provider: ProviderId; modelId: string; cli?: boolean }
}

export interface RunnerDeps {
  repos: Repos
  /** Deskmates' data folder (shared memory documents, chat widgets). */
  dataDir?: string
  /** The connected Google account, for the Gmail, Calendar and Drive tools. */
  google?: ToolContext['google']
  bus: EventBus
  models: ModelResolver
  changes: ChangeLog
  createTools: (ctx: ToolContext) => ToolSet
  /** The skills library, when skills are set up on this machine; absent otherwise. */
  skills?: ToolContext['skills']
  /** MCP connectors (spec 5.6); absent until that task is wired up, so runs get no connector tools then. */
  connectors?: ToolContext['connectors']
  plugins?: ToolContext['plugins']
  /** Sub-agent runner (spec 5.1); absent until that task is wired up, so runs get no delegate tool then. */
  subagents?: ToolContext['subagents']
  /** Terminal-agent service (spec 5.14); required for tasks routed to a CLI-backed model provider.
   *  A getter so wiring order in main.ts doesn't matter — it's only read once a task actually runs. */
  getTerminals?: () => TerminalsService | undefined
  /** Offscreen page rendering in the host, for the design tools that screenshot or run pages. */
  render?: ToolContext['render']
  /** The agent browser; absent without the app. */
  browser?: ToolContext['browser']
  /** Screen control for screen_look / screen_act; absent without a desktop. */
  screen?: ToolContext['screen']
  /** Scheduled tasks; absent in tests. A getter, since the scheduler is built after the runner. */
  getSchedules?: () => ToolContext['schedules']
  /** The `deskmates` command, for command-line agents to reach the agent browser from their shell.
   *  A getter, since the agent kit is written after the runner is built. */
  agentCommand?: () => string | undefined
  /** The name a run acts under in browser questions (a scheduled task's name), when it isn't the tab's. */
  agentNameFor?: (taskId: string) => string | undefined
  now?: () => Date
}

/** ScheduleWakeup's allowed delay, like the tool it mirrors. */
const MIN_WAKEUP_MS = 60_000
const MAX_WAKEUP_MS = 60 * 60_000

/** Extracts a friendly error message from various error shapes. */
export function friendlyError(error: unknown): string {
  const statusCode = getStatusCode(error)
  if (statusCode === 401 || statusCode === 403) {
    return 'The API key was rejected. Check it in Settings.'
  }
  if (statusCode === 429) {
    return 'The model\'s rate limit or quota was reached. Wait a bit or pick another model.'
  }
  if (error instanceof Error) return error.message
  return String(error)
}

function getStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    if ('statusCode' in error && typeof (error as any).statusCode === 'number') {
      return (error as any).statusCode
    }
    if ('cause' in error && (error as any).cause && typeof (error as any).cause === 'object') {
      if ('statusCode' in (error as any).cause) return (error as any).cause.statusCode
    }
    if ('lastError' in error && (error as any).lastError && typeof (error as any).lastError === 'object') {
      if ('statusCode' in (error as any).lastError) return (error as any).lastError.statusCode
    }
  }
  return undefined
}

interface ApprovalAnswer {
  approvalId: string
  approved: boolean
  reason?: string
  toolName?: string
}

interface RunState {
  controller: AbortController
  promise: Promise<void>
}

export class TaskRunner {
  private readonly deps: RunnerDeps
  private readonly runs = new Map<string, RunState>()
  private readonly queued = new Map<string, string[]>()
  private readonly suggestions = new Map<string, string>()
  /** In-memory collected (but not yet appended) approval answers. */
  private readonly answers = new Map<string, ApprovalAnswer[]>()
  private readonly idleWaiters = new Map<string, Array<() => void>>()

  /** Pending ScheduleWakeup timers, cleared on shutdown. */
  private readonly wakeups = new Set<ReturnType<typeof setTimeout>>()

  constructor(deps: RunnerDeps) {
    this.deps = deps
  }

  async send(taskId: string, text: string): Promise<void> {
    const task = this.deps.repos.tasks.require(taskId)

    // The suggestion is for the message the user hasn't written yet; now they have.
    if (this.suggestions.delete(taskId)) this.deps.bus.emit({ type: 'task.suggestion', taskId, text: null })

    // Sent while it works: kept, shown as queued, and sent as soon as this reply ends.
    if (this.runs.has(taskId)) {
      const queued = [...(this.queued.get(taskId) ?? []), text]
      this.queued.set(taskId, queued)
      this.deps.bus.emit({ type: 'task.queued', taskId, queued })
      return
    }
    if (task.status === 'waiting-approval') {
      throw new Error('Answer the pending approval first.')
    }

    // Append user message
    this.deps.repos.tasks.appendMessages(taskId, [{ role: 'user', content: text }])

    // Set title from first message if still default
    if (task.title === 'New task') {
      let title = text.split('\n')[0].trim()
      if (title.length > 60) {
        title = title.slice(0, 60) + '…'
      }
      this.deps.repos.tasks.update(taskId, { title })
    }

    // Emit timeline
    const stored = this.deps.repos.tasks.messages(taskId)
    this.deps.bus.emit({ type: 'task.timeline', taskId, timeline: buildTimeline(stored) })

    // Start the run in the background
    this.startRun(taskId)
  }

  async respond(taskId: string, approvalId: string, approved: boolean, always?: boolean): Promise<void> {
    const task = this.deps.repos.tasks.require(taskId)
    if (task.status !== 'waiting-approval') {
      throw new Error('That approval is no longer pending.')
    }

    const stored = this.deps.repos.tasks.messages(taskId)
    const pending = pendingApprovals(stored)
    const match = pending.find((p) => p.approvalId === approvalId)
    if (!match) {
      throw new Error('That approval is no longer pending.')
    }

    // Initialize answer list for this task if needed
    if (!this.answers.has(taskId)) this.answers.set(taskId, [])
    const answers = this.answers.get(taskId)!

    if (answers.some((a) => a.approvalId === approvalId)) {
      throw new Error('That approval is no longer pending.')
    }

    const answer: ApprovalAnswer = {
      approvalId,
      approved,
      reason: approved ? undefined : 'The user denied this action.',
      toolName: match.toolName
    }
    answers.push(answer)

    // If always && approved: add tool to autoApprove
    if (always && approved) {
      const currentTask = this.deps.repos.tasks.require(taskId)
      if (!currentTask.autoApprove.includes(match.toolName)) {
        const newAutoApprove = [...currentTask.autoApprove, match.toolName]
        const updatedTask = this.deps.repos.tasks.update(taskId, { autoApprove: newAutoApprove })
        this.deps.bus.emit({ type: 'task.updated', task: updatedTask })
      }

      // Also approve every other pending request for the same tool
      for (const p of pending) {
        if (p.toolName === match.toolName && p.approvalId !== approvalId) {
          if (!answers.find((a) => a.approvalId === p.approvalId)) {
            answers.push({ approvalId: p.approvalId, approved: true, toolName: p.toolName })
          }
        }
      }
    }

    // Check if all pending approvals are answered
    const answeredIds = new Set(answers.map((a) => a.approvalId))
    const stillPending = pending.filter((p) => !answeredIds.has(p.approvalId))

    if (stillPending.length > 0) {
      // Emit timeline with overlay and return
      this.deps.bus.emit({ type: 'task.timeline', taskId, timeline: this.timeline(taskId) })
      return
    }

    // All answered — append one tool message with all responses and start run
    const responseParts = answers.map((a) => ({
      type: 'tool-approval-response' as const,
      approvalId: a.approvalId,
      approved: a.approved,
      ...(a.reason ? { reason: a.reason } : {})
    }))
    this.deps.repos.tasks.appendMessages(taskId, [{ role: 'tool', content: responseParts } as ModelMessage])
    this.answers.delete(taskId)

    // Emit timeline and start the run
    this.deps.bus.emit({ type: 'task.timeline', taskId, timeline: this.timeline(taskId) })
    this.startRun(taskId)
  }

  /** The likely next message for a task whose reply just ended, or null (see suggest.ts). */
  suggestion(taskId: string): string | null {
    return this.suggestions.get(taskId) ?? null
  }

  private async suggest(taskId: string): Promise<void> {
    const { repos, bus } = this.deps
    try {
      const task = repos.tasks.require(taskId)
      const project = repos.projects.require(task.projectId)
      const resolved = this.deps.models.resolve(project.model)
      const messages = repos.tasks.messages(taskId).map((m) => m.message)
      const text = await suggestNextMessage(messages, resolved.cli ? null : resolved.model)
      // A run that started meanwhile (the user typed their own message) makes it moot.
      if (!text || this.runs.has(taskId)) return
      this.suggestions.set(taskId, text)
      bus.emit({ type: 'task.suggestion', taskId, text })
    } catch {
      // No suggestion; nothing to report.
    }
  }

  /** Messages the user sent while a task was working, in order, waiting for its reply to end. */
  queuedMessages(taskId: string): string[] {
    return this.queued.get(taskId) ?? []
  }

  /** Takes back the queued messages (the user pulled them into the box to edit). */
  unqueue(taskId: string): string[] {
    const queued = this.queued.get(taskId) ?? []
    this.queued.delete(taskId)
    this.deps.bus.emit({ type: 'task.queued', taskId, queued: [] })
    return queued
  }

  stop(taskId: string): void {
    const state = this.runs.get(taskId)
    if (state) {
      state.controller.abort()
    }
  }

  async whenIdle(taskId: string): Promise<void> {
    const state = this.runs.get(taskId)
    if (!state) return
    return new Promise<void>((resolve) => {
      if (!this.idleWaiters.has(taskId)) this.idleWaiters.set(taskId, [])
      this.idleWaiters.get(taskId)!.push(resolve)
    })
  }

  isRunning(taskId: string): boolean {
    return this.runs.has(taskId)
  }

  timeline(taskId: string): TimelineItem[] {
    const stored = this.deps.repos.tasks.messages(taskId)
    const items = buildTimeline(stored)

    // Apply overlay from collected but unsent answers
    const answers = this.answers.get(taskId)
    if (answers) {
      for (const answer of answers) {
        // Find the tool item with this approvalId
        for (const item of items) {
          if (item.kind === 'tool' && item.approvalId === answer.approvalId) {
            if (answer.approved) {
              item.state = 'running'
            } else {
              item.state = 'denied'
            }
            break
          }
        }
      }
    }

    return items
  }

  async stopAll(): Promise<void> {
    for (const timer of this.wakeups) clearTimeout(timer)
    this.wakeups.clear()
    const taskIds = [...this.runs.keys()]
    for (const taskId of taskIds) {
      this.stop(taskId)
    }
    await Promise.all(taskIds.map((id) => this.whenIdle(id)))
  }

  /**
   * The operating prompt's tools for an agent working in `folder` outside this tool loop: a
   * command-line agent (through the deskmates-prompt MCP server), a bot or Duo. The folder's Work
   * project is used when there is one, else the project of the one command-line turn in flight,
   * else the folder itself. File changes land on the running task when there is one, so the user
   * can see and undo them there. Risky tools ask the user in the app first.
   */
  promptToolsFor(folder: string, agent: string, options: { guard?: boolean } = {}): ToolSet {
    const { repos, bus, deps } = { repos: this.deps.repos, bus: this.deps.bus, deps: this.deps }
    const norm = (path: string): string => resolvePath(path).replace(/[\\/]+$/, '').toLowerCase()
    const projects = repos.projects.list().filter((p) => p.kind !== 'design')
    const runningTasks = [...this.runs.keys()].map((id) => repos.tasks.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t))
    let project = folder ? projects.find((p) => norm(p.folder) === norm(folder)) : undefined
    if (!project) {
      const cliRuns = runningTasks.map((t) => repos.projects.get(t.projectId)).filter((p): p is NonNullable<typeof p> => Boolean(p) && p!.kind !== 'design' && this.deps.models.resolve(p!.model).cli === true)
      if (cliRuns.length === 1) project = cliRuns[0]
    }
    const running = project ? runningTasks.find((t) => t.projectId === project!.id) : undefined
    const taskId = running?.id ?? `bridge:${project?.id ?? norm(folder)}`
    const resolved = this.deps.models.resolve(project?.model ?? null)
    const root = project?.folder ?? folder
    if (!root) throw new Error('No folder to work in: start this agent in a Deskmates project folder.')
    const ctx: ToolContext = {
      taskId,
      projectId: project?.id ?? '',
      root,
      changes: deps.changes,
      memories: repos.memories,
      modelRef: { provider: resolved.provider, modelId: resolved.modelId },
      ...(deps.skills ? { skills: deps.skills } : {}),
      ...(deps.connectors ? { connectors: deps.connectors } : {}),
      ...(deps.plugins ? { plugins: deps.plugins } : {}),
      ...(deps.render ? { render: deps.render } : {}),
      ...(deps.browser ? { browser: deps.browser } : {}),
      ...(deps.getSchedules?.() && project ? { schedules: deps.getSchedules() } : {}),
      agentName: agent,
      cliModel: true,
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
      ...(deps.google ? { google: deps.google } : {}),
      chats: chatHistory(repos),
      projectKind: 'work',
      // A command-line turn's plan shows on its task, at the end of the chat, as the Work tab's does.
      onPlan: (items) => {
        if (!running) return
        repos.tasks.update(taskId, { plan: items })
        bus.emit({ type: 'task.updated', task: repos.tasks.require(taskId) })
      },
      onNotify: (title, body) => bus.emit({ type: 'notify', title, body }),
      onChangesUpdated: () => {
        if (running) bus.emit({ type: 'changes.updated', taskId, changes: repos.changes.list(taskId) })
      },
      onMemoryUpdated: () => {
        if (project) bus.emit({ type: 'memory.updated', projectId: project.id, memories: repos.memories.list(project.id) })
      }
    }
    const browser = deps.browser
    const ask = async (name: string, detail: string): Promise<boolean> => {
      if (!browser) return false
      const answer = await browser.ask({ kind: 'action', domain: 'Deskmates', detail, agent, runKey: taskId }, 10 * 60_000)
      return answer === 'allow-once' || answer === 'always'
    }
    const tools = pickPromptTools(deps.createTools(ctx))
    // A caller with its own approval step (a bot run's approval cards) asks there instead.
    return options.guard === false ? tools : guardRiskyTools(tools, ask)
  }

  private startRun(taskId: string): void {
    const controller = new AbortController()
    const state: RunState = { controller, promise: Promise.resolve() }
    this.runs.set(taskId, state)
    state.promise = this.executeRun(taskId, controller)
  }

  private async executeRun(taskId: string, controller: AbortController): Promise<void> {
    const { repos, bus, models, deps } = { repos: this.deps.repos, bus: this.deps.bus, models: this.deps.models, deps: this.deps }
    const getNow = deps.now ?? (() => new Date())

    try {
      // Set status running
      // A finished task list belongs to the request before this one: a new request starts a new list.
      const finishedPlan = repos.tasks.require(taskId).plan.every((item) => item.status === 'done')
      const runningTask = repos.tasks.update(taskId, { status: 'running', error: null, ...(finishedPlan ? { plan: [] } : {}) })
      bus.emit({ type: 'task.updated', task: runningTask })

      // Read task, project and settings
      const task = repos.tasks.require(taskId)
      const project = repos.projects.require(task.projectId)
      const settings = repos.settings.get()

      // Resolve model
      const resolved = models.resolve(project.model)
      const { provider, modelId } = resolved

      // Build tool context
      const ctx: ToolContext = {
        taskId,
        projectId: task.projectId,
        root: project.folder,
        changes: deps.changes,
        memories: repos.memories,
        modelRef: { provider, modelId },
        ...(deps.skills ? { skills: deps.skills } : {}),
        ...(deps.connectors ? { connectors: deps.connectors } : {}),
        ...(deps.plugins ? { plugins: deps.plugins } : {}),
        ...(deps.subagents ? { subagents: deps.subagents } : {}),
        ...(deps.render ? { render: deps.render } : {}),
        ...(deps.browser ? { browser: deps.browser } : {}),
        ...(deps.screen ? { screen: deps.screen } : {}),
        ...(deps.getSchedules?.() ? { schedules: deps.getSchedules() } : {}),
        ...(deps.agentNameFor?.(taskId) ? { agentName: deps.agentNameFor(taskId) } : {}),
        cliModel: resolved.cli === true,
        ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
        ...(deps.google ? { google: deps.google } : {}),
        chats: chatHistory(repos),
        signal: controller.signal,
        projectKind: project.kind === 'design' ? 'design' : 'work',
        renameProject: (title) => {
          const renamed = repos.projects.update(task.projectId, { name: title })
          bus.emit({ type: 'project.updated', project: renamed })
        },
        showInPreview: (path) => {
          bus.emit({ type: 'design.show', projectId: task.projectId, path })
        },
        scheduleWakeup: (delayMs, prompt) => {
          const ms = Math.min(Math.max(delayMs, MIN_WAKEUP_MS), MAX_WAKEUP_MS)
          const timer = setTimeout(() => {
            this.wakeups.delete(timer)
            if (this.runs.has(taskId)) return
            void this.send(taskId, prompt).catch((error: unknown) => console.error('[core] scheduled wake-up failed', error))
          }, ms)
          timer.unref?.()
          this.wakeups.add(timer)
        },
        onPlan: (items) => {
          repos.tasks.update(taskId, { plan: items })
          bus.emit({ type: 'task.updated', task: repos.tasks.require(taskId) })
        },
        onNotify: (title, body) => {
          bus.emit({ type: 'notify', title, body })
        },
        onChangesUpdated: () => {
          bus.emit({ type: 'changes.updated', taskId, changes: repos.changes.list(taskId) })
          if (repos.projects.require(task.projectId).kind === 'design') {
            bus.emit({ type: 'design.updated', projectId: task.projectId, updatedAt: Date.now(), source: 'assistant' })
          }
        },
        onMemoryUpdated: () => {
          bus.emit({ type: 'memory.updated', projectId: task.projectId, memories: repos.memories.list(task.projectId) })
        }
      }

      const tools = deps.createTools(ctx)
      const instructions = buildInstructions({
        project,
        settings,
        memories: repos.memories.list(task.projectId),
        projectInstructions: readProjectInstructions(project.folder),
        now: getNow(),
        model: { provider, modelId },
        agentCommand: deps.agentCommand?.(),
        ...(deps.skills
          ? { skills: deps.skills.catalog() }
          : {})
      })

      // CLI-backed providers (OpenCode/agy): run the whole turn through a terminal session instead
      // of the tool-calling loop — their own agents/tools execute inside the CLI.
      if (resolved.cli) {
        await this.executeCliTurn(taskId, task, project, resolved, instructions, controller)
        return
      }

      // Create agent
      const agent = new ToolLoopAgent({
        model: patientModel(resolved.model, {
          onWait: (_pauseMs, waitedMs) => {
            if (waitedMs > 0) return
            bus.emit({
              type: 'notify',
              title: 'The AI provider is busy',
              body: `${PROVIDER_LABELS[provider]}'s servers for ${modelId} are full right now. Deskmates keeps retrying for up to 10 minutes; stop the task to give up.`
            })
          }
        }),
        instructions,
        tools,
        // Gemini 2.5 and later think before answering; this asks it to share a summary of that
        // thinking so the transcript can show it. Older Gemini models reject the setting.
        providerOptions: sharesThoughts(provider, modelId) ? { google: { thinkingConfig: { includeThoughts: true } } } : undefined,
        toolApproval: ({ toolCall }: { toolCall: { toolName: string } }) =>
          approvalFor(toolCall.toolName, repos.tasks.require(taskId).autoApprove),
        // A question to the user ends the turn: the answers come back as the next message.
        stopWhen: [isStepCount(settings.maxSteps), hasToolCall('AskUserQuestion'), hasToolCall('ask_user'), hasToolCall('ask_user_input_v0'), hasToolCall('end_conversation')]
      })

      // Stream
      const stored = repos.tasks.messages(taskId)
      // History sized to this model's window, after the system prompt and tool list take their share.
      const messages = compactHistory(stored.map((s) => s.message), {
        maxTotalChars: historyBudgetChars({ provider, modelId, instructionsChars: instructions.length, toolsChars: toolsChars(tools) })
      })

      const result = await agent.stream({
        messages,
        abortSignal: controller.signal
      })

      const live = new LiveTimeline(taskId, bus, () => Date.now())

      let firstError: unknown = null

      for await (const part of result.stream) {
        live.apply(part as TextStreamPart<ToolSet>)

        const p = part as any
        if (p.type === 'finish-step') {
          const usage = p.usage
          repos.usage.add(provider, 1, usage?.inputTokens?.total ?? usage?.inputTokens ?? 0, usage?.outputTokens?.total ?? usage?.outputTokens ?? 0)
        }
        if (p.type === 'error' && !firstError) {
          firstError = p.error
        }
      }

      live.flush()

      // Get response messages
      try {
        const responseMessages = await result.responseMessages
        if (responseMessages && responseMessages.length > 0) {
          repos.tasks.appendMessages(taskId, responseMessages as ModelMessage[])
        }
      } catch {
        // Skip on failure
      }

      // Check for dangling tool calls
      const updatedStored = repos.tasks.messages(taskId)
      const dangling = danglingToolCalls(updatedStored)
      if (dangling) {
        repos.tasks.appendMessages(taskId, [dangling])
      }

      // Determine final status
      if (controller.signal.aborted) {
        repos.tasks.update(taskId, { status: 'idle', error: 'Stopped.' })
      } else if (firstError) {
        repos.tasks.update(taskId, { status: 'error', error: friendlyError(firstError) })
      } else {
        const finalStored = repos.tasks.messages(taskId)
        const pending = pendingApprovals(finalStored)
        if (pending.length > 0) {
          repos.tasks.update(taskId, { status: 'waiting-approval' })
          const currentTask = repos.tasks.require(taskId)
          bus.emit({
            type: 'notify',
            title: 'Approval needed',
            body: `${currentTask.title}: ${pending[0].toolName}`
          })
        } else {
          repos.tasks.update(taskId, { status: 'idle', error: null })
        }
      }
    } catch (err) {
      // Errors thrown before streaming (e.g. missing model)
      try {
        repos.tasks.update(taskId, { status: 'error', error: friendlyError(err) })
      } catch {
        // If the task itself can't be updated, just log
      }
    } finally {
      this.runs.delete(taskId)
      deps.browser?.endRun(taskId)
      bus.emit({ type: 'task.updated', task: repos.tasks.require(taskId) })
      bus.emit({ type: 'task.timeline', taskId, timeline: this.timeline(taskId) })
      bus.emit({ type: 'usage.updated', usage: repos.usage.list() })

      // Resolve idle waiters
      const waiters = this.idleWaiters.get(taskId)
      if (waiters) {
        this.idleWaiters.delete(taskId)
        for (const resolve of waiters) resolve()
      }

      // What the user sent while this ran goes out now, as the next message, unless it errored and
      // needs them to look first (it stays queued, shown in the chat, until they send again).
      const queued = this.queued.get(taskId)
      if (queued?.length && repos.tasks.require(taskId).status !== 'waiting-approval') {
        this.queued.delete(taskId)
        bus.emit({ type: 'task.queued', taskId, queued: [] })
        void this.send(taskId, queued.join('\n\n')).catch((error: unknown) => console.error('[core] sending the queued message failed', error))
      } else if (repos.tasks.require(taskId).status === 'idle' && !controller.signal.aborted) {
        void this.suggest(taskId)
      }
    }
  }

  /** CLI-backed provider runs: send the turn (instructions + the user's latest message) to a
   *  terminal session through `TerminalsService.execute`, and append the CLI's reply as the
   *  assistant message. Throws on a failed run, like the tool loop's errors do.
   *
   *  Takes the run's AbortController because a CLI turn has no tool loop for it to interrupt: the
   *  only thing that can stop one is the CLI process, so the signal is handed to the terminal service
   *  to kill. Without this the Work tab's Stop button is a no-op for OpenCode/agy tasks. */
  private async executeCliTurn(
    taskId: string,
    task: { projectId: string },
    project: { kind: string; folder: string },
    resolved: { provider: ProviderId; modelId: string },
    instructions: string,
    controller: AbortController
  ): Promise<void> {
    const { repos, bus } = this.deps
    const terminals = this.deps.getTerminals?.()
    if (!terminals) {
      throw new Error("CLI providers (OpenCode/agy/Freebuff) need terminal sessions, which aren't available here.")
    }

    const stored = repos.tasks.messages(taskId)
    const content = [...stored].reverse().find((s) => s.message.role === 'user')?.message.content ?? ''
    const userText =
      typeof content === 'string'
        ? content
        : content.map((part) => ('text' in part ? part.text : String(part))).join(' ')
    // The Work tab's standing instructions are handed over separately rather than prepended to the
    // question. For OpenCode that means they become the conversation's `system` block, sent once and
    // then remembered by the session — the 175KB prompt is no longer re-sent, and no longer re-read,
    // before every question. It is also what makes the second prompt in a session cheap: the model
    // already has the brief and only has to read the new message.
    const prompt = userText.trim()

    const live = new LiveTimeline(taskId, bus, () => Date.now())
    const result = await terminals.execute(
      resolved.provider as 'opencode' | 'agy' | 'freebuff',
      project.folder,
      prompt,
      resolved.modelId,
      {
        system: instructions,
        signal: controller.signal,
        onItem: (item) => {
          if (item.kind === 'assistant') {
            // Freebuff sends each paragraph whole and grows it in place by id, so it shows where it
            // was said, between steps; the other CLIs send pieces of one reply to append.
            if (resolved.provider === 'freebuff') bus.emit({ type: 'task.item', taskId, item })
            else live.appendText(item.text)
            return
          }
          // A CLI turn's first output can be a long way off, so its tool activity (reading the
          // spilled prompt, running a command) is the only sign of life in between. Surfaced as the
          // Agents tab surfaces the same items.
          bus.emit({ type: 'task.item', taskId, item })
        }
      }
    )
    live.flush()

    // Whatever the CLI managed to say is kept even when the run was cut short — stopping a run that
    // had already answered shouldn't throw the answer away.
    if (result.text) {
      repos.tasks.appendMessages(taskId, [{ role: 'assistant', content: result.text }])
    }

    if (result.stopped || controller.signal.aborted) {
      repos.tasks.update(taskId, { status: 'idle', error: 'Stopped.' })
      return
    }
    if (result.error) throw new Error(result.error)

    repos.tasks.update(taskId, { status: 'idle', error: null })

    if (project.kind === 'design') {
      bus.emit({ type: 'design.updated', projectId: task.projectId, updatedAt: Date.now(), source: 'editor' })
    }
  }
}

/** Whether this model streams a summary of its reasoning when asked (see the providerOptions above). */
export function sharesThoughts(provider: string, modelId: string): boolean {
  if (provider !== 'google') return false
  // Image, speech and embedding variants share the family name but don't think.
  return /gemini-(2\.5|[3-9])/i.test(modelId) && !/image|tts|embedding|live|audio/i.test(modelId)
}

/** The text of a stored message: its text parts, joined. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** Every project's chats, for the chat-history tools. */
export function chatHistory(repos: Repos): NonNullable<ToolContext['chats']> {
  return {
    list: () =>
      repos.projects
        .list()
        .flatMap((project) => repos.tasks.list(project.id).map((task) => ({ id: task.id, title: task.title, project: project.name, updatedAt: task.updatedAt })))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    turns: (id) =>
      repos.tasks
        .messages(id)
        .filter((stored) => stored.message.role === 'user' || stored.message.role === 'assistant')
        .map((stored) => ({ role: stored.message.role as 'user' | 'assistant', text: messageText(stored.message.content) }))
        .filter((turn) => turn.text.trim())
  }
}
