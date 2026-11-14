import { describe, expect, it } from 'vitest'
import { bareDomain, blocked, checkOutboxAdd } from '../../src/core/duo/limits'
import { DEFAULT_DUO_LIMITS, DEFAULT_DUO_PROFILE, type OutboxItem, type SentRecord } from '../../src/shared/duo'

const NOW = new Date(2026, 10, 5, 8, 0).getTime()
const DAY = 86_400_000

const email = (company: string, domain: string, to = `info@${domain}`) => ({ kind: 'email' as const, company, domain, to, followUpNo: null })
const queuedItem = (over: Partial<OutboxItem>): OutboxItem => ({
  id: Math.random().toString(36),
  kind: 'email',
  company: 'X',
  domain: 'x.it',
  to: 'info@x.it',
  source: '',
  subject: '',
  body: '',
  followUpNo: null,
  note: '',
  status: 'pending',
  error: null,
  createdAt: NOW,
  decidedAt: null,
  sentAt: null,
  ...over
})
const check = (item: Parameters<typeof checkOutboxAdd>[0]['item'], history: SentRecord[] = [], queued: OutboxItem[] = []) =>
  checkOutboxAdd({ item, history, queued, limits: DEFAULT_DUO_LIMITS, doNotContact: DEFAULT_DUO_PROFILE.doNotContact, now: NOW })

describe('Duo outreach limits', () => {
  it('allows a first pitch to a published company address', () => {
    expect(check(email('Hotel Roma', 'hotelroma.it'))).toBeNull()
    expect(check(email('Hotel Roma', 'www.hotelroma.it', 'direzione@hotelroma.it'))).toBeNull()
  })

  it('refuses a sixth new pitch today', () => {
    const queued = ['a.it', 'b.it', 'c.it', 'd.it', 'e.it'].map((d) => queuedItem({ domain: d, to: `info@${d}` }))
    expect(check(email('F', 'f.it'), [], queued)).toMatch(/5 new pitches today/)
    // Yesterday's don't count.
    const old = queued.map((q) => ({ ...q, createdAt: NOW - DAY }))
    expect(check(email('F', 'f.it'), [], old)).toBeNull()
  })

  it('never pitches a company twice', () => {
    expect(check(email('Hotel Roma', 'hotelroma.it'), [{ domain: 'hotelroma.it', company: 'Hotel Roma', kind: 'first', at: NOW - 40 * DAY }])).toMatch(/already pitched/)
    expect(check(email('Hotel Roma', 'hotelroma.it'), [], [queuedItem({ domain: 'mail.hotelroma.it' })])).toMatch(/already pitched/)
  })

  it('refuses romgaz and sutsigol', () => {
    expect(check(email('Romgaz', 'romgaz.ro'))).toMatch(/never-contact/)
    expect(check(email('S.C. Suț și Gol S.R.L.', 'sutsigol.ro'))).toMatch(/never-contact/)
    expect(blocked({ company: 'Dental Plus', domain: 'dentalplus.ro', to: 'office@dentalplus.ro' }, DEFAULT_DUO_PROFILE.doNotContact)).toBeNull()
  })

  it('refuses addresses that are not on the company’s own domain', () => {
    expect(check(email('Hotel Roma', 'hotelroma.it', 'hotelroma@gmail.com'))).toMatch(/own domain/)
    expect(check(email('Hotel Roma', 'hotelroma.it', 'not an email'))).toMatch(/isn't an email/)
  })

  it('refuses followup 2 before 3 days, allows it after', () => {
    const history: SentRecord[] = [{ domain: 'hotelroma.it', company: 'Hotel Roma', kind: 'first', at: NOW - 2 * DAY }]
    const followUp = { ...email('Hotel Roma', 'hotelroma.it'), kind: 'followup' as const, followUpNo: 2 }
    expect(check(followUp, history)).toMatch(/3 days/)
    expect(check(followUp, [{ ...history[0]!, at: NOW - 3 * DAY }])).toBeNull()
  })

  it('refuses fifth email, and anything after a reply or bounce', () => {
    const base = { domain: 'hotelroma.it', company: 'Hotel Roma' }
    const four: SentRecord[] = [
      { ...base, kind: 'first', at: NOW - 20 * DAY },
      { ...base, kind: 'followup', at: NOW - 17 * DAY },
      { ...base, kind: 'followup', at: NOW - 13 * DAY },
      { ...base, kind: 'followup', at: NOW - 6 * DAY }
    ]
    const followUp = { ...email('Hotel Roma', 'hotelroma.it'), kind: 'followup' as const, followUpNo: null }
    expect(check(followUp, four)).toMatch(/already had 4 emails/)
    expect(check(followUp, [four[0]!, { ...base, kind: 'reply-received', at: NOW - DAY }])).toMatch(/already replied/)
    expect(check(followUp, [four[0]!, { ...base, kind: 'bounce', at: NOW - DAY }])).toMatch(/bounced/)
  })

  it('reply suggestions are not limited', () => {
    expect(check({ kind: 'reply', company: 'Hotel Roma', domain: 'hotelroma.it', to: 'x', followUpNo: null })).toBeNull()
  })

  it('linkedin needs a profile url and has its own daily limit', () => {
    const li = { kind: 'linkedin' as const, company: 'Agency', domain: 'agency.ro', to: 'https://www.linkedin.com/in/someone', followUpNo: null }
    expect(check(li)).toBeNull()
    expect(check({ ...li, to: 'someone@agency.ro' })).toMatch(/profile URL/)
  })

  it('reads domains from urls and addresses', () => {
    expect(bareDomain('https://www.Hotel.it/contatti')).toBe('hotel.it')
    expect(bareDomain('info@hotel.it')).toBe('hotel.it')
  })
})
