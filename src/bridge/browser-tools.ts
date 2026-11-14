import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Call } from './actions'

/**
 * The agent browser for connected agents (Freebuff, OpenCode…). Each tool runs in the app through
 * `browser.tool`, with exactly the rules the app's own agents follow: asking before using a site,
 * asking before anything that sends, never typing passwords, and only the user pressing Send on LinkedIn.
 */
export function registerBrowserTools(server: McpServer, call: Call, agent?: string): void {
  const run = async (name: string, input: Record<string, unknown>): Promise<CallToolResult> => {
    try {
      const { text } = await call('browser.tool', { name, input, ...(agent ? { agent } : {}) })
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  }

  server.registerTool('browser_open', {
    description:
      "Opens a page in Deskmates' agent browser, which the user can watch and use from the browser button at the top right of Deskmates. Returns the page's text and its numbered buttons, links and fields. Sign-ins there are the user's: never type passwords or codes.",
    inputSchema: { url: z.string().describe('The address to open.'), new_tab: z.boolean().optional().describe('Open in a new tab.') }
  }, (args) => run('browser_open', args))

  server.registerTool('browser_read', {
    description: 'Reads the current page again: its text and numbered elements. Do it after the page changes, before clicking by number.',
    inputSchema: {}
  }, () => run('browser_read', {}))

  server.registerTool('browser_click', {
    description:
      'Clicks a numbered element. The first click or typing on a site asks the user; anything that sends, posts, pays, signs or deletes needs their yes (Duo: an approved Outbox item); on LinkedIn only the user presses Send.',
    inputSchema: { element: z.number().int().positive().describe('The element number.') }
  }, (args) => run('browser_click', args))

  server.registerTool('browser_type', {
    description: 'Types into a numbered text field, replacing its text. Password, code, card and ID fields are refused: the user types those.',
    inputSchema: {
      element: z.number().int().positive(),
      text: z.string(),
      submit: z.boolean().optional().describe('Press Enter afterwards.')
    }
  }, (args) => run('browser_type', args))

  server.registerTool('browser_key', {
    description: 'Presses a key in the page: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, Home, End, or a combination like Ctrl+A.',
    inputSchema: { key: z.string() }
  }, (args) => run('browser_key', args))

  server.registerTool('browser_scroll', {
    description: 'Scrolls the page (down, up, top or bottom) and reads what is in view.',
    inputSchema: { direction: z.enum(['down', 'up', 'top', 'bottom']).optional() }
  }, (args) => run('browser_scroll', args))

  server.registerTool('browser_back', {
    description: 'Goes back to the previous page.',
    inputSchema: {}
  }, () => run('browser_back', {}))

  server.registerTool('browser_tabs', {
    description: 'Lists, switches or closes the agent browser’s tabs.',
    inputSchema: { action: z.enum(['list', 'switch', 'close']).optional(), tab_id: z.string().optional() }
  }, (args) => run('browser_tabs', args))

  server.registerTool('browser_wait', {
    description: 'Waits a few seconds for a slow page, then reads it.',
    inputSchema: { seconds: z.number().min(1).max(30).optional() }
  }, (args) => run('browser_wait', args))
}
