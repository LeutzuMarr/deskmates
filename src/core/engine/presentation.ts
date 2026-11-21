/**
 * How Deskmates shows an agent's work, told to every agent whatever its prompt: a line before each
 * step (the chat shows it between the steps), the task list the user watches at the end of the
 * chat, a final summary that reads like Claude's (a lead line, bold, headings, bullets), and a
 * closing question shaped so the app turns it into buttons.
 */
import { NARRATION_RULES } from './narration'

export interface PresentationOptions {
  /** How this agent sets the task list: its own update_plan tool, the deskmates-prompt MCP
   *  server's update_plan, or not at all. */
  plan: 'tool' | 'mcp' | 'none'
  /** Whether the agent has a question-card tool (AskUserQuestion / ask_user / ask_user_input_v0). */
  cards: boolean
}

export function presentationRules(options: PresentationOptions): string {
  const parts = [NARRATION_RULES, '']
  if (options.plan !== 'none') {
    parts.push(
      'The task list (shown at the end of the chat, above the message box):',
      `- For any request with more than one step, call ${options.plan === 'mcp' ? 'update_plan from the deskmates-prompt server' : 'update_plan'} before your first step with the whole plan: short steps, the one you start in_progress, the rest pending.`,
      '- Call it again each time a step finishes (that step done, the next in_progress) and whenever the plan changes, sending the whole list. When everything is finished, send it with every step done.',
      ''
    )
  }
  parts.push(
    'Your final message (the summary at the end of a task):',
    '- Open with one plain sentence saying the outcome: what is now done or true.',
    '- Then the details that matter, easy to scan: **bold** for the key facts and names, bullet points for changes, findings or steps, and short `###` headings when there are separate parts. `code` for file names, commands and values.',
    "- Say plainly what isn't finished, didn't work or wasn't checked. Keep it short: no filler, no repeating what the step lines already said.",
    '- A one-line answer to a quick question needs none of this; just answer.',
    '',
    'Asking the user:'
  )
  if (options.cards) parts.push('- To ask the user to choose, use your question-card tool, as your operating prompt says.')
  parts.push(
    '- When you end by asking whether to go on, make it the very last sentence, a yes/no question on its own line ("Want me to apply the fix?"): Deskmates shows Yes and No buttons for it.',
    '- When the user has to pick between options, end with the question on its own line followed by a numbered list of 2 to 5 short options: Deskmates turns them into buttons.',
    '- Ask one question at a time, and only when the answer is theirs to give.'
  )
  return parts.join('\n')
}
