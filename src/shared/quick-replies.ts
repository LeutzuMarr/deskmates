/**
 * Turns a reply that ends by asking the user to choose ("Which one should I send? 1. … 2. …") into
 * tap-to-answer options, so the user doesn't have to type the answer. Used for agents that can't draw
 * a question card themselves (Freebuff and the other command-line agents), and as a fallback for any
 * reply that asks in plain text.
 */
export interface QuickReplies {
  question: string
  options: string[]
}

const ITEM = /^\s*(?:\d{1,2}[.)]|[a-f][.)]|[-*•])\s+(.+?)\s*$/i
const MAX_OPTION = 120

/** Plain text of a list item: no bold, no links, and only the label before a long explanation. */
function cleanOption(raw: string): string {
  let text = raw
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
  // "Approve all: sends the ten drafts" → "Approve all"; keep it whole when it's short.
  const cut = text.search(/\s[—–-]\s|:\s/)
  if (cut > 2 && text.length > 48) text = text.slice(0, cut).trim()
  return text.replace(/[.;,]$/, '').trim()
}

/** A question answered with yes or no ("Want me to continue?", "Should I send it?"). */
const YES_NO = /^(?:so,?\s+|and\s+|ok(?:ay)?,?\s+)?(?:should|shall|do|does|did|would|will|want|can|could|may|is|are|ready|ok|okay|good to|happy for)\b/i

/**
 * The yes/no question a reply ends on, as its last sentence, or null. A reply that closes by asking
 * to go on gets Yes and No buttons, so going on is one click.
 */
export function yesNoQuestion(text: string): string | null {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines.at(-1)
  if (!last || !last.endsWith('?') || ITEM.test(last)) return null
  // The last sentence of the last line: "Done. Want me to push it?" asks "Want me to push it?".
  const sentence = (last.match(/[^.!?]*\?$/)?.[0] ?? last).replace(/\*\*/g, '').trim()
  if (!YES_NO.test(sentence)) return null
  // "Should I use A or B?" is a choice, not a yes/no.
  if (/\bor\b/i.test(sentence) && !/\bor not\b/i.test(sentence)) return null
  return sentence
}

export function quickReplies(text: string): QuickReplies | null {
  const listed = listedReplies(text)
  if (listed) return listed
  const question = yesNoQuestion(text)
  return question ? { question, options: ['Yes', 'No'] } : null
}

function listedReplies(text: string): QuickReplies | null {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd())
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  if (lines.length === 0) return null

  // The last block of list items, allowing blank lines between items.
  let end = lines.length - 1
  let question: string | null = null
  // A question after the list ("Which one?") ends the reply.
  if (!ITEM.test(lines[end]!) && lines[end]!.includes('?')) {
    question = lines[end]!.trim()
    end--
    while (end >= 0 && !lines[end]!.trim()) end--
  }
  const items: string[] = []
  let start = end
  for (let i = end; i >= 0; i--) {
    const line = lines[i]!
    if (!line.trim()) continue
    const match = ITEM.exec(line)
    if (!match) break
    items.unshift(match[1]!)
    start = i
  }
  if (items.length < 2 || items.length > 6) return null
  if (!question) {
    // Otherwise the question introduces the list ("Which should I do?\n1. …").
    let q = start - 1
    while (q >= 0 && !lines[q]!.trim()) q--
    if (q < 0 || !/[?:]\s*$/.test(lines[q]!) || !lines[q]!.includes('?')) return null
    question = lines[q]!.trim()
  }
  const options = items.map(cleanOption).filter((o) => o.length > 0 && o.length <= MAX_OPTION)
  if (options.length !== items.length) return null
  return { question: question.replace(/\*\*/g, ''), options }
}
