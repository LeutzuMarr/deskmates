/**
 * The screen tool group: raw mouse/keyboard/screenshot control of the bot PC's whole desktop,
 * through the agent service's `/input` and `/screenshot` (see `agent-client.ts` and
 * `bot-image/agent.py`). This is the fallback for whatever isn't a web page — the browser tool's
 * DOM-scoped click/type is preferred whenever a page is open, since it also enforces the
 * never-type-passwords rule (see `cdp-client.ts`), which raw desktop input has no way to check.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { AgentClient } from './agent-client'
import type { SaveScreenshot } from './types'

/** Builds the screen tool set. `agent` and `saveScreenshot` are fresh per run (see `runner.ts`). */
export function screenTools(agent: AgentClient, saveScreenshot: SaveScreenshot) {
  return {
    screen_screenshot: tool({
      description:
        "Take a screenshot of the bot PC's whole desktop and save it to the run folder. Prefer the browser tool's own screenshot for web pages; use this one for anything outside the browser.",
      inputSchema: z.object({}),
      execute: async () => saveScreenshot(await agent.screenshot(), 'screen')
    }),

    screen_click: tool({
      description:
        "Click at a pixel position on the bot PC's desktop. This drives the whole desktop, not just a web page — prefer the browser tool's click when working inside one.",
      inputSchema: z.object({
        x: z.number().int(),
        y: z.number().int(),
        button: z.number().int().min(1).max(9).default(1),
        double: z.boolean().default(false)
      }),
      execute: async ({ x, y, button, double }) => {
        await agent.input({ action: double ? 'double_click' : 'click', x, y, button })
        return { clicked: { x, y } }
      }
    }),

    screen_type: tool({
      description:
        "Type text on the bot PC's desktop, into whatever currently has focus. Never use this for a password — if a site or app needs a login, stop and tell the user to open Take Over and sign in themselves.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        await agent.input({ action: 'type', text })
        return { typed: true }
      }
    }),

    screen_key: tool({
      description: 'Press a key or key combination on the bot PC, in xdotool syntax (for example "Return", "ctrl+a", "Escape").',
      inputSchema: z.object({ keys: z.string().min(1) }),
      execute: async ({ keys }) => {
        await agent.input({ action: 'key', keys })
        return { pressed: keys }
      }
    }),

    screen_scroll: tool({
      description: "Scroll the bot PC's desktop, optionally at a specific position.",
      inputSchema: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(50).default(3),
        x: z.number().int().optional(),
        y: z.number().int().optional()
      }),
      execute: async ({ direction, amount, x, y }) => {
        await agent.input({ action: 'scroll', direction, amount, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) })
        return { scrolled: direction }
      }
    })
  }
}
