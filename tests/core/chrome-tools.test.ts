import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { z } from 'zod'
import type { SiteAnswer } from '../../src/shared/agent-browser'
import type { ChromeDriver, ChromeTab, ConsoleEntry, NetworkEntry } from '../../src/core/chrome/service'
import { keyDef, modifierBits } from '../../src/core/chrome/service'
import { candidateEndpoints, parseActivePort } from '../../src/core/chrome/discover'
import { ENTER_TARGET_SCRIPT, findScript, FOCUSED_FIELD_SCRIPT, formInputScript, pageTextScript, readPageScript } from '../../src/core/chrome/page-scripts'
import { CHROME_TOOL_NAMES, chromeToolInfos, chromeTools, forgetChromeRun, isOffLimits, scriptTouchesSecrets, siteOf, type ChromeAsker } from '../../src/core/tools/chrome'
import { pickPromptTools, promptToolInfos } from '../../src/core/tools/shared-prompt-tools'
import { jsonSchemaToZod } from '../../src/core/connectors/schema'
import { stepWords } from '../../src/renderer/src/lib/steps'

type Field = { name: string; role: string; field: { inputType?: string; name?: string; label?: string } }

/** A pretend Chrome: tabs, and canned answers to the page scripts the tools run. */
class FakeChrome implements ChromeDriver {
  list: ChromeTab[] = [{ tabId: 1, title: 'My bank', url: 'https://bank.example/accounts', deskmates: false }]
  next = 2
  clicks: Array<{ tabId: number; x: number; y: number }> = []
  typed: string[] = []
  keys: string[] = []
  scripts: string[] = []
  fields: Record<string, Field> = {
    ref_1: { name: 'Compose', role: 'button', field: {} },
    ref_2: { name: 'Send', role: 'button', field: {} },
    ref_3: { name: 'Password', role: 'textbox', field: { inputType: 'password', name: 'password' } },
    ref_4: { name: 'Subject', role: 'textbox', field: { inputType: 'text', name: 'subject' } }
  }
  focused: Field['field'] | null = null
  enterTarget: string | null = null

  async tabs() {
    return { deskmates: this.list.filter((t) => t.deskmates), user: this.list.filter((t) => !t.deskmates) }
  }
  async tab(tabId: number) {
    const tab = this.list.find((t) => t.tabId === tabId)
    if (!tab) throw new Error(`There is no tab ${tabId}.`)
    return { ...tab }
  }
  async createTab(url = 'about:blank') {
    const tab = { tabId: this.next++, title: url, url, deskmates: true }
    this.list.push(tab)
    return { ...tab }
  }
  async closeTab(tabId: number) {
    this.list = this.list.filter((t) => t.tabId !== tabId)
  }
  async navigate(tabId: number, url: string) {
    const tab = this.list.find((t) => t.tabId === tabId)!
    tab.url = url
    tab.title = url
    return { ...tab }
  }
  async history(tabId: number) {
    return this.tab(tabId)
  }
  async evaluate<T>(_tabId: number, expression: string): Promise<T> {
    const ref = /byRef\("(ref_\d+)"\)/.exec(expression)?.[1]
    if (expression === FOCUSED_FIELD_SCRIPT) return this.focused as T
    if (expression === ENTER_TARGET_SCRIPT) return this.enterTarget as T
    if (expression.includes('opts.filter')) return { url: 'x', title: 'Page', tree: Object.entries(this.fields).map(([r, f]) => `- ${f.role} "${f.name}" [${r}]`).join('\n'), truncated: false } as T
    if (expression.includes('inline: \'center\'')) {
      const f = ref ? this.fields[ref] : undefined
      return (f ? { x: 10, y: 20, name: f.name, role: f.role, field: f.field, url: '' } : { error: 'gone' }) as T
    }
    if (expression.includes('return { field: fieldInfo(el), tag')) {
      const f = ref ? this.fields[ref] : undefined
      return (f ? { field: f.field, name: f.name, role: f.role, tag: 'input', url: 'u' } : { error: 'gone' }) as T
    }
    if (expression.includes('const fire =')) return { ok: true, set: 'value' } as T
    if (expression.includes('const words =')) return { url: '', matches: ['button "Send" [ref_2]'], total: 1 } as T
    if (expression.includes('elementFromPoint')) return { name: '', role: 'generic', url: '' } as T
    this.scripts.push(expression)
    return 'script result' as T
  }
  async click(tabId: number, x: number, y: number) {
    this.clicks.push({ tabId, x, y })
  }
  async move() {}
  async drag() {}
  async wheel() {}
  async insertText(_tabId: number, text: string) {
    this.typed.push(text)
  }
  async key(_tabId: number, key: string) {
    this.keys.push(key)
  }
  async screenshot() {
    return { data: Buffer.from('jpg').toString('base64'), width: 800, height: 600 }
  }
  consoleMessages(): ConsoleEntry[] {
    return [
      { level: 'log', text: 'ready', at: 1 },
      { level: 'error', text: 'boom', at: 2 }
    ]
  }
  clearConsole() {}
  networkRequests(): NetworkEntry[] {
    return [{ requestId: '7.1', method: 'GET', url: 'https://mail.example/api/inbox', status: 200, type: 'Fetch', at: 1 }]
  }
  clearNetwork() {}
  async responseBody() {
    return '{"unread":3}'
  }
}

