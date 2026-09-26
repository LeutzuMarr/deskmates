/**
 * A small Chrome DevTools Protocol client for one bot PC's Chromium, used by the browser tools
 * (`browser.ts`). Deliberately narrow: just enough of CDP (the HTTP `/json/*` endpoints plus
 * `Runtime.evaluate`/`Page.navigate`/`Page.captureScreenshot` over each target's own WebSocket)
 * to open pages, read them as text, click and type by CSS selector, and screenshot — not a
 * general-purpose CDP library. Prefers DOM-level actions (`querySelector` + `.click()`, setting
 * `.value` and dispatching input events) over pixel-coordinate input, which keeps this client
 * independent of viewport size and matches the "prefer text over screenshots" design goal.
 */
import WebSocket from 'ws'
import { PcUnreachableError } from './types'

export interface CdpTargetInfo {
  targetId: string
  url: string
  title: string
}

export interface PageContent {
  url: string
  title: string
  /** Visible text of the page body, capped to keep model usage low. */
  text: string
  links: Array<{ text: string; href: string }>
  /** True when the page currently shows a password field — a signal to stop and ask for Take Over rather than try to log in. */
  hasPasswordField: boolean
}

/** What the browser tools need from the bot's Chromium. `ChromeCdpClient` is the real implementation; tests inject a fake. */
export interface CdpClient {
  listTargets(): Promise<CdpTargetInfo[]>
  newTab(url: string): Promise<CdpTargetInfo>
  navigate(targetId: string, url: string): Promise<CdpTargetInfo>
  closeTab(targetId: string): Promise<void>
  readPage(targetId: string): Promise<PageContent>
  /** Throws if the selector matches zero or more than one element. */
  click(targetId: string, selector: string): Promise<void>
  /** Throws if the selector matches zero or more than one element, or resolves to a password field. */
  typeText(targetId: string, selector: string, text: string): Promise<void>
  screenshot(targetId: string): Promise<Buffer>
  /** Closes every open per-target WebSocket. Safe to call more than once. */
  close(): Promise<void>
}

interface RawTarget {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl: string
}

const EVALUATE_TIMEOUT_MS = 20_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jsLiteral(value: string): string {
  return JSON.stringify(value)
}

/** One target's own CDP WebSocket, speaking the plain `{id, method, params}` -> `{id, result|error}` protocol. */
class CdpSession {
  private ws: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>()

