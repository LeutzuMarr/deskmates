import { utilityProcess, type UtilityProcess } from 'electron'
import corePath from '../core/main?modulePath'
import type { CoreConnection } from '../shared/desktop-api'
import type { CoreToHost, HostToCore, ProviderId, ScreenMark } from '../shared/protocol'
import type { RenderRequest, RenderResult, VideoRequest, VideoResult } from '../core/render/types'
import type { BrowserAction, BrowserResult, HostBrowserState } from '../shared/agent-browser'

export interface CoreHostOptions {
  dataDir: string
  rendererDir: string
  version: string
  /** Folder holding the _claude-code_ / _claude-design_ / _claude-cowork_ prompt directories. */
  promptsDir: string
  getKeys: () => Promise<Partial<Record<ProviderId, string>>>
  onNotify: (title: string, body: string) => void
  /** A computer-use session started or ended (also called with false if the core process exits). */
  onComputerUse?: (active: boolean) => void
  /** The screen guide wants marks drawn over the screen (physical pixels); an empty list clears them. */
  onOverlay?: (marks: ScreenMark[], seconds: number) => void
  /** Renders a design page offscreen for the core's design tools. Without it, every render request fails. */
  onRenderRequest?: (request: RenderRequest) => Promise<RenderResult>
  /** Records a design page to a video file for the core's export_video tool. */
  onVideoRequest?: (request: VideoRequest & { out: string }) => Promise<VideoResult>
  /** Acts in the agent browser for the core's browser tools. Without it, every browser request fails. */
  onBrowserRequest?: (action: BrowserAction) => Promise<BrowserResult>
  /** The core (re)started: a chance to send it the agent browser's current state. */
  onReady?: () => void
  onRestart: () => void
}

const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 60_000
const RESTART_DELAY_MS = 1_000
const SHUTDOWN_GRACE_MS = 2_000
const CORE_STOPPED_MESSAGE = "Deskmates' background process stopped. Restart the app."

/** Forks the core as an Electron utility process and manages its lifecycle. */
export class CoreHost {
  private child: UtilityProcess | null = null
  private connection: CoreConnection | null = null
  private waiters: Array<{ resolve: (connection: CoreConnection) => void; reject: (error: Error) => void }> = []
  private stopping = false
  private restartTimestamps: number[] = []

  constructor(private readonly opts: CoreHostOptions) {}

