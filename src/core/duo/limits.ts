/**
 * The outreach rules Duo can't talk its way around: checked in code every time something is added to
 * the Outbox, against what was already sent (the history) and what is already waiting.
 */
import type { DuoLimits, OutboxItem, SentRecord } from '../../shared/duo'
import { fold } from '../../shared/agent-browser'

const DAY_MS = 86_400_000

/** Start of the local day containing `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** A bare domain from a domain, URL or email address: "https://www.Hotel.it/x" → "hotel.it". */
export function bareDomain(value: string): string {
  const text = value.trim().toLowerCase()
  const fromEmail = text.includes('@') && !text.includes('/') ? text.split('@').pop()! : text
  try {
    return new URL(/^[a-z]+:\/\//.test(fromEmail) ? fromEmail : `https://${fromEmail}`).hostname.replace(/^www\./, '')
  } catch {
    return fromEmail.replace(/^www\./, '')
  }
}

/** The part of a domain that names the organisation: "mail.hotel-roma.it" → "hotel-roma.it". */
function siteOf(domain: string): string {
  const parts = bareDomain(domain).split('.')
  // Two-part public suffixes like co.uk keep three labels.
  const twoPart = parts.length >= 3 && ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(parts[parts.length - 2]!)
  return parts.slice(twoPart ? -3 : -2).join('.')
}

export function sameCompany(a: string, b: string): boolean {
  return Boolean(a) && Boolean(b) && siteOf(a) === siteOf(b)
}

/** Whether a company is on the never-contact list, by domain or by name (accents and case ignored). */
export function blocked(item: Pick<OutboxItem, 'domain' | 'company' | 'to'>, doNotContact: string[]): string | null {
  const name = fold(item.company)
  for (const entry of doNotContact) {
    const e = fold(entry.trim())
    if (!e) continue
    if (e.includes('.') && (sameCompany(e, item.domain) || sameCompany(e, item.to))) return entry
    const squashed = (t: string): string => t.replace(/[^a-z0-9]/g, '')
    if (!e.includes('.') && (squashed(name).includes(squashed(e)) || squashed(siteOf(item.domain)).includes(squashed(e)))) return entry
  }
  return null
}

const LIVE: ReadonlySet<OutboxItem['status']> = new Set(['pending', 'approved', 'sent', 'with-user'])

export interface OutboxCheckInput {
  item: Pick<OutboxItem, 'kind' | 'company' | 'domain' | 'to' | 'followUpNo'>
  history: SentRecord[]
  queued: OutboxItem[]
  limits: DuoLimits
  doNotContact: string[]
  now: number
}

/** Why this can't go in the Outbox, or null when it can. */
export function checkOutboxAdd({ item, history, queued, limits, doNotContact, now }: OutboxCheckInput): string | null {
  if (item.kind === 'reply' || item.kind === 'other') return null
  if (!item.company.trim() || !item.domain.trim()) return 'Give the company and its website domain.'
  if (!item.to.trim()) return 'Give who it goes to.'
  const hit = blocked(item, doNotContact)
  if (hit) return `${item.company} is on the never-contact list (${hit}). Don't contact them.`

  const today = startOfDay(now)
  const mine = history.filter((h) => sameCompany(h.domain, item.domain))
  const waiting = queued.filter((q) => LIVE.has(q.status) && q.status !== 'sent' && sameCompany(q.domain, item.domain))
  if (mine.some((h) => h.kind === 'reply-received')) return `${item.company} already replied. Their sequence is over: the user answers them.`
  if (mine.some((h) => h.kind === 'bounce')) return `Email to ${item.company} bounced. Don't send them more.`

  if (item.kind === 'linkedin') {
    if (!/linkedin\.com\//i.test(item.to)) return 'For LinkedIn, "to" is the person’s LinkedIn profile URL.'
    const sentToday = history.filter((h) => h.kind === 'linkedin' && h.at >= today).length
    const queuedToday = queued.filter((q) => q.kind === 'linkedin' && LIVE.has(q.status) && q.status !== 'sent' && q.createdAt >= today).length
    if (sentToday + queuedToday >= limits.linkedinPerDay) return `That's already ${limits.linkedinPerDay} LinkedIn messages today, the daily limit.`
    if (mine.some((h) => h.kind === 'linkedin') || waiting.some((q) => q.kind === 'linkedin')) return `${item.company} already got a LinkedIn message.`
    return null
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.to.trim())) return `"${item.to}" isn't an email address.`
  if (!sameCompany(item.to, item.domain)) {
    return `The address ${item.to} isn't on ${item.company}'s own domain (${item.domain}). Only use an address the company publishes on its site.`
  }

  const emails = mine.filter((h) => h.kind === 'first' || h.kind === 'followup')
  const waitingEmails = waiting.filter((q) => q.kind === 'email' || q.kind === 'followup')

  if (item.kind === 'email') {
    if (emails.length > 0 || waitingEmails.length > 0) return `${item.company} was already pitched. Never pitch a company twice: follow up in the same thread instead.`
    const sentToday = history.filter((h) => h.kind === 'first' && h.at >= today).length
    const queuedToday = queued.filter((q) => q.kind === 'email' && LIVE.has(q.status) && q.status !== 'sent' && q.createdAt >= today).length
    if (sentToday + queuedToday >= limits.newEmailsPerDay) return `That's already ${limits.newEmailsPerDay} new pitches today, the daily limit.`
    return null
  }

  // A follow-up.
  const first = emails.filter((h) => h.kind === 'first').sort((a, b) => a.at - b.at)[0]
  if (!first) return `${item.company} hasn't had a first email yet, so there's nothing to follow up.`
  if (waitingEmails.length > 0) return `A follow-up to ${item.company} is already waiting in the Outbox.`
  const number = emails.length + 1
  if (number > limits.maxEmailsPerCompany) return `${item.company} already had ${limits.maxEmailsPerCompany} emails, the most a company ever gets.`
  if (item.followUpNo !== null && item.followUpNo !== number) return `This would be email ${number} to ${item.company}, not ${item.followUpNo}.`
  const days = limits.followUpDays[number - 2] ?? Infinity
  const age = (now - first.at) / DAY_MS
  if (age < days) return `Follow-up ${number} to ${item.company} can go ${days} days after the first email; it's been ${Math.floor(age)}.`
  const followUpsToday =
    history.filter((h) => h.kind === 'followup' && h.at >= today).length +
    queued.filter((q) => q.kind === 'followup' && LIVE.has(q.status) && q.status !== 'sent' && q.createdAt >= today).length
  if (followUpsToday >= limits.followUpsPerDay) return `That's already ${limits.followUpsPerDay} follow-ups today, the daily limit.`
  return null
}
