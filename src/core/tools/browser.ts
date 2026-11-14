/**
 * The agent browser tools every assistant gets (Work, Design, Duo, scheduled runs). The browser is
 * the one the user sees in the title bar's browser panel; see `core/browser/service.ts`.
 *
 * The rules that keep the user safe are applied here, not left to the model:
 * - opening and reading pages never asks; clicking and typing on a site asks once per site;
 * - clicking anything that sends, posts, pays, signs or deletes asks the user first (Duo instead
 *   needs an approved Outbox item for that site);
 * - nothing ever presses Send or Connect on LinkedIn, and LinkedIn isn't touched while the user is away;
 * - password, code, card and ID fields are refused by the browser itself.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { BrowserAction, BrowserPage, BrowserResult } from '../../shared/agent-browser'
import { AWAY_AFTER_SECONDS, domainOf, isLinkedIn, isSendControl } from '../../shared/agent-browser'
import type { BrowserService } from '../browser/service'

/** How long a run waits for the user to answer "may I use this site?" before moving on. */
const ASK_TIMEOUT_MS = 10 * 60_000
/** How long a run waits for the user to hand the browser back. */
const USER_CONTROL_WAIT_MS = 5 * 60_000
const MAX_TOOL_TEXT = 15_000

export interface BrowserToolDeps {
  browser: BrowserService
  /** Who is acting, as the user will read it: "Work", "Design", "Duo", or a scheduled task's name. */
  agent: string
  /** Keys "Allow once" answers to this run. */
  runKey: string
  /** Duo only: the approved Outbox item that may be sent on `domain` right now, if any. */
  sendPermit?: (domain: string) => { id: string; summary: string } | null
  /** Where screenshots are saved (a folder the agent can read). */
  screenshotDir?: string
  signal?: AbortSignal
}

const LINKEDIN_AWAY =
  "LinkedIn isn't used while the user is away from the PC: its rules forbid automated use. Leave LinkedIn items in the Outbox; the user finishes them at the PC."
const LINKEDIN_SEND =
  "On LinkedIn only the user presses Send or Connect. The message is filled in: tell the user it's ready in the browser panel."

/** The page as compact text for a model: the visible text, then the numbered elements. */
export function formatPage(page: BrowserPage, note?: string): string {
  const lines = [`Page: ${page.title || '(no title)'} | ${page.url} | tab ${page.tabId}`]
  if (note) lines.push(`Note: ${note}`)
  if (page.signIn) {
    lines.push('This is a sign-in page. Never type passwords or codes: ask the user to sign in in the browser panel (the browser button at the top right), then continue.')
  }
  const text = page.text.length > MAX_TOOL_TEXT ? `${page.text.slice(0, MAX_TOOL_TEXT)}\n…(cut; scroll or read again for more)` : page.text
  lines.push('', 'Text:', text || '(none)', '', 'Elements (use the number with browser_click / browser_type):')
  for (const el of page.elements) {
    const value = el.value !== undefined ? ` = "${el.value}"` : ''
    const guard = el.sensitive ? ' (password/code field: only the user types here)' : ''
    lines.push(`[${el.n}] ${el.role} "${el.name}"${value}${guard}`)
  }
  if (page.truncated) lines.push('(The page has more; scroll to see it.)')
  return lines.join('\n')
}

