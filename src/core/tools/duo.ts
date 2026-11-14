/**
 * Duo's own tools. The same definitions serve an API-model run directly and Duo's Freebuff through
 * the MCP bridge (`duo.tool`), so both follow exactly the same Outbox rules.
 */
import { existsSync, readFileSync } from 'node:fs'
import { tool } from 'ai'
import { z } from 'zod'
import type { DuoService } from '../duo/service'
import { profileMarkdown } from '../duo/brief'

export function duoTools(duo: DuoService, playbookPath: string) {
  const describe = (i: { id: string; kind: string; company: string; to: string; subject: string; status: string }): string =>
    `${i.id} · ${i.kind} · ${i.company} · ${i.to}${i.subject ? ` · "${i.subject}"` : ''} · ${i.status}`

  return {
    duo_profile: tool({
      description: "The user's details (name, school, company, email, webmail, LinkedIn) and your limits.",
      inputSchema: z.object({}),
      execute: async () => profileMarkdown(duo.profile())
    }),

    duo_playbook: tool({
      description: "The user's outreach playbook: who to pitch, how to write, the follow-up sequence and the signature.",
      inputSchema: z.object({}),
      execute: async () => (existsSync(playbookPath) ? readFileSync(playbookPath, 'utf8') : 'There is no playbook yet: ask the user how they pitch.')
    }),

    duo_outbox_add: tool({
      description:
        'Put a drafted email, follow-up or LinkedIn message in the Outbox for the user to approve. Nothing is sent. Refused (with the reason) over the daily limits, for a company already pitched, on the never-contact list, or with an address not on the company’s own domain.',
      inputSchema: z.object({
        kind: z.enum(['email', 'followup', 'linkedin', 'reply', 'other']).describe('email = a first pitch; followup = the next email in a company’s sequence; reply = a suggested answer to someone who wrote back'),
        company: z.string().min(1),
        domain: z.string().min(1).describe('The company’s website, like hotelroma.it'),
        to: z.string().min(1).describe('Their published email address, or the LinkedIn profile URL'),
        source: z.string().default('').describe('Where you found the address (the page URL)'),
        subject: z.string().default(''),
        body: z.string().min(1).describe('The exact text, signature included'),
        follow_up_no: z.number().int().min(2).max(4).optional().describe('For followup: 2, 3 or 4'),
        note: z.string().default('').describe('One line for the user: why this company, what you noticed')
      }),
      execute: async (input) => {
        const item = duo.addOutbox({ ...input, followUpNo: input.follow_up_no ?? null })
        return `Added to the Outbox for approval: ${describe(item)}.`
      }
    }),

    duo_outbox_list: tool({
      description: 'The Outbox: drafts waiting for approval, approved, sent, skipped and failed items (newest first).',
      inputSchema: z.object({ status: z.enum(['pending', 'approved', 'sent', 'skipped', 'failed', 'with-user', 'all']).default('all') }),
      execute: async ({ status }) => {
        const items = duo.state().outbox.filter((i) => status === 'all' || i.status === status).slice(0, 60)
        return items.length ? items.map(describe).join('\n') : 'Nothing there.'
      }
    }),

    duo_send_next: tool({
      description: 'The next item the user approved, with its exact text, to send now. Says when nothing is left.',
      inputSchema: z.object({}),
      execute: async () => {
        const item = duo.nextApproved()
        if (!item) return 'Nothing approved is waiting. You are done sending.'
        return [`id: ${item.id}`, `kind: ${item.kind}`, `company: ${item.company}`, `to: ${item.to}`, `subject: ${item.subject}`, item.followUpNo ? `follow-up number: ${item.followUpNo}` : '', '', item.body]
          .filter((l) => l !== '')
          .join('\n')
      }
    }),

    duo_mark_sent: tool({
      description: 'After you pressed Send and saw the email in Sent: mark that approved item sent.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => `Marked sent: ${describe(duo.markSent(id))}.`
    }),

    duo_mark_failed: tool({
      description: 'An approved item could not be sent: say why.',
      inputSchema: z.object({ id: z.string(), reason: z.string() }),
      execute: async ({ id, reason }) => `Marked failed: ${describe(duo.markFailed(id, reason))}.`
    }),

    duo_mark_with_user: tool({
      description: 'A LinkedIn message is filled in on the page and waits for the user to press Send.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => `Handed to the user: ${describe(duo.markWithUser(id))}. Tell them it's ready in the browser panel.`
    }),

    duo_record: tool({
      description:
        'Record outreach history you found: a reply or bounce from a company (their sequence then ends), or an email sent before you started (so nobody is pitched twice).',
      inputSchema: z.object({
        company: z.string(),
        domain: z.string(),
        kind: z.enum(['reply-received', 'bounce', 'first', 'followup']),
        date: z.string().optional().describe('YYYY-MM-DD, when it happened (default today)')
      }),
      execute: async ({ company, domain, kind, date }) => {
        const at = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`).getTime() : undefined
        duo.record({ company, domain, kind, at })
        return `Recorded ${kind} for ${company}.`
      }
    }),

    duo_todo_add: tool({
      description: "Add to the user's to-do list (homework, a test to prepare, a reply to send).",
      inputSchema: z.object({ text: z.string().min(1), due: z.string().optional().describe('YYYY-MM-DD'), source: z.string().default('duo').describe('school, outreach, you…') }),
      execute: async ({ text, due, source }) => {
        duo.addTodo(text, due ?? null, source)
        return 'Added.'
      }
    }),

    duo_todo_list: tool({
      description: "The user's to-do list.",
      inputSchema: z.object({}),
      execute: async () => {
        const todos = duo.state().todos
        return todos.length ? todos.map((t) => `${t.id} · ${t.done ? 'done' : 'open'} · ${t.due ?? 'no date'} · ${t.text}`).join('\n') : 'The list is empty.'
      }
    }),

    duo_todo_done: tool({
      description: 'Tick off a to-do.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        duo.setTodoDone(id, true)
        return 'Done.'
      }
    })
  }
}
