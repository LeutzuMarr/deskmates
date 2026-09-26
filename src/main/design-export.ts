import { BrowserWindow, dialog, net } from 'electron'
import type { WebContents } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import type { DesignExportFormat } from '../shared/desktop-api'
import { DC_RUNTIME_URL, encodePreviewPath, isDesignComponent, previewUrl } from '../shared/design-bridge'
import { MISSING_ERROR } from '../core/designs/files'
import { resolvePreviewRequest, stripEditorIds } from './preview-files'

export interface ExportDesignInput {
  dataDir: string
  projectId: string
  format: DesignExportFormat
  /** Page width in CSS pixels (PDF and PNG). */
  width: number
  parent: BrowserWindow | null
  /** The design-relative page to export; index.html when absent. */
  file?: string
}

const LOAD_TIMEOUT = 20_000

const EXTENSIONS: Record<DesignExportFormat, string> = { html: '.html', pdf: '.pdf', png: '.png' }
const FILTERS: Record<DesignExportFormat, Electron.FileFilter[]> = {
  html: [{ name: 'Web page', extensions: ['html'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  png: [{ name: 'PNG image', extensions: ['png'] }]
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Loads a design URL, failing after 20 seconds. */
async function loadDesign(contents: WebContents, url: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      contents.loadURL(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The design took too long to load for export.')), LOAD_TIMEOUT)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The page's rendered height in CSS pixels, after Design Components and web fonts are ready. */
async function renderedHeight(contents: WebContents): Promise<number> {
  const height = await contents.executeJavaScript(
    '(window.DCSupport ? window.DCSupport.ready : Promise.resolve()).then(() => document.fonts.ready).then(() => document.documentElement.scrollHeight)'
  )
  return typeof height === 'number' ? height : 0
}

/**
 * An exported DC can't reach the preview scheme, so the runtime goes inline. Child DCs and
 * x-imported files are not bundled: they still need to sit next to the exported file on a server.
 */
async function inlineDcRuntime(html: string): Promise<string> {
  const response = await net.fetch(DC_RUNTIME_URL)
  if (!response.ok) throw new Error('The design component runtime could not be read for export.')
  const runtime = (await response.text()).replace(/<\/script/gi, '<\\/script')
  const tag = `<script src="${DC_RUNTIME_URL}"></script>`
  return html.includes(tag) ? html.replace(tag, () => `<script>${runtime}</script>`) : html
}

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

const sanitizeName = (title: string): string => {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
  const base = (cleaned || 'Design').slice(0, 100)
  // Windows treats CON, PRN, NUL, COM1…9, LPT1…9 (with or without an extension) as reserved device names.
  return RESERVED_DEVICE_NAMES.test(base) ? `${base} design` : base
}

/** Exports a design to HTML, PDF or PNG after asking where to save it. Returns the path, or null on cancel. */
export async function exportDesign(input: ExportDesignInput): Promise<string | null> {
  const { dataDir, projectId, format, width, parent } = input
  const file = input.file ?? 'index.html'
  const pageUrl = previewUrl(projectId, encodePreviewPath(file))

  let html: string | null = null
  const resolved = resolvePreviewRequest(pageUrl, dataDir, '')
  if (resolved.kind === 'file' && resolved.isHtml) {
    try {
      html = await readFile(resolved.path, 'utf8')
    } catch {
      html = null
    }
  }
  const titleMatch = html?.match(/<title[^>]*>([^<]*)<\/title>/i)
  const base = sanitizeName(titleMatch?.[1]?.trim() ?? '')

  const result = parent
    ? await dialog.showSaveDialog(parent, {
        defaultPath: `${base}${EXTENSIONS[format]}`,
        filters: FILTERS[format]
      })
    : await dialog.showSaveDialog({
        defaultPath: `${base}${EXTENSIONS[format]}`,
        filters: FILTERS[format]
      })
  if (result.canceled || !result.filePath) return null
  const filePath = result.filePath

  if (format === 'html') {
    if (html === null) throw new Error(input.file ? 'That page was not found in this design.' : MISSING_ERROR)
    await writeFile(filePath, isDesignComponent(file) ? await inlineDcRuntime(html) : stripEditorIds(html), 'utf8')
    return filePath
  }

  const window = new BrowserWindow({
    show: false,
    width,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: format === 'png'
    }
  })

  try {
    await loadDesign(window.webContents, pageUrl + '?export=1')
    const height = await renderedHeight(window.webContents)

    if (format === 'pdf') {
      await wait(300)
      const data = await window.webContents.printToPDF({
        printBackground: true,
        margins: { left: 0, right: 0, top: 0, bottom: 0 },
        pageSize: { width: width / 96, height: Math.min(height, 19200) / 96 }
      })
      await writeFile(filePath, data)
      return filePath
    }

    window.setContentSize(width, Math.min(height, 16384))
    await wait(300)
    const image = await window.webContents.capturePage()
    await writeFile(filePath, image.toPNG())
    return filePath
  } finally {
    window.destroy()
  }
}