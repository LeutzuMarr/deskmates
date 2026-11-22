/**
 * Keeps Deskmates from piling strikes onto the user's Freebuff account.
 *
 * Freebuff's free mode refuses requests it judges to come from a third-party client ("Freebuff free
 * mode only works through the official Freebuff CLI, Freebuff Desktop and freebuff.com … recorded as
 * strike 1 on this account"). It shows that as an error in its own window, which Deskmates can't
 * read reliably, but it also writes it to its chat log (`userError` on the turn). After every turn
 * Deskmates reads that log; on such a refusal it stops sending anything to Freebuff (scheduled
 * tasks included) until the user allows it again in Settings. It never tries to get around the check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export interface FreebuffBlock {
  /** Freebuff's own words. */
  reason: string
  at: number
}

/** Freebuff refusing a request because it came through Deskmates rather than its own apps. */
export const THIRD_PARTY_REFUSAL = /third-party client, harness or proxy|only works through the official Freebuff/i

let file: string | null = null
let block: FreebuffBlock | null = null

/** Where the block is kept across restarts (main.ts sets it at start). */
export function setFreebuffGuardFile(path: string): void {
  file = path
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as FreebuffBlock
    block = saved && typeof saved.reason === 'string' ? saved : null
  } catch {
    block = null
  }
}

export function freebuffBlock(): FreebuffBlock | null {
  return block
}

export function blockFreebuff(reason: string, at = Date.now()): FreebuffBlock {
  block = { reason, at }
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(block), 'utf8')
    } catch {
      // Still blocked for this session.
    }
  }
  return block
}

export function unblockFreebuff(): void {
  block = null
  if (file) rmSync(file, { force: true })
}

/** What the user is told while Freebuff is blocked. */
export function blockedMessage(current: FreebuffBlock): string {
  return [
    `Freebuff refused Deskmates' request on ${new Date(current.at).toLocaleString()}: "${current.reason}"`,
    'So Deskmates has stopped sending anything to Freebuff (scheduled tasks included), so no more strikes are added to your account.',
    'Pick another model for this project (Gemini, OpenAI and others in Settings), or use Freebuff in its own app. Settings has "Let Deskmates use Freebuff again" if you want to try later.'
  ].join(' ')
}

interface FreebuffChatMessage {
  id?: string
  variant?: string
  content?: string
  userError?: string
}

/**
 * Freebuff's own record of an error on its latest turn in `folder`: the `userError` of the last AI
 * message in the folder's newest chat, when that message was written at or after `since`. Null when
 * the turn had no error (or Freebuff's log isn't where expected).
 */
export function freebuffTurnError(folder: string, since: number, home = homedir()): string | null {
  try {
    const chats = join(home, '.config', 'manicode', 'projects', basename(folder.replace(/[\\/]+$/, '')), 'chats')
    if (!existsSync(chats)) return null
    const newest = readdirSync(chats).sort().at(-1)
    if (!newest) return null
    const messages = JSON.parse(readFileSync(join(chats, newest, 'chat-messages.json'), 'utf8')) as FreebuffChatMessage[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!
      if (message.variant === 'user') return null
      const at = Number(/^ai-(\d+)/.exec(message.id ?? '')?.[1] ?? NaN)
      if (!Number.isFinite(at)) continue
      if (at < since - 2000) return null
      return message.userError?.trim() || null
    }
    return null
  } catch {
    return null
  }
}
