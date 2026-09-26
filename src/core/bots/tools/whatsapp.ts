/**
 * The `whatsapp_send` tool: delivers a bot's message through WhatsApp Web in its own Chromium,
 * driven the same way as the browser tool group (`browser.ts`) — over the bot's `CdpClient`, text
 * first, a screenshot only as the final proof. This is the one way a Deskmates bot reaches the
 * user (design spec, section 5.11):
 *
 * - the bot uses its own dedicated WhatsApp number, never the user's, so the ban risk from
 *   WhatsApp's anti-automation terms falls on a throwaway number instead of the user's own account;
 * - it may only message the ONE number configured for this bot — `to` lets the model state its
 *   intent, but this tool is the enforcement point, not the model's word, so a prompt-injected or
 *   simply mistaken "message someone else" is refused before any page is touched;
 * - the user logs the bot's WhatsApp in once, through Take Over, by scanning the QR code with the
 *   bot's own phone; this tool never sees that login and never tries to work around its absence —
 *   it fails with a plain sentence instead.
 *
 * Nothing here calls `console.log`/`console.error` with the number or the message body, and the
 * tool's own return value never echoes them back — see the class doc below for the one part of
 * "never log" this file can't reach: `runner.ts`'s existing, shared tool-call logging (every bot
 * tool's raw input is written to that run's `log.jsonl`, the same as `type_text`'s typed text
 * already is) is framework behavior this task doesn't touch.
 *
 * `allowedNumber` is supplied by whoever builds this tool for a run. `protocol.ts` doesn't yet have
 * a field for "the WhatsApp number configured for this bot" — neither `Bot` nor `Schedule` has
 * one — so nothing yet resolves and injects a real value end to end. See the task report for this
 * gap, the same kind of not-yet-wired note `runner.ts` carries for `runs.respond`.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { CdpClient, PageContent } from './cdp-client'
import type { SaveScreenshot } from './types'

export interface WhatsAppSendDeps {
  cdp: CdpClient
  saveScreenshot: SaveScreenshot
  /** The one phone number this bot's whatsapp_send may message, in any common format — compared to `to` with punctuation stripped, not by exact string. */
  allowedNumber: string
}

/** WhatsApp Web's own login-gate copy, present only when the browser hasn't been signed in through Take Over yet. Matched as plain substrings of the extracted page text so this isn't pinned to one exact WhatsApp Web release. */
const LOGIN_GATE_PATTERNS: readonly RegExp[] = [/log into whatsapp web/i, /scan the qr code/i, /use whatsapp on your computer/i]

const NOT_LOGGED_IN_MESSAGE =
  "WhatsApp isn't logged in on this bot's computer yet. Open Take Over in Deskmates and scan the QR code with the bot's phone, then try again."

const WRONG_NUMBER_MESSAGE = 'whatsapp_send can only message the number configured for this bot.'

const PAGE_CHANGED_MESSAGE = "Couldn't find WhatsApp's message box for this chat. WhatsApp Web may have changed its page."

/** WhatsApp Web's compose box lives in the footer, distinguishing it from the (also contenteditable) header search box. */
const COMPOSE_SELECTOR = 'footer [contenteditable="true"]'
/** The send button's icon carries a locale-independent data-icon attribute, unlike its aria-label. */
const SEND_SELECTOR = 'span[data-icon="send"]'

/** Strips everything but digits, then an international "00" trunk prefix, so "+1 (555) 123-4567" and "001 555 123 4567" compare equal. */
function normalizeNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('00') ? digits.slice(2) : digits
}

function looksLoggedOut(page: Pick<PageContent, 'text'>): boolean {
  return LOGIN_GATE_PATTERNS.some((pattern) => pattern.test(page.text))
}

/** Builds the `whatsapp_send` tool. Fresh per run, same as `browserTools` — see `runner.ts`. */
export function whatsappTools(deps: WhatsAppSendDeps) {
  /** The tab this run's WhatsApp chat is open in, reused across calls in the same run (mirrors `browser.ts`'s `activeTargetId`). */
  let targetId: string | null = null

  const openChat = async (phoneDigits: string, message: string): Promise<string> => {
    const url = `https://web.whatsapp.com/send?phone=${phoneDigits}&text=${encodeURIComponent(message)}`
    if (targetId) {
      try {
        await deps.cdp.navigate(targetId, url)
        return targetId
      } catch {
        targetId = null // the tab was closed from under us — fall through and open a fresh one.
      }
    }
    const target = await deps.cdp.newTab(url)
    targetId = target.targetId
    return targetId
  }

  return {
    whatsapp_send: tool({
      description:
        "Send a WhatsApp message from this bot's own WhatsApp number. Only ever reaches the number configured for this bot — any other number is refused before anything is sent.",
      inputSchema: z.object({
        to: z
          .string()
          .min(1)
          .describe('The recipient phone number, in international format. Must be the number configured for this bot.'),
        message: z.string().min(1)
      }),
      execute: async ({ to, message }) => {
        const wanted = normalizeNumber(to)
        if (wanted === '' || wanted !== normalizeNumber(deps.allowedNumber)) {
          throw new Error(WRONG_NUMBER_MESSAGE)
        }

        const id = await openChat(wanted, message)
        const page = await deps.cdp.readPage(id)
        if (looksLoggedOut(page)) throw new Error(NOT_LOGGED_IN_MESSAGE)

        try {
          await deps.cdp.typeText(id, COMPOSE_SELECTOR, message)
        } catch {
          const recheck = await deps.cdp.readPage(id).catch(() => page)
          throw new Error(looksLoggedOut(recheck) ? NOT_LOGGED_IN_MESSAGE : PAGE_CHANGED_MESSAGE)
        }

        await deps.cdp.click(id, SEND_SELECTOR)
        const png = await deps.cdp.screenshot(id)
        const screenshot = await deps.saveScreenshot(png, 'whatsapp')
        return { sent: true, screenshot }
      }
    })
  }
}
