import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import type { GoogleStatus } from '../../../shared/protocol'

/** Google's "G", drawn inline so the button needs no image file. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

/**
 * Extras → Connectors: the Google account. One button opens Google's own sign-in page in the
 * browser; once the user allows access, Gmail, Calendar and Drive work for the Work tab's agent.
 */
export function GoogleAccountCard() {
  const showToast = useStore((s) => s.showToast)
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    core.call('google.status', {}).then(
      (next) => live && setStatus(next),
      () => live && setStatus({ configured: false, connected: false, email: null, pending: false })
    )
    const off = core.onEvent((event) => {
      if (event.type === 'google.updated') setStatus(event.status)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const fail = (error: unknown): void => showToast(error instanceof Error ? error.message : String(error))

  const connect = async (): Promise<void> => {
    setBusy(true)
    try {
      const { url } = await core.call('google.connect', {})
      // Opens in the user's own browser, where they are already signed in to Google.
      window.open(url, '_blank', 'noopener')
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    if (!window.confirm('Disconnect Google? The assistant will stop reading your mail, calendar and Drive.')) return
    setBusy(true)
    try {
      setStatus(await core.call('google.disconnect', {}))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const loadClient = async (file: File): Promise<void> => {
    try {
      setStatus(await core.call('google.setClient', { json: await file.text() }))
      showToast('Google sign-in is set up. Press “Sign in with Google”.')
    } catch (error) {
      fail(error)
    }
  }

  if (!status) return null

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-rule bg-card p-4">
      <div className="flex min-w-0 items-center gap-3">
        <GoogleMark />
        <div className="min-w-0">
          <div className="truncate font-serif text-[16px]">Google account</div>
          <div className="mt-0.5 text-[12px] text-ink-faint">
            {status.connected
              ? `Connected as ${status.email ?? 'your Google account'} · Gmail, Calendar and Drive`
              : status.pending
                ? 'Finish signing in in your browser…'
                : status.configured
                  ? 'Gmail, Calendar and Drive for the assistant. You sign in on Google’s own page.'
                  : 'One-time setup: load the OAuth client file from Google Cloud (Desktop app).'}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {status.connected ? (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : status.configured ? (
          <button type="button" className="btn btn-ivory inline-flex items-center gap-2" disabled={busy} onClick={() => void connect()}>
            {status.pending || busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <GoogleMark />}
            {status.pending ? 'Waiting for Google…' : 'Sign in with Google'}
          </button>
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void loadClient(file)
                event.target.value = ''
              }}
            />
            <button type="button" className="btn btn-outline" onClick={() => fileRef.current?.click()}>
              Load client file…
            </button>
          </>
        )}
      </div>
    </div>
  )
}
