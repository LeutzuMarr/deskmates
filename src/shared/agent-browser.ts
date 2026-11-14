/**
 * The agent browser's shared types and the small rules both the core and the main process apply:
 * which fields an agent may never type into, which buttons count as sending something, and which
 * sites get special treatment. Kept free of Node and DOM imports so it runs in both, and in the page.
 */

/** One numbered thing on the page an agent can click or type into. */
export interface BrowserElement {
  n: number
  role: string
  name: string
  tag: string
  inputType?: string
  /** A password, one-time code, card or ID field: only the user may type here. */
  sensitive: boolean
  /** A field's current value (never filled in for sensitive fields). */
  value?: string
}

export interface BrowserPage {
  tabId: string
  url: string
  title: string
  text: string
  elements: BrowserElement[]
  /** The page asks the user to sign in (a visible password field or a known sign-in page). */
  signIn: boolean
  truncated: boolean
}

export interface BrowserTab {
  tabId: string
  url: string
  title: string
  active: boolean
  loading?: boolean
}

/** A question for the user: may agents use a site, or may one click Send on it. */
export interface SiteAsk {
  id: string
  kind: 'site' | 'action'
  domain: string
  /** What the agent wants to do, in plain words ("click “Send” on mail.zoho.eu"). */
  detail: string
  /** Which agent asked: "Work", "Design", "Duo", or a scheduled task's name. */
  agent: string
  at: number
}

export type SiteAnswer = 'allow-once' | 'always' | 'deny'

export interface BrowserState {
  /** Whether the panel is open on the PC. */
  open: boolean
  tabs: BrowserTab[]
  /** Who is driving: the agent, or the user (who clicked or typed in the panel). */
  controller: 'agent' | 'user'
  /** An agent action is running right now. */
  busy: boolean
  /** The agent browser has been used since the app started (shows the title-bar button). */
  used: boolean
  /** Seconds since the user last touched the PC's mouse or keyboard. */
  idleSeconds: number
  asks: SiteAsk[]
  /** The agent that last acted ("Duo", "Work"…), for the panel's banner. */
  lastAgent: string | null
}

export const EMPTY_BROWSER_STATE: BrowserState = {
  open: false,
  tabs: [],
  controller: 'agent',
  busy: false,
  used: false,
  idleSeconds: 0,
  asks: [],
  lastAgent: null
}

/** What the core asks the app's main process to do in the agent browser. `agent` names who asks. */
export type BrowserAction = { agent: string } & (
  | { op: 'open'; url: string; newTab?: boolean }
  | { op: 'read' }
  | { op: 'click'; n: number }
  | { op: 'type'; n: number; text: string; submit?: boolean }
  | { op: 'key'; key: string }
  | { op: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom'; amount?: number }
  | { op: 'back' }
  | { op: 'forward' }
  | { op: 'screenshot' }
  | { op: 'tabs' }
  | { op: 'switch'; tabId: string }
  | { op: 'close'; tabId: string }
  /** The label of element `n` and the page's URL, without acting (the core checks it before a click). */
  | { op: 'inspect'; n: number }
  /** The label of the button Enter would press in the focused field, if Enter submits a form. */
  | { op: 'enter-target' }
)

export type BrowserResult =
  | {
      ok: true
      page?: BrowserPage
      tabs?: BrowserTab[]
      /** Base64 PNG, for `screenshot`. */
      png?: string
      /** Something the agent should know ("Saved report.pdf to Downloads"). */
      note?: string
      /** For `inspect` / `enter-target`. */
      name?: string | null
      url?: string
    }
  | { ok: false; error: string; userControl?: boolean }

/** The part of `BrowserState` the main process knows; the core adds `asks` and `used`. */
export type HostBrowserState = Omit<BrowserState, 'asks' | 'used'>

/** The user counts as away from the PC after this long without touching it. */
export const AWAY_AFTER_SECONDS = 600

/** Lowercase, without accents, so "Plătește" and "platește" match "platest". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const SENSITIVE_TYPES = new Set(['password'])
const SENSITIVE_NAME =
  /pass(word|wd|code)?\b|parol|passwort|contrasena|\botp\b|otp[_-]?code|one[\s_-]?time|2fa|mfa|totp|verification[\s_-]?code|cod[\s_-]?(de[\s_-]?)?verificare|\bcvv\b|\bcvc\b|\bcsc\b|card[\s_-]?(number|num|no)|cardnumber|\bcc[\s_-]?(num|number)\b|\biban\b|\bcnp\b|\bssn\b|social[\s_-]?security|passport|pasaport|\bpin\b/

/** A field only the user may type into: passwords, one-time codes, card numbers and ID numbers. */
export function isSensitiveField(field: { inputType?: string; name?: string; autocomplete?: string; id?: string; label?: string }): boolean {
  if (field.inputType && SENSITIVE_TYPES.has(field.inputType.toLowerCase())) return true
  const autocomplete = (field.autocomplete ?? '').toLowerCase()
  if (/current-password|new-password|one-time-code|^cc-|\bcc-/.test(autocomplete)) return true
  return [field.name, field.id, field.label].some((value) => value && SENSITIVE_NAME.test(fold(value)))
}

/** The verb at the start of a control's label that sends something out or can't be undone. */
const SEND_WORDS =
  /^(send|trimite|invia|envoyer|enviar|senden|post|posteaza|publish|publica|pubblica|submit|trimitere|pay|plateste|paga|place order|buy|cumpara|sign|semneaza|delete|sterge|elimina|remove|connect|conecteaza|confirm|confirma)\b/

const NOT_SENDING = /^(sender|signature|semnatura|sent|trimise|sign in|sign up|signin|connect with|connections|deleted|postpone|posted|send feedback)\b/

/** Whether clicking a control with this label sends, posts, pays, signs or deletes something. */
export function isSendControl(label: string): boolean {
  const text = fold(label).replace(/\s+/g, ' ').trim()
  if (!text || NOT_SENDING.test(text)) return false
  return SEND_WORDS.test(text)
}

/** The page's host without a leading `www.`, lowercase; '' for something that isn't a URL. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Two hosts belong to the same site when one is the other or a subdomain of it, or both share a parent (accounts.zoho.eu and mail.zoho.eu). */
export function sameSite(a: string, b: string): boolean {
  const base = (host: string): string => host.split('.').slice(-2).join('.')
  if (!a || !b) return false
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`) || base(a) === base(b)
}

export function isLinkedIn(url: string): boolean {
  const host = domainOf(url)
  return host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in'
}

const SIGN_IN_HOSTS = ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'accounts.zoho.eu', 'accounts.zoho.com', 'appleid.apple.com']

/** Whether the URL is a sign-in page: a known identity provider or a /login, /signin path. */
export function isSignInHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true
    return /(^|\/)(login|log-in|signin|sign-in|sso|auth\/login|uas\/login)(\/|$|\?)/i.test(parsed.pathname)
  } catch {
    return false
  }
}