/** Answers questions as told, and remembers "Allow once" for the run, as BrowserService does. */
class FakeAsker implements ChromeAsker {
  asks: Array<{ kind: string; domain: string; detail: string }> = []
  answer: SiteAnswer | 'timeout' = 'allow-once'
  idle = 0
  private allowed = new Set<string>()
  async ask(input: { kind: 'site' | 'action'; domain: string; detail: string }) {
    this.asks.push({ kind: input.kind, domain: input.domain, detail: input.detail })
    if (input.kind === 'site' && (this.answer === 'allow-once' || this.answer === 'always')) this.allowed.add(input.domain)
    return this.answer
  }
  isAllowed(domain: string) {
    return this.allowed.has(domain)
  }
  idleSeconds() {
    return this.idle
  }
}

const RUN = 'test-run'
const setup = () => {
  const chrome = new FakeChrome()
  const asker = new FakeAsker()
  const tools = chromeTools({ chrome, asker, agent: 'Work', runKey: RUN }) as Record<string, { execute: (input: unknown, options: unknown) => Promise<string> }>
  const call = (name: string, input: unknown = {}) => tools[name]!.execute(input, { toolCallId: 't', messages: [] })
  return { chrome, asker, call }
}

afterEach(() => forgetChromeRun(RUN))

