/**
 * The agent browser: real Chromium tabs (Electron `WebContentsView`s) on their own persistent
 * profile, separate from the user's Chrome, so sign-ins made here stay here. Agents drive it through
 * the core (`browser-request` messages); the user sees and uses the same tabs in the browser panel.
 *
 * While the panel is closed the tabs live in a hidden window, so pages keep their full size and keep
 * working. When the panel opens, the active tab moves into the Deskmates window, over the panel's area.
 */
import { app, BrowserWindow, powerMonitor, session, WebContentsView, type Session } from 'electron'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserAction, BrowserPage, BrowserResult, BrowserTab, HostBrowserState } from '../shared/agent-browser'
import { domainOf } from '../shared/agent-browser'
import {
  ENTER_SUBMITS_SCRIPT,
  FOCUSED_IS_SENSITIVE_SCRIPT,
  READ_PAGE_SCRIPT,
  focusForTypingScript,
  locateScript,
  nameOfScript,
  scrollScript
} from './agent-browser-page'
import { ControlState } from './browser-control'

export { ControlState }

export const AGENT_BROWSER_PARTITION = 'persist:agent-browser'
const HIDDEN_SIZE = { width: 1280, height: 860 }
const LOAD_TIMEOUT_MS = 20_000
const SETTLE_MS = 600
/** Input events Electron reports within this long of an agent's own event are the agent's. */
const AGENT_INPUT_WINDOW_MS = 400
const MAX_TABS = 8

interface Tab {
  id: string
  view: WebContentsView
}

const KEY_CODES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  space: 'Space'
}

export interface AgentBrowserOptions {
  /** The Deskmates window, where the panel shows the active tab. */
  getWindow: () => BrowserWindow | null
  /** Called whenever tabs, control or the panel change. */
  onState: (state: HostBrowserState) => void
}

export class AgentBrowser {
  private readonly tabs: Tab[] = []
  private activeId: string | null = null
  private host: BrowserWindow | null = null
  private panelBounds: Electron.Rectangle | null = null
  private attachedTo: BrowserWindow | null = null
  private readonly control = new ControlState()
  private busy = false
  private lastAgent: string | null = null
  private agentInputAt = 0
  private queue: Promise<unknown> = Promise.resolve()
  private notes: string[] = []
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private lastIdleReported = -1
  private profile: Session | null = null

  constructor(private readonly options: AgentBrowserOptions) {}

  /** Runs one agent action, one at a time. Never throws: failures come back as `{ ok: false }`. */
  act(action: BrowserAction): Promise<BrowserResult> {
    const run = this.queue.then(() => this.perform(action))
    this.queue = run.catch(() => undefined)
    return run
  }

  state(): HostBrowserState {
    return {
      open: this.panelBounds !== null,
      tabs: this.tabList(),
      controller: this.control.controller,
      busy: this.busy,
      idleSeconds: powerMonitor.getSystemIdleTime(),
      lastAgent: this.lastAgent
    }
  }

