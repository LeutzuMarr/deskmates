import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, ImagePlus, Plus, Trash2 } from 'lucide-react'
import { getAsset } from '../db'
import { Sheet, NameSheet } from '../ui/Sheet'
import { allTemplates, onTemplatesChanged, removeTemplate, type StoredTemplate } from '../templates/registry'
import { addMyStickers, addMyTemplate, fetchCatalog, installPack, listInstalled, listStickers, MY_PACK, removeSticker, uninstallPack, type CatalogPack, type InstalledPack, type Sticker } from './store'
import { templatePage, usePageThumb } from '../ink/thumb'

/** A sticker from the device's storage. */
export function StickerImage({ sticker, size = 56 }: { sticker: Sticker; size?: number }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let made: string | null = null
    void getAsset(sticker.assetId).then((asset) => {
      if (!asset) return
      made = URL.createObjectURL(asset.blob)
      setUrl(made)
    })
    return () => {
      if (made) URL.revokeObjectURL(made)
    }
  }, [sticker.assetId])
  return url ? <img src={url} alt={sticker.name} draggable={false} style={{ width: size, height: size, objectFit: 'contain' }} /> : <span style={{ width: size, height: size }} className="block rounded-xl bg-black/5" />
}

const NO_ITEMS: never[] = []

function TemplateThumb({ template }: { template: StoredTemplate }) {
  const page = useState(() => {
    const base = templatePage(template)
    return template.backgrounds?.[0] ? { ...base, background: { assetId: template.backgrounds[0] } } : base
  })[0]
  const ref = usePageThumb(page, NO_ITEMS, template.landscape ? 96 : 72, template)
  return <canvas ref={ref} className="rounded-md shadow-[0_0_0_1px_rgba(0,0,0,.08),0_3px_10px_rgba(0,0,0,.10)]" />
}

/** Pictures picked from Photos or Files, split into pages if it's a PDF (handled by the PDF importer when present). */
export const pdfPages: { toImages?: (file: File, progress?: (done: number, total: number) => void) => Promise<Blob[]> } = {}