describe('Chrome tools', () => {
  it('lists Deskmates tabs, opens one when asked, and only mentions the user’s own tabs', async () => {
    const { chrome, call } = setup()
    const first = await call('tabs_context')
    expect(first).toContain('No Deskmates tabs')
    expect(first).toContain('1 tab of their own')
    expect(first).not.toContain('bank.example')
    const created = await call('tabs_context', { createIfEmpty: true, includeUserTabs: true })
    expect(created).toContain('Tab 2')
    expect(created).toContain('bank.example')
    expect(chrome.list.filter((t) => t.deskmates)).toHaveLength(1)
  })

  it('opens and reads pages an agent opened without asking, and keeps away from Chrome’s own pages', async () => {
    const { asker, call } = setup()
    expect(await call('navigate', { url: 'mail.example' })).toContain('https://mail.example')
    expect(await call('read_page', {})).toContain('button "Send" [ref_2]')
    expect(await call('find', { query: 'send' })).toBeTruthy()
    expect(asker.asks).toEqual([])
    await expect(call('navigate', { url: 'chrome://settings' })).rejects.toThrow(/off limits/)
    await expect(call('tabs_create', { url: 'javascript:alert(1)' })).rejects.toThrow(/off limits/)
  })

  it('asks once per site before clicking, and every time before something that sends', async () => {
    const { chrome, asker, call } = setup()
    await call('navigate', { url: 'https://mail.example/inbox' })
    await call('computer', { action: 'left_click', ref: 'ref_1' })
    await call('computer', { action: 'left_click', ref: 'ref_1' })
    expect(asker.asks).toEqual([{ kind: 'site', domain: 'mail.example', detail: 'use mail.example in your Chrome' }])
    await call('computer', { action: 'left_click', ref: 'ref_2' })
    expect(asker.asks[1]).toMatchObject({ kind: 'action', detail: 'click “Send” on mail.example in your Chrome' })
    expect(chrome.clicks).toHaveLength(3)
    asker.answer = 'deny'
    await expect(call('computer', { action: 'left_click', ref: 'ref_2' })).rejects.toThrow(/said no/)
    expect(chrome.clicks).toHaveLength(3)
  })

  it('never types or fills passwords and codes', async () => {
    const { chrome, call } = setup()
    await call('navigate', { url: 'https://mail.example' })
    chrome.focused = { inputType: 'password', name: 'password' }
    await expect(call('computer', { action: 'type', text: 'hunter2' })).rejects.toThrow(/Only the user types there/)
    await expect(call('form_input', { ref: 'ref_3', value: 'hunter2' })).rejects.toThrow(/Only the user types there/)
    expect(chrome.typed).toEqual([])
    chrome.focused = { inputType: 'text', name: 'subject' }
    await call('computer', { action: 'type', text: 'Hello' })
    expect(await call('form_input', { ref: 'ref_4', value: 'Hi' })).toContain('Subject')
    expect(chrome.typed).toEqual(['Hello'])
    await expect(call('javascript_tool', { action: 'javascript_exec', text: 'document.querySelector("#password").value = "x"' })).rejects.toThrow(/passwords/)
  })

  it('treats Enter that submits through a Send button, and Ctrl+Enter, as sending', async () => {
    const { chrome, asker, call } = setup()
    await call('navigate', { url: 'https://mail.example' })
    chrome.enterTarget = 'Send message'
    await call('computer', { action: 'key', text: 'Enter' })
    expect(asker.asks.map((a) => a.kind)).toEqual(['site', 'action'])
    chrome.enterTarget = null
    await call('computer', { action: 'key', text: 'ctrl+Enter' })
    expect(asker.asks.map((a) => a.kind)).toEqual(['site', 'action', 'action'])
    expect(chrome.keys).toEqual(['Enter', 'ctrl+Enter'])
  })

  it('asks before touching the user’s own tabs, even to read them', async () => {
    const { asker, call } = setup()
    await call('read_page', { tabId: 1 })
    expect(asker.asks[0]).toMatchObject({ kind: 'site', domain: 'bank.example' })
    asker.answer = 'deny'
    forgetChromeRun(RUN)
    const fresh = setup()
    fresh.asker.answer = 'deny'
    await expect(fresh.call('get_page_text', { tabId: 1 })).rejects.toThrow(/said no/)
    await expect(fresh.call('tabs_close', { tabId: 1 })).rejects.toThrow(/user's own tabs/)
  })

  it('asks once per site before running scripts', async () => {
    const { chrome, asker, call } = setup()
    await call('navigate', { url: 'https://mail.example' })
    expect(await call('javascript_tool', { text: 'document.title' })).toBe('script result')
    expect(await call('javascript_tool', { text: '1 + 1' })).toBe('script result')
    expect(asker.asks.filter((a) => a.kind === 'action')).toHaveLength(1)
    expect(chrome.scripts).toEqual(['document.title', '1 + 1'])
  })

  it('keeps LinkedIn’s rules: nothing presses Send, and nothing runs while the user is away', async () => {
    const { chrome, asker, call } = setup()
    await call('navigate', { url: 'https://www.linkedin.com/messaging' })
    await expect(call('computer', { action: 'left_click', ref: 'ref_2' })).rejects.toThrow(/only the user presses Send/)
    expect(chrome.clicks).toEqual([])
    asker.idle = 3600
    await expect(call('read_page', {})).rejects.toThrow(/away/)
  })

  it('reads the console and network requests, and saves screenshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrome-shots-'))
    const chrome = new FakeChrome()
    const tools = chromeTools({ chrome, asker: new FakeAsker(), agent: 'Work', runKey: RUN, screenshotDir: dir }) as Record<string, { execute: (i: unknown, o: unknown) => Promise<string> }>
    const call = (name: string, input: unknown = {}) => tools[name]!.execute(input, {})
    await call('navigate', { url: 'https://mail.example' })
    expect(await call('read_console_messages', { onlyErrors: true })).toBe('[error] boom')
    expect(await call('read_network_requests', { urlPattern: 'inbox' })).toContain('GET 200 https://mail.example/api/inbox')
    expect(await call('read_network_requests', { requestId: '7.1' })).toBe('{"unread":3}')
    expect(await call('computer', { action: 'screenshot' })).toMatch(/800×600.*Saved to .*chrome-\d+\.jpg/)
  })
})

