import type { CoreToHost, HostToCore } from '../../shared/protocol'
import type { RenderClient, RenderRequest, RenderResult, VideoRequest, VideoResult } from './types'

/** The part of Electron's utility-process `parentPort` this client uses. */
export interface RenderPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data?: unknown }) => void): void
}

/** The host's own per-request limit when the request doesn't set one. */
const HOST_DEFAULT_TIMEOUT_MS = 30_000
/** Extra time on top of the host's limit: the host renders one page at a time, so requests can queue. */
const QUEUE_ALLOWANCE_MS = 90_000
/** A long recording at 60 fps can take this long to capture and encode. */
const VIDEO_TIMEOUT_MS = 60 * 60_000

interface Pending {
  resolve(result: RenderResult): void
  settle(): void
}

const abortError = (): Error => Object.assign(new Error('Rendering was stopped.'), { name: 'AbortError' })

/** Asks the Electron host to render pages, over the utility-process channel. */
export class ParentPortRenderClient implements RenderClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly videos = new Map<number, { resolve(result: VideoResult): void; reject(error: Error): void; settle(): void }>()

  constructor(private readonly port: RenderPort | undefined) {
    port?.on('message', (event) => {
      this.receive(event.data)
    })
  }

  render(request: RenderRequest, signal?: AbortSignal): Promise<RenderResult> {
    const port = this.port
    if (!port) {
      return Promise.reject(new Error('Page rendering needs the Deskmates app; the core is running on its own.'))
    }
    if (signal?.aborted) return Promise.reject(abortError())

    const id = this.nextId++
    const timeoutMs = (request.timeoutMs ?? HOST_DEFAULT_TIMEOUT_MS) + QUEUE_ALLOWANCE_MS
    return new Promise<RenderResult>((resolve, reject) => {
      const onAbort = (): void => {
        entry.settle()
        reject(abortError())
      }
      const timer = setTimeout(() => {
        entry.settle()
        reject(new Error('The app did not finish rendering the page in time.'))
      }, timeoutMs)
      timer.unref?.()
      const entry: Pending = {
        resolve,
        settle: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
        }
      }
      this.pending.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        port.postMessage({ type: 'render-request', id, request } satisfies CoreToHost)
      } catch (error) {
        entry.settle()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  recordVideo(request: VideoRequest & { out: string }, signal?: AbortSignal): Promise<VideoResult> {
    const port = this.port
    if (!port) return Promise.reject(new Error('Video recording needs the Deskmates app; the core is running on its own.'))
    if (signal?.aborted) return Promise.reject(abortError())
    const id = this.nextId++
    return new Promise<VideoResult>((resolve, reject) => {
      const onAbort = (): void => {
        entry.settle()
        reject(abortError())
      }
      const timer = setTimeout(() => {
        entry.settle()
        reject(new Error('The app did not finish recording the video in time.'))
      }, VIDEO_TIMEOUT_MS)
      timer.unref?.()
      const entry = {
        resolve,
        reject,
        settle: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.videos.delete(id)
        }
      }
      this.videos.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        port.postMessage({ type: 'video-request', id, request } satisfies CoreToHost)
      } catch (error) {
        entry.settle()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Settles the request a host message answers. Returns false for messages that aren't render or video results. */
  receive(message: unknown): boolean {
    const result = message as HostToCore | undefined
    if (result?.type === 'video-result') {
      const video = this.videos.get(result.id)
      if (video) {
        video.settle()
        if (result.result) video.resolve(result.result)
        else video.reject(new Error(result.error ?? 'The video could not be recorded.'))
      }
      return true
    }
    if (result?.type !== 'render-result') return false
    const entry = this.pending.get(result.id)
    if (entry) {
      entry.settle()
      entry.resolve(result.result)
    }
    return true
  }
}
