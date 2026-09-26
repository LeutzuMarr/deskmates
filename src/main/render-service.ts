import { BrowserWindow, nativeImage, session } from 'electron'
import type { NativeImage, PrintToPDFOptions, Rectangle, WebContents } from 'electron'
import type { RenderLog, RenderPdfOptions, RenderRequest, RenderResult, RenderStep } from '../core/render/types'
import { PREVIEW_SCHEME } from '../shared/design-bridge'

const DEFAULT_WIDTH = 1440
const DEFAULT_HEIGHT = 900
const DEFAULT_SETTLE_MS = 300
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_HEIGHT = 8000
const READY_TIMEOUT_MS = 5000
const STEP_READY_TIMEOUT_MS = 2000
const MAX_STEPS = 100
/** Chromium can't capture a surface larger than this on either side. */
const MAX_CAPTURE_SIDE = 16384
/** Captures above this many pixels are scaled down before encoding. */
const MAX_CAPTURE_PIXELS = 40_000_000
/** Tallest PDF page Chromium will print: 200 inches. */
const MAX_PDF_HEIGHT = 19200
const PREVIEW_QUALITY = 72
const MAX_LOGS = 300
const MAX_LOG_CHARS = 2000
const MAX_RESULT_CHARS = 200_000

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Waits for web fonts, images and two animation frames; a page that never settles still gets captured. */
const readyScript = (timeoutMs: number): string => `(() => {
  const ready = (async () => {
    for (const img of document.images) if (img.loading === 'lazy') img.loading = 'eager'
    try { await document.fonts.ready } catch {}
    await Promise.all(Array.from(document.images).filter((img) => !img.complete).map((img) => new Promise((done) => {
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
    })))
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  })()
  return Promise.race([ready, new Promise((done) => setTimeout(done, ${timeoutMs}))]).then(() => true)
})()`

const FRAMES_SCRIPT = `new Promise((done) => {
  const timer = setTimeout(() => done(true), 500)
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done(true) }))
})`

const PAGE_SIZE_SCRIPT = `(() => ({
  width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
  height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
}))()`

/**
 * Runs `code` in the page and resolves to `{ ok, json }` or `{ ok: false, error }`. The value of the
 * last expression is returned; code using top-level `await` or `return` runs as an async function body.
 * Values are serialised in the page because DOM nodes and functions can't cross the IPC boundary.
 */
const PAGE_RUNNER = `async (code, timeoutMs) => {
  const seen = new WeakSet()
  const replacer = (key, value) => {
    if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString()
    if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']'
    if (value === window) return '[Window]'
    if (value instanceof Element) {
      const html = value.outerHTML
      return html.length > 500 ? html.slice(0, 500) + '…' : html
    }
    if (value instanceof Node) return '[' + value.nodeName + ']'
    if (value instanceof NodeList || value instanceof HTMLCollection) return Array.from(value)
    if (value instanceof Map) return Object.fromEntries(value)
    if (value instanceof Set) return Array.from(value)
    if (value instanceof Error) return { name: value.name, message: value.message }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  }
  const asBody = () => (0, eval)('(async () => {\\n' + code + '\\n})()')
  try {
    let value
    try {
      // Sloppy-mode eval reads \`await (x)\` as a call to a function named await, so code using await
      // is run as an async expression (keeping its value) or, failing that, an async function body.
      value = /\\bawait\\b/.test(code)
        ? (0, eval)('(async () => (\\n' + code.replace(/[\\s;]+$/, '') + '\\n))()')
        : (0, eval)(code)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      value = asBody()
    }
    let timer
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The script did not finish within ' + timeoutMs / 1000 + ' seconds.')), timeoutMs)
    })
    try {
      value = await Promise.race([value, limit])
    } finally {
      clearTimeout(timer)
    }
    return { ok: true, json: value === undefined ? undefined : JSON.stringify(value, replacer) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name + ': ' + error.message : String(error) }
  }
}`

