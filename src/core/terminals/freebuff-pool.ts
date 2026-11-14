import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREEBUFF_CURRENT_MODEL, type FreebuffModel, type FreebuffStatus } from '../../shared/freebuff'
import type { TimelineItem } from '../../shared/protocol'
import { FreebuffHost, StoppedError } from './freebuff-host'
import type { CliRunOptions, CliRunResult } from './managed'

/** Prompts longer than this go through a file: they are typed key by key into Freebuff's input. */
const MAX_TYPED_PROMPT = 1500

/**
 * The Freebuffs behind the Work tab: one hidden Freebuff per project folder, kept running between
 * turns so the conversation and the chosen model carry over. See freebuff-host.ts for how a hidden
 * Freebuff is driven.
 */
export class FreebuffPool {
  private readonly hosts = new Map<string, FreebuffHost>()
  /** Hosts whose current Freebuff session has been told where the standing instructions are. */
  private readonly instructed = new WeakSet<FreebuffHost>()
  private lastFolder: string | null = null

  async execute(folder: string, prompt: string, model: string | undefined, runOptions: CliRunOptions = {}): Promise<CliRunResult> {
    if (runOptions.signal?.aborted) return { text: '', stopped: true }
    const host = this.hostFor(folder, runOptions.trustAgents === true)
    this.lastFolder = folder
    const onAbort = (): void => host.cancel()
    runOptions.signal?.addEventListener('abort', onAbort, { once: true })
    const activityId = randomUUID()
    const cleanup: string[] = []
    try {
      await host.start()
      if (host.current === 'busy') {
        host.cancel()
        await host.whenFree()
      }
      if (model && model !== FREEBUFF_CURRENT_MODEL) await host.selectModel(model)
      if (runOptions.signal?.aborted) return { text: '', stopped: true }

      let request = prompt
      if (request.length > MAX_TYPED_PROMPT) {
        const file = this.writeFile(folder, `freebuff-request-${randomUUID()}.md`, request)
        cleanup.push(file)
        request = `The request is in the file ${file}. Read all of it and answer it.`
      }
      if (runOptions.system && !this.instructed.has(host)) {
        const file = this.writeFile(folder, 'freebuff-instructions.md', runOptions.system)
        request = `First read ${file}: it has your standing instructions as the Deskmates assistant in this folder, and they apply to everything below. Then: ${request}`
      }

      const steps = new ActivitySteps(activityId, (item) => runOptions.onItem?.(item))
      const reply = await host.ask(request, (items) => steps.reportAll(items))
      this.instructed.add(host)
      steps.finish()
      if (reply) runOptions.onItem?.({ kind: 'assistant', id: randomUUID(), at: Date.now(), text: reply })
      return { text: reply }
    } catch (error) {
      if (error instanceof StoppedError || runOptions.signal?.aborted) return { text: '', stopped: true }
      return { text: '', error: error instanceof Error ? error.message : String(error) }
    } finally {
      runOptions.signal?.removeEventListener('abort', onAbort)
      for (const file of cleanup) rmSync(file, { force: true })
    }
  }

  /** The session status of `folder`'s Freebuff, or of the one used last. Null when none runs. */
  status(folder?: string): FreebuffStatus | null {
    const key = folder ?? this.lastFolder
    const host = key ? this.hosts.get(key) : undefined
    return host && host.current !== 'stopped' && host.current !== 'error' ? host.status() : null
  }

  /** Freebuff's current model list, read off an idle running Freebuff (the one used last first).
   *  Null when none is running idle: Deskmates never starts a Freebuff session just to read it. */
  async listModels(): Promise<FreebuffModel[] | null> {
    const last = this.lastFolder ? this.hosts.get(this.lastFolder) : undefined
    const host = [last, ...this.hosts.values()].find((h) => h?.current === 'idle')
    return host ? host.listModels() : null
  }

  dispose(): void {
    for (const host of this.hosts.values()) host.stop()
    this.hosts.clear()
  }

  private hostFor(folder: string, trustAgents = false): FreebuffHost {
    let host = this.hosts.get(folder)
    if (!host) {
      const created: FreebuffHost = new FreebuffHost({
        workspace: folder,
        trustAgents,
        onState: (state) => {
          // A fresh Freebuff session hasn't seen the instructions yet.
          if (state === 'starting') this.instructed.delete(created)
        }
      })
      host = created
      this.hosts.set(folder, host)
    }
    return host
  }

  /** Writes into the folder's .deskmates directory, where Freebuff may read (agy uses it the same way). */
  private writeFile(folder: string, name: string, content: string): string {
    const dir = join(folder, '.deskmates')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, content, 'utf8')
    return file
  }
}

/** One timeline line that follows Freebuff's progress through a turn, updated in place by its id. */
function activityItem(id: string, activity: string, state: 'running' | 'done', at = Date.now()): TimelineItem {
  return { kind: 'tool', id, at, toolName: 'freebuff', input: { activity }, state }
}

/**
 * Turns Freebuff's "latest line of work" into a list of steps, the way the other agents report
 * theirs: a new line of work closes the step before it and opens its own, while a line that only
 * grows (the reply streaming in) keeps updating the step it is.
 */
export class ActivitySteps {
  private current: { id: string; text: string; at: number } | null = null

  constructor(
    private readonly firstId: string,
    private readonly emit: (item: TimelineItem) => void
  ) {}

  report(activity: string): void {
    const text = activity.trim()
    if (!text) return
    const current = this.current
    if (current && (text === current.text || text.startsWith(current.text) || current.text.startsWith(text))) {
      if (text.length > current.text.length) {
        current.text = text
        this.emit(activityItem(current.id, text, 'running', current.at))
      }
      return
    }
    if (current) this.emit(activityItem(current.id, current.text, 'done', current.at))
    this.current = { id: current ? randomUUID() : this.firstId, text, at: Date.now() }
    this.emit(activityItem(this.current.id, text, 'running', this.current.at))
  }

  /** Every step shown so far this turn, oldest first. */
  private readonly shown: Array<{ id: string; text: string; at: number }> = []

  /**
   * Reports everything Freebuff has written so far (`workItems`), so no line is lost between two reads
   * of its screen. Items are matched to steps already shown by content, in order: an item still being
   * written grows its step, a new one becomes a new step. Matching by content rather than position
   * keeps steps from repeating when the start of the turn scrolls off Freebuff's window.
   */
  reportAll(items: string[]): void {
    let from = 0
    for (const raw of items) {
      const text = raw.trim()
      if (!text) continue
      let match = -1
      for (let i = from; i < this.shown.length; i++) {
        const seen = this.shown[i]!.text
        if (text === seen || text.startsWith(seen) || seen.startsWith(text)) {
          match = i
          break
        }
      }
      if (match >= 0) {
        const step = this.shown[match]!
        if (text.length > step.text.length) {
          step.text = text
          this.emit(activityItem(step.id, text, this.current === step ? 'running' : 'done', step.at))
        }
        from = match + 1
        continue
      }
      // A new step: the one before it is finished.
      const current = this.current
      if (current) this.emit(activityItem(current.id, current.text, 'done', current.at))
      const step = { id: this.shown.length === 0 && !current ? this.firstId : randomUUID(), text, at: Date.now() }
      this.shown.push(step)
      this.current = step
      this.emit(activityItem(step.id, text, 'running', step.at))
      from = this.shown.length
    }
  }

  finish(): void {
    const current = this.current
    if (current) this.emit(activityItem(current.id, current.text, 'done', current.at))
    else this.emit(activityItem(this.firstId, 'Finished', 'done'))
    this.current = null
  }
}
