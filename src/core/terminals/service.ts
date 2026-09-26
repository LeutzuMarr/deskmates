import type { CommandRunner } from '../bots/command-runner'
import type { EventBus } from '../events'
import { detectTerminalAgents } from './detect'
import { ManagedTerminalRunner } from './managed'
import type { ProcessSpawner } from './process'
import { AttachTerminalRunner } from './attach'
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

  /** Runs one bounded CLI turn (OpenCode `run` / agy `-p`) with no visible session or primer, for
   *  tasks routed to a CLI-backed model provider. Resolves with the assistant's reply text, or the
   *  parsed error when the run failed. */
  execute(tool: TerminalTool, folder: string, prompt: string, model?: string): Promise<{ text: string; error?: string }>

  /** Attaches to a terminal the user already has open (spec 5.14) and returns its session. */
  attach(pid: number, tool: TerminalTool): AttachedTerminalSession
  attachedList(): AttachedTerminalSession[]
  attachSend(id: string, text: string): void
  attachRetry(id: string): void
  attachAnswer(id: string, key: string, option: string): void
  attachStop(id: string): void
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
          title: `${session.tool === 'opencode' ? 'OpenCode' : session.tool === 'agy' ? 'Antigravity' : 'Your agent'} is asking for permission`,
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

  execute(tool: TerminalTool, folder: string, prompt: string, model?: string): Promise<{ text: string; error?: string }> {
    return this.managed.execute(tool, folder, prompt, model)
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
}