const rectScript = (selector: string): string => `(() => {
  let el
  try { el = document.querySelector(${JSON.stringify(selector)}) } catch { return { invalid: true } }
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height, scrollY: window.scrollY }
})()`

type ScriptOutcome = { ok: true; json?: string } | { ok: false; error: string }

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface CaptureTarget {
  fullPage: boolean
  maxHeight: number
  selector?: string
}

/** Page URLs this service will load: design files on the preview scheme, nothing else. */
function checkUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Only design pages can be rendered.')
  }
  if (parsed.protocol !== `${PREVIEW_SCHEME}:` || parsed.host !== 'design') {
    throw new Error('Only design pages can be rendered.')
  }
  return parsed
}

/** The `deskmates-preview://design/<projectId>/` prefix a page may navigate within. */
function designPrefix(url: URL): string {
  const projectId = url.pathname.split('/').filter(Boolean)[0] ?? ''
  return `${PREVIEW_SCHEME}://design/${projectId}/`
}

function pushLog(logs: RenderLog[], level: RenderLog['level'], message: string): void {
  if (logs.length >= MAX_LOGS) return
  logs.push({ level, message: message.length > MAX_LOG_CHARS ? `${message.slice(0, MAX_LOG_CHARS)}…` : message })
}

const LOG_LEVELS: Record<string, RenderLog['level']> = { debug: 'log', info: 'info', warning: 'warn', error: 'error' }

