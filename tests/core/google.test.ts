import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoogleAuth, parseClientFile, type GoogleStatus } from '../../src/core/google/auth'
import { buildRawEmail, readableMessage, googleTools, GOOGLE_RISKY_TOOLS } from '../../src/core/tools/google-tools'
import { approvalFor } from '../../src/core/engine/approvals'

const CLIENT = { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' }
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A stand-in for Google's token and userinfo endpoints. */
function fakeGoogle() {
  const calls: Array<{ url: string; body: string }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? String(init.body) : ''
    calls.push({ url, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'authorization_code') return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 })
      return json({ access_token: 'access-2', expires_in: 3600 })
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json({ email: 'me@example.com' })
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json({})
    if (url.includes('/gmail/v1/users/me/labels')) return json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] })
    return json({ error: { message: 'unexpected' } }, 404)
  }) as typeof fetch
  return { impl, calls }
}

describe('Google sign-in', () => {
  it('reads the client file Google Cloud downloads, and refuses anything else', () => {
    expect(parseClientFile(JSON.stringify({ installed: { client_id: CLIENT.clientId, client_secret: 'shh' } }))).toEqual(CLIENT)
    expect(() => parseClientFile('{"installed":{"client_id":"nope"}}')).toThrow(/no OAuth client/)
    expect(() => parseClientFile('not json')).toThrow(/valid JSON/)
  })

  it('signs in through the browser round trip and keeps the account across restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-google-'))
    dirs.push(dataDir)
    const google = fakeGoogle()
    const changes: GoogleStatus[] = []
    const auth = new GoogleAuth({ dataDir, client: () => CLIENT, onChange: (s) => changes.push(s), fetch: google.impl })
    expect(auth.status()).toMatchObject({ configured: true, connected: false })

    const { url } = await auth.connect()
    const signIn = new URL(url)
    expect(signIn.host).toBe('accounts.google.com')
    expect(signIn.searchParams.get('code_challenge_method')).toBe('S256')
    expect(signIn.searchParams.get('scope')).toContain('gmail.modify')
    const redirect = signIn.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // A wrong state is refused; the real one finishes the sign-in.
    expect((await fetch(`${redirect}/?code=x&state=wrong`)).status).toBe(400)
    const page = await fetch(`${redirect}/?code=the-code&state=${signIn.searchParams.get('state')}`)
    expect(await page.text()).toContain('me@example.com')
    expect(auth.status()).toMatchObject({ connected: true, email: 'me@example.com', pending: false })
    expect(google.calls.find((c) => c.body.includes('grant_type=authorization_code'))!.body).toContain('code_verifier=')

    // The refresh token is not stored in plain text on Windows.
    const saved = readFileSync(join(dataDir, 'google', 'account.json'), 'utf8')
    if (process.platform === 'win32') expect(saved).not.toContain('refresh-1')

    const again = new GoogleAuth({ dataDir, client: () => CLIENT, onChange: () => undefined, fetch: google.impl })
    await again.load()
    expect(again.status()).toMatchObject({ connected: true, email: 'me@example.com' })
    expect(await again.accessToken()).toBe('access-2')

    await again.disconnect()
    expect(again.status().connected).toBe(false)
    expect(google.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(true)
  }, 30_000)

  it('says plainly when Google is not set up', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-google-'))
    dirs.push(dataDir)
    const auth = new GoogleAuth({ dataDir, client: () => null, onChange: () => undefined })
    expect(auth.status().configured).toBe(false)
    await expect(auth.connect()).rejects.toThrow(/isn’t set up/)
    await expect(auth.accessToken()).rejects.toThrow(/isn’t connected/)
  })
})

describe('Gmail, Calendar and Drive tools', () => {
  it('builds a sendable email, encoding a non-ASCII subject', () => {
    const raw = buildRawEmail({ to: ['a@b.com'], subject: 'Întâlnire mâine', body: 'Salut!' })
    const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    expect(text).toContain('To: a@b.com')
    expect(text).toContain('Subject: =?UTF-8?B?')
    expect(text).toContain(Buffer.from('Salut!').toString('base64'))
  })

  it('reads a message as headers and text', () => {
    const msg = readableMessage({
      id: 'm1',
      threadId: 't1',
      payload: {
        headers: [
          { name: 'From', value: 'x@y.com' },
          { name: 'Subject', value: 'Hi' }
        ],
        parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('hello there').toString('base64url') } }, { filename: 'a.pdf', body: { attachmentId: 'z' } }]
      }
    })
    expect(msg).toMatchObject({ messageId: 'm1', from: 'x@y.com', subject: 'Hi', body: 'hello there', attachments: ['a.pdf'] })
  })

  it('calls Gmail with the signed-in account', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-google-'))
    dirs.push(dataDir)
    const google = fakeGoogle()
    const auth = new GoogleAuth({ dataDir, client: () => CLIENT, onChange: () => undefined, fetch: google.impl })
    const { url } = await auth.connect()
    const u = new URL(url)
    await fetch(`${u.searchParams.get('redirect_uri')}/?code=c&state=${u.searchParams.get('state')}`)
    const tools = googleTools(auth, google.impl)
    expect(Object.keys(tools)).toContain('mcp__Gmail__send_message')
    expect(Object.keys(tools)).toContain('mcp__Google_Calendar__create_event')
    expect(Object.keys(tools)).toContain('mcp__Google_Drive__search_files')
    const labels = await (tools.mcp__Gmail__list_labels as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({}, {})
    expect(labels).toEqual([{ labelId: 'INBOX', name: 'INBOX', type: 'system' }])
  }, 30_000)

  it('asks before sending, deleting, sharing or changing the calendar, and not before reading', () => {
    for (const name of GOOGLE_RISKY_TOOLS) expect(approvalFor(name, [])).toBe('user-approval')
    expect(approvalFor('mcp__Gmail__search_threads', [])).toBeUndefined()
    expect(approvalFor('mcp__Google_Drive__read_file_content', [])).toBeUndefined()
    // A connector's own tools still always ask.
    expect(approvalFor('mcp__gmail__search_threads', [])).toBe('user-approval')
  })
})
