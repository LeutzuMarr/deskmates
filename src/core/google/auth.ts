/**
 * "Sign in with Google" for Deskmates: the installed-app OAuth flow every desktop app uses. The
 * user clicks Connect, Google's own sign-in page opens in their browser, they pick an account and
 * allow access, and Google sends the browser back to a one-time address on 127.0.0.1 that only
 * this process listens on. No API keys for the user: the app's OAuth client (made once by whoever
 * builds Deskmates) is all Google needs.
 *
 * The refresh token is kept encrypted (Windows DPAPI on Windows); access tokens live in memory
 * and are refreshed when they expire.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { windowsDpapi } from '../../main/secret-cipher'

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive'
]

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
/** How long the sign-in page may stay open before the one-time address closes. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface GoogleClient {
  clientId: string
  clientSecret: string
}

export interface GoogleStatus {
  /** Whether an OAuth client is set up, so Connect can work at all. */
  configured: boolean
  connected: boolean
  email: string | null
  /** True while a sign-in page is open and the app is waiting for Google. */
  pending: boolean
}

interface Stored {
  email: string | null
  refreshToken: string
}

export interface GoogleAuthDeps {
  dataDir: string
  /** The OAuth client: settings first, then the environment. Null when none is set up. */
  client: () => GoogleClient | null
  onChange: (status: GoogleStatus) => void
  fetch?: typeof fetch
}

const base64url = (buffer: Buffer): string => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Reads the client_secret_*.json Google Cloud gives for a "Desktop app" OAuth client. */
export function parseClientFile(text: string): GoogleClient {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("That file isn't valid JSON. Use the client_secret_….json Google Cloud downloads for the OAuth client.")
  }
  const body = (parsed as { installed?: Record<string, unknown>; web?: Record<string, unknown> }) ?? {}
  const entry = body.installed ?? body.web ?? (parsed as Record<string, unknown>)
  const clientId = typeof entry.client_id === 'string' ? entry.client_id.trim() : ''
  const clientSecret = typeof entry.client_secret === 'string' ? entry.client_secret.trim() : ''
  if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret) {
    throw new Error('That file has no OAuth client ID and secret. Download it from Google Cloud → APIs & Services → Credentials → your Desktop app client.')
  }
  return { clientId, clientSecret }
}

export class GoogleAuth {
  private stored: Stored | null = null
  private access: { token: string; expiresAt: number } | null = null
  private pending: { server: Server; timer: NodeJS.Timeout } | null = null
  private readonly file: string
  private readonly http: typeof fetch

  constructor(private readonly deps: GoogleAuthDeps) {
    this.file = join(deps.dataDir, 'google', 'account.json')
    this.http = deps.fetch ?? fetch
  }

  status(): GoogleStatus {
    return { configured: this.deps.client() !== null, connected: this.stored !== null, email: this.stored?.email ?? null, pending: this.pending !== null }
  }

  isConnected(): boolean {
    return this.stored !== null
  }

