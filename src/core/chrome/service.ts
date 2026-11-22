/**
 * The user's own Google Chrome, driven over the DevTools Protocol. One connection for the whole
 * core (Chrome asks the user to allow each new one), shared by every agent: the Work tab, the
 * command-line agents through deskmates-prompt, bots and Duo. The rules about what agents may do
 * live in the tools (`core/tools/chrome.ts`); this only does what it is told.
 *
 * Tabs get short numbers (1, 2, 3…) for the model. Tabs an agent opened are "Deskmates tabs"; the
 * user's own tabs are listed separately, and the tools ask before touching them.
 */
import { CdpConnection, CdpError } from './cdp'
import { browserSocketAt, candidateEndpoints, CHROME_SETUP_HELP, type ChromeEndpoint } from './discover'
import { READY_SCRIPT, VIEWPORT_SCRIPT } from './page-scripts'

export interface ChromeTab {
  tabId: number
  title: string
  url: string
  /** Opened by a Deskmates agent (tabs_create or navigate into a new tab). */
  deskmates: boolean
}

export interface ConsoleEntry {
  level: string
  text: string
  url?: string
  at: number
}

export interface NetworkEntry {
  requestId: string
  method: string
  url: string
  type?: string
  status?: number
  mimeType?: string
  failed?: string
  at: number
}

export interface Shot {
  /** Base64 JPEG. */
  data: string
  width: number
  height: number
}

export type MouseButton = 'left' | 'right' | 'middle'

/** What the Chrome tools need from Chrome. `ChromeService` is the real one; tests use a fake. */
export interface ChromeDriver {
  tabs(): Promise<{ deskmates: ChromeTab[]; user: ChromeTab[] }>
  createTab(url?: string): Promise<ChromeTab>
  closeTab(tabId: number): Promise<void>
  tab(tabId: number): Promise<ChromeTab>
  navigate(tabId: number, url: string): Promise<ChromeTab>
  history(tabId: number, direction: 'back' | 'forward'): Promise<ChromeTab>
  evaluate<T = unknown>(tabId: number, expression: string): Promise<T>
  click(tabId: number, x: number, y: number, options?: { button?: MouseButton; count?: number; modifiers?: number }): Promise<void>
  move(tabId: number, x: number, y: number): Promise<void>
  drag(tabId: number, from: [number, number], to: [number, number]): Promise<void>
  wheel(tabId: number, x: number, y: number, dx: number, dy: number): Promise<void>
  insertText(tabId: number, text: string): Promise<void>
  key(tabId: number, key: string): Promise<void>
  screenshot(tabId: number, region?: [number, number, number, number], scale?: number, format?: 'jpeg' | 'png'): Promise<Shot>
  /** Resizes the Chrome window the tab is in. */
  resizeWindow?(tabId: number, width: number, height: number): Promise<void>
  /** Puts files into the file input `ref` points at (or the first one inside it). */
  setFiles?(tabId: number, ref: string, paths: string[]): Promise<void>
  /** Drops files on the page at (x, y), as dragging them from the desktop would. */
  dropFiles?(tabId: number, x: number, y: number, paths: string[]): Promise<void>
  consoleMessages(tabId: number): ConsoleEntry[]
  clearConsole(tabId: number): void
  networkRequests(tabId: number): NetworkEntry[]
  clearNetwork(tabId: number): void
  responseBody(tabId: number, requestId: string): Promise<string>
  /** Starts collecting a tab's console and network requests (from now on). */
  watch?(tabId: number): Promise<void>
}

const CONNECT_TIMEOUT_MS = 60_000
const MAX_CONSOLE = 500
const MAX_NETWORK = 500

type TargetInfo = { targetId: string; type: string; title: string; url: string; attached?: boolean }

interface Attached {
  sessionId: string
  console: ConsoleEntry[]
  network: Map<string, NetworkEntry>
}

/** CDP modifier bits. */
export const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, super: 4, shift: 8 } as const

/** "ctrl+shift" → 10. Unknown names are ignored. */
export function modifierBits(text?: string): number {
  if (!text) return 0
  return text
    .toLowerCase()
    .split(/[+\s]+/)
    .reduce((bits, part) => bits | ((MODIFIERS as Record<string, number>)[part] ?? 0), 0)
}

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 }
}

