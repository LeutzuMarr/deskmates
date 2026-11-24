/**
 * Plugs the page-content tools into the notebook and library: lasso, text, tape, inserting
 * pictures, stickers and sticky notes, pasting, PDFs in and out, and audio.
 */
import { useRef, useState } from 'react'
import { Lasso, Plus, Ribbon, Type } from 'lucide-react'
import { Menu, SegmentedControl, Slider } from 'glisse'
import { EXTRA_TOOLS, notebookAudio, notebookExtras, type NotebookContext } from './editor/NotebookView'
import type { NotesEngine } from './editor/engine'
import { lassoTool, selectionOf } from './editor/lasso'
import { finishEditing, insertPictures, insertSticker, insertSticky, tapeTool, textTool } from './editor/content'
import { ContentOverlay, pasteItems } from './editor/ContentOverlay'
import { StickerPanel } from './editor/StickerPanel'
import { AudioControls, recorder } from './audio/audio'
import { Popover, anchorOf } from './ui/Popover'
import { HIGHLIGHTS, PALETTE } from './editor/tools'
import { libraryActions } from './library/NotesTab'
import { pdfPages } from './store/StoreView'
import { backgroundPages, createNotebook, putAsset, save, makePage } from './db'

EXTRA_TOOLS.push(
  { value: 'lasso', label: 'Lasso', icon: <Lasso size={19} /> },
  { value: 'text', label: 'Text', icon: <Type size={19} /> },
  { value: 'tape', label: 'Tape', icon: <Ribbon size={19} /> }
)

const loadPdf = (): Promise<typeof import('./pdf/pdf')> => import('./pdf/pdf')
pdfPages.toImages = async (file, progress) => (await loadPdf()).pdfToImages(file, progress)

notebookAudio.stamp = (notebookId) => recorder.stamp(notebookId)

notebookExtras.setup = [
  ...(notebookExtras.setup ?? []),
  (engine) => {
    engine.handlers.lasso = lassoTool(engine)
    engine.handlers.text = textTool(engine)
    engine.handlers.tape = tapeTool(engine)
    // Undo and redo work on the page as saved: drop a selection or a text being typed first.
    const release = (): void => {
      finishEditing(engine)
      selectionOf(engine).clear()
    }
    engine.beforeHistory.add(release)
    return () => undefined
  }
]

notebookExtras.toolChanged = [
  ...(notebookExtras.toolChanged ?? []),
  (engine, tool) => {
    if (tool !== 'lasso') selectionOf(engine).clear()
    if (tool !== 'text') finishEditing(engine)
  }
]

notebookExtras.overlay = [...(notebookExtras.overlay ?? []), (engine, context) => <ContentOverlay engine={engine} notice={context.notice} setTool={context.setTool} />]

/** The "+" in a notebook's top bar: picture, camera, sticker, sticky note, paste, PDF pages. */
function InsertMenu({ engine, context }: { engine: NotesEngine; context: NotebookContext }) {
  const pictures = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const pdf = useRef<HTMLInputElement>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const [stickers, setStickers] = useState<{ x: number; y: number } | null>(null)
  const lasso = (): void => context.setTool('lasso')

  const addPdfPages = async (file: File): Promise<void> => {
    context.notice('Reading the PDF…')
    const { pdfToImages } = await loadPdf()
    const images = await pdfToImages(file, (done, total) => context.notice(`Reading the PDF… page ${done} of ${total}`))
    const ids: string[] = []
    for (const image of images) ids.push((await putAsset(image, { name: file.name })).id)
    const index = engine.currentPageIndex()
    const pages = engine.pages
    const from = pages[index]?.order ?? 0
    const span = pages[index + 1] ? pages[index + 1]!.order - from : ids.length + 1
    const fields = await backgroundPages(ids)
    const made = fields.map((extra, i) => makePage(engine.notebookId, from + (span * (i + 1)) / (fields.length + 1), { paper: 'blank', color: 'white', size: 'a4' }, Date.now(), extra))
    await save({ pages: made })
    engine.setPages([...pages.slice(0, index + 1), ...made, ...pages.slice(index + 1)])
    engine.showPage(index + 1)
    context.notice(`Added ${made.length} ${made.length === 1 ? 'page' : 'pages'}. Write on them like any page.`)
  }

  return (
    <span ref={anchor} className="flex items-center">
      <Menu
        aria-label="Insert"
        align="end"
        icon={<Plus size={20} />}
        items={[
          { label: 'Picture', onSelect: () => pictures.current?.click() },
          { label: 'Take a photo', onSelect: () => camera.current?.click() },
          { label: 'Sticker', onSelect: () => setStickers(anchorOf(anchor.current)) },
          {
            label: 'Sticky note',
            onSelect: () => insertSticky(engine)
          },
          { label: 'Paste', onSelect: () => void pasteItems(engine, lasso).then((ok) => !ok && context.notice('Nothing copied yet. Select with the lasso and tap Copy.')) },
          { label: 'PDF pages…', onSelect: () => pdf.current?.click() }
        ]}
      />
      <input ref={pictures} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => {
        const files = [...(e.target.files ?? [])]
        e.target.value = ''
        if (files.length) void insertPictures(engine, files, lasso)
      }} />
      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => {
        const files = [...(e.target.files ?? [])]
        e.target.value = ''
        if (files.length) void insertPictures(engine, files, lasso)
      }} />
      <input ref={pdf} type="file" accept="application/pdf" className="sr-only" onChange={(e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (file) void addPdfPages(file).catch(() => context.notice('That PDF couldn’t be read.'))
      }} />
      <Popover open={Boolean(stickers)} anchor={stickers} label="Stickers" onClose={() => setStickers(null)} width={360}>
        <StickerPanel
          onPick={(sticker) => {
            insertSticker(engine, sticker, lasso)
            setStickers(null)
          }}
        />
      </Popover>
    </span>
  )
}

