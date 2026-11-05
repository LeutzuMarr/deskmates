import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREEBUFF_CURRENT_MODEL, type FreebuffStatus } from '../../shared/freebuff'
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

      const reply = await host.ask(request, (activity) => runOptions.onItem?.(activityItem(activityId, activity, 'running')))
      this.instructed.add(host)
      runOptions.onItem?.(activityItem(activityId, 'Finished', 'done'))
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
function activityItem(id: string, activity: string, state: 'running' | 'done'): TimelineItem {
  return { kind: 'tool', id, at: Date.now(), toolName: 'freebuff', input: { activity }, state }
}
