import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { MessageCircle, QrCode, WifiOff } from 'lucide-react'
import { TabBar } from 'glisse'
import type { RemoteDevice } from '../remote/relay'
import type { Notebook } from './db'
import { NotebookView } from './editor/NotebookView'
import { NotesTab } from './library/NotesTab'
import { SearchTab, TrashTab } from './library/SearchTrash'
import { StoreView } from './store/StoreView'
import { loadTemplates } from './templates/registry'
import { useLiquid } from './ui/liquid'
import { Sheet } from './ui/Sheet'
import { syncer } from './sync/sync'

export function useOnline(): boolean {
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

type Tab = 'notes' | 'store' | 'search' | 'trash'

const TITLES: Record<Tab, string> = { notes: 'Notes', store: 'Store', search: 'Search', trash: 'Trash' }

/** Hooks for parts that need the app's state (sync status, AI). */
export const appExtras: { headerStart?: (device: RemoteDevice | null, online: boolean) => ReactNode; onDevice?: (device: RemoteDevice | null) => void } = {}

export function NotesApp({ initialDevice }: { initialDevice: RemoteDevice | null }) {
  const online = useOnline()
  const [device, setDevice] = useState(initialDevice)
  const [tab, setTab] = useState<Tab>('notes')
  const [notice, setNotice] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [pairSheet, setPairSheet] = useState(false)
  const [pasted, setPasted] = useState('')
  const [open, setOpen] = useState<{ notebook: Notebook; pageId?: string } | null>(null)
  const [libraryKey, setLibraryKey] = useState(0)
  const tabsRef = useRef<HTMLDivElement>(null)
  useLiquid(tabsRef, { reach: 20 })

  useEffect(() => {
    void loadTemplates()
  }, [])
  useEffect(() => appExtras.onDevice?.(device), [device])
  // Notebooks that arrive from another device show up in the library.
  useEffect(() => syncer.onChange((change) => (change.stores.has('notebooks') || change.stores.has('folders')) && setLibraryKey((k) => k + 1)), [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  const say = useCallback((text: string) => setNotice(text), [])

  const pair = async (link?: string): Promise<void> => {
    setPairing(true)
    try {
      const { pairByScanning, pairByLink } = await import('../remote/pair')
      const outcome = link ? await pairByLink(link) : await pairByScanning()
      if (outcome.status === 'paired') setPairSheet(false)
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
    else if (!device) setPairSheet(true)
    else location.assign('/')
  }

  if (open)
    return (
      <NotebookView
        notebook={open.notebook}
        startPageId={open.pageId}
        device={device}
        online={online}
        onClose={() => {
          setOpen(null)
          setLibraryKey((k) => k + 1)
        }}
      />
    )

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-end justify-between gap-3 px-6 pb-4 pt-[calc(env(safe-area-inset-top)+18px)]">
        <h1 className="font-serif text-[40px] leading-none tracking-tight">{TITLES[tab]}</h1>
        <div className="flex items-center gap-2">
          {appExtras.headerStart?.(device, online)}
          {!online && (
            <span className="flex items-center gap-1.5 rounded-full bg-oat px-3 py-1.5 text-[13px] text-ink-muted">
              <WifiOff size={14} /> Offline
            </span>
          )}
          {!device && online && (
            <button type="button" disabled={pairing} onClick={() => setPairSheet(true)} className="press glass flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium">
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

      <main className="flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+96px)]">
        {tab === 'notes' && <NotesTab key={libraryKey} onOpen={(notebook) => setOpen({ notebook })} notice={say} />}
        {tab === 'store' && <StoreView online={online} notice={say} />}
        {tab === 'search' && <SearchTab onOpen={(notebook, pageId) => setOpen({ notebook, pageId })} />}
        {tab === 'trash' && <TrashTab />}
      </main>

      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+14px)] z-30 flex justify-center">
        <div ref={tabsRef} className="pointer-events-auto">
          <TabBar
            aria-label="Sections"
            items={[
              { value: 'notes', label: 'Notes' },
              { value: 'store', label: 'Store' },
              { value: 'search', label: 'Search' },
              { value: 'trash', label: 'Trash' }
            ]}
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
          />
        </div>
      </div>

      {pairSheet && (
        <Sheet title="Pair with your PC" onClose={() => setPairSheet(false)} width={460}>
          <p className="mb-4 text-[14px] leading-relaxed text-ink-muted">On your PC, open Deskmates → Settings → Phone → Add a phone. Then scan its code, or copy its link, send it to this device (AirDrop, Messages…) and paste it here.</p>
          <button type="button" disabled={pairing} onClick={() => void pair()} className="press flex w-full items-center justify-center gap-2 rounded-full bg-clay py-3 text-[15px] font-semibold text-white disabled:opacity-50">
            <QrCode size={18} /> Scan the code
          </button>
          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (pasted.trim()) void pair(pasted.trim())
            }}
          >
            <label className="text-[13px] font-semibold" htmlFor="pair-link">
              Or paste the link
            </label>
            <textarea
              id="pair-link"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={3}
              placeholder="https://…/#pair=…"
              className="resize-none break-all rounded-xl border border-rule bg-card px-3 py-2 font-mono text-[13px] outline-none focus:border-clay"
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="press flex-1 rounded-full bg-black/5 py-2.5 text-[14px] font-semibold dark:bg-white/10"
                onClick={() =>
                  void navigator.clipboard
                    ?.readText()
                    .then((text) => setPasted(text))
                    .catch(() => setNotice('Tap the box and choose Paste.'))
                }
              >
                Paste
              </button>
              <button type="submit" disabled={pairing || !pasted.trim()} className="press flex-1 rounded-full bg-clay py-2.5 text-[14px] font-semibold text-white disabled:opacity-40">
                {pairing ? 'Pairing…' : 'Pair'}
              </button>
            </div>
          </form>
        </Sheet>
      )}

      {notice && (
        <div role="status" className="glass fixed bottom-[calc(env(safe-area-inset-bottom)+86px)] left-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 rounded-2xl px-4 py-3 text-center text-[14px] shadow-xl">
          {notice}
        </div>
      )}
    </div>
  )
}
