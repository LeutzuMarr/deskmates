/**
 * Chat titles that say what a chat is about, not a copy of its first message. A gist of the request
 * is used at once (no model needed); after the first reply, a model writes a short summary title.
 */
import { generateText, type LanguageModel } from 'ai'

const MAX_WORDS = 6
const MAX_CHARS = 60

/** Openings that carry no meaning: greetings, politeness, "can you…", "I want you to…". */
const FILLER = [
  /^(hi|hey|hello|hiya|good (morning|afternoon|evening)|yo)\b[\s,!.]*/i,
  /^(ok(ay)?|so|well|now|also|and|then|right)\b[\s,]*/i,
  /^(please|pls|plz|kindly)\b[\s,]*/i,
  /^(can|could|would|will) (you|u)( please)?\s+/i,
  /^(i|we) (want|need|would like|'d like|wanna) (you )?(to )?/i,
  /^(i'm|i am) (trying|looking|hoping) to\s+/i,
  /^help me( to)?\s+/i,
  /^(let's|lets|let us)\s+/i,
  /^(make sure|try) (to\s+)?/i
]

/** Words a title doesn't need at its end. */
const TRAILING = /\b(please|for me|thanks|thank you|asap|now|today|again|too|as well)$/i

const capitalise = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/** A short gist of the first message, without a model: its main request, in at most six words. */
export function gistTitle(message: string): string {
  let text = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s]+|(?:\/[\w.-]+){2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let changed = true
  while (changed) {
    changed = false
    for (const filler of FILLER) {
      const next = text.replace(filler, '')
      if (next !== text) {
        text = next.trim()
        changed = true
      }
    }
  }
  // The first clause holds the request; what follows a comma or "and then" is detail.
  text = (text.split(/(?<=[.?!;:])\s|,\s| and then | so that | because /i)[0] ?? text).replace(/[.?!;:,]+$/, '').trim()
  const words = text.split(' ').filter(Boolean)
  let title = words.slice(0, MAX_WORDS).join(' ')
  while (TRAILING.test(title)) title = title.replace(TRAILING, '').trim()
  title = title.replace(/[\s,;:-]+$/, '')
  if (!title) return 'New chat'
  return capitalise(title.length > MAX_CHARS ? `${title.slice(0, MAX_CHARS - 1).trimEnd()}…` : title)
}

/** Cleans what a model wrote into a title, or null when it isn't usable. */
export function cleanTitle(raw: string): string | null {
  let text = raw.trim().split('\n')[0]!.trim()
  text = text
    .replace(/^(title|chat title)\s*:\s*/i, '')
    .replace(/[.!]+$/, '')
    .replace(/^["'“‘*#\s]+|["'”’*\s]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim()
  if (!text || text.length > MAX_CHARS || text.split(/\s+/).length > 8) return null
  if (/^(none|n\/a|untitled|new chat)$/i.test(text)) return null
  return capitalise(text)
}

/** A short title summarising a chat's start, or null (no model, a failure, or nothing usable). */
export async function summaryTitle(firstMessage: string, firstReply: string, model: LanguageModel | null, signal?: AbortSignal): Promise<string | null> {
  if (!model || !firstMessage.trim()) return null
  try {
    const { text } = await generateText({
      model,
      system:
        "You name chats. Reply with only a short title (2 to 6 words) that says what this chat is about: the topic or the task, the way someone would label it in a list. Don't quote or copy the user's message, don't start with a verb like \"Help\" or \"Asking\", no quotes, no final period. Use the language the user wrote in.",
      prompt: `The user wrote:\n${firstMessage.slice(0, 2000)}${firstReply.trim() ? `\n\nThe assistant answered:\n${firstReply.slice(0, 1500)}` : ''}\n\nTitle:`,
      maxOutputTokens: 24,
      abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    })
    return cleanTitle(text)
  } catch {
    // A title is a nicety: the gist stays.
    return null
  }
}
