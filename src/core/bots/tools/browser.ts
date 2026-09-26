/**
 * The browser tool group: drives the bot PC's Chromium over CDP (see `cdp-client.ts`). Reading a
 * page returns extracted text rather than an image, which is the point — it keeps model usage low
 * (see the design spec, section 2 and 5.3). `screenshot` exists for when text truly isn't enough.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { CdpClient } from './cdp-client'
import type { SaveScreenshot } from './types'

function normalizeUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
}

/** Builds the browser tool set. `cdp` and `saveScreenshot` are fresh per run (see `runner.ts`). */
export function browserTools(cdp: CdpClient, saveScreenshot: SaveScreenshot) {
  /** The tab most recently opened or navigated by this run, used when a tool call omits tab_id. */
  let activeTargetId: string | null = null

  const resolveTarget = (tabId?: string): string => {
    const targetId = tabId ?? activeTargetId
    if (!targetId) throw new Error('No page is open yet. Call open_page first.')
    return targetId
  }

  return {
    open_page: tool({
      description:
        'Open a URL in the browser. By default this navigates the current tab (or opens the first one); set new_tab to open it in a new tab instead.',
      inputSchema: z.object({
        url: z.string().min(1),
        new_tab: z.boolean().default(false).describe('Open a new tab instead of reusing the current one')
      }),
      execute: async ({ url, new_tab }) => {
        const target =
          !new_tab && activeTargetId ? await cdp.navigate(activeTargetId, normalizeUrl(url)) : await cdp.newTab(normalizeUrl(url))
        activeTargetId = target.targetId
        return { tab_id: target.targetId, url: target.url, title: target.title }
      }
    }),

    read_page: tool({
      description:
        'Read the current page as text: its title, url, visible text and links. Prefer this over screenshot — it uses far less of your budget.',
      inputSchema: z.object({ tab_id: z.string().optional().describe('Defaults to the current tab') }),
      execute: async ({ tab_id }) => cdp.readPage(resolveTarget(tab_id))
    }),

    click: tool({
      description: 'Click one element on the current page, found by a CSS selector. Fails if the selector matches zero or more than one element.',
      inputSchema: z.object({
        selector: z.string().min(1),
        tab_id: z.string().optional().describe('Defaults to the current tab')
      }),
      execute: async ({ selector, tab_id }) => {
        await cdp.click(resolveTarget(tab_id), selector)
        return { clicked: selector }
      }
    }),

    type_text: tool({
      description:
        "Type text into one element on the current page, found by a CSS selector. Refuses password fields — if a site needs a login, stop and tell the user to open Take Over and sign in themselves.",
      inputSchema: z.object({
        selector: z.string().min(1),
        text: z.string(),
        tab_id: z.string().optional().describe('Defaults to the current tab')
      }),
      execute: async ({ selector, text, tab_id }) => {
        await cdp.typeText(resolveTarget(tab_id), selector, text)
        return { typed: selector }
      }
    }),

    screenshot: tool({
      description: 'Take a screenshot of the current page and save it to the run folder. Only use this when reading the page as text is not enough.',
      inputSchema: z.object({ tab_id: z.string().optional().describe('Defaults to the current tab') }),
      execute: async ({ tab_id }) => {
        const png = await cdp.screenshot(resolveTarget(tab_id))
        return saveScreenshot(png, 'browser')
      }
    }),

    tabs: tool({
      description: 'List the open browser tabs, or close one by its tab_id.',
      inputSchema: z.object({
        action: z.enum(['list', 'close']).default('list'),
        tab_id: z.string().optional().describe('Required for action "close"')
      }),
      execute: async ({ action, tab_id }) => {
        if (action === 'close') {
          if (!tab_id) throw new Error('tab_id is required to close a tab.')
          await cdp.closeTab(tab_id)
          if (activeTargetId === tab_id) activeTargetId = null
          return { closed: tab_id }
        }
        const targets = await cdp.listTargets()
        return { tabs: targets.map((t) => ({ tab_id: t.targetId, url: t.url, title: t.title })) }
      }
    })
  }
}
