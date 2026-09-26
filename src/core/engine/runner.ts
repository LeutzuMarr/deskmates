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
import { buildInstructions, readProjectInstructions } from './instructions'
import { LiveTimeline } from './live'
import { buildTimeline, danglingToolCalls, pendingApprovals } from './timeline'

/** Model resolver interface — declared locally per job instructions. */
export interface ModelResolver {
  resolve(ref: ModelRef | null): { model: LanguageModel; provider: ProviderId; modelId: string; cli?: boolean }
}

export interface RunnerDeps {
  repos: Repos
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

    if (this.runs.has(taskId)) {
      throw new Error('This task is already working. Stop it first or wait.')
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
      const runningTask = repos.tasks.update(taskId, { status: 'running', error: null })
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
        ...(deps.skills
          ? { skills: deps.skills.catalog() }
          : {})
      })

      // CLI-backed providers (OpenCode/agy): run the whole turn through a terminal session instead
      // of the tool-calling loop — their own agents/tools execute inside the CLI.
      if (resolved.cli) {
        await this.executeCliTurn(taskId, task, project, resolved, instructions)
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
        toolApproval: ({ toolCall }: { toolCall: { toolName: string } }) =>
          approvalFor(toolCall.toolName, repos.tasks.require(taskId).autoApprove),
        // A question to the user ends the turn: the answers come back as the next message.
        stopWhen: [isStepCount(settings.maxSteps), hasToolCall('AskUserQuestion'), hasToolCall('ask_user')]
      })

      // Stream
      const stored = repos.tasks.messages(taskId)
      const messages = compactHistory(stored.map((s) => s.message))

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
      bus.emit({ type: 'task.updated', task: repos.tasks.require(taskId) })
      bus.emit({ type: 'task.timeline', taskId, timeline: this.timeline(taskId) })
      bus.emit({ type: 'usage.updated', usage: repos.usage.list() })

      // Resolve idle waiters
      const waiters = this.idleWaiters.get(taskId)
      if (waiters) {
        this.idleWaiters.delete(taskId)
        for (const resolve of waiters) resolve()
      }
    }
  }

  /** CLI-backed provider runs: send the turn (instructions + the user's latest message) to a
   *  terminal session through `TerminalsService.execute`, and append the CLI's reply as the
   *  assistant message. Throws on a failed run, like the tool loop's errors do. */
  private async executeCliTurn(
    taskId: string,
    task: { projectId: string },
    project: { kind: string; folder: string },
    resolved: { provider: ProviderId; modelId: string },
    instructions: string
  ): Promise<void> {
    const { repos, bus } = this.deps
    const terminals = this.deps.getTerminals?.()
    if (!terminals) {
      throw new Error("CLI providers (OpenCode/agy) need terminal sessions, which aren't available here.")
    }

    const stored = repos.tasks.messages(taskId)
    const content = [...stored].reverse().find((s) => s.message.role === 'user')?.message.content ?? ''
    const userText =
      typeof content === 'string'
        ? content
        : content.map((part) => ('text' in part ? part.text : String(part))).join(' ')
    const prompt = `${instructions.trimEnd()}\n\n${userText.trim()}`.trim()

    const result = await terminals.execute(
      resolved.provider as 'opencode' | 'agy',
      project.folder,
      prompt,
      resolved.modelId
    )

    if (result.error) throw new Error(result.error)

    if (result.text) {
      repos.tasks.appendMessages(taskId, [{ role: 'assistant', content: result.text }])
    }

    repos.tasks.update(taskId, { status: 'idle', error: null })

    if (project.kind === 'design') {
      bus.emit({ type: 'design.updated', projectId: task.projectId, updatedAt: Date.now(), source: 'editor' })
    }
  }
}