  /** Loads the saved account, if any. */
  async load(): Promise<void> {
    if (!existsSync(this.file)) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { email?: string | null; token?: string; dpapi?: boolean }
      if (!saved.token) return
      let refreshToken = saved.token
      if (saved.dpapi) {
        const out = await windowsDpapi.unprotect({ token: saved.token })
        if (!out.token) return
        refreshToken = Buffer.from(out.token, 'base64').toString('utf8')
      }
      this.stored = { email: saved.email ?? null, refreshToken }
    } catch (error) {
      console.error('[google] could not read the saved account', error)
    }
  }

  private async save(stored: Stored | null): Promise<void> {
    if (!stored) {
      rmSync(this.file, { force: true })
      return
    }
    mkdirSync(dirname(this.file), { recursive: true })
    if (process.platform === 'win32') {
      const out = await windowsDpapi.protect({ token: Buffer.from(stored.refreshToken, 'utf8').toString('base64') })
      writeFileSync(this.file, JSON.stringify({ email: stored.email, token: out.token, dpapi: true }), 'utf8')
    } else {
      writeFileSync(this.file, JSON.stringify({ email: stored.email, token: stored.refreshToken }), { encoding: 'utf8', mode: 0o600 })
    }
  }

  /**
   * Starts signing in: opens a one-time address on 127.0.0.1 and returns Google's sign-in URL for
   * the app to open in the browser. Resolves when the URL is ready; the account connects when the
   * user finishes in the browser (onChange reports it).
   */
  async connect(): Promise<{ url: string }> {
    const client = this.deps.client()
    if (!client) throw new Error('Google sign-in isn’t set up in this copy of Deskmates yet.')
    this.cancelPending()
    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(24))

    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}`

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const done = (ok: boolean, message: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(callbackPage(ok, message))
        this.cancelPending()
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('This sign-in link is out of date. Go back to Deskmates and press Connect again.')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        done(false, error === 'access_denied' ? 'You didn’t allow access, so Deskmates isn’t connected.' : `Google said: ${error}`)
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        done(false, 'Google sent no sign-in code.')
        return
      }
      void this.finish(client, code, verifier, redirectUri).then(
        (email) => done(true, `Deskmates is connected to ${email ?? 'your Google account'}. You can close this tab.`),
        (err: unknown) => done(false, err instanceof Error ? err.message : String(err))
      )
    })
    const timer = setTimeout(() => this.cancelPending(), SIGN_IN_TIMEOUT_MS)
    timer.unref?.()
    this.pending = { server, timer }
    this.deps.onChange(this.status())

    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent select_account',
      state
    })
    return { url: `${AUTH_URL}?${params.toString()}` }
  }

  private cancelPending(): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending.server.close()
    this.pending = null
    this.deps.onChange(this.status())
  }

  private async finish(client: GoogleClient, code: string, verifier: string, redirectUri: string): Promise<string | null> {
    const response = await this.http(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri })
    })
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string }
    if (!response.ok || !body.access_token) throw new Error(`Google didn't finish the sign-in: ${body.error_description ?? body.error ?? response.status}`)
    if (!body.refresh_token) throw new Error('Google gave no lasting access. Remove Deskmates at myaccount.google.com/permissions and connect again.')
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
    let email: string | null = null
    try {
      const info = await this.http(USERINFO_URL, { headers: { Authorization: `Bearer ${body.access_token}` } })
      email = ((await info.json()) as { email?: string }).email ?? null
    } catch {
      email = null
    }
    this.stored = { email, refreshToken: body.refresh_token }
    await this.save(this.stored)
    this.deps.onChange(this.status())
    return email
  }

  /** A valid access token, refreshed when needed. Throws a plain message when not connected. */
  async accessToken(): Promise<string> {
    if (!this.stored) throw new Error('Google isn’t connected. The user can connect it in Extras → Connectors → Google account.')
    if (this.access && Date.now() < this.access.expiresAt - 60_000) return this.access.token
    const client = this.deps.client()
    if (!client) throw new Error('Google sign-in isn’t set up in this copy of Deskmates.')
    const response = await this.http(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: this.stored.refreshToken, grant_type: 'refresh_token' })
    })
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
    if (!response.ok || !body.access_token) {
      if (body.error === 'invalid_grant') {
        // Access was removed in the Google account (or expired): forget it so the UI offers Connect.
        this.stored = null
        this.access = null
        await this.save(null)
        this.deps.onChange(this.status())
        throw new Error('Google access was removed or expired. The user needs to connect Google again in Extras → Connectors.')
      }
      throw new Error(`Couldn't refresh Google access (${body.error ?? response.status}).`)
    }
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
    return body.access_token
  }

  async disconnect(): Promise<void> {
    const token = this.stored?.refreshToken
    this.stored = null
    this.access = null
    await this.save(null)
    this.deps.onChange(this.status())
    if (token) await this.http(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined)
  }

  dispose(): void {
    this.cancelPending()
  }
}

function callbackPage(ok: boolean, message: string): string {
  const safe = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><html><head><meta charset="utf-8"><title>Deskmates</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#faf9f5;color:#141413}div{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 8px;color:${ok ? '#23864a' : '#c8372d'}}</style></head><body><div><h1>${ok ? 'Connected' : 'Not connected'}</h1><p>${safe}</p></div></body></html>`
}