  start(): void {
    this.stopping = false
    this.connection = null

    const child = utilityProcess.fork(corePath, [], {
      serviceName: 'Deskmates Core',
      stdio: 'inherit',
      env: {
        ...process.env,
        DESKMATES_DATA_DIR: this.opts.dataDir,
        DESKMATES_RENDERER_DIR: this.opts.rendererDir,
        DESKMATES_VERSION: this.opts.version,
        DESKMATES_PROMPTS_DIR: this.opts.promptsDir
      }
    })
    this.child = child

    child.on('message', (message: CoreToHost) => {
      if (message.type === 'ready') {
        const connection = { port: message.port, token: message.token }
        this.connection = connection
        this.sendKeys()
        const waiters = this.waiters
        this.waiters = []
        for (const waiter of waiters) waiter.resolve(connection)
        this.opts.onReady?.()
      } else if (message.type === 'notify') {
        this.opts.onNotify(message.title, message.body)
      } else if (message.type === 'computer-use') {
        this.opts.onComputerUse?.(message.active)
      } else if (message.type === 'overlay') {
        this.opts.onOverlay?.(message.marks, message.seconds)
      } else if (message.type === 'render-request') {
        this.render(child, message.id, message.request)
      } else if (message.type === 'video-request') {
        this.video(child, message.id, message.request)
      } else if (message.type === 'browser-request') {
        this.browser(child, message.id, message.action)
      }
    })

    child.on('exit', () => {
      this.opts.onComputerUse?.(false)
      this.opts.onOverlay?.([], 0)
      this.child = null
      this.connection = null
      if (this.stopping) return

      const now = Date.now()
      this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS)
      if (this.restartTimestamps.length >= MAX_RESTARTS) {
        console.error(
          `[deskmates] Core process exited and hit the restart limit (${MAX_RESTARTS} restarts per ${RESTART_WINDOW_MS / 1000}s); giving up.`
        )
        this.failWaiters()
        return
      }
      this.restartTimestamps.push(now)

      setTimeout(() => {
        if (this.stopping) return
        this.start()
        this.opts.onRestart()
      }, RESTART_DELAY_MS)
    })
  }

  connectionInfo(): Promise<CoreConnection> {
    if (this.connection) return Promise.resolve(this.connection)
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  stopComputerUse(): void {
    const message: HostToCore = { type: 'computer-stop' }
    this.child?.postMessage(message)
  }

  sendKeys(): void {
    void this.opts
      .getKeys()
      .then((keys) => {
        const message: HostToCore = { type: 'keys', keys }
        this.child?.postMessage(message)
      })
      .catch((error: unknown) => console.error('[main] could not load the saved API keys', error))
  }

  /** Tells the core what the agent browser looks like now (tabs, who is driving, the panel). */
  sendBrowserState(state: HostBrowserState): void {
    const message: HostToCore = { type: 'browser-state', state }
    try {
      this.child?.postMessage(message)
    } catch (error) {
      console.error('[main] could not send the browser state to the core', error)
    }
  }

  /** Answers a browser request, but only to the process that asked (not one restarted since). */
  private browser(child: UtilityProcess, id: number, action: BrowserAction): void {
    const reply = (result: BrowserResult): void => {
      if (this.child !== child) return
      const message: HostToCore = { type: 'browser-result', id, result }
      try {
        child.postMessage(message)
      } catch (error) {
        console.error('[main] could not send a browser result to the core', error)
      }
    }
    if (!this.opts.onBrowserRequest) {
      reply({ ok: false, error: 'The agent browser is not available.' })
      return
    }
    this.opts.onBrowserRequest(action).then(reply, (error: unknown) =>
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
    )
  }

  /** Answers a video request, but only to the process that asked (not one restarted since). */
  private video(child: UtilityProcess, id: number, request: VideoRequest & { out: string }): void {
    const reply = (message: HostToCore): void => {
      if (this.child !== child) return
      try {
        child.postMessage(message)
      } catch (error) {
        console.error('[main] could not send a video result to the core', error)
      }
    }
    if (!this.opts.onVideoRequest) {
      reply({ type: 'video-result', id, error: 'Video recording is not available.' })
      return
    }
    this.opts.onVideoRequest(request).then(
      (result) => reply({ type: 'video-result', id, result }),
      (error: unknown) => reply({ type: 'video-result', id, error: error instanceof Error ? error.message : String(error) })
    )
  }

  /** Answers a render request, but only to the process that asked (not one restarted since). */
  private render(child: UtilityProcess, id: number, request: RenderRequest): void {
    const reply = (result: RenderResult): void => {
      if (this.child !== child) return
      const message: HostToCore = { type: 'render-result', id, result }
      try {
        child.postMessage(message)
      } catch (error) {
        console.error('[main] could not send a render result to the core', error)
      }
    }
    if (!this.opts.onRenderRequest) {
      reply({ screenshots: [], logs: [], error: 'Page rendering is not available.' })
      return
    }
    this.opts.onRenderRequest(request).then(reply, (error: unknown) =>
      reply({ screenshots: [], logs: [], error: error instanceof Error ? error.message : String(error) })
    )
  }

  /**
   * Asks the core to exit by itself, then kills it if it doesn't. Windows has no real signals, so
   * `kill()` stops the process dead and its cleanup (removing agent-kit/bridge.json, closing the
   * server) never runs.
   */
  stop(): void {
    this.stopping = true
    const child = this.child
    this.child = null
    this.connection = null
    this.failWaiters()
    if (!child) return

    let exited = false
    child.once('exit', () => {
      exited = true
      clearTimeout(timer)
    })
    const message: HostToCore = { type: 'shutdown' }
    try {
      child.postMessage(message)
    } catch {
      child.kill()
      return
    }
    const timer = setTimeout(() => {
      if (!exited) child.kill()
    }, SHUTDOWN_GRACE_MS)
    timer.unref?.()
  }

  /** Rejects and clears any pending `connectionInfo()` callers. Waiters queued afterward are unaffected. */
  private failWaiters(): void {
    if (this.waiters.length === 0) return
    const waiters = this.waiters
    this.waiters = []
    const error = new Error(CORE_STOPPED_MESSAGE)
    for (const waiter of waiters) waiter.reject(error)
  }
}