function parseJson(json: string | undefined): unknown {
  if (json === undefined) return undefined
  if (json.length > MAX_RESULT_CHARS) return `${json.slice(0, MAX_RESULT_CHARS)}… (cut)`
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

async function runScript(contents: WebContents, code: string, timeoutMs: number): Promise<ScriptOutcome> {
  return (await contents.executeJavaScript(`(${PAGE_RUNNER})(${JSON.stringify(code)}, ${timeoutMs})`, true)) as ScriptOutcome
}

/** Runs a helper script, giving up quietly after `timeoutMs` (a page can block its own event loop). */
async function runQuiet<T>(contents: WebContents, code: string, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      contents.executeJavaScript(code) as Promise<T>,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function pageSize(contents: WebContents): Promise<{ width: number; height: number }> {
  const size = await runQuiet<{ width: number; height: number }>(contents, PAGE_SIZE_SCRIPT, 2000)
  return size ?? { width: 0, height: 0 }
}

/** Resizes the viewport and waits for the page to lay out and paint at the new size. */
async function resize(window: BrowserWindow, width: number, height: number): Promise<void> {
  window.setContentSize(width, height)
  await runQuiet(window.webContents, FRAMES_SCRIPT, 1000)
  await wait(50)
}

/**
 * Captures `box` (CSS pixels) and returns a plain image with the device pixels in its 1x
 * representation, so encoding and resizing don't resample it back down to CSS pixels.
 */
async function snap(contents: WebContents, box: Box, scale: number): Promise<NativeImage> {
  const rect: Rectangle = {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.ceil(box.width)),
    height: Math.max(1, Math.ceil(box.height))
  }
  contents.invalidate()
  await runQuiet(contents, FRAMES_SCRIPT, 1000)
  const image = await contents.capturePage(rect, { stayHidden: true })
  if (image.isEmpty()) throw new Error('The capture came back empty.')
  const pixels = image.getSize(scale)
  let flat = scale === 1 ? image : nativeImage.createFromBitmap(image.toBitmap({ scaleFactor: scale }), pixels)
  const size = flat.getSize()
  if (size.width * size.height > MAX_CAPTURE_PIXELS) {
    const factor = Math.sqrt(MAX_CAPTURE_PIXELS / (size.width * size.height))
    flat = flat.resize({ width: Math.floor(size.width * factor), quality: 'good' })
  }
  return flat
}

const fits = (box: Box, width: number, height: number): boolean =>
  box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5

async function elementBox(contents: WebContents, selector: string): Promise<Box & { scrollY: number }> {
  const box = await runQuiet<(Box & { scrollY: number }) | { invalid: true } | null>(contents, rectScript(selector), 2000)
  if (box && 'invalid' in box) throw new Error(`Not a valid CSS selector: ${selector}`)
  if (!box) throw new Error(`No element matches ${selector}`)
  if (box.width < 1 || box.height < 1) throw new Error(`The element ${selector} has no size (is it hidden?)`)
  return box
}

async function captureElement(window: BrowserWindow, selector: string, scale: number): Promise<NativeImage> {
  const contents = window.webContents
  const [width, height] = window.getContentSize()
  let box = await elementBox(contents, selector)
  if (!fits(box, width, height) && box.height <= height) {
    await runQuiet(contents, `window.scrollBy(0, ${Math.floor(box.y)})`, 1000)
    await runQuiet(contents, FRAMES_SCRIPT, 1000)
    box = await elementBox(contents, selector)
  }
  if (fits(box, width, height)) return snap(contents, box, scale)

  // Taller than the viewport, or it can't be scrolled into view: grow the viewport to hold it.
  const needed = Math.ceil(box.scrollY + box.y + box.height)
  const tall = clamp(needed, height, Math.floor(MAX_CAPTURE_SIDE / scale))
  await runQuiet(contents, 'window.scrollTo(0, 0)', 1000)
  await resize(window, width, tall)
  try {
    const grown = await elementBox(contents, selector)
    const x = Math.max(0, grown.x)
    const y = Math.max(0, grown.y)
    const clipped = {
      x,
      y,
      width: Math.min(grown.x + grown.width, width) - x,
      height: Math.min(grown.y + grown.height, tall) - y
    }
    if (clipped.width < 1 || clipped.height < 1) throw new Error(`The element ${selector} is outside the page.`)
    return await snap(contents, clipped, scale)
  } finally {
    await resize(window, width, height)
  }
}

async function capture(window: BrowserWindow, target: CaptureTarget, scale: number): Promise<NativeImage> {
  const contents = window.webContents
  if (target.selector) return captureElement(window, target.selector, scale)
  const [width, height] = window.getContentSize()
  if (target.fullPage) {
    const page = await pageSize(contents)
    const full = clamp(Math.ceil(page.height), height, Math.min(target.maxHeight, Math.floor(MAX_CAPTURE_SIDE / scale)))
    if (full > height) {
      await resize(window, width, full)
      try {
        return await snap(contents, { x: 0, y: 0, width, height: full }, scale)
      } finally {
        await resize(window, width, height)
      }
    }
  }
  return snap(contents, { x: 0, y: 0, width, height }, scale)
}

/** A small JPEG for a model to look at: at most `maxWidth` wide and three times as tall. */
function preview(image: NativeImage, maxWidth: number): string {
  let small = image
  const { width } = small.getSize()
  if (width > maxWidth) small = small.resize({ width: maxWidth, quality: 'good' })
  const size = small.getSize()
  const maxHeight = maxWidth * 3
  if (size.height > maxHeight) small = small.crop({ x: 0, y: 0, width: size.width, height: maxHeight })
  return small.toJPEG(PREVIEW_QUALITY).toString('base64')
}

async function printPdf(contents: WebContents, options: RenderPdfOptions, viewportWidth: number): Promise<Buffer> {
  const noMargins = { top: 0, bottom: 0, left: 0, right: 0 }
  const pdf: PrintToPDFOptions = { printBackground: true }
  if (options.landscape) pdf.landscape = true
  if (options.noMargins) pdf.margins = noMargins
  if (options.fitToContent) {
    const page = await pageSize(contents)
    pdf.pageSize = {
      width: Math.max(page.width, viewportWidth) / 96,
      height: clamp(page.height, 1, MAX_PDF_HEIGHT) / 96
    }
    pdf.margins = noMargins
  } else if (typeof options.pageSize === 'string') {
    pdf.pageSize = options.pageSize
  } else if (options.pageSize) {
    pdf.pageSize = {
      width: clamp(options.pageSize.width, 1, MAX_PDF_HEIGHT) / 96,
      height: clamp(options.pageSize.height, 1, MAX_PDF_HEIGHT) / 96
    }
  }
  if (options.preferCSSPageSize) pdf.preferCSSPageSize = true
  return contents.printToPDF(pdf)
}

/**
 * Renders design pages in hidden offscreen windows for the core's design tools: screenshots,
 * scripts, console output and PDFs. Requests run one at a time, each in a fresh sandboxed window
 * with no preload and no Node, which is destroyed afterwards.
 */
export class RenderService {
  private tail: Promise<unknown> = Promise.resolve()
  private active: BrowserWindow | null = null
  private disposed = false
  private downloadGuard: ((event: Electron.Event, item: Electron.DownloadItem, contents: WebContents) => void) | null =
    null

  render(request: RenderRequest): Promise<RenderResult> {
    const job = this.tail.then(() => this.renderNow(request))
    this.tail = job.catch(() => undefined)
    return job
  }

  dispose(): void {
    this.disposed = true
    this.closeActive()
    if (this.downloadGuard) session.defaultSession.off('will-download', this.downloadGuard)
    this.downloadGuard = null
  }

  private closeActive(): void {
    const window = this.active
    this.active = null
    if (!window || window.isDestroyed()) return
    try {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    } catch {
      // Already detached.
    }
    window.destroy()
  }

  private async renderNow(request: RenderRequest): Promise<RenderResult> {
    const result: RenderResult = { screenshots: [], logs: [] }
    if (this.disposed) return { ...result, error: 'The app is closing.' }
    this.guardDownloads()

    const timeoutMs = clamp(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS)
    let timer: NodeJS.Timeout | undefined
    const job = this.run(request, result)
    job.catch(() => undefined)
    try {
      await Promise.race([
        job,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`The page took longer than ${Math.round(timeoutMs / 1000)} seconds to render.`)),
            timeoutMs
          )
        })
      ])
    } catch (error) {
      result.error = messageOf(error)
    } finally {
      clearTimeout(timer)
      this.closeActive()
    }
    return {
      ...result,
      screenshots: [...result.screenshots],
      ...(result.sizes ? { sizes: [...result.sizes] } : {}),
      ...(result.previews ? { previews: [...result.previews] } : {}),
      logs: [...result.logs]
    }
  }

  /** A page could start a download; never let one open a save dialog from a hidden window. */
  private guardDownloads(): void {
    if (this.downloadGuard) return
    this.downloadGuard = (event, _item, contents) => {
      if (this.active && !this.active.isDestroyed() && contents === this.active.webContents) event.preventDefault()
    }
    session.defaultSession.on('will-download', this.downloadGuard)
  }

  private async run(request: RenderRequest, result: RenderResult): Promise<void> {
    const url = checkUrl(request.url)
    const prefix = designPrefix(url)
    const width = clamp(Math.round(request.width ?? DEFAULT_WIDTH), 100, 4096)
    const height = clamp(Math.round(request.height ?? DEFAULT_HEIGHT), 100, 4096)
    const scale = clamp(request.scale ?? 1, 0.25, 4)
    const scriptTimeout = clamp(request.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS, 100, 60_000)
    const target: CaptureTarget = {
      fullPage: request.fullPage === true,
      maxHeight: clamp(request.maxHeight ?? DEFAULT_MAX_HEIGHT, height, MAX_CAPTURE_SIDE),
      ...(request.selector ? { selector: request.selector } : {})
    }

    const window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        offscreen: { deviceScaleFactor: scale },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        disableDialogs: true,
        spellcheck: false
      }
    })
    this.active = window
    // The constructor clamps a window to the screen; an explicit resize isn't clamped.
    window.setContentSize(width, height)
    const contents = window.webContents
    const shorten = (source: string | undefined): string =>
      source?.startsWith(prefix) ? source.slice(prefix.length).replace(/\?export=1$/, '') : (source ?? '')
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => {
      if (!target.startsWith(prefix)) event.preventDefault()
    })
    contents.on('dom-ready', () => {
      void contents.insertCSS('::-webkit-scrollbar { width: 0 !important; height: 0 !important; }').catch(() => undefined)
    })
    let status = 0
    contents.on('did-navigate', (_event, _url, code) => {
      status = code
    })
    contents.on('console-message', (details) => {
      if (details.message.startsWith('%cElectron Security Warning')) return
      const source = shorten(details.sourceId)
      const where = source && details.level !== 'info' && details.level !== 'debug' ? ` (${source}:${details.lineNumber})` : ''
      pushLog(result.logs, LOG_LEVELS[details.level] ?? 'log', `${details.message}${where}`)
    })
    contents.on('render-process-gone', (_event, details) => {
      pushLog(result.logs, 'error', `The page crashed (${details.reason}).`)
    })
    // Failed subresource loads (a missing image or stylesheet) never reach console-message; the
    // DevTools protocol's log domain reports them.
    try {
      contents.debugger.attach('1.3')
      contents.debugger.on('message', (_event, method, params: { entry?: { source?: string; text?: string; url?: string } }) => {
        const entry = params.entry
        if (method !== 'Log.entryAdded' || entry?.source !== 'network' || !entry.text) return
        pushLog(result.logs, 'error', entry.url ? `${entry.text} (${shorten(entry.url)})` : entry.text)
      })
      // Not awaited: before the first navigation there is no renderer to answer yet.
      contents.debugger.sendCommand('Log.enable').catch(() => undefined)
    } catch {
      // Captures and scripts still work without it; only these log lines are lost.
    }

    await contents.loadURL(url.toString())
    if (status >= 400) throw new Error(`The page could not be loaded (HTTP ${status}).`)
    await runQuiet(contents, readyScript(READY_TIMEOUT_MS), READY_TIMEOUT_MS + 1000)
    await wait(clamp(request.settleMs ?? DEFAULT_SETTLE_MS, 0, 10_000))

    const takeShot = async (step: RenderStep, label: string): Promise<void> => {
      if (!result.sizes) result.sizes = []
      if (request.previewWidth && !result.previews) result.previews = []
      try {
        const image = await capture(window, step.selector ? { ...target, selector: step.selector } : target, scale)
        const encoded =
          request.format === 'jpeg' ? image.toJPEG(clamp(Math.round(request.quality ?? 80), 1, 100)) : image.toPNG()
        result.screenshots.push(encoded.toString('base64'))
        result.sizes.push(image.getSize())
        if (result.previews && request.previewWidth) {
          result.previews.push(preview(image, clamp(Math.round(request.previewWidth), 64, 4096)))
        }
      } catch (error) {
        result.screenshots.push('')
        result.sizes.push({ width: 0, height: 0 })
        result.previews?.push('')
        pushLog(result.logs, 'error', `${label}: ${messageOf(error)}`)
      }
    }

    const steps = (request.steps ?? []).slice(0, MAX_STEPS).map((step) => (typeof step === 'string' ? { code: step } : step))
    for (const [index, step] of steps.entries()) {
      if (step.code) {
        const outcome = await runScript(contents, step.code, scriptTimeout)
        if (!outcome.ok) pushLog(result.logs, 'error', `Step ${index + 1} failed: ${outcome.error}`)
        await runQuiet(contents, readyScript(STEP_READY_TIMEOUT_MS), STEP_READY_TIMEOUT_MS + 500)
      }
      if (step.delay) await wait(clamp(step.delay, 0, 30_000))
      if (request.screenshots) await takeShot(step, `Step ${index + 1}`)
    }

    if (request.script !== undefined) {
      const outcome = await runScript(contents, request.script, scriptTimeout)
      if (outcome.ok) result.scriptResult = parseJson(outcome.json)
      else result.scriptError = outcome.error
    }

    if (request.screenshots && steps.length === 0) await takeShot({}, 'Screenshot')

    if (request.pdf) result.pdf = (await printPdf(contents, request.pdfOptions ?? {}, width)).toString('base64')
  }
}