export function agentBrowserTools(deps: BrowserToolDeps) {
  const { browser } = deps

  const away = (): boolean => browser.idleSeconds() >= AWAY_AFTER_SECONDS
  const currentUrl = (): string => browser.state().tabs.find((t) => t.active)?.url ?? ''

  /** Runs an action, waiting for the user to hand the browser back if they're using it. */
  const run = async (action: BrowserAction): Promise<BrowserResult> => {
    const first = await browser.act(action)
    if (first.ok || !first.userControl) return first
    const back = await browser.waitForAgentControl(USER_CONTROL_WAIT_MS, deps.signal)
    if (!back) return { ok: false, error: 'The user is using the browser. Wait for them, or continue with something else and try again later.' }
    return browser.act(action)
  }

  const show = (result: BrowserResult): string => {
    if (!result.ok) throw new Error(result.error)
    if (result.page) return formatPage(result.page, result.note)
    if (result.tabs) return result.tabs.map((t) => `${t.active ? '*' : ' '} ${t.tabId}  ${t.title || '(no title)'}  ${t.url}`).join('\n') || 'No tabs are open.'
    return result.note ?? 'Done.'
  }

  /** Site permission for clicking and typing: asks once per site, remembered as the user chooses. */
  const ensureSite = async (domain: string): Promise<void> => {
    if (!domain || browser.isAllowed(domain, deps.runKey)) return
    const answer = await browser.ask({ kind: 'site', domain, detail: `use ${domain}`, agent: deps.agent, runKey: deps.runKey }, ASK_TIMEOUT_MS, deps.signal)
    if (answer === 'deny') throw new Error(`The user said no to using ${domain}. Don't use this site; tell them what you would have done there.`)
    if (answer === 'timeout') throw new Error(`The user hasn't answered whether you may use ${domain}. Skip it for now and carry on with the rest.`)
  }

  /** A click or Enter that would send, post, pay, sign or delete: LinkedIn never, Duo with a permit, others ask. */
  const ensureSend = async (label: string, url: string): Promise<void> => {
    const domain = domainOf(url)
    if (isLinkedIn(url)) throw new Error(LINKEDIN_SEND)
    if (deps.sendPermit) {
      const permit = deps.sendPermit(domain)
      if (!permit) {
        throw new Error(`“${label}” would send something on ${domain}, and nothing approved is waiting to be sent there. Put it in the Outbox for the user to approve first.`)
      }
      return
    }
    const answer = await browser.ask(
      { kind: 'action', domain, detail: `click “${label}” on ${domain}`, agent: deps.agent, runKey: deps.runKey },
      ASK_TIMEOUT_MS,
      deps.signal
    )
    if (answer !== 'allow-once' && answer !== 'always') {
      throw new Error(answer === 'deny' ? `The user said no to “${label}”. Don't do it.` : `The user hasn't answered about “${label}”. Leave it undone and tell them.`)
    }
  }

  const guardLinkedIn = (url: string): void => {
    if (isLinkedIn(url) && away()) throw new Error(LINKEDIN_AWAY)
  }

  /**
   * Before a key with Enter in it. On LinkedIn, Enter in a message box sends it, so it's never pressed
   * there. Ctrl/Cmd+Enter sends mail in most webmail, so it counts as Send. A plain Enter that would
   * submit a form through a sending button counts as clicking that button.
   */
  const guardEnter = async (key = 'Enter'): Promise<void> => {
    const url = currentUrl()
    if (isLinkedIn(url)) throw new Error(LINKEDIN_SEND)
    if (/(ctrl|control|cmd|meta)\s*\+\s*(enter|return)/i.test(key)) {
      await ensureSend(key, url)
      return
    }
    const target = await browser.act({ op: 'enter-target', agent: deps.agent })
    if (target.ok && target.name && isSendControl(target.name)) await ensureSend(target.name, target.url ?? url)
  }

  const agent = deps.agent

  return {
    browser_open: tool({
      description:
        "Open a web page in the agent browser (the one the user can watch from the browser button at Deskmates' top right). Returns the page's text and its numbered buttons, links and fields. Use it for sites that need the user's sign-in or clicking around; for plain reading, web_search/web_fetch are cheaper.",
      inputSchema: z.object({
        url: z.string().min(1).describe('The address, like https://mail.zoho.eu'),
        new_tab: z.boolean().default(false).describe('Open in a new tab instead of the current one')
      }),
      execute: async ({ url, new_tab }) => {
        guardLinkedIn(/^https?:/i.test(url) ? url : `https://${url}`)
        return show(await run({ op: 'open', url, newTab: new_tab, agent }))
      }
    }),

    browser_read: tool({
      description: 'Read the current page again: its text and numbered elements. Do this after anything changes the page, before clicking by number.',
      inputSchema: z.object({}),
      execute: async () => {
        guardLinkedIn(currentUrl())
        return show(await run({ op: 'read', agent }))
      }
    }),

    browser_click: tool({
      description:
        'Click a numbered element from the last browser_read/browser_open. The first click or typing on a site asks the user for permission. Anything that sends, posts, pays, signs or deletes needs the user’s yes, and on LinkedIn only the user presses Send.',
      inputSchema: z.object({ element: z.number().int().positive().describe('The element number, like 12') }),
      execute: async ({ element }) => {
        const info = await run({ op: 'inspect', n: element, agent })
        if (!info.ok) throw new Error(info.error)
        if (info.name === null || info.name === undefined) throw new Error(`Element ${element} isn't on the page any more. Read the page again.`)
        const url = info.url ?? currentUrl()
        guardLinkedIn(url)
        await ensureSite(domainOf(url))
        if (isSendControl(info.name)) await ensureSend(info.name, url)
        return show(await run({ op: 'click', n: element, agent }))
      }
    }),

    browser_type: tool({
      description:
        'Type into a numbered text field, replacing what is in it. Refuses password, code, card and ID fields: the user types those in the browser panel. Set submit to press Enter afterwards.',
      inputSchema: z.object({
        element: z.number().int().positive(),
        text: z.string(),
        submit: z.boolean().default(false).describe('Press Enter after typing')
      }),
      execute: async ({ element, text, submit }) => {
        const url = currentUrl()
        guardLinkedIn(url)
        await ensureSite(domainOf(url))
        const typed = await run({ op: 'type', n: element, text, submit: false, agent })
        if (!submit || !typed.ok) return show(typed)
        await guardEnter()
        return show(await run({ op: 'key', key: 'Enter', agent }))
      }
    }),

    browser_key: tool({
      description: 'Press a key in the page: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, Home, End, Space, or a combination like Ctrl+A.',
      inputSchema: z.object({ key: z.string().min(1) }),
      execute: async ({ key }) => {
        const url = currentUrl()
        guardLinkedIn(url)
        await ensureSite(domainOf(url))
        if (/(^|\+)\s*(enter|return)\s*$/i.test(key.trim())) await guardEnter(key)
        return show(await run({ op: 'key', key, agent }))
      }
    }),

    browser_scroll: tool({
      description: 'Scroll the page and read what is now in view.',
      inputSchema: z.object({ direction: z.enum(['down', 'up', 'top', 'bottom']).default('down') }),
      execute: async ({ direction }) => {
        guardLinkedIn(currentUrl())
        return show(await run({ op: 'scroll', direction, agent }))
      }
    }),

    browser_back: tool({
      description: 'Go back to the previous page in the current tab.',
      inputSchema: z.object({}),
      execute: async () => show(await run({ op: 'back', agent }))
    }),

    browser_tabs: tool({
      description: 'List the agent browser’s tabs, switch to one, or close one.',
      inputSchema: z.object({
        action: z.enum(['list', 'switch', 'close']).default('list'),
        tab_id: z.string().optional().describe('Needed for switch and close')
      }),
      execute: async ({ action, tab_id }) => {
        if (action === 'list') return show(await run({ op: 'tabs', agent }))
        if (!tab_id) throw new Error('tab_id is needed to switch or close a tab.')
        return show(await run(action === 'switch' ? { op: 'switch', tabId: tab_id, agent } : { op: 'close', tabId: tab_id, agent }))
      }
    }),

    browser_screenshot: tool({
      description: 'Save a picture of the current page and return its path. Only when the text from browser_read is not enough (a chart, a layout).',
      inputSchema: z.object({}),
      execute: async () => {
        const result = await run({ op: 'screenshot', agent })
        if (!result.ok) throw new Error(result.error)
        if (!result.png) throw new Error('The browser returned no picture.')
        const dir = deps.screenshotDir
        if (!dir) return 'The picture was taken, but there is no folder to save it in.'
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `browser-${Date.now()}.png`)
        writeFileSync(file, Buffer.from(result.png, 'base64'))
        return `Saved the page picture to ${file}.`
      }
    }),

    browser_wait: tool({
      description: 'Wait a few seconds for a slow page, then read it.',
      inputSchema: z.object({ seconds: z.number().min(1).max(30).default(3) }),
      execute: async ({ seconds }) => {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
        guardLinkedIn(currentUrl())
        return show(await run({ op: 'read', agent }))
      }
    })
  }
}