/** A key name ("Enter", "a", "F5", "ArrowDown") as CDP wants it; null when unknown. */
export function keyDef(name: string): KeyDef | null {
  const lower = name.toLowerCase()
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower]
  const f = /^f([1-9]|1[0-2])$/.exec(lower)
  if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]) }
  if (name.length === 1) {
    const upper = name.toUpperCase()
    const isLetter = /[a-z]/i.test(name)
    const isDigit = /[0-9]/.test(name)
    return { key: name, code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '', keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0, text: name }
  }
  return null
}

export class ChromeService implements ChromeDriver {
  private connection: CdpConnection | null = null
  private connecting: Promise<CdpConnection> | null = null
  private endpoint: ChromeEndpoint | null = null
  /** Short tab numbers ↔ Chrome's target ids. */
  private readonly numbers = new Map<string, number>()
  private readonly targets = new Map<number, string>()
  private nextNumber = 1
  private readonly ours = new Set<string>()
  private readonly attached = new Map<string, Attached>()
  private readonly attaching = new Map<string, Promise<Attached>>()

  constructor(private readonly options: { env?: NodeJS.ProcessEnv; profileDirs?: string[]; connectTimeoutMs?: number } = {}) {}

  /** Where it is connected, for messages. Null before the first tool call. */
  get connectedTo(): ChromeEndpoint | null {
    return this.connection?.isOpen ? this.endpoint : null
  }

  // ---- connection ----

  private async connect(): Promise<CdpConnection> {
    if (this.connection?.isOpen) return this.connection
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const errors: string[] = []
      for (const candidate of candidateEndpoints({ env: this.options.env, ...(this.options.profileDirs ? { dirs: this.options.profileDirs } : {}) })) {
        let endpoint: ChromeEndpoint | null = null
        if ('http' in candidate) {
          const url = await browserSocketAt(candidate.http)
          if (url) endpoint = { url, source: candidate.source }
        } else endpoint = candidate
        if (!endpoint) continue
        try {
          const connection = await CdpConnection.open(endpoint.url, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
          this.adopt(connection, endpoint)
          return connection
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      throw new CdpError(errors.length > 0 ? `${CHROME_SETUP_HELP} (Chrome said: ${errors[errors.length - 1]})` : CHROME_SETUP_HELP)
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private adopt(connection: CdpConnection, endpoint: ChromeEndpoint): void {
    this.connection = connection
    this.endpoint = endpoint
    this.attached.clear()
    this.attaching.clear()
    connection.onClose(() => {
      if (this.connection === connection) this.connection = null
      this.attached.clear()
      this.attaching.clear()
    })
    connection.on('Target.detachedFromTarget', (params) => {
      for (const [targetId, entry] of this.attached) if (entry.sessionId === params.sessionId) this.attached.delete(targetId)
    })
    connection.on('Target.targetDestroyed', (params) => this.forget(String(params.targetId)))
    connection.on('Runtime.consoleAPICalled', (params, sessionId) => {
      const entry = this.bySession(sessionId)
      if (!entry) return
      const args = (params.args as Array<{ value?: unknown; description?: string; type?: string }> | undefined) ?? []
      const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type ?? ''))).join(' ')
      const frame = (params.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined)?.callFrames?.[0]
      push(entry.console, { level: String(params.type ?? 'log'), text, ...(frame?.url ? { url: `${frame.url}:${(frame.lineNumber ?? 0) + 1}` } : {}), at: Date.now() }, MAX_CONSOLE)
    })
    connection.on('Runtime.exceptionThrown', (params, sessionId) => {
      const entry = this.bySession(sessionId)
      if (!entry) return
      const details = params.exceptionDetails as { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } } | undefined
      push(entry.console, { level: 'error', text: details?.exception?.description ?? details?.text ?? 'Uncaught exception', ...(details?.url ? { url: `${details.url}:${(details.lineNumber ?? 0) + 1}` } : {}), at: Date.now() }, MAX_CONSOLE)
    })
    connection.on('Log.entryAdded', (params, sessionId) => {
      const entry = this.bySession(sessionId)
      const log = params.entry as { level?: string; text?: string; url?: string } | undefined
      if (!entry || !log) return
      push(entry.console, { level: log.level ?? 'info', text: log.text ?? '', ...(log.url ? { url: log.url } : {}), at: Date.now() }, MAX_CONSOLE)
    })
    connection.on('Network.requestWillBeSent', (params, sessionId) => {
      const entry = this.bySession(sessionId)
      const request = params.request as { method?: string; url?: string } | undefined
      if (!entry || !request) return
      const id = String(params.requestId)
      entry.network.set(id, { requestId: id, method: request.method ?? 'GET', url: request.url ?? '', ...(params.type ? { type: String(params.type) } : {}), at: Date.now() })
      if (entry.network.size > MAX_NETWORK) entry.network.delete(entry.network.keys().next().value as string)
    })
    connection.on('Network.responseReceived', (params, sessionId) => {
      const item = this.bySession(sessionId)?.network.get(String(params.requestId))
      const response = params.response as { status?: number; mimeType?: string } | undefined
      if (!item || !response) return
      if (typeof response.status === 'number') item.status = response.status
      if (response.mimeType) item.mimeType = response.mimeType
    })
    connection.on('Network.loadingFailed', (params, sessionId) => {
      const item = this.bySession(sessionId)?.network.get(String(params.requestId))
      if (item) item.failed = String(params.errorText ?? 'failed')
    })
  }

