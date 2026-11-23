import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { addMyStickers, listInstalled, listStickers, MY_PACK, type InstalledPack, type Sticker } from '../store/store'
import { StickerImage } from '../store/StoreView'

/** Stickers by pack, to tap onto the page; and adding your own from Photos. */
export function StickerPanel({ onPick }: { onPick: (sticker: Sticker) => void }) {
  const [packs, setPacks] = useState<InstalledPack[] | null>(null)
  const [pack, setPack] = useState<string | null>(null)
  const [stickers, setStickers] = useState<Sticker[]>([])
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void listInstalled().then((list) => {
      const sorted = [...list].sort((a, b) => (a.id === MY_PACK ? -1 : b.id === MY_PACK ? 1 : a.name.localeCompare(b.name)))
      setPacks(sorted)
      setPack((current) => current ?? sorted[0]?.id ?? null)
    })
  }, [])
  useEffect(() => {
    if (pack) void listStickers(pack).then(setStickers)
  }, [pack])

  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
        <div className="flex w-max gap-1.5">
          {packs?.map((p) => (
            <button key={p.id} type="button" onClick={() => setPack(p.id)} className={`press rounded-full px-3 py-1.5 text-[13px] font-semibold ${pack === p.id ? 'text-white' : 'bg-black/5 dark:bg-white/10'}`} style={pack === p.id ? { background: p.accent } : undefined}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      {packs?.length === 0 && <p className="text-[13px] text-ink-muted">No stickers yet. Get a subject pack in the Store, or add your own pictures.</p>}
      <div className="grid max-h-[46vh] grid-cols-[repeat(auto-fill,minmax(58px,1fr))] gap-2 overflow-y-auto">
        {stickers.map((s) => (
          <button key={s.id} type="button" aria-label={s.name} className="press flex items-center justify-center rounded-xl p-1.5 hover:bg-black/5" onClick={() => onPick(s)}>
            <StickerImage sticker={s} size={48} />
          </button>
        ))}
      </div>
      <button type="button" className="press flex items-center justify-center gap-1.5 rounded-full bg-black/5 py-2 text-[13px] font-semibold dark:bg-white/10" onClick={() => input.current?.click()}>
        <ImagePlus size={15} /> Add my own
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length) return
          void addMyStickers(files.map((f) => ({ blob: f, name: f.name.replace(/\.[^.]+$/, '') }))).then(() => {
            setPack(MY_PACK)
            void listInstalled().then(setPacks)
            void listStickers(MY_PACK).then(setStickers)
          })
        }}
      />
    </div>
  )
}
