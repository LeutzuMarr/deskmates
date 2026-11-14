import { describe, expect, it } from 'vitest'
import type { BrowserAction, BrowserPage, BrowserResult, HostBrowserState } from '../../src/shared/agent-browser'
import { EMPTY_BROWSER_STATE } from '../../src/shared/agent-browser'
import { BrowserService, type BrowserPort } from '../../src/core/browser/service'
import { agentBrowserTools } from '../../src/core/tools/browser'
import { EventBus } from '../../src/core/events'

/** A pretend browser in the app's main process: one page, with the elements a test gives it. */
class FakeBrowser implements BrowserPort {
  listeners: Array<(event: { data?: unknown }) => void> = []
  actions: BrowserAction[] = []
  url = 'https://mail.zoho.eu/inbox'
  elements: BrowserPage['elements'] = [
    { n: 1, role: 'button', name: 'Compose', tag: 'button', sensitive: false },
    { n: 2, role: 'button', name: 'Send', tag: 'button', sensitive: false },
    { n: 3, role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', sensitive: true }
  ]
  enterTarget: string | null = null
  userHasIt = false
  idle = 0

  on(_event: 'message', listener: (event: { data?: unknown }) => void): void {
    this.listeners.push(listener)
  }

  postMessage(message: unknown): void {
    const { id, action } = message as { id: number; action: BrowserAction }
    this.actions.push(action)
    queueMicrotask(() => this.reply(id, this.answer(action)))
  }

  pushState(patch: Partial<HostBrowserState> = {}): void {
    const state: HostBrowserState = {
      ...EMPTY_BROWSER_STATE,
      tabs: [{ tabId: 't1', url: this.url, title: 'Page', active: true }],
      controller: this.userHasIt ? 'user' : 'agent',
      idleSeconds: this.idle,
      ...patch
    }
    for (const l of this.listeners) l({ data: { type: 'browser-state', state } })
  }

  private reply(id: number, result: BrowserResult): void {
    for (const l of this.listeners) l({ data: { type: 'browser-result', id, result } })
  }

  private page(): BrowserPage {
    return { tabId: 't1', url: this.url, title: 'Page', text: 'Hello', elements: this.elements, signIn: false, truncated: false }
  }

  private answer(action: BrowserAction): BrowserResult {
    if (this.userHasIt && action.op !== 'inspect' && action.op !== 'tabs') return { ok: false, error: 'busy', userControl: true }
    switch (action.op) {
      case 'inspect':
        return { ok: true, name: this.elements.find((e) => e.n === action.n)?.name ?? null, url: this.url }
      case 'enter-target':
        return { ok: true, name: this.enterTarget, url: this.url }
      case 'open':
        this.url = action.url
        return { ok: true, page: this.page() }
      case 'type':
        if (this.elements.find((e) => e.n === action.n)?.sensitive) return { ok: false, error: "That's a password field." }
        return { ok: true, page: this.page() }
      default:
        return { ok: true, page: this.page() }
    }
  }
}

function setup(options: { sites?: string[]; permit?: (domain: string) => { id: string; summary: string } | null } = {}) {
  const fake = new FakeBrowser()
  let sites = options.sites ?? []
  const notes: string[] = []
  const service = new BrowserService({
    bus: new EventBus(),
    port: fake,
    sites: { get: () => sites, set: (next) => (sites = next) },
    notify: (title) => notes.push(title)
  })
  fake.pushState()
  const tools = agentBrowserTools({ browser: service, agent: options.permit ? 'Duo' : 'Work', runKey: 'task-1', sendPermit: options.permit })
  const exec = <T>(name: keyof typeof tools, input: T): Promise<string> =>
    (tools[name] as unknown as { execute: (input: T, options: unknown) => Promise<string> }).execute(input, { toolCallId: 'x', messages: [] })
  /** Answers the first waiting question as soon as it appears. */
  const answerNext = async (answer: 'allow-once' | 'always' | 'deny'): Promise<void> => {
    for (let i = 0; i < 50; i++) {
      const ask = service.state().asks[0]
      if (ask) {
        service.respond(ask.id, answer)
        return
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('no question was asked')
  }
  return { fake, service, exec, answerNext, notes, sites: () => sites }
}

describe('agent browser tools', () => {
  it('read never asks', async () => {
    const { exec, service, fake } = setup()
    const text = await exec('browser_read', {})
    expect(text).toContain('[1] button "Compose"')
    expect(text).toContain('only the user types here')
    expect(service.state().asks).toHaveLength(0)
    expect(fake.actions.map((a) => a.op)).toEqual(['read'])
  })

  it('act on new site asks once then remembers always', async () => {
    const { exec, answerNext, sites, service } = setup()
    const click = exec('browser_click', { element: 1 })
    await answerNext('always')
    await click
    expect(sites()).toEqual(['mail.zoho.eu'])
    await exec('browser_click', { element: 1 })
    expect(service.state().asks).toHaveLength(0)
  })

  it('a denied site is not touched', async () => {
    const { exec, answerNext, fake } = setup()
    const click = exec('browser_click', { element: 1 })
    await answerNext('deny')
    await expect(click).rejects.toThrow(/said no/)
    expect(fake.actions.some((a) => a.op === 'click')).toBe(false)
  })

  it('send needs the user’s yes for work agents', async () => {
    const { exec, answerNext, fake, service } = setup({ sites: ['zoho.eu'] })
    const click = exec('browser_click', { element: 2 })
    await new Promise((r) => setTimeout(r, 20))
    expect(service.state().asks[0]?.kind).toBe('action')
    expect(service.state().asks[0]?.detail).toContain('Send')
    await answerNext('allow-once')
    await click
    expect(fake.actions.some((a) => a.op === 'click' && a.n === 2)).toBe(true)
  })

  it('duo send click refused without approved item', async () => {
    const { exec, fake } = setup({ sites: ['zoho.eu'], permit: () => null })
    await expect(exec('browser_click', { element: 2 })).rejects.toThrow(/Outbox/)
    expect(fake.actions.some((a) => a.op === 'click')).toBe(false)
  })

  it('duo send click allowed with an approved item for that site', async () => {
    const { exec, fake } = setup({ sites: ['zoho.eu'], permit: (domain) => (domain.endsWith('zoho.eu') ? { id: 'o1', summary: 'x' } : null) })
    await exec('browser_click', { element: 2 })
    expect(fake.actions.some((a) => a.op === 'click' && a.n === 2)).toBe(true)
  })

  it('linkedin send always refused', async () => {
    const { exec, fake } = setup({ sites: ['linkedin.com'], permit: () => ({ id: 'o1', summary: 'x' }) })
    fake.url = 'https://www.linkedin.com/messaging/thread/1'
    fake.pushState()
    await expect(exec('browser_click', { element: 2 })).rejects.toThrow(/only the user presses Send/)
    await expect(exec('browser_key', { key: 'Enter' })).rejects.toThrow(/only the user presses Send/)
    expect(fake.actions.some((a) => a.op === 'click' || a.op === 'key')).toBe(false)
  })

  it('linkedin refused when user away', async () => {
    const { exec, fake } = setup({ sites: ['linkedin.com'] })
    fake.idle = 900
    fake.pushState()
    await expect(exec('browser_open', { url: 'https://www.linkedin.com/feed', new_tab: false })).rejects.toThrow(/away/)
    expect(fake.actions).toHaveLength(0)
  })

  it('ctrl+enter counts as send and Enter submitting a Send form too', async () => {
    const { exec, fake } = setup({ sites: ['zoho.eu'], permit: () => null })
    await expect(exec('browser_key', { key: 'Ctrl+Enter' })).rejects.toThrow(/Outbox/)
    fake.enterTarget = 'Send'
    await expect(exec('browser_type', { element: 1, text: 'hi', submit: true })).rejects.toThrow(/Outbox/)
    expect(fake.actions.some((a) => a.op === 'key')).toBe(false)
  })

  it('password typing refused message passes through', async () => {
    const { exec } = setup({ sites: ['zoho.eu'] })
    await expect(exec('browser_type', { element: 3, text: 'secret', submit: false })).rejects.toThrow(/password/)
  })

  it('waits for the user to hand the browser back', async () => {
    const { exec, fake } = setup({ sites: ['zoho.eu'] })
    fake.userHasIt = true
    fake.pushState()
    const read = exec('browser_read', {})
    await new Promise((r) => setTimeout(r, 20))
    fake.userHasIt = false
    fake.pushState()
    expect(await read).toContain('Compose')
  })
})