notebookExtras.topRight = [
  ...(notebookExtras.topRight ?? []),
  (engine, context) => <InsertMenu engine={engine} context={context} />,
  (engine) => <AudioControls engine={engine} />
]

notebookExtras.menu = [
  ...(notebookExtras.menu ?? []),
  (engine, context) => [
    {
      label: 'Export as PDF',
      onSelect: () => {
        context.notice('Making the PDF…')
        void loadPdf()
          .then(async ({ notebookToPdf, shareFile }) => {
            const blob = await notebookToPdf(engine.pages, (id) => engine.itemsOn(id))
            await shareFile(blob, `${context.notebook.title.replace(/[\\/:*?"<>|]/g, '')}.pdf`)
          })
          .catch(() => context.notice('The PDF couldn’t be made.'))
      }
    }
  ]
]

notebookExtras.toolOptions = (tool, tools, update) => {
  if (tool === 'text')
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2.5">
          {PALETTE.map((c) => (
            <button key={c} type="button" className="swatch" aria-label={c} aria-pressed={tools.text.color === c} style={{ background: c }} onClick={() => update({ ...tools, text: { ...tools.text, color: c } })} />
          ))}
        </div>
        <SegmentedControl
          aria-label="Font"
          items={[
            { value: 'sans', label: 'Sans' },
            { value: 'serif', label: 'Serif' },
            { value: 'hand', label: 'Hand' },
            { value: 'mono', label: 'Mono' }
          ]}
          value={tools.text.font}
          onValueChange={(v) => update({ ...tools, text: { ...tools.text, font: v as typeof tools.text.font } })}
        />
        <label className="flex items-center gap-3 text-[13px] text-ink-muted">
          Size
          <span className="flex-1">
            <Slider aria-label="Text size" min={10} max={64} step={1} value={tools.text.size} onValueChange={(v) => update({ ...tools, text: { ...tools.text, size: v } })} />
          </span>
          <span className="w-8 text-right tabular-nums">{tools.text.size}</span>
        </label>
        <p className="text-[12px] text-ink-muted">Tap the page to type. Tap text you typed to change it.</p>
      </div>
    )
  if (tool === 'tape')
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2.5">
          {HIGHLIGHTS.map((c) => (
            <button key={c} type="button" className="swatch" aria-label={c} aria-pressed={tools.pens.highlighter.color === c} style={{ background: c }} onClick={() => update({ ...tools, pens: { ...tools.pens, highlighter: { ...tools.pens.highlighter, color: c } } })} />
          ))}
        </div>
        <p className="text-[12px] text-ink-muted">Drag over an answer to cover it. Tap the tape to peek, tap again to cover it.</p>
      </div>
    )
  if (tool === 'lasso') return <p className="text-[13px] text-ink-muted">Draw around things to select them. Drag to move, pull the corner to resize, pull the top handle to turn.</p>
  return null
}

libraryActions.newMenu = (context) => [
  {
    label: 'Import a PDF',
    onSelect: () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/pdf'
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return
        void (async () => {
          try {
            context.notice('Reading the PDF…')
            const { pdfToImages } = await loadPdf()
            const images = await pdfToImages(file, (done, total) => context.notice(`Reading the PDF… page ${done} of ${total}`))
            const ids: string[] = []
            for (const image of images) ids.push((await putAsset(image, { name: file.name })).id)
            const notebook = await createNotebook({ title: file.name.replace(/\.pdf$/i, ''), folderId: context.folderId, firstPages: await backgroundPages(ids) })
            context.opened(notebook)
          } catch {
            context.notice('That PDF couldn’t be read.')
          }
        })()
      }
      input.click()
    }
  }
]