describe('Chrome tools for command-line agents', () => {
  it('are listed by deskmates-prompt with schemas the bridge can read', () => {
    const infos = chromeToolInfos()
    expect(infos.map((i) => i.name)).toEqual([...CHROME_TOOL_NAMES])
    const listed = promptToolInfos().map((i) => i.name)
    for (const name of CHROME_TOOL_NAMES) expect(listed).toContain(name)
    const computer = jsonSchemaToZod(infos.find((i) => i.name === 'computer')!.inputSchema) as z.ZodTypeAny
    expect(computer.safeParse({ action: 'left_click', coordinate: [10, 20] }).success).toBe(true)
    expect(computer.safeParse({ action: 'fly' }).success).toBe(false)
  })

  it('are kept when a bridged run picks the prompt’s tools', () => {
    const { chrome, asker } = setup()
    const picked = pickPromptTools({ ...chromeTools({ chrome, asker, agent: 'Freebuff', runKey: RUN }), not_a_prompt_tool: {} as never })
    expect(Object.keys(picked).sort()).toEqual([...CHROME_TOOL_NAMES].sort())
  })

  it('apply defaults to bridged calls, which skip the SDK’s own parsing', async () => {
    const { call } = setup()
    await call('navigate', { url: 'https://mail.example' })
    // No filter, depth or max_chars given: the defaults fill them in.
    expect(await call('read_page', {})).toContain('[ref_1]')
  })
})

describe('Chrome connection', () => {
  it('reads DevToolsActivePort and prefers a set address', () => {
    expect(parseActivePort('9333\n/devtools/browser/abc\n')).toBe('ws://127.0.0.1:9333/devtools/browser/abc')
    expect(parseActivePort('nope')).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'chrome-profile-'))
    writeFileSync(join(dir, 'DevToolsActivePort'), '9444\r\n/devtools/browser/xyz')
    const found = candidateEndpoints({ env: { DESKMATES_CHROME_URL: 'http://127.0.0.1:9000/' }, dirs: [dir, join(dir, 'missing')] })
    expect(found).toEqual([
      { http: 'http://127.0.0.1:9000', source: 'setting' },
      { url: 'ws://127.0.0.1:9444/devtools/browser/xyz', source: 'profile', profile: dir },
      { http: 'http://127.0.0.1:9222', source: 'port' }
    ])
  })

  it('turns key names and modifiers into DevTools input', () => {
    expect(modifierBits('ctrl+shift')).toBe(10)
    expect(keyDef('Enter')).toMatchObject({ key: 'Enter', keyCode: 13, text: '\r' })
    expect(keyDef('a')).toMatchObject({ code: 'KeyA', keyCode: 65 })
    expect(keyDef('F5')).toMatchObject({ key: 'F5', keyCode: 116 })
    expect(keyDef('NotAKey')).toBeNull()
  })

  it('knows sites, Chrome’s own pages and scripts that touch secrets', () => {
    expect(siteOf('https://www.github.com/x')).toBe('github.com')
    expect(siteOf('about:blank')).toBe('')
    expect(isOffLimits('chrome://settings/passwords')).toBe(true)
    expect(isOffLimits('about:blank')).toBe(false)
    expect(isOffLimits('https://example.com')).toBe(false)
    expect(scriptTouchesSecrets('document.title')).toBe(false)
    expect(scriptTouchesSecrets("document.querySelector('[name=otp]').value = '123'")).toBe(true)
  })
})