  private bySession(sessionId: string | undefined): Attached | undefined {
    if (!sessionId) return undefined
    for (const entry of this.attached.values()) if (entry.sessionId === sessionId) return entry
    return undefined
  }

  private forget(targetId: string): void {
    const n = this.numbers.get(targetId)
    if (n !== undefined) this.targets.delete(n)
    this.numbers.delete(targetId)
    this.ours.delete(targetId)
    this.attached.delete(targetId)
  }

  private numberOf(targetId: string): number {
    let n = this.numbers.get(targetId)
    if (n === undefined) {
      n = this.nextNumber++
      this.numbers.set(targetId, n)
      this.targets.set(n, targetId)
    }
    return n
  }

  private async pages(): Promise<TargetInfo[]> {
    const connection = await this.connect()
    const { targetInfos } = await connection.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')
    return targetInfos.filter((t) => t.type === 'page' && !/^(devtools|chrome-extension):/i.test(t.url))
  }

  private toTab(info: TargetInfo): ChromeTab {
    return { tabId: this.numberOf(info.targetId), title: info.title, url: info.url, deskmates: this.ours.has(info.targetId) }
  }

  private targetOf(tabId: number): string {
    const targetId = this.targets.get(tabId)
    if (!targetId) throw new CdpError(`There is no tab ${tabId}. Call tabs_context to see the open tabs.`)
    return targetId
  }