export function StoreView({ online, notice }: { online: boolean; notice: (text: string) => void }) {
  const [catalog, setCatalog] = useState<CatalogPack[] | null>(null)
  const [installed, setInstalled] = useState<InstalledPack[]>([])
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<CatalogPack | null>(null)
  const [mine, setMine] = useState<Sticker[]>([])
  const [myTemplates, setMyTemplates] = useState<StoredTemplate[]>([])
  const [templateName, setTemplateName] = useState<{ files: File[] } | null>(null)
  const stickerInput = useRef<HTMLInputElement>(null)
  const templateInput = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => {
    void listInstalled().then(setInstalled)
    void listStickers(MY_PACK).then(setMine)
    setMyTemplates(allTemplates().filter((t): t is StoredTemplate => (t as StoredTemplate).source === 'mine'))
  }, [])
  useEffect(() => {
    void fetchCatalog().then(setCatalog)
    reload()
    return onTemplatesChanged(reload)
  }, [reload, online])

  const get = async (pack: CatalogPack): Promise<void> => {
    if (!online) {
      notice('Connect to the internet to get packs. After that they work offline.')
      return
    }
    setBusy((b) => ({ ...b, [pack.id]: '0%' }))
    try {
      await installPack(pack.id, (done, total) => setBusy((b) => ({ ...b, [pack.id]: `${Math.round((done / Math.max(1, total)) * 100)}%` })))
      notice(`${pack.name} is ready: its templates are in New notebook, its stickers in the sticker tool.`)
    } catch (error) {
      notice(error instanceof Error ? error.message : 'The pack couldn’t be downloaded.')
    } finally {
      setBusy((b) => {
        const { [pack.id]: _, ...rest } = b
        return rest
      })
      reload()
    }
  }

  const isInstalled = (id: string): boolean => installed.some((p) => p.id === id)

  return (
    <div className="flex flex-col gap-8 px-6">
      <section>
        <h2 className="mb-1 font-serif text-[26px]">Subject packs</h2>
        <p className="mb-4 text-[14px] text-ink-muted">Free templates and stickers for school. Once you get a pack, it works without internet.</p>
        {catalog?.length === 0 && <p className="text-[14px] text-ink-muted">Connect to the internet once to see the packs.</p>}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
          {catalog?.map((pack) => (
            <div key={pack.id} className="glass flex flex-col gap-3 rounded-[26px] p-4" style={{ boxShadow: `inset 0 0 0 1px ${pack.accent}22` }}>
              <button type="button" className="press flex items-center gap-3 text-left" onClick={() => setOpen(pack)}>
                <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl" style={{ background: `${pack.accent}1f` }}>
                  {online || isInstalled(pack.id) ? <img src={pack.cover} alt="" className="size-11" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block font-serif text-[20px] leading-tight">{pack.name}</span>
                  <span className="block text-[12px] text-ink-muted">
                    {pack.templates} templates · {pack.stickers} stickers
                  </span>
                </span>
              </button>
              <p className="line-clamp-2 text-[13px] leading-snug text-ink-muted">{pack.description}</p>
              {online && (
                <div className="flex gap-1.5 overflow-hidden">
                  {pack.preview.slice(0, 7).map((src) => (
                    <img key={src} src={src} alt="" className="size-8" loading="lazy" />
                  ))}
                </div>
              )}
              {isInstalled(pack.id) ? (
                <div className="flex gap-2">
                  <span className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[#23864a]/12 py-2 text-[13px] font-semibold text-[#23864a]">
                    <Check size={15} /> On this device
                  </span>
                  <button type="button" aria-label={`Remove ${pack.name}`} className="press rounded-full bg-black/5 px-3 dark:bg-white/10" onClick={() => void uninstallPack(pack.id).then(reload)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : (
                <button type="button" disabled={Boolean(busy[pack.id])} onClick={() => void get(pack)} className="press flex items-center justify-center gap-1.5 rounded-full py-2 text-[14px] font-semibold text-white disabled:opacity-70" style={{ background: pack.accent }}>
                  {busy[pack.id] ? `Getting… ${busy[pack.id]}` : (
                    <>
                      <Download size={15} /> Get — free
                    </>
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-[26px]">My stickers</h2>
            <p className="text-[14px] text-ink-muted">Add your own from Photos or Files. In a notebook, the lasso can also turn a drawing into a sticker.</p>
          </div>
          <button type="button" className="press flex shrink-0 items-center gap-1.5 rounded-full bg-clay px-4 py-2 text-[14px] font-semibold text-white" onClick={() => stickerInput.current?.click()}>
            <ImagePlus size={16} /> Add
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          {mine.map((s) => (
            <div key={s.id} className="group relative rounded-2xl bg-black/[.03] p-2 dark:bg-white/5">
              <StickerImage sticker={s} size={64} />
              <button type="button" aria-label="Remove sticker" className="press absolute -right-1.5 -top-1.5 rounded-full bg-card p-1 shadow" onClick={() => void removeSticker(s).then(reload)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {mine.length === 0 && <p className="text-[14px] text-ink-faint">No stickers of your own yet.</p>}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-[26px]">My templates</h2>
            <p className="text-[14px] text-ink-muted">Turn a picture or a PDF (a planner, a worksheet) into a template, or save a page’s paper from a notebook’s menu.</p>
          </div>
          <button type="button" className="press flex shrink-0 items-center gap-1.5 rounded-full bg-clay px-4 py-2 text-[14px] font-semibold text-white" onClick={() => templateInput.current?.click()}>
            <Plus size={16} /> Add
          </button>
        </div>
        <div className="flex flex-wrap gap-4">
          {myTemplates.map((t) => (
            <div key={t.id} className="relative flex flex-col items-center gap-1 text-[12px]">
              <TemplateThumb template={t} />
              {t.name}
              <button type="button" aria-label="Remove template" className="press absolute -right-1.5 -top-1.5 rounded-full bg-card p-1 shadow" onClick={() => void removeTemplate(t.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {myTemplates.length === 0 && <p className="text-[14px] text-ink-faint">No templates of your own yet.</p>}
        </div>
      </section>

      <p className="pb-4 text-[12px] text-ink-faint">Pack stickers include Microsoft Fluent Emoji, used under the MIT licence (© Microsoft Corporation).</p>

      <input
        ref={stickerInput}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) void addMyStickers(files.map((f) => ({ blob: f, name: f.name.replace(/\.[^.]+$/, '') }))).then(reload)
        }}
      />
      <input
        ref={templateInput}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) setTemplateName({ files })
        }}
      />
      {templateName && (
        <NameSheet
          title="Name this template"
          initial={templateName.files[0]!.name.replace(/\.[^.]+$/, '')}
          action="Save template"
          onClose={() => setTemplateName(null)}
          onDone={(name) => {
            const files = templateName.files
            setTemplateName(null)
            void (async () => {
              const pages: Blob[] = []
              for (const f of files) {
                if (f.type === 'application/pdf') {
                  if (!pdfPages.toImages) {
                    notice('PDFs can’t be read here yet.')
                    return
                  }
                  pages.push(...(await pdfPages.toImages(f)))
                } else pages.push(f)
              }
              const first = pages[0]
              let landscape = false
              if (first) {
                const bitmap = await createImageBitmap(first)
                landscape = bitmap.width > bitmap.height
                bitmap.close()
              }
              await addMyTemplate(name, pages, landscape)
              notice(`“${name}” is in New notebook under Mine.`)
            })()
          }}
        />
      )}
      {open && (
        <Sheet title={open.name} onClose={() => setOpen(null)} width={560}>
          <p className="mb-4 text-[14px] text-ink-muted">{open.description}</p>
          {online ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(54px,1fr))] gap-2">
              {open.preview.map((src) => (
                <img key={src} src={src} alt="" className="size-12" loading="lazy" />
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-ink-faint">Connect to the internet to preview this pack.</p>
          )}
          <p className="mt-4 text-[12px] text-ink-faint">{open.credits}</p>
        </Sheet>
      )}
    </div>
  )
}
