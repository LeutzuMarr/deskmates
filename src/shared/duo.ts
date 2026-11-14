/**
 * Duo: the assistant that works for the user in the background (its own tab in Deskmates and on the
 * phone). These are the shapes the core, the app and the phone share.
 */
import type { ModelRef, ToolItem } from './protocol'

/** What Duo knows about the user, filled in at setup and editable in Duo's settings. */
export interface DuoProfile {
  /** The user's name, as they sign emails. */
  name: string
  /** Who they are, in their own words ("student at …, founder of Velosyntech"). */
  about: string
  school: { name: string; url: string }
  company: { name: string; url: string }
  /** The email they pitch from, and where its inbox is (signed in once in the agent browser). */
  email: { address: string; webmailUrl: string }
  linkedinUrl: string
  /** Morning brief time, "HH:MM". */
  briefTime: string
  /** Check-in times through the day, "HH:MM" each. */
  checkIns: string[]
  /** No cards or notifications between these times ("HH:MM"). */
  quietFrom: string
  quietTo: string
  /** The model Duo runs on. Freebuff by default; every Freebuff run starts with the user's tap. */
  model: ModelRef | null
  /** Daily limits the Outbox enforces. */
  limits: DuoLimits
  /** Never contact these (domains or names). */
  doNotContact: string[]
  /** Duo is paused: no cards, no runs. */
  paused: boolean
  /** Setup finished. */
  ready: boolean
}

export interface DuoLimits {
  newEmailsPerDay: number
  followUpsPerDay: number
  linkedinPerDay: number
  /** Most emails one company ever receives (the first plus follow-ups). */
  maxEmailsPerCompany: number
  /** Days after the first email before follow-ups 2, 3 and 4 may go. */
  followUpDays: number[]
}

export const DEFAULT_DUO_LIMITS: DuoLimits = {
  newEmailsPerDay: 5,
  followUpsPerDay: 15,
  linkedinPerDay: 10,
  maxEmailsPerCompany: 4,
  followUpDays: [3, 7, 14]
}

export const DEFAULT_DUO_PROFILE: DuoProfile = {
  name: '',
  about: '',
  school: { name: '', url: '' },
  company: { name: '', url: '' },
  email: { address: '', webmailUrl: '' },
  linkedinUrl: '',
  briefTime: '07:30',
  checkIns: ['11:00', '14:00', '17:00', '20:00'],
  quietFrom: '22:30',
  quietTo: '07:00',
  model: { provider: 'freebuff', modelId: 'current' },
  limits: DEFAULT_DUO_LIMITS,
  doNotContact: ['romgaz.ro', 'Romgaz', 'sutsigol', 'Suț și Gol'],
  paused: false,
  ready: false
}

export type OutboxKind = 'email' | 'followup' | 'linkedin' | 'reply' | 'other'
export type OutboxStatus = 'pending' | 'approved' | 'skipped' | 'sent' | 'failed' | 'with-user'

/** Something Duo wants to send in the user's name. Nothing goes out until the user approves it. */
export interface OutboxItem {
  id: string
  kind: OutboxKind
  company: string
  /** The company's site domain, used for the "never pitched twice" rule. */
  domain: string
  /** Email address, or the LinkedIn profile URL. */
  to: string
  /** Where Duo found the address (a URL on the company's site), shown to the user. */
  source: string
  subject: string
  body: string
  /** For follow-ups: which email of the sequence (2, 3 or 4), and the thread's subject. */
  followUpNo: number | null
  /** Duo's note to the user ("they have no chat on their site"). */
  note: string
  status: OutboxStatus
  error: string | null
  createdAt: number
  decidedAt: number | null
  sentAt: number | null
}

/** One email or message that went out, or a reply or bounce that came back: the outreach history. */
export interface SentRecord {
  domain: string
  company: string
  kind: 'first' | 'followup' | 'linkedin' | 'reply-received' | 'bounce'
  at: number
}

export interface DuoTodo {
  id: string
  text: string
  /** "YYYY-MM-DD", or null. */
  due: string | null
  done: boolean
  /** Where it came from: "school", "outreach", "you", … */
  source: string
  createdAt: number
}

export interface DuoMessage {
  id: string
  role: 'duo' | 'user'
  text: string
  at: number
  /** A morning brief, a check-in, or plain conversation. */
  kind: 'brief' | 'check-in' | 'chat' | 'note'
}

/** A message the user sent while Duo was working, held until the run in flight ends. */
export interface DuoQueued {
  id: string
  text: string
  at: number
}

/** A run waiting for the user's tap (every Freebuff run starts this way). */
export interface DuoCard {
  id: string
  kind: 'brief' | 'check-in'
  /** When it became due. */
  at: number
}

export interface DuoState {
  profile: DuoProfile
  messages: DuoMessage[]
  outbox: OutboxItem[]
  todos: DuoTodo[]
  cards: DuoCard[]
  /** What Duo is doing now, or null when idle. */
  working: string | null
  /** The steps of the run in flight, or of the last one, as they happen ("Analyzing example.com"). */
  steps: ToolItem[]
  /** The reply the steps led to, once the run is over; null while it runs. */
  stepsFor: string | null
  /** Messages the user sent while Duo was busy, waiting their turn, oldest first. */
  queued: DuoQueued[]
  /** The next brief or check-in. */
  nextAt: number | null
}