  /** The panel's page area in window coordinates, or null when the panel is closed. */
  setPanelBounds(bounds: Electron.Rectangle | null): void {
    const wasOpen = this.panelBounds !== null
    this.panelBounds = bounds ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) } : null
    // Closing the panel hands the browser back to the agent.
    if (!bounds && wasOpen) this.control.handBack()
    this.placeViews()
    this.emit()
  }

  /** The user pressed "Hand back to agent". */
  handBack(): void {
    if (this.control.handBack()) this.emit()
  }

  /** Navigation the user does from the panel's toolbar. Counts as the user using the browser. */
  async userNavigate(op: 'back' | 'forward' | 'reload' | 'go', url?: string): Promise<void> {
    const tab = this.active()
    if (!tab) {
      if (op === 'go' && url) await this.openTab(normalizeUrl(url))
      this.emit()
      return
    }
    this.markUserInput()
    const contents = tab.view.webContents
    if (op === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    else if (op === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    else if (op === 'reload') contents.reload()
    else if (op === 'go' && url) {
      const target = normalizeUrl(url)
      if (isWebUrl(target)) await contents.loadURL(target).catch(() => undefined)
    }
    this.emit()
  }

  userSelectTab(tabId: string): void {
    if (!this.tabs.some((t) => t.id === tabId)) return
    this.activeId = tabId
    this.placeViews()
    this.emit()
  }

  userCloseTab(tabId: string): void {
    this.closeTab(tabId)
    this.emit()
  }

  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    for (const tab of this.tabs) tab.view.webContents.close()
    this.tabs.length = 0
    if (this.host && !this.host.isDestroyed()) this.host.destroy()
    this.host = null
  }

  // ---- internals ----

  private async perform(action: BrowserAction): Promise<BrowserResult> {
    if (!this.control.canAgentAct() && action.op !== 'tabs' && action.op !== 'inspect') {
      return { ok: false, error: 'The user is using the browser right now.', userControl: true }
    }
    this.lastAgent = action.agent
    this.busy = true
    this.emit()
    try {
      const result = await this.dispatch(action)
      if (result.ok && this.notes.length > 0) {
        result.note = [result.note, ...this.notes].filter(Boolean).join(' ')
        this.notes = []
      }
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.busy = false
      this.emit()
    }
  }

  private async dispatch(action: BrowserAction): Promise<BrowserResult> {
    switch (action.op) {
      case 'open': {
        const url = normalizeUrl(action.url)
        if (!isWebUrl(url)) return { ok: false, error: 'Only http and https addresses can be opened.' }
        const current = this.active()
        if (current && !action.newTab) {
          this.agentInputAt = Date.now()
          await this.load(current, url)
        } else {
          await this.openTab(url)
        }
        return { ok: true, page: await this.readActive() }
      }
      case 'read':
        return { ok: true, page: await this.readActive() }
      case 'click':
        return this.click(action.n)
      case 'type':
        return this.type(action.n, action.text, action.submit === true)
      case 'key':
        return this.key(action.key)
      case 'scroll': {
        const tab = this.requireActive()
        await tab.view.webContents.executeJavaScript(scrollScript(action.direction, action.amount ?? 0.8))
        return { ok: true, page: await this.readActive() }
      }
      case 'back':
      case 'forward': {
        const tab = this.requireActive()
        const history = tab.view.webContents.navigationHistory
        if (action.op === 'back' ? !history.canGoBack() : !history.canGoForward()) return { ok: false, error: `There is no page to go ${action.op} to.` }
        this.agentInputAt = Date.now()
        if (action.op === 'back') history.goBack()
        else history.goForward()
        await this.waitForLoad(tab)
        return { ok: true, page: await this.readActive() }
      }
      case 'screenshot': {
        const tab = this.requireActive()
        let image = await tab.view.webContents.capturePage()
        const size = image.getSize()
        if (size.width > 1280) image = image.resize({ width: 1280 })
        return { ok: true, png: image.toPNG().toString('base64') }
      }
      case 'tabs':
        return { ok: true, tabs: this.tabList() }
      case 'switch': {
        if (!this.tabs.some((t) => t.id === action.tabId)) return { ok: false, error: 'There is no tab with that id.' }
        this.activeId = action.tabId
        this.placeViews()
        return { ok: true, page: await this.readActive() }
      }
      case 'close':
        this.closeTab(action.tabId)
        return { ok: true, tabs: this.tabList() }
      case 'inspect': {
        const tab = this.requireActive()
        const name = (await tab.view.webContents.executeJavaScript(nameOfScript(action.n))) as string | null
        return { ok: true, name, url: tab.view.webContents.getURL() }
      }
      case 'enter-target': {
        const tab = this.requireActive()
        const name = (await tab.view.webContents.executeJavaScript(ENTER_SUBMITS_SCRIPT)) as string | null
        return { ok: true, name, url: tab.view.webContents.getURL() }
      }
    }
  }

  private async click(n: number): Promise<BrowserResult> {
    const tab = this.requireActive()
    const contents = tab.view.webContents
    const spot = (await contents.executeJavaScript(locateScript(n))) as { error?: string; x: number; y: number; covered?: boolean }
    if (spot.error) return { ok: false, error: `Element ${n} isn't on the page any more. Read the page again.` }
    this.agentInputAt = Date.now()
    const point = { x: spot.x, y: spot.y }
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await this.settle(tab)
    return { ok: true, page: await this.readActive() }
  }

  private async type(n: number, text: string, submit: boolean): Promise<BrowserResult> {
    const tab = this.requireActive()
    const contents = tab.view.webContents
    const focus = (await contents.executeJavaScript(focusForTypingScript(n))) as { error?: string }
    if (focus.error === 'missing') return { ok: false, error: `Element ${n} isn't on the page any more. Read the page again.` }
    if (focus.error === 'sensitive') {
      return { ok: false, error: "That's a password, code, card or ID field. Only the user types there: ask them to open the browser panel and fill it in themselves." }
    }
    if (focus.error === 'not-a-field') return { ok: false, error: `Element ${n} isn't a text field.` }
    this.agentInputAt = Date.now()
    if (text.length > 0) await contents.insertText(text)
    else {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
    }
    if (submit) {
      this.agentInputAt = Date.now()
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      contents.sendInputEvent({ type: 'char', keyCode: '\r' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await this.settle(tab)
    }
    return { ok: true, page: await this.readActive() }
  }

  private async key(name: string): Promise<BrowserResult> {
    const tab = this.requireActive()
    const contents = tab.view.webContents
    if (await contents.executeJavaScript(FOCUSED_IS_SENSITIVE_SCRIPT)) {
      return { ok: false, error: "The focused field is a password, code, card or ID field. Only the user types there." }
    }
    const parts = name.split('+').map((p) => p.trim())
    const main = parts.pop() ?? ''
    const keyCode = KEY_CODES[main.toLowerCase()] ?? (main.length === 1 ? main : null)
    if (!keyCode) return { ok: false, error: `Unknown key "${name}". Use Enter, Tab, Escape, Backspace, arrow keys, PageUp/PageDown, Home, End, Space or one character.` }
    const modifiers = parts
      .map((p) => p.toLowerCase())
      .map((p) => (p === 'ctrl' || p === 'control' ? 'control' : p === 'cmd' || p === 'meta' ? 'meta' : p))
      .filter((p): p is 'control' | 'shift' | 'alt' | 'meta' => ['control', 'shift', 'alt', 'meta'].includes(p))
    this.agentInputAt = Date.now()
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
    else if (keyCode.length === 1 && modifiers.length === 0) contents.sendInputEvent({ type: 'char', keyCode })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await this.settle(tab)
    return { ok: true, page: await this.readActive() }
  }

  private async readActive(): Promise<BrowserPage> {
    const tab = this.requireActive()
    const raw = (await tab.view.webContents.executeJavaScript(READ_PAGE_SCRIPT)) as Omit<BrowserPage, 'tabId'>
    return { tabId: tab.id, ...raw }
  }

  private requireActive(): Tab {
    const tab = this.active()
    if (!tab) throw new Error('No page is open yet. Open one first.')
    return tab
  }

  private active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId)
  }

  private tabList(): BrowserTab[] {
    return this.tabs.map((t) => ({
      tabId: t.id,
      url: t.view.webContents.getURL(),
      title: t.view.webContents.getTitle(),
      active: t.id === this.activeId,
      loading: t.view.webContents.isLoading()
    }))
  }

  private browserSession(): Session {
    if (this.profile) return this.profile
    const profile = session.fromPartition(AGENT_BROWSER_PARTITION)
    // Sites like Google refuse to sign in from a browser that calls itself Electron.
    profile.setUserAgent(profile.getUserAgent().replace(/\s(Electron|deskmates)\/\S+/gi, ''))
    // Pages here get no camera, microphone, location or notifications.
    profile.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'))
    profile.on('will-download', (_event, item) => {
      const folder = app.getPath('downloads')
      const name = basename(item.getFilename()) || 'download'
      let target = join(folder, name)
      for (let i = 1; existsSync(target); i++) target = join(folder, `${basename(name, extname(name))} (${i})${extname(name)}`)
      item.setSavePath(target)
      item.once('done', (_e, state) => {
        this.notes.push(state === 'completed' ? `Downloaded ${basename(target)} to ${target}.` : `A download of ${name} didn't finish (${state}).`)
      })
    })
    this.profile = profile
    return profile
  }

  private hostWindow(): BrowserWindow {
    if (this.host && !this.host.isDestroyed()) return this.host
    this.host = new BrowserWindow({
      ...HIDDEN_SIZE,
      show: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: { backgroundThrottling: false }
    })
    this.host.on('closed', () => {
      this.host = null
    })
    if (!this.idleTimer) {
      // Lets the core know when the user is away from the PC (for the LinkedIn rule), without polling it per action.
      this.idleTimer = setInterval(() => {
        const idle = powerMonitor.getSystemIdleTime()
        const away = idle >= 600
        if (away !== this.lastIdleReported >= 600 || Math.abs(idle - this.lastIdleReported) >= 60) this.emit()
      }, 15_000)
      this.idleTimer.unref?.()
    }
    return this.host
  }

  private async openTab(url: string): Promise<Tab> {
    if (this.tabs.length >= MAX_TABS) {
      const oldest = this.tabs.find((t) => t.id !== this.activeId)
      if (oldest) this.closeTab(oldest.id)
    }
    const view = new WebContentsView({
      webPreferences: { session: this.browserSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    const tab: Tab = { id: randomUUID().slice(0, 8), view }
    const contents = view.webContents
    contents.setWindowOpenHandler(({ url: target }) => {
      if (isWebUrl(target)) void this.openTab(target).then(() => this.emit())
      return { action: 'deny' }
    })
    contents.on('before-input-event', () => this.markUserInput())
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseWheel') this.markUserInput()
    })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading', 'did-start-loading'] as const) {
      contents.on(event as 'did-stop-loading', () => this.emit())
    }
    this.tabs.push(tab)
    this.activeId = tab.id
    this.placeViews()
    this.agentInputAt = Date.now()
    await this.load(tab, url)
    return tab
  }

  private closeTab(tabId: string): void {
    const index = this.tabs.findIndex((t) => t.id === tabId)
    if (index === -1) return
    const [tab] = this.tabs.splice(index, 1)
    this.detach(tab!)
    tab!.view.webContents.close()
    if (this.activeId === tabId) this.activeId = this.tabs[this.tabs.length - 1]?.id ?? null
    this.placeViews()
  }

  /** Puts the active tab over the panel when it's open, and every other tab in the hidden window. */
  private placeViews(): void {
    const win = this.options.getWindow()
    const host = this.hostWindow()
    for (const tab of this.tabs) {
      const showInPanel = tab.id === this.activeId && this.panelBounds !== null && win && !win.isDestroyed()
      const target = showInPanel ? win! : host
      if (!target.contentView.children.includes(tab.view)) {
        this.detach(tab)
        target.contentView.addChildView(tab.view)
      }
      tab.view.setBounds(showInPanel ? this.panelBounds! : { x: 0, y: 0, ...HIDDEN_SIZE })
      tab.view.setVisible(showInPanel || target === host)
    }
    this.attachedTo = this.panelBounds ? win : null
  }

  private detach(tab: Tab): void {
    for (const owner of [this.options.getWindow(), this.host, this.attachedTo]) {
      if (owner && !owner.isDestroyed() && owner.contentView.children.includes(tab.view)) owner.contentView.removeChildView(tab.view)
    }
  }

  private markUserInput(): void {
    if (this.panelBounds === null) return
    if (Date.now() - this.agentInputAt < AGENT_INPUT_WINDOW_MS) return
    if (this.control.userInput()) this.emit()
  }

  private async load(tab: Tab, url: string): Promise<void> {
    try {
      await Promise.race([tab.view.webContents.loadURL(url), sleep(LOAD_TIMEOUT_MS)])
    } catch (error) {
      // A redirect or a page that aborts its own load still leaves something on screen to read.
      const message = error instanceof Error ? error.message : String(error)
      if (!/ERR_ABORTED/.test(message)) throw new Error(`Couldn't open ${domainOf(url) || url}: ${message.replace(/^.*?ERR_/, 'ERR_')}`)
    }
    await sleep(SETTLE_MS)
  }

  /** After a click or key, waits for a navigation it may have started, then lets the page settle. */
  private async settle(tab: Tab): Promise<void> {
    await sleep(250)
    if (tab.view.webContents.isLoading()) await this.waitForLoad(tab)
    await sleep(SETTLE_MS)
  }

  private waitForLoad(tab: Tab): Promise<void> {
    const contents = tab.view.webContents
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        contents.removeListener('did-stop-loading', done)
        resolve()
      }
      const timer = setTimeout(done, LOAD_TIMEOUT_MS)
      contents.once('did-stop-loading', done)
    })
  }

  private emit(): void {
    const state = this.state()
    this.lastIdleReported = state.idleSeconds
    this.options.onState(state)
  }
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
