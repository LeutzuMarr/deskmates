/**
 * The message the user is likely to send next, shown greyed out in the empty message box once a
 * reply ends; Tab puts it in the box. A reply that ends on a yes/no question or a list of options
 * suggests the obvious answer at once; otherwise the task's own model guesses from the last turn.
 */
import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import { quickReplies } from '../../shared/quick-replies'

const MAX_SUGGESTION = 160

/** The text of a stored message's text parts. */
function textOf(message: ModelMessage): string {
  const content = message.content as unknown
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('\n')
}

/** A suggestion that needs no model: the answer a closing question asks for. */
export function obviousNextMessage(reply: string): string | null {
  const replies = quickReplies(reply)
  if (!replies) return null
  if (replies.options[0] === 'Yes' && replies.options[1] === 'No') return 'Yes, go ahead'
  return replies.options[0] ?? null
}

/** Cleans what a model wrote into one short message, or null when it isn't usable. */
export function cleanSuggestion(raw: string): string | null {
  let text = raw.trim().split('\n')[0]!.trim()
  text = text.replace(/^(user|you|next message)\s*:\s*/i, '').replace(/^["'“]+|["'”]+$/g, '').trim()
  if (!text || text.length > MAX_SUGGESTION) return null
  if (/^(none|n\/a|nothing)\.?$/i.test(text)) return null
  return text
}

/**
 * The likely next message for a finished turn, or null. `model` is absent for command-line models,
 * which then only get the obvious answers.
 */
export async function suggestNextMessage(messages: ModelMessage[], model: LanguageModel | null, signal?: AbortSignal): Promise<string | null> {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const reply = lastAssistant ? textOf(lastAssistant).trim() : ''
  if (!reply) return null
  const obvious = obviousNextMessage(reply)
  if (obvious) return obvious
  if (!model) return null
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  try {
    const { text } = await generateText({
      model,
      system:
        "You predict the user's next message in a chat with their AI assistant. Reply with only that message, as the user would type it: short (under 12 words), in the user's language and voice, and natural as a follow-up. If there is no likely follow-up, reply NONE.",
      prompt: `The user wrote:\n${lastUser ? textOf(lastUser).slice(0, 2000) : ''}\n\nThe assistant answered:\n${reply.slice(-3000)}\n\nThe user's next message:`,
      maxOutputTokens: 40,
      abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    })
    return cleanSuggestion(text)
  } catch {
    // A suggestion is a nicety: a busy or failing model just means there isn't one.
    return null
  }
}
