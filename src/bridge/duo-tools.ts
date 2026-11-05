import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Call } from './actions'

/** Duo's tools for its own Freebuff (the MCP server started from Duo's workspace, as agent "Duo"). */
export function registerDuoTools(server: McpServer, call: Call): void {
  const run = async (name: string, input: Record<string, unknown>): Promise<CallToolResult> => {
    try {
      const { text } = await call('duo.tool', { name, input })
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  }
  const reg = (name: string, description: string, inputSchema: Record<string, z.ZodType>): void => {
    server.registerTool(name, { description, inputSchema }, (args: Record<string, unknown>) => run(name, args))
  }

  reg('duo_profile', "The user's details (name, school, company, email, webmail, LinkedIn) and your limits.", {})
  reg('duo_playbook', "The user's outreach playbook.", {})
  reg(
    'duo_outbox_add',
    'Put a drafted email, follow-up or LinkedIn message in the Outbox for the user to approve. Nothing is sent. Refused with the reason over the limits, for a company already pitched, on the never-contact list, or with an address not on the company’s own domain.',
    {
      kind: z.enum(['email', 'followup', 'linkedin', 'reply', 'other']),
      company: z.string(),
      domain: z.string().describe('The company website, like hotelroma.it'),
      to: z.string().describe('Their published email address, or the LinkedIn profile URL'),
      source: z.string().optional().describe('Where you found the address'),
      subject: z.string().optional(),
      body: z.string().describe('The exact text, signature included'),
      follow_up_no: z.number().int().optional().describe('For followup: 2, 3 or 4'),
      note: z.string().optional().describe('One line for the user')
    }
  )
  reg('duo_outbox_list', 'The Outbox items, newest first.', { status: z.enum(['pending', 'approved', 'sent', 'skipped', 'failed', 'with-user', 'all']).optional() })
  reg('duo_send_next', 'The next approved item to send, with its exact text.', {})
  reg('duo_mark_sent', 'Mark an approved item sent, after it shows in Sent.', { id: z.string() })
  reg('duo_mark_failed', 'An approved item could not be sent.', { id: z.string(), reason: z.string() })
  reg('duo_mark_with_user', 'A LinkedIn message is filled in and waits for the user to press Send.', { id: z.string() })
  reg('duo_record', 'Record a reply, a bounce, or an email sent before Duo (history).', {
    company: z.string(),
    domain: z.string(),
    kind: z.enum(['reply-received', 'bounce', 'first', 'followup']),
    date: z.string().optional().describe('YYYY-MM-DD')
  })
  reg('duo_todo_add', "Add to the user's to-do list.", { text: z.string(), due: z.string().optional().describe('YYYY-MM-DD'), source: z.string().optional() })
  reg('duo_todo_list', "The user's to-do list.", {})
  reg('duo_todo_done', 'Tick off a to-do.', { id: z.string() })
}
