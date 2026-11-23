/**
 * PDFs: reading one in (each page becomes a picture the page is drawn over, at twice the page's
 * size so it stays sharp when zoomed) and writing a notebook out (each page as drawn, one picture
 * per PDF page, with pdf-lib). Both load only when used.
 */
import type { Item, Page } from '../model'
import { drawPaper } from '../ink/paper'
import { paintItem } from '../ink/paint'
import { thumbCache } from '../ink/thumb'
import { templateById } from '../templates/registry'
import { drawTemplate } from '../templates/spec'

/** Renders every page of a PDF to a PNG. */
export async function pdfToImages(file: Blob, progress?: (done: number, total: number) => void): Promise<Blob[]> {
  const pdfjs = await import('pdfjs-dist')
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = worker
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const out: Blob[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const base = page.getViewport({ scale: 1 })
    // About 2000 px on the long side: sharp on an iPad when zoomed, without huge files.
    const scale = Math.min(4, 2000 / Math.max(base.width, base.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    if (blob) out.push(blob)
    page.cleanup()
    progress?.(n, doc.numPages)
  }
  await doc.destroy()
  return out
}

async function waitForPictures(pages: Page[], items: Item[]): Promise<void> {
  const cache = thumbCache()
  const ids = [...pages.flatMap((p) => (p.background ? [p.background.assetId] : [])), ...items.flatMap((i) => (i.kind === 'image' || i.kind === 'sticker' ? [(i.data as { assetId: string }).assetId] : []))]
  for (let attempt = 0; attempt < 40; attempt++) {
    if (ids.every((id) => cache.picture(id))) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Draws one page to a canvas at `scale` page pixels per pixel. */
export function renderPage(page: Page, items: Item[], scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(page.width * scale)
  canvas.height = Math.round(page.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  const all = { minX: 0, minY: 0, maxX: page.width, maxY: page.height }
  drawPaper(ctx, page, all, scale)
  const template = templateById(page.template)
  if (template) drawTemplate(ctx, template, page.width, page.color, scale)
  const cache = thumbCache()
  if (page.background) {
    const picture = cache.picture(page.background.assetId)
    if (picture) ctx.drawImage(picture, 0, 0, page.width, page.height)
  }
  for (const item of [...items].sort((a, b) => a.z - b.z)) paintItem(ctx, item, cache, page.color)
  return canvas
}

/** The notebook as a PDF (A4 pages stay A4: 794 page pixels = 595 points). */
export async function notebookToPdf(pages: Page[], itemsOf: (pageId: string) => Item[], progress?: (done: number, total: number) => void): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const allItems = pages.flatMap((p) => itemsOf(p.id))
  await waitForPictures(pages, allItems)
  for (const [i, page] of pages.entries()) {
    const items = itemsOf(page.id)
    // Endless whiteboards export just the part with something on it.
    let target = page
    let shift: [number, number] = [0, 0]
    if (page.size === 'infinite') {
      const { itemBounds } = await import('../ink/paint')
      const bounds = items.map((it) => itemBounds(it, thumbCache()))
      const minX = Math.min(...bounds.map((b) => b.minX), page.width / 2) - 40
      const minY = Math.min(...bounds.map((b) => b.minY), page.height / 2) - 40
      const maxX = Math.max(...bounds.map((b) => b.maxX), page.width / 2 + 400) + 40
      const maxY = Math.max(...bounds.map((b) => b.maxY), page.height / 2 + 300) + 40
      target = { ...page, width: maxX - minX, height: maxY - minY }
      shift = [minX, minY]
    }
    const canvas = shift[0] || shift[1] ? renderShifted(target, page, items, shift) : renderPage(target, items, 2)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (!png) continue
    const image = await pdf.embedJpg(new Uint8Array(await png.arrayBuffer()))
    const w = target.width * 0.75
    const h = target.height * 0.75
    const out = pdf.addPage([w, h])
    out.drawImage(image, { x: 0, y: 0, width: w, height: h })
    progress?.(i + 1, pages.length)
  }
  const bytes = await pdf.save()
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}

function renderShifted(target: Page, page: Page, items: Item[], [sx, sy]: [number, number]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  const scale = Math.min(2, 4096 / Math.max(target.width, target.height))
  canvas.width = Math.round(target.width * scale)
  canvas.height = Math.round(target.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.translate(-sx, -sy)
  drawPaper(ctx, page, { minX: sx, minY: sy, maxX: sx + target.width, maxY: sy + target.height }, scale)
  for (const item of [...items].sort((a, b) => a.z - b.z)) paintItem(ctx, item, thumbCache(), page.color)
  return canvas
}

/** Hands a file to the iPad's share sheet (Save to Files, AirDrop…), or downloads it elsewhere. */
export async function shareFile(blob: Blob, name: string): Promise<void> {
  const file = new File([blob], name, { type: blob.type })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      // iPadOS only opens the share sheet right after a tap; making the PDF took longer, so ask
      // for one more tap.
      if ((error as Error).name === 'NotAllowedError') {
        offerShare(file)
        return
      }
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** A floating button that opens the share sheet with the file (on a fresh tap). */
function offerShare(file: File): void {
  document.getElementById('dm-share-offer')?.remove()
  const button = document.createElement('button')
  button.id = 'dm-share-offer'
  button.type = 'button'
  button.textContent = `Share “${file.name}”`
  button.style.cssText =
    'position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 24px);transform:translateX(-50%);z-index:100;padding:13px 22px;border:0;border-radius:999px;background:#c96442;color:#fff;font:600 15px system-ui,-apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)'
  const done = (): void => button.remove()
  button.onclick = () => {
    done()
    void navigator.share({ files: [file], title: file.name }).catch(() => undefined)
  }
  document.body.append(button)
  setTimeout(done, 20_000)
}