  /** Attaches to a tab (once) and starts collecting its console and network requests. */
  private async session(tabId: number): Promise<Attached> {
    const targetId = this.targetOf(tabId)
    const connection = await this.connect()
    const known = this.attached.get(targetId)
    if (known) return known
    const inFlight = this.attaching.get(targetId)
    if (inFlight) return inFlight
    const work = (async () => {
      const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      const entry: Attached = { sessionId, console: [], network: new Map() }
      this.attached.set(targetId, entry)
      await Promise.all([
        connection.send('Page.enable', {}, sessionId),
        connection.send('Runtime.enable', {}, sessionId),
        connection.send('Log.enable', {}, sessionId),
        connection.send('Network.enable', {}, sessionId)
      ]).catch(() => undefined)
      return entry
    })()
    this.attaching.set(targetId, work)
    try {
      return await work
    } catch (error) {
      throw new CdpError(`Couldn't attach to tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.attaching.delete(targetId)
    }
  }

  private async send<T = Record<string, unknown>>(tabId: number, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const { sessionId } = await this.session(tabId)
    return (await this.connect()).send<T>(method, params, sessionId, timeoutMs)
  }

  /** Brings the tab to the front: input and screenshots need a visible tab. */
  private async front(tabId: number): Promise<void> {
    const connection = await this.connect()
    await connection.send('Target.activateTarget', { targetId: this.targetOf(tabId) }).catch(() => undefined)
  }

  // ---- tabs ----

  async tabs(): Promise<{ deskmates: ChromeTab[]; user: ChromeTab[] }> {
    const tabs = (await this.pages()).map((info) => this.toTab(info))
    return { deskmates: tabs.filter((t) => t.deskmates), user: tabs.filter((t) => !t.deskmates) }
  }

  async tab(tabId: number): Promise<ChromeTab> {
    const targetId = this.targetOf(tabId)
    const info = (await this.pages()).find((t) => t.targetId === targetId)
    if (!info) {
      this.forget(targetId)
      throw new CdpError(`Tab ${tabId} was closed. Call tabs_context to see the open tabs.`)
    }
    return this.toTab(info)
  }

  async createTab(url = 'about:blank'): Promise<ChromeTab> {
    const connection = await this.connect()
    const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: false })
    this.ours.add(targetId)
    const tabId = this.numberOf(targetId)
    // Attach before loading anything, so the console and network requests of the load are kept.
    await this.session(tabId)
    if (url && url !== 'about:blank') return this.navigate(tabId, url)
    return this.tab(tabId)
  }

  async closeTab(tabId: number): Promise<void> {
    const connection = await this.connect()
    const targetId = this.targetOf(tabId)
    await connection.send('Target.closeTarget', { targetId })
    this.forget(targetId)
  }

  async navigate(tabId: number, url: string): Promise<ChromeTab> {
    const result = await this.send<{ errorText?: string }>(tabId, 'Page.navigate', { url })
    if (result.errorText) throw new CdpError(`Chrome couldn't open ${url}: ${result.errorText}`)
    await this.settle(tabId)
    return this.tab(tabId)
  }

  async history(tabId: number, direction: 'back' | 'forward'): Promise<ChromeTab> {
    const { currentIndex, entries } = await this.send<{ currentIndex: number; entries: Array<{ id: number }> }>(tabId, 'Page.getNavigationHistory')
    const target = entries[currentIndex + (direction === 'back' ? -1 : 1)]
    if (!target) throw new CdpError(`There is no page to go ${direction} to in tab ${tabId}.`)
    await this.send(tabId, 'Page.navigateToHistoryEntry', { entryId: target.id })
    await this.settle(tabId)
    return this.tab(tabId)
  }

  /** Waits for the page to finish loading (up to 15 seconds), tolerating the navigation in between. */
  private async settle(tabId: number, timeoutMs = 15_000): Promise<void> {
    const until = Date.now() + timeoutMs
    await sleep(150)
    while (Date.now() < until) {
      try {
        const ready = await this.evaluate<{ state: string }>(tabId, READY_SCRIPT)
        if (ready.state === 'complete') return
      } catch {
        // The old page went away mid-navigation; try again.
      }
      await sleep(250)
    }
  }

  // ---- the page ----

  async evaluate<T = unknown>(tabId: number, expression: string): Promise<T> {
    const result = await this.send<{ result?: { value?: unknown; description?: string; type?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      tabId,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true },
      30_000
    )
    if (result.exceptionDetails) throw new CdpError(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The script threw an error.')
    const value = result.result
    if (!value) return undefined as T
    if ('value' in value) return value.value as T
    return (value.description ?? (value.type === 'undefined' ? undefined : value.type)) as T
  }

  async click(tabId: number, x: number, y: number, options: { button?: MouseButton; count?: number; modifiers?: number } = {}): Promise<void> {
    await this.front(tabId)
    const button = options.button ?? 'left'
    const modifiers = options.modifiers ?? 0
    const count = options.count ?? 1
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers })
    for (let i = 1; i <= count; i++) {
      await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers })
      await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers })
    }
  }

  async move(tabId: number, x: number, y: number): Promise<void> {
    await this.front(tabId)
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  }

  async drag(tabId: number, from: [number, number], to: [number, number]): Promise<void> {
    await this.front(tabId)
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1] })
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1 })
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      const x = from[0] + ((to[0] - from[0]) * i) / steps
      const y = from[1] + ((to[1] - from[1]) * i) / steps
      await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1 })
  }

  async wheel(tabId: number, x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy })
  }

  async insertText(tabId: number, text: string): Promise<void> {
    await this.front(tabId)
    await this.send(tabId, 'Input.insertText', { text })
  }

  /** One key or chord: "Enter", "ctrl+a", "shift+Tab". */
  async key(tabId: number, chord: string): Promise<void> {
    await this.front(tabId)
    const parts = chord.split('+').map((p) => p.trim()).filter(Boolean)
    const main = parts.pop() ?? ''
    const modifiers = modifierBits(parts.join('+'))
    const def = keyDef(main)
    if (!def) throw new CdpError(`Unknown key "${main}". Use names like Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, or a single character.`)
    const withText = def.text !== undefined && (modifiers & ~MODIFIERS.shift) === 0
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers }
    await this.send(tabId, 'Input.dispatchKeyEvent', { ...base, type: withText ? 'keyDown' : 'rawKeyDown', ...(withText ? { text: def.text, unmodifiedText: def.text } : {}) })
    await this.send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  async screenshot(tabId: number, region?: [number, number, number, number], scale?: number, format: 'jpeg' | 'png' = 'jpeg'): Promise<Shot> {
    await this.front(tabId)
    const view = await this.evaluate<{ width: number; height: number; dpr: number }>(tabId, VIEWPORT_SCRIPT)
    const [x0, y0, x1, y1] = region ?? [0, 0, view.width, view.height]
    const width = Math.max(1, x1 - x0)
    const height = Math.max(1, y1 - y0)
    // Viewport screenshots come out in CSS pixels, so their coordinates are the ones clicks use.
    const zoom = scale ?? (region ? Math.min(4, 1280 / width) : 1)
    const { data } = await this.send<{ data: string }>(tabId, 'Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 80 } : {}), clip: { x: x0, y: y0, width, height, scale: zoom } }, 30_000)
    return { data, width: Math.round(width * zoom), height: Math.round(height * zoom) }
  }

  async resizeWindow(tabId: number, width: number, height: number): Promise<void> {
    const connection = await this.connect()
    const { windowId } = await connection.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: this.targetOf(tabId) })
    // A maximised or full-screen window has to become normal before it takes a size.
    await connection.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => undefined)
    await connection.send('Browser.setWindowBounds', { windowId, bounds: { width: Math.round(width), height: Math.round(height) } })
  }

  async setFiles(tabId: number, ref: string, paths: string[]): Promise<void> {
    const expression = `(() => { const R = window.__deskmatesRefs; const w = R && R.map.get(${JSON.stringify(ref)}); const el = w && w.deref(); if (!el || !el.isConnected) return null; if (el.matches && el.matches('input[type=file]')) return el; const inner = el.querySelector && el.querySelector('input[type=file]'); if (inner) return inner; const label = el.closest && el.closest('label'); const target = label && label.control; return target && target.matches('input[type=file]') ? target : null; })()`
    const found = await this.send<{ result?: { objectId?: string; subtype?: string } }>(tabId, 'Runtime.evaluate', { expression, returnByValue: false })
    const objectId = found.result?.objectId
    if (!objectId || found.result?.subtype === 'null') throw new CdpError(`${ref} is not a file input, and has none inside it. Use read_page or find to get the file input's ref, or give a coordinate to drop the file there.`)
    await this.send(tabId, 'DOM.enable').catch(() => undefined)
    await this.send(tabId, 'DOM.setFileInputFiles', { files: paths, objectId })
  }

  async dropFiles(tabId: number, x: number, y: number, paths: string[]): Promise<void> {
    await this.front(tabId)
    const data = { items: [], files: paths, dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await this.send(tabId, 'Input.dispatchDragEvent', { type, x, y, data })
    }
  }

  consoleMessages(tabId: number): ConsoleEntry[] {
    const targetId = this.targets.get(tabId)
    return (targetId && this.attached.get(targetId)?.console) || []
  }

  clearConsole(tabId: number): void {
    const targetId = this.targets.get(tabId)
    const entry = targetId ? this.attached.get(targetId) : undefined
    if (entry) entry.console.length = 0
  }

  networkRequests(tabId: number): NetworkEntry[] {
    const targetId = this.targets.get(tabId)
    return [...((targetId && this.attached.get(targetId)?.network.values()) || [])]
  }

  clearNetwork(tabId: number): void {
    const targetId = this.targets.get(tabId)
    targetId && this.attached.get(targetId)?.network.clear()
  }

  async responseBody(tabId: number, requestId: string): Promise<string> {
    const { body, base64Encoded } = await this.send<{ body: string; base64Encoded: boolean }>(tabId, 'Network.getResponseBody', { requestId })
    return base64Encoded ? `(binary, ${Math.round((body.length * 3) / 4)} bytes)` : body
  }

  /** Makes sure console and network collection runs for a tab (from now on). */
  async watch(tabId: number): Promise<void> {
    await this.session(tabId)
  }
}

function push<T>(list: T[], item: T, max: number): void {
  list.push(item)
  if (list.length > max) list.splice(0, list.length - max)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let shared: ChromeService | null = null

/** The one Chrome connection the core keeps for every agent. */
export function sharedChrome(): ChromeService {
  shared ??= new ChromeService()
  return shared
}
