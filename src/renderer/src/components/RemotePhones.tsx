import { useEffect, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import type { RemoteStatusInfo } from '../../../shared/protocol'

/** Settings → Phone → Use from anywhere: pair a phone with a QR code, see and remove paired phones. */
export function RemotePhones(): ReactNode {
  const toast = useStore((s) => s.showToast)
  const [status, setStatus] = useState<RemoteStatusInfo | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [left, setLeft] = useState(0)
  const [form, setForm] = useState({ relay: '', anon: '', appUrl: '' })

  const load = (): void => void core.call('remote.status', {}).then(setStatus).catch(() => setStatus(null))
  useEffect(load, [])

  const pairing = status?.pairing ?? null
  useEffect(() => {
    if (!pairing) {
      setQr(null)
      return
    }
    // Low error correction keeps the code coarse enough for a camera to read off a screen.
    void QRCode.toDataURL(pairing.url, { margin: 2, width: 520, errorCorrectionLevel: 'L' }).then(setQr)
    const tick = (): void => {
      const seconds = Math.max(0, Math.round((pairing.until - Date.now()) / 1000))
      setLeft(seconds)
      if (seconds === 0) load()
    }
    tick()
    const timer = setInterval(tick, 1000)
    // Picks up the phone once it has paired.
    const poll = setInterval(load, 3000)
    return () => {
      clearInterval(timer)
      clearInterval(poll)
    }
  }, [pairing?.url])

  const run = async <T,>(fn: () => Promise<T>): Promise<void> => {
    try {
      await fn()
      load()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error))
    }
  }

  if (!status) return null
  return (
    <div className="mt-4 border-t border-rule pt-4">
      <p className="text-[14px] text-ink">Use from anywhere</p>
      <p className="mt-1 text-[12px] text-ink-faint">
        Duo and the rest of Deskmates on your phone, on any network, as an app on your home screen with notifications. Everything between the phone and this PC is end-to-end encrypted; this PC must be on with Deskmates running.
      </p>
      {!status.configured ? (
        <div className="mt-3 flex flex-col gap-2">
          <input className="input" placeholder="Relay: https://….supabase.co" value={form.relay} onChange={(e) => setForm({ ...form, relay: e.target.value })} />
          <input className="input" placeholder="Relay publishable key" value={form.anon} onChange={(e) => setForm({ ...form, anon: e.target.value })} />
          <input className="input" placeholder="Web app: https://….vercel.app" value={form.appUrl} onChange={(e) => setForm({ ...form, appUrl: e.target.value })} />
          <button type="button" className="btn btn-ivory r-concentric self-end" style={concentricVars(14)} onClick={() => void run(() => core.call('remote.configure', form))}>
            Save
          </button>
        </div>
      ) : (
        <>
          {pairing && qr ? (
            <div className="mt-3 flex items-center gap-4">
              <img src={qr} width={260} height={260} alt="QR code to pair a phone" className="rounded-xl bg-white p-1" />
              <div className="min-w-0 text-[12px] text-ink-muted">
                <p>Scan this with the phone's camera, or send it the link (Copy the link below) and paste it in Pair with PC → Paste the link. On an iPhone, then tap Share → Add to Home Screen, open it from there, and turn on notifications. Already on the home screen? Tap Pair with PC (or Scan the code) inside the app.</p>
                <p className="mt-2">Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</p>
                <button type="button" className="btn btn-text px-0" onClick={() => void navigator.clipboard.writeText(pairing.url).then(() => toast('Link copied'))}>
                  Copy the link
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-ivory r-concentric mt-3" style={concentricVars(14)} onClick={() => void run(() => core.call('remote.pairStart', {}))}>
              Add a phone
            </button>
          )}
          {status.devices.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {status.devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="text-ink">
                    {d.name} <span className="text-ink-faint">· {d.notifications ? 'notifications on' : 'no notifications'}{d.lastSeenAt ? ` · last used ${new Date(d.lastSeenAt).toLocaleString()}` : ''}</span>
                  </span>
                  <button type="button" className="btn btn-text" onClick={() => void run(() => core.call('remote.remove', { id: d.id }))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn btn-text mt-2 px-0"
            onClick={() =>
              void core
                .call('remote.notesLink', {})
                .then(({ url }) => window.open(url, '_blank'))
                .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error)))
            }
          >
            Open my notes in the browser
          </button>
          <p className="mt-2 text-[12px] text-ink-faint">{status.appUrl}</p>
        </>
      )}
    </div>
  )
}
