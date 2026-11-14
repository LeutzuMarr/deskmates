import { describe, expect, it } from 'vitest'
import { domainOf, isLinkedIn, isSendControl, isSensitiveField, isSignInHost, sameSite } from '../../src/shared/agent-browser'

describe('agent browser policy helpers', () => {
  it('spots password, code, card and ID fields', () => {
    expect(isSensitiveField({ inputType: 'password' })).toBe(true)
    expect(isSensitiveField({ autocomplete: 'one-time-code' })).toBe(true)
    expect(isSensitiveField({ autocomplete: 'cc-number' })).toBe(true)
    expect(isSensitiveField({ name: 'cardnumber' })).toBe(true)
    expect(isSensitiveField({ name: 'otp_code' })).toBe(true)
    expect(isSensitiveField({ id: 'cvv' })).toBe(true)
    expect(isSensitiveField({ name: 'CNP' })).toBe(true)
    expect(isSensitiveField({ name: 'Parolă' })).toBe(true)
    expect(isSensitiveField({ inputType: 'email', name: 'email' })).toBe(false)
    expect(isSensitiveField({ inputType: 'text', name: 'subject' })).toBe(false)
    expect(isSensitiveField({ inputType: 'search', name: 'q' })).toBe(false)
  })

  it('spots controls that send, post, pay, sign or delete', () => {
    for (const label of ['Send', 'Send now', 'Trimite', 'Invia', 'Post', 'Publish', 'Submit', 'Pay', 'Plătește', 'Sign', 'Delete', 'Șterge', 'Connect', 'Conectează-te', 'Envoyer']) {
      expect(isSendControl(label), label).toBe(true)
    }
    for (const label of ['Sender settings', 'Signature', 'Inbox', 'Compose', 'Reply all', 'Sent', 'Design', 'Connections', 'Deleted items', 'Postpone']) {
      expect(isSendControl(label), label).toBe(false)
    }
  })

  it('finds the domain without www', () => {
    expect(domainOf('https://www.mail.zoho.eu/x')).toBe('mail.zoho.eu')
    expect(domainOf('https://LinkedIn.com/in/x')).toBe('linkedin.com')
    expect(domainOf('not a url')).toBe('')
  })

  it('treats subdomains of the same site as one site', () => {
    expect(sameSite('mail.zoho.eu', 'zoho.eu')).toBe(true)
    expect(sameSite('accounts.zoho.eu', 'mail.zoho.eu')).toBe(true)
    expect(sameSite('zoho.eu', 'zoho.com')).toBe(false)
    expect(sameSite('evil-zoho.eu', 'zoho.eu')).toBe(false)
  })

  it('knows LinkedIn and sign-in pages', () => {
    expect(isLinkedIn('https://www.linkedin.com/in/x')).toBe(true)
    expect(isLinkedIn('https://lnkd.in/abc')).toBe(true)
    expect(isLinkedIn('https://notlinkedin.com')).toBe(false)
    expect(isSignInHost('https://accounts.google.com/v3/signin')).toBe(true)
    expect(isSignInHost('https://accounts.zoho.eu/signin?x')).toBe(true)
    expect(isSignInHost('https://example.com/login')).toBe(true)
    expect(isSignInHost('https://example.com/blog/logging')).toBe(false)
  })
})
