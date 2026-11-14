/**
 * The core's side of the agent browser. The browser itself lives in the app's main process; this
 * sends it actions, keeps the state everyone sees (the PC's panel and the phone), and holds the
 * questions waiting for the user: "may agents use this site?" and "may the agent click Send here?".
 */
import { randomUUID } from 'node:crypto'
import type {
  BrowserAction,
  BrowserResult,
  BrowserState,
  HostBrowserState,
  SiteAnswer,
  SiteAsk
} from '../../shared/agent-browser'
import { EMPTY_BROWSER_STATE, sameSite } from '../../shared/agent-browser'
import type { CoreToHost, HostToCore } from '../../shared/protocol'
import type { EventBus } from '../events'

/** The part of Electron's utility-process `parentPort` this uses. */
export interface BrowserPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data?: unknown }) => void): void
}

/** Where "Always allow" sites are kept (the settings repo's extra keys). */
export interface SiteStore {
  get(): string[]
  set(domains: string[]): void
}

export interface BrowserServiceOptions {
  bus: EventBus
  /** Absent when the core runs without the app (tests, the CLI): every action then fails politely. */
  port?: BrowserPort
  sites: SiteStore
  /** Shown on the PC and pushed to paired phones when the user is asked something. */
  notify: (title: string, body: string) => void
  /** How long one action may take before the core gives up on it. */
  actionTimeoutMs?: number
}

type Pending = { resolve: (result: BrowserResult) => void; timer: ReturnType<typeof setTimeout> }
type AskWaiter = { ask: SiteAsk; resolve: (answer: SiteAnswer | 'timeout') => void; timer: ReturnType<typeof setTimeout> }

const ACTION_TIMEOUT_MS = 90_000

export class BrowserService {
  private host: HostBrowserState = { ...EMPTY_BROWSER_STATE }
  private used = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly asks = new Map<string, AskWaiter>()
  /** Sites allowed once, for the run that asked: cleared when that run's tools are rebuilt. */
  private readonly allowedOnce = new Map<string, Set<string>>()
  private controlWaiters: Array<() => void> = []

  constructor(private readonly options: BrowserServiceOptions) {
    options.port?.on('message', (event) => this.receive(event.data as HostToCore | undefined))
  }

  get available(): boolean {
    return this.options.port !== undefined
  }

  state(): BrowserState {
    return { ...this.host, used: this.used, asks: [...this.asks.values()].map((w) => w.ask) }
  }

  /** Sends one action to the browser. Resolves with the result; never rejects. */
  act(action: BrowserAction): Promise<BrowserResult> {
    const port = this.options.port
    if (!port) return Promise.resolve({ ok: false, error: 'The agent browser needs the Deskmates app; it is not available here.' })
    if (!this.used) {
      this.used = true
      this.emit()
    }
    const id = this.nextId++
    return new Promise<BrowserResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'The browser did not answer in time. The page may be stuck; try reading it again.' })
      }, this.options.actionTimeoutMs ?? ACTION_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      try {
        port.postMessage({ type: 'browser-request', id, action } satisfies CoreToHost)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  /** Waits until the user hands the browser back (or `timeoutMs` passes). True when the agent may act. */
  waitForAgentControl(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.host.controller === 'agent') return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.controlWaiters = this.controlWaiters.filter((w) => w !== wake)
        resolve(value)
      }
      const wake = (): void => done(true)
      const onAbort = (): void => done(false)
      const timer = setTimeout(() => done(false), timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.controlWaiters.push(wake)
    })
  }

  /** Seconds since the user last touched the PC, as the app last reported it. */
  idleSeconds(): number {
    return this.host.idleSeconds
  }

  // ---- sites and questions ----

  alwaysAllowed(): string[] {
    return this.options.sites.get()
  }

  removeSite(domain: string): string[] {
    const next = this.options.sites.get().filter((d) => d !== domain)
    this.options.sites.set(next)
    return next
  }

  /** Whether agents may act on `domain` without asking: always allowed, or allowed once for this run. */
  isAllowed(domain: string, runKey: string): boolean {
    if (this.options.sites.get().some((d) => sameSite(d, domain))) return true
    return [...(this.allowedOnce.get(runKey) ?? [])].some((d) => sameSite(d, domain))
  }

  /**
   * Asks the user something and waits for the answer (or the timeout). "Always" on a site question
   * remembers the site for every agent; "Allow once" remembers it for this run only.
   */
  ask(input: { kind: SiteAsk['kind']; domain: string; detail: string; agent: string; runKey: string }, timeoutMs: number, signal?: AbortSignal): Promise<SiteAnswer | 'timeout'> {
    // The same question asked again while one is waiting shares its answer.
    const existing = [...this.asks.values()].find((w) => w.ask.kind === input.kind && w.ask.domain === input.domain && w.ask.detail === input.detail)
    const ask: SiteAsk = existing?.ask ?? { id: randomUUID(), kind: input.kind, domain: input.domain, detail: input.detail, agent: input.agent, at: Date.now() }
    return new Promise((resolve) => {
      const finish = (answer: SiteAnswer | 'timeout'): void => {
        signal?.removeEventListener('abort', onAbort)
        if (answer === 'always' && input.kind === 'site') {
          const sites = this.options.sites.get()
          if (!sites.includes(input.domain)) this.options.sites.set([...sites, input.domain])
        }
        if ((answer === 'allow-once' || answer === 'always') && input.kind === 'site') {
          const once = this.allowedOnce.get(input.runKey) ?? new Set<string>()
          once.add(input.domain)
          this.allowedOnce.set(input.runKey, once)
        }
        resolve(answer)
      }
      const onAbort = (): void => finish('timeout')
      signal?.addEventListener('abort', onAbort, { once: true })
      if (existing) {
        const previous = existing.resolve
        existing.resolve = (answer) => {
          previous(answer)
          finish(answer)
        }
        return
      }
      const timer = setTimeout(() => this.settle(ask.id, 'timeout'), timeoutMs)
      timer.unref?.()
      this.asks.set(ask.id, { ask, resolve: finish, timer })
      this.emit()
      const what = input.kind === 'site' ? `${input.agent} wants to use ${input.domain}.` : `${input.agent} wants to ${input.detail}.`
      this.options.notify('The agent browser needs you', `${what} Open the browser panel to answer.`)
    })
  }

  respond(id: string, answer: SiteAnswer): BrowserState {
    if (!this.asks.has(id)) throw new Error('That question was already answered.')
    this.settle(id, answer)
    return this.state()
  }

  /** Forgets the "Allow once" sites of a finished run. */
  endRun(runKey: string): void {
    this.allowedOnce.delete(runKey)
  }

  private settle(id: string, answer: SiteAnswer | 'timeout'): void {
    const waiter = this.asks.get(id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.asks.delete(id)
    waiter.resolve(answer)
    this.emit()
  }

  private receive(message: HostToCore | undefined): void {
    if (!message) return
    if (message.type === 'browser-result') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(message.id)
      entry.resolve(message.result)
    } else if (message.type === 'browser-state') {
      this.host = message.state
      if (message.state.tabs.length > 0) this.used = true
      if (message.state.controller === 'agent') {
        const waiters = this.controlWaiters
        this.controlWaiters = []
        waiters.forEach((wake) => wake())
      }
      this.emit()
    }
  }

  private emit(): void {
    this.options.bus.emit({ type: 'browser.updated', state: this.state() })
  }
}