describe('Chrome page scripts', () => {
  const page = () => {
    const window = new Window({ url: 'https://shop.example/cart' })
    window.document.body.innerHTML = `
      <main><h1>Your cart</h1><p>Two items</p>
      <button id="buy">Place order</button>
      <label for="q">Quantity</label><input id="q" name="qty" value="1">
      <input type="password" name="password">
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <label><input type="checkbox" id="gift"> Gift wrap</label>
      <a href="/help">Help</a><div style="display:none"><button>Hidden</button></div></main>`
    // happy-dom lays nothing out: give every element a size so it counts as visible.
    ;(window as unknown as { Element: { prototype: { getBoundingClientRect: () => unknown } } }).Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0 })
    const run = <T>(script: string): T => (window as unknown as { eval: (s: string) => T }).eval(script)
    return { window, run }
  }

  it('reads the page as a tree with refs, hiding what is hidden', () => {
    const { run } = page()
    const result = run<{ tree: string }>(readPageScript({ filter: 'all', depth: 15, maxChars: 50_000 }))
    expect(result.tree).toContain('heading "Your cart" [ref_')
    expect(result.tree).toContain('button "Place order" [ref_')
    expect(result.tree).toContain('textbox "Quantity" [ref_')
    expect(result.tree).toContain('(password: only the user types here)')
    expect(result.tree).toContain('link "Help" [ref_')
    expect(result.tree).not.toContain('Hidden')
    const interactive = run<{ tree: string }>(readPageScript({ filter: 'interactive', depth: 15, maxChars: 50_000 }))
    expect(interactive.tree).not.toContain('heading')
  })

  it('keeps refs stable, finds elements and fills fields', () => {
    const { window, run } = page()
    const tree = run<{ tree: string }>(readPageScript({ filter: 'interactive', depth: 15, maxChars: 50_000 })).tree
    const refFor = (text: string) => /\[(ref_\d+)\]/.exec(tree.split('\n').find((l) => l.includes(text))!)![1]!
    const found = run<{ matches: string[] }>(findScript('place order'))
    expect(found.matches[0]).toContain(`[${refFor('Place order')}]`)
    expect(run<{ ok?: boolean }>(formInputScript(refFor('Quantity'), '3')).ok).toBe(true)
    expect((window.document.getElementById('q') as unknown as { value: string }).value).toBe('3')
    expect(run<{ set?: string }>(formInputScript(refFor('combobox'), 'Large')).set).toBe('Large')
    run(formInputScript(refFor('Gift wrap'), true))
    expect((window.document.getElementById('gift') as unknown as { checked: boolean }).checked).toBe(true)
    expect(run<{ error?: string }>(formInputScript('ref_999', 'x')).error).toMatch(/Read the page again/)
    expect(run<{ text: string }>(pageTextScript(1000)).text).toContain('Your cart')
  })
})

describe('Chrome step labels', () => {
  it('say what each Chrome step does, with or without the server’s prefix', () => {
    expect(stepWords('tabs_context', {}).live).toBe('Checking the Chrome tabs')
    expect(stepWords('navigate', { url: 'https://www.github.com/pulls' }).done).toBe('Opened github.com/pulls')
    expect(stepWords('navigate', { url: 'back' }).live).toBe('Going back')
    expect(stepWords('computer', { action: 'left_click', ref: 'ref_3' }).live).toBe('Clicking on the page')
    expect(stepWords('computer', { action: 'key', text: 'Enter' }).done).toBe('Pressed Enter')
    expect(stepWords('computer', { action: 'screenshot' }).live).toBe('Taking a screenshot')
    expect(stepWords('find', { query: 'search box' }).live).toBe('Looking for "search box" on the page')
    expect(stepWords('form_input', { ref: 'ref_1', value: 'x' }).done).toBe('Filled in a field')
    expect(stepWords('javascript_tool', { text: '1' }).done).toBe('Ran a script on the page')
    expect(stepWords('read_console_messages', {}).live).toBe('Checking the console')
    expect(stepWords('read_network_requests', {}).done).toBe('Checked network requests')
    expect(stepWords('deskmates-prompt_get_page_text', {}).live).toBe('Reading the page')
    expect(stepWords('mcp__deskmates-prompt__tabs_create', { url: 'https://example.com' }).done).toBe('Opened example.com in Chrome')
  })
})
