import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, MoreHorizontal, Plus, QrCode, WifiOff, X } from 'lucide-react'
import type { RemoteDevice } from '../remote/relay'
import { COVERS, createNotebook, listNotebooks, trashNotebook, type Notebook } from './db'

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function Cover({ cover, title }: { cover: string; title: string }) {
  return (
    <div
      className="relative aspect-[3/4] w-full overflow-hidden rounded-l-md rounded-r-2xl shadow-[0_1px_2px_rgba(0,0,0,.12),0_8px_22px_rgba(0,0,0,.12)]"
      style={{ background: `var(--cover-${cover}, var(--cover-clay))` }}
    >
      {/* The spine, and a soft light across the cover. */}
      <div className="absolute inset-y-0 left-0 w-[9%] bg-black/15" />
      <div className="absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,.18),transparent_45%)]" />
      <div className="absolute inset-x-[16%] top-[14%] rounded-md bg-white/85 px-2 py-1.5 text-center font-serif text-[13px] leading-tight text-[#141413] break-words hyphens-auto line-clamp-3">
        {title}
      </div>
    </div>
  )
}

function NewNotebookSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, cover: string) => void }) {
  const [title, setTitle] = useState('')
  const [cover, setCover] = useState<string>(COVERS[0])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 sm:items-center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="glass m-3 w-full max-w-md rounded-[28px] p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          onCreate(title, cover)
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-2xl">New notebook</h2>
          <button type="button" aria-label="Close" className="press rounded-full p-2 hover:bg-black/5" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="flex gap-4">
          <div className="w-24 shrink-0">
            <Cover cover={cover} title={title || 'Untitled notebook'} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <input
              ref={input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Name, e.g. Math"
              maxLength={80}
              className="w-full rounded-xl border border-rule bg-card px-3 py-2.5 text-[16px] outline-none focus:border-clay"
            />
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cover colour">
              {COVERS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={cover === c}
                  aria-label={c}
                  onClick={() => setCover(c)}
                  className="press size-8 rounded-full ring-offset-2 ring-offset-[var(--card)]"
                  style={{ background: `var(--cover-${c})`, boxShadow: cover === c ? '0 0 0 2px var(--card), 0 0 0 4px var(--ink)' : undefined }}
                />
              ))}
            </div>
          </div>
        </div>
        <button type="submit" className="press mt-5 w-full rounded-full bg-clay py-3 text-[15px] font-semibold text-white">
          Create
        </button>
      </form>
    </div>
  )
}

export function NotesApp({ initialDevice }: { initialDevice: RemoteDevice | null }) {
  const online = useOnline()
  const [device, setDevice] = useState(initialDevice)
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)

  const reload = useCallback(() => {
    void listNotebooks()
      .then(setNotebooks)
      .catch(() => {
        setNotebooks([])
        setNotice('Notes can’t be saved in this browser. Add Deskmates to the Home Screen and open it from there.')
      })
  }, [])
  useEffect(reload, [reload])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  const pair = async (): Promise<void> => {
    setPairing(true)
    try {
      const { pairByScanning } = await import('../remote/pair')
      const outcome = await pairByScanning()
      if (outcome.status === 'paired') {
        setDevice(outcome.device)
        setNotice(`Paired with ${outcome.device.pc || 'your PC'}. This stays signed in.`)
      } else if (outcome.status === 'failed') setNotice(outcome.message)
    } finally {
      setPairing(false)
    }
  }

  const openDeskmates = (): void => {
    if (!online) setNotice('Deskmates needs the internet. Your notes work without it.')
    else if (!device) void pair()
    else location.assign('/')
  }

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 flex items-end justify-between gap-3 px-6 pb-3 pt-[calc(env(safe-area-inset-top)+18px)]">
        <h1 className="font-serif text-[40px] leading-none tracking-tight">Notes</h1>
        <div className="flex items-center gap-2">
          {!online && (
            <span className="flex items-center gap-1.5 rounded-full bg-oat px-3 py-1.5 text-[13px] text-ink-muted">
              <WifiOff size={14} /> Offline
            </span>
          )}
          {!device && online && (
            <button type="button" disabled={pairing} onClick={() => void pair()} className="press glass flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium">
              <QrCode size={17} /> Pair with PC
            </button>
          )}
          <button
            type="button"
            onClick={openDeskmates}
            aria-disabled={!online || !device}
            className={`press flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-semibold ${online && device ? 'bg-clay text-white' : 'glass text-ink-faint'}`}
          >
            <MessageCircle size={17} /> Deskmates
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-6 gap-y-8">
          <button type="button" onClick={() => setCreating(true)} className="press flex flex-col gap-2 text-left">
            <div className="flex aspect-[3/4] w-full items-center justify-center rounded-2xl border-2 border-dashed border-rule text-ink-muted">
              <Plus size={34} strokeWidth={1.6} />
            </div>
            <div className="text-[14px] font-medium">New notebook</div>
          </button>
          {notebooks?.map((n) => (
            <div key={n.id} className="flex flex-col gap-2">
              <button type="button" className="press" onClick={() => setNotice('Writing in notebooks arrives in the next update.')}>
                <Cover cover={n.cover} title={n.title} />
              </button>
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium">{n.title}</div>
                  <div className="text-[12px] text-ink-muted">{shortDate(n.updatedAt)}</div>
                </div>
                <button
                  type="button"
                  aria-label={`Move ${n.title} to the trash`}
                  className="press -mr-1 rounded-full p-1 text-ink-muted"
                  onClick={() => {
                    if (confirm(`Move “${n.title}” to the trash?`)) void trashNotebook(n.id).then(reload)
                  }}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
        {notebooks?.length === 0 && <p className="mt-10 max-w-sm text-[15px] leading-relaxed text-ink-muted">Your notebooks live on this device and open even without internet.</p>}
      </main>

      {creating && (
        <NewNotebookSheet
          onClose={() => setCreating(false)}
          onCreate={(title, cover) => {
            setCreating(false)
            void createNotebook({ title, cover }).then(reload)
          }}
        />
      )}

      {notice && (
        <div role="status" className="glass fixed bottom-[calc(env(safe-area-inset-bottom)+20px)] left-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 rounded-2xl px-4 py-3 text-center text-[14px] shadow-xl">
          {notice}
        </div>
      )}
    </div>
  )
}