  constructor(
    private readonly wsUrl: string,
    private readonly WebSocketCtor: typeof WebSocket
  ) {}

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new this.WebSocketCtor(this.wsUrl)
      let settled = false
      ws.on('open', () => {
        settled = true
        resolve()
      })
      ws.on('message', (data: WebSocket.RawData) => {
        let message: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          message = JSON.parse(data.toString())
        } catch {
          return
        }
        if (typeof message.id !== 'number') return
        const waiting = this.pending.get(message.id)
        if (!waiting) return
        this.pending.delete(message.id)
        if (message.error) waiting.reject(new Error(message.error.message ?? 'The page reported an error.'))
        else waiting.resolve(message.result)
      })
      ws.on('error', (error) => {
        if (!settled) {
          settled = true
          reject(new PcUnreachableError('browser', error))
        }
        this.failAll(error)
      })
      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null
          this.connecting = null
        }
        this.failAll(new Error("This tab's connection closed."))
      })
      this.ws = ws
    })
    return this.connecting
  }

  private failAll(error: unknown): void {
    for (const waiting of this.pending.values()) waiting.reject(error)
    this.pending.clear()
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.connect()
    const ws = this.ws
    if (!ws) throw new Error("This tab's connection closed.")
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for the browser to answer ${method}.`))
      }, EVALUATE_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }

  close(): void {
    this.ws?.close()
    this.ws = null
    this.connecting = null
    this.failAll(new Error('Closed.'))
  }
}

/** The real client: HTTP for `/json/*`, one `CdpSession` per open tab for everything else. */
export class ChromeCdpClient implements CdpClient {
  private readonly sessions = new Map<string, CdpSession>()

  constructor(
    private readonly httpBaseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly WebSocketCtor: typeof WebSocket = WebSocket
  ) {}

  async listTargets(): Promise<CdpTargetInfo[]> {
    const list = await this.httpJson<RawTarget[]>('/json/list')
    return list.filter((t) => t.type === 'page').map((t) => ({ targetId: t.id, url: t.url, title: t.title }))
  }

  async newTab(url: string): Promise<CdpTargetInfo> {
    const raw = await this.httpJson<RawTarget>(`/json/new?${url}`, 'PUT')
    this.remember(raw)
    await this.waitForLoad(raw.id, url === 'about:blank' ? undefined : 'about:blank')
    return this.currentInfo(raw.id)
  }

  async navigate(targetId: string, url: string): Promise<CdpTargetInfo> {
    const session = await this.resolveSession(targetId)
    await session.send('Page.navigate', { url })
    await this.waitForLoad(targetId)
    return this.currentInfo(targetId)
  }

  async closeTab(targetId: string): Promise<void> {
    await this.httpJson(`/json/close/${targetId}`)
    this.sessions.get(targetId)?.close()
    this.sessions.delete(targetId)
  }

  async readPage(targetId: string): Promise<PageContent> {
    return this.evaluate<PageContent>(
      targetId,
      `(() => {
        const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map((a) => ({
          text: (a.innerText || a.textContent || '').trim().slice(0, 120),
          href: a.href
        }))
        const text = (document.body ? (document.body.innerText || document.body.textContent || '') : '').trim().slice(0, 20000)
        return {
          url: location.href,
          title: document.title,
          text,
          links,
          hasPasswordField: !!document.querySelector('input[type="password"]')
        }
      })()`
    )
  }

  async click(targetId: string, selector: string): Promise<void> {
    await this.evaluate(
      targetId,
      `(() => {
        const els = document.querySelectorAll(${jsLiteral(selector)})
        if (els.length === 0) throw new Error('No element matches this selector: ' + ${jsLiteral(selector)})
        if (els.length > 1) throw new Error('This selector matches ' + els.length + ' elements; use a more specific one.')
        const el = els[0]
        el.scrollIntoView({ block: 'center', inline: 'center' })
        el.click()
        return true
      })()`
    )
  }

  async typeText(targetId: string, selector: string, text: string): Promise<void> {
    const result = await this.evaluate<{ blocked: boolean }>(
      targetId,
      `(() => {
        const els = document.querySelectorAll(${jsLiteral(selector)})
        if (els.length === 0) throw new Error('No element matches this selector: ' + ${jsLiteral(selector)})
        if (els.length > 1) throw new Error('This selector matches ' + els.length + ' elements; use a more specific one.')
        const el = els[0]
        const tag = (el.tagName || '').toLowerCase()
        const inputType = (el.type || '').toLowerCase()
        if (tag === 'input' && inputType === 'password') return { blocked: true }
        el.scrollIntoView({ block: 'center', inline: 'center' })
        el.focus()
        if (tag === 'input' || tag === 'textarea') {
          const proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${jsLiteral(text)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        } else if (el.isContentEditable) {
          el.textContent = ${jsLiteral(text)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          throw new Error('This element cannot be typed into.')
        }
        return { blocked: false }
      })()`
    )
    if (result.blocked) {
      throw new Error(
        "That field looks like a password field. I never type passwords — ask the user to open Take Over and sign in themselves."
      )
    }
  }

  async screenshot(targetId: string): Promise<Buffer> {
    const session = await this.resolveSession(targetId)
    const result = await session.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(result.data, 'base64')
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  private async evaluate<T>(targetId: string, expression: string): Promise<T> {
    const session = await this.resolveSession(targetId)
    const result = await session.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The page script failed.')
    }
    return result.result?.value as T
  }

  private async currentInfo(targetId: string): Promise<CdpTargetInfo> {
    const info = await this.evaluate<{ url: string; title: string }>(targetId, '({ url: location.href, title: document.title })')
    return { targetId, url: info.url, title: info.title }
  }

  /**
   * `leaving` is a URL the page must have moved off first: a new tab starts on an `about:blank`
   * document that is already "complete" before the requested URL has even committed, so
   * `readyState` alone would report the blank page as loaded.
   */
  private async waitForLoad(targetId: string, leaving?: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.evaluate<{ href: string; readyState: string }>(
        targetId,
        '({ href: location.href, readyState: document.readyState })'
      ).catch(() => null)
      if (state && state.href !== leaving && (state.readyState === 'complete' || state.readyState === 'interactive')) return
      await sleep(150)
    }
  }

  private async resolveSession(targetId: string): Promise<CdpSession> {
    const cached = this.sessions.get(targetId)
    if (cached) return cached
    const list = await this.httpJson<RawTarget[]>('/json/list')
    const found = list.find((t) => t.id === targetId)
    if (!found) throw new Error('No open tab with that id. Use tabs to see what is open.')
    return this.remember(found)
  }

  private remember(raw: RawTarget): CdpSession {
    const session = new CdpSession(raw.webSocketDebuggerUrl, this.WebSocketCtor)
    this.sessions.set(raw.id, session)
    return session
  }

  private async httpJson<T>(path: string, method = 'GET'): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.httpBaseUrl}${path}`, { method })
    } catch (error) {
      throw new PcUnreachableError('browser', error)
    }
    if (!res.ok) throw new Error(`The bot's browser returned ${res.status} for ${path}.`)
    return (await res.json()) as T
  }
}
