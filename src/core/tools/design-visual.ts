import { existsSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { tool, type JSONValue, type ToolResultPart } from 'ai'
import { z } from 'zod'
import JSZip from 'jszip'
import pdfLib from 'pdf-lib'
import PptxGenJS from 'pptxgenjs'
import { previewUrl } from '../../shared/design-bridge'
import { readImageMetadata } from '../designs/image-metadata'
import { findMissingReferences, inlineHtml } from '../designs/inline-html'
import { realRoot, resolveInside, toProjectRelative } from '../fs/safe-path'
import type { RenderLog, RenderRequest, RenderResult } from '../render/types'
import type { ToolContext } from './context'
import { writeTracked } from './files'

const { PDFDocument } = pdfLib

type ToolResultOutput = ToolResultPart['output']

const DESKTOP = { width: 1440, height: 900 }
const VERIFY_VIEWPORTS = [
  { label: 'Desktop', width: 1440, height: 900, preview: 1000 },
  { label: 'Tablet', width: 834, height: 1112, preview: 700 },
  { label: 'Phone', width: 390, height: 844, preview: 390 }
]
const PREVIEW_WIDTH = 1000
const SMALL_PREVIEW_WIDTH = 720
/** view_image shows images at most this large on their long side. */
const VIEW_MAX_SIDE = 1000
/** Images sent to the model as they are, when no bigger than this. */
const VIEW_DIRECT_MAX_BYTES = 4 * 1024 * 1024
const HQ_MAX_SIDE = 2576
const MAX_SLEEP_SECONDS = 60
const MAX_TRACKED = 200
const MAX_ZIP_BYTES = 200 * 1024 * 1024
const MAX_ZIP_FILES = 5000
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'out', 'build'])
/** Providers whose AI SDK adapters pass tool-result images to the model; the others would send them as JSON text. */
const IMAGE_RESULT_PROVIDERS = new Set(['google', 'openai'])

const USER_VIEW_NOTE =
  "Deskmates can't reach the user's live preview pane from here: this loads the file the user was last shown (or, if unknown, the newest design page) fresh in an offscreen copy, so live state such as camera feeds, uploads or unsaved interaction is not there."

const PRINT_BASED =
  /<(deck-stage|doc-page)[\s>/]|component-from-global-scope\s*=\s*["'](deck-stage|doc-page)["']|<meta[^>]+name\s*=\s*["']omelette-owns-print["']/i
const PRINT_SOURCE_META = /<meta[^>]+name\s*=\s*["']omelette-print-source["']/i

/** Measures what ready_for_verification checks; runs in the page before the capture. */
const PROBE_SCRIPT = `(() => {
  const doc = document.documentElement
  const body = document.body
  const vw = doc.clientWidth || window.innerWidth
  const scrollWidth = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0)
  const scrollHeight = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0)
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
  const all = body ? Array.from(body.querySelectorAll('*')) : []
  const wide = []
  if (scrollWidth > vw + 1) {
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.right <= vw + 1) continue
      const parent = el.parentElement
      if (parent && parent !== body && parent.getBoundingClientRect().right > vw + 1) continue
      wide.push(name(el) + ' (right edge at ' + Math.round(r.right) + 'px)')
      if (wide.length >= 5) break
    }
  }
  const broken = Array.from(document.images)
    .filter((img) => img.complete && img.naturalWidth === 0 && img.naturalHeight === 0 && img.getAttribute('src'))
    .map((img) => img.getAttribute('src'))
    .slice(0, 10)
  const text = body ? body.innerText.trim() : ''
  const media = document.querySelectorAll('img, svg, canvas, video, picture, iframe, object, embed').length
  const shadowHosts = all.filter((el) => el.shadowRoot).length
  const root = document.getElementById('root')
  return {
    viewportWidth: vw,
    scrollWidth,
    scrollHeight,
    textLength: text.length,
    blank: text.length === 0 && media === 0 && shadowHosts === 0,
    emptyRoot: !!root && root.children.length === 0 && !root.textContent.trim(),
    overflow: scrollWidth > vw + 1,
    wide,
    broken
  }
})()`

interface Probe {
  viewportWidth: number
  scrollWidth: number
  scrollHeight: number
  textLength: number
  blank: boolean
  emptyRoot: boolean
  overflow: boolean
  wide: string[]
  broken: string[]
}

const SPEAKER_NOTES_SCRIPT = `(() => {
  const el = document.getElementById('speaker-notes')
  if (!el) return null
  try { return JSON.parse(el.textContent || 'null') } catch { return 'invalid' }
})()`

/** Prepares a deck for capture: hidden chrome, unscaled stage, extra fonts, swapped fonts. */
const DECK_SETUP = `async (opts) => {
  if (!document.getElementById('__dm_pptx_style')) {
    const style = document.createElement('style')
    style.id = '__dm_pptx_style'
    style.textContent = opts.hide.map((s) => s + ' { display: none !important; }').join('\\n')
    document.head.appendChild(style)
    for (const family of opts.fonts) {
      const base = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family).replace(/%20/g, '+')
      for (const weight of ['', ':wght@500', ':wght@600', ':wght@700']) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = base + weight + '&display=swap'
        document.head.appendChild(link)
      }
    }
  }
  if (opts.reset) {
    for (const el of document.querySelectorAll(opts.reset)) {
      el.setAttribute('noscale', '')
      el.style.transform = 'none'
      el.style.width = opts.width + 'px'
      el.style.height = opts.height + 'px'
    }
  }
  if (opts.swaps.length) {
    const escape = (text) => text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
    for (const el of document.querySelectorAll('*')) {
      const family = getComputedStyle(el).fontFamily
      let next = family
      for (const swap of opts.swaps) {
        next = next.replace(new RegExp('(^|,\\\\s*)["\\']?' + escape(swap.from) + '["\\']?(?=\\\\s*(,|$))', 'gi'), '$1"' + swap.to + '"')
      }
      if (next !== family) el.style.fontFamily = next
    }
  }
  await document.fonts.ready
}`

interface ToolImage {
  label: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
}

type VisualOutput = { [key: string]: unknown; images?: ToolImage[] }

/** The file each task last opened in its own offscreen preview, with that load's console output. */
const agentViews = new Map<string, { path: string; logs: RenderLog[] }>()
/** The file last shown in each design's preview pane, when a tool reported it. */
const userViews = new Map<string, string>()
/** PNGs kept by save_screenshot's in_memory_png_key, per design and key. */
const captureStore = new Map<string, Buffer[]>()
/** The verifier's last verdict per task. */
const verdicts = new Map<string, { verdict: 'done' | 'needs_work'; description?: string }>()

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string)
}

/** Records the file the user's preview pane now shows, so the *_user_view tools, gen_pptx and snapshot_element use it. */
export function noteUserView(projectId: string, path: string): void {
  remember(userViews, projectId, path)
}

/** PNGs save_screenshot stashed under `key` (for a script runner to read back). */
export function getCaptures(projectId: string, key: string): Buffer[] {
  return captureStore.get(`${projectId}:${key}`) ?? []
}

/** The last verdict verification_feedback recorded for a task. */
export function lastVerdict(taskId: string): { verdict: 'done' | 'needs_work'; description?: string } | undefined {
  return verdicts.get(taskId)
}

/** Text for every model; images as content parts only for providers that can receive them. */
function toModelOutput(output: VisualOutput, withImages: boolean): ToolResultOutput {
  const { images = [], ...rest } = output
  const shown = images.filter((image) => image.data)
  if (!withImages || shown.length === 0) {
    const note =
      shown.length > 0
        ? {
            images_not_shown:
              "Screenshots were taken, but this model's provider can't receive images from tools. Rely on the measurements and logs, or inspect the page with eval_js."
          }
        : {}
    return { type: 'json', value: JSON.parse(JSON.stringify({ ...rest, ...note })) as JSONValue }
  }
  return {
    type: 'content',
    value: [
      { type: 'text', text: JSON.stringify(rest) },
      ...shown.flatMap((image) => [
        { type: 'text' as const, text: image.label },
        { type: 'file' as const, mediaType: image.mediaType, data: { type: 'data' as const, data: image.data } }
      ])
    ]
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const formatLogs = (logs: RenderLog[], max = 40): string[] => logs.slice(0, max).map((log) => `[${log.level}] ${log.message}`)
const errorLines = (logs: RenderLog[], max = 15): string[] =>
  logs.filter((log) => log.level === 'error').slice(0, max).map((log) => log.message)

/** A file name without folders or characters Windows refuses. */
const safeName = (name: string, fallback: string): string => {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return cleaned || fallback
}

/** Time for a request with steps: the host's base allowance plus each step's delay and capture. */
const stepsTimeout = (delays: number[]): number =>
  Math.min(300_000, 30_000 + delays.reduce((sum, delay) => sum + delay + 1500, 0))

const stem = (path: string): string => basename(path).replace(/\.html?$/i, '')

export function designVisualTools(ctx: ToolContext) {
  const withImages = IMAGE_RESULT_PROVIDERS.has(ctx.modelRef.provider)
  const rel = (abs: string): string => toProjectRelative(ctx.root, abs)

  const cleanPath = (input: string): string => {
    const path = input.trim().replace(/\\/g, '/')
    if (/^\/?projects\//i.test(path)) throw new Error("Only files in this design's own folder can be used here.")
    return path.replace(/^\/+/, '')
  }

  const resolveFile = (path: string, html = false): { abs: string; rel: string } => {
    const abs = resolveInside(ctx.root, cleanPath(path))
    if (!existsSync(abs)) throw new Error(`Not found: ${path}`)
    if (!statSync(abs).isFile()) throw new Error(`Not a file: ${path}`)
    if (html && !/\.html?$/i.test(abs)) throw new Error(`${path} is not an HTML file.`)
    return { abs, rel: rel(abs) }
  }

  const pageUrl = (relPath: string, exportMode = true): string =>
    `${previewUrl(ctx.projectId, relPath.split('/').map(encodeURIComponent).join('/'))}${exportMode ? '?export=1' : ''}`

  const render = async (request: RenderRequest, signal?: AbortSignal): Promise<RenderResult> => {
    if (!ctx.render) {
      throw new Error(
        'Page rendering is not available: these tools need the Deskmates app window, and the assistant is running without it.'
      )
    }
    const result = await ctx.render.render(request, signal)
    if (result.error) {
      const errors = errorLines(result.logs, 5)
      throw new Error(errors.length ? `${result.error} Console errors: ${errors.join(' | ')}` : result.error)
    }
    return result
  }

  const images = (result: RenderResult, labels: string[]): ToolImage[] => {
    const previews = result.previews
    return (previews ?? result.screenshots).flatMap((data, index) =>
      data
        ? [{ label: labels[index] ?? `Capture ${index + 1}`, mediaType: previews ? ('image/jpeg' as const) : ('image/png' as const), data }]
        : []
    )
  }

  /** The newest of index.html and the .dc.html pages: what the preview most likely shows. */
  const newestPage = async (): Promise<string> => {
    const root = realRoot(ctx.root)
    const candidates: string[] = []
    if (existsSync(join(root, 'index.html'))) candidates.push(join(root, 'index.html'))
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory() && depth < 2 && !SKIP_DIRS.has(entry.name)) await walk(abs, depth + 1)
        else if (entry.isFile() && /\.dc\.html$/i.test(entry.name)) candidates.push(abs)
      }
    }
    await walk(root, 0)
    if (candidates.length === 0) throw new Error('There is no page to show yet: create index.html or a .dc.html file first.')
    const dated = await Promise.all(candidates.map(async (abs) => ({ abs, time: (await stat(abs)).mtimeMs })))
    dated.sort((a, b) => b.time - a.time)
    return rel(dated[0].abs)
  }

  const stillThere = (path: string | undefined): path is string =>
    !!path && existsSync(resolveInside(ctx.root, path))

  const agentViewPath = async (): Promise<string> => {
    const path = agentViews.get(ctx.taskId)?.path
    return stillThere(path) ? path : newestPage()
  }

  const userViewPath = async (): Promise<string> => {
    const path = userViews.get(ctx.projectId)
    return stillThere(path) ? path : newestPage()
  }

  const setAgentView = (path: string, logs: RenderLog[]): void => remember(agentViews, ctx.taskId, { path, logs })

  const evalIn = async (path: string, code: string, signal?: AbortSignal) => {
    const result = await render({ url: pageUrl(path), ...DESKTOP, script: code }, signal)
    return {
      path,
      ...(result.scriptError ? { error: result.scriptError } : { result: result.scriptResult ?? null }),
      console_errors: errorLines(result.logs)
    }
  }

  const screenshotOf = async (path: string, signal?: AbortSignal): Promise<VisualOutput> => {
    const result = await render({ url: pageUrl(path), ...DESKTOP, screenshots: true, previewWidth: PREVIEW_WIDTH }, signal)
    return {
      path,
      viewport: `${DESKTOP.width}x${DESKTOP.height}`,
      console_errors: errorLines(result.logs),
      images: images(result, [`${path} at ${DESKTOP.width}x${DESKTOP.height}`])
    }
  }

  return {
    show_html: tool({
      description:
        "Load an HTML file from the design folder in your own offscreen preview to check it; the user's view doesn't change. Set screenshot to true to see the page (1440x900) in this result. Each call loads the page fresh; get_webview_logs returns its console output.",
      inputSchema: z.object({
        path: z.string().describe('File path relative to the design folder'),
        screenshot: z.boolean().optional().describe('Return a screenshot of the loaded page in this result. Default false.')
      }),
      execute: async ({ path, screenshot = false }, { abortSignal }): Promise<VisualOutput> => {
        const file = resolveFile(path, true)
        setAgentView(file.rel, [])
        const result = await render(
          { url: pageUrl(file.rel), ...DESKTOP, screenshots: screenshot, previewWidth: PREVIEW_WIDTH },
          abortSignal
        )
        setAgentView(file.rel, result.logs)
        return {
          path: file.rel,
          loaded: true,
          console_errors: errorLines(result.logs),
          console_warnings: result.logs.filter((log) => log.level === 'warn').length,
          images: screenshot ? images(result, [`${file.rel} at 1440x900`]) : []
        }
      },
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    get_webview_logs: tool({
      description:
        'Console output and page errors (including files that failed to load) from the page last opened with show_html or a screenshot tool.',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        let state = agentViews.get(ctx.taskId)
        if (!state || !stillThere(state.path)) {
          const path = await agentViewPath()
          const result = await render({ url: pageUrl(path), ...DESKTOP }, abortSignal)
          state = { path, logs: result.logs }
          setAgentView(path, result.logs)
        }
        return { path: state.path, logs: formatLogs(state.logs), ...(state.logs.length ? {} : { note: 'No console output.' }) }
      }
    }),

    sleep: tool({
      description:
        'Wait up to 60 seconds. Every tool here loads its page fresh, so waiting does not move a later screenshot along an animation; use a step delay for that.',
      inputSchema: z.object({ seconds: z.number().describe('How long to wait, at most 60.') }),
      execute: async ({ seconds }, { abortSignal }) => {
        const ms = Math.round(clamp(seconds, 0, MAX_SLEEP_SECONDS) * 1000)
        await new Promise<void>((resolve, reject) => {
          if (abortSignal?.aborted) return reject(new Error('Stopped.'))
          const onAbort = (): void => {
            clearTimeout(timer)
            reject(new Error('Stopped.'))
          }
          const timer = setTimeout(() => {
            abortSignal?.removeEventListener('abort', onAbort)
            resolve()
          }, ms)
          abortSignal?.addEventListener('abort', onAbort, { once: true })
        })
        return { slept_seconds: ms / 1000 }
      }
    }),

    save_screenshot: tool({
      description:
        'Capture one or more states of an HTML page (1440x900) and save them: to files (save_path; several steps get 01-, 02- prefixes) or kept in memory as PNGs (in_memory_png_key). Each step can run JavaScript and wait before its capture; the steps run in order on one page load. Saved images also come back in this result. To only look at a page, use show_html with screenshot instead.',
      inputSchema: z.object({
        hq: z.boolean().optional().describe('Sharper capture at up to 2576px wide; PNG unless save_path ends in .jpg. Default false.'),
        in_memory_png_key: z.string().optional().describe('Keep the captures as PNGs under this key instead of saving files.'),
        path: z.string().describe('HTML file to capture, relative to the design folder'),
        return_images: z.boolean().optional().describe('Return the images in this result (up to 4; first 2 and last 2 beyond that). Default true.'),
        save_path: z.string().optional().describe('Where to save, relative to the design folder, ending in .png or .jpg'),
        steps: z
          .array(
            z.object({
              code: z.string().optional().describe('JavaScript to run before this capture.'),
              delay: z.number().optional().describe('Milliseconds to wait before capturing. Default 50, or 200 after code.')
            })
          )
          .max(100)
          .describe('Capture steps (max 100)')
      }),
      execute: async (
        { hq = false, in_memory_png_key, path, return_images = true, save_path, steps },
        { abortSignal }
      ): Promise<VisualOutput> => {
        if (!!save_path === !!in_memory_png_key) throw new Error('Give exactly one of save_path or in_memory_png_key.')
        const file = resolveFile(path, true)
        let format: 'png' | 'jpeg' = 'png'
        let target: string | null = null
        if (save_path) {
          target = resolveInside(ctx.root, cleanPath(save_path))
          const ext = extname(target).toLowerCase()
          if (ext === '.jpg' || ext === '.jpeg') format = 'jpeg'
          else if (ext !== '.png') throw new Error('save_path must end in .png or .jpg.')
        }
        const sharp = hq || !!in_memory_png_key
        const renderSteps = (steps.length > 0 ? steps : [{}]).map((step: { code?: string; delay?: number }) => ({
          ...(step.code ? { code: step.code } : {}),
          delay: step.delay ?? (step.code ? 200 : 50)
        }))
        const result = await render(
          {
            url: pageUrl(file.rel),
            ...DESKTOP,
            scale: sharp ? Math.min(2, HQ_MAX_SIDE / DESKTOP.width) : 1,
            steps: renderSteps,
            screenshots: true,
            format,
            quality: sharp ? 92 : 70,
            ...(return_images ? { previewWidth: renderSteps.length > 2 ? SMALL_PREVIEW_WIDTH : PREVIEW_WIDTH } : {}),
            timeoutMs: stepsTimeout(renderSteps.map((step) => step.delay))
          },
          abortSignal
        )
        setAgentView(file.rel, result.logs)

        const count = result.screenshots.length
        const pick = (index: number): boolean => count <= 4 || index < 2 || index >= count - 2
        const labels = result.screenshots.map((_, index) => `Step ${index + 1}`)
        const shown = return_images ? images(result, labels).filter((image) => pick(labels.indexOf(image.label))) : []
        const failed = result.screenshots.flatMap((data, index) => (data ? [] : [index + 1]))
        const common = {
          path: file.rel,
          sizes: result.sizes ?? [],
          ...(failed.length ? { failed_steps: failed } : {}),
          console_errors: errorLines(result.logs)
        }

        if (in_memory_png_key) {
          const buffers = result.screenshots.filter(Boolean).map((data) => Buffer.from(data, 'base64'))
          remember(captureStore, `${ctx.projectId}:${in_memory_png_key}`, buffers)
          return { ...common, key: in_memory_png_key, captures: buffers.length, images: shown }
        }

        const saved: string[] = []
        for (const [index, data] of result.screenshots.entries()) {
          if (!data || !target) continue
          const abs =
            count === 1 ? target : join(dirname(target), `${String(index + 1).padStart(2, '0')}-${basename(target)}`)
          saved.push((await writeTracked(ctx, abs, Buffer.from(data, 'base64'))).path)
        }
        return { ...common, saved, images: shown }
      },
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    multi_screenshot: tool({
      description:
        'Look at several states of an HTML page (1440x900) in one call: each step runs JavaScript, waits, then captures. The steps run in order on one fresh page load. Nothing is saved. Max 12 steps.',
      inputSchema: z.object({
        path: z.string().describe('HTML file relative to the design folder'),
        steps: z
          .array(
            z.object({
              code: z.string().describe('JavaScript to run before this capture.'),
              delay: z.number().optional().describe('Milliseconds to wait after the code before capturing. Default 200.')
            })
          )
          .min(1)
          .max(12)
          .describe('Capture steps')
      }),
      execute: async ({ path, steps }, { abortSignal }): Promise<VisualOutput> => {
        const file = resolveFile(path, true)
        const renderSteps = steps.map((step) => ({ code: step.code, delay: step.delay ?? 200 }))
        const result = await render(
          {
            url: pageUrl(file.rel),
            ...DESKTOP,
            steps: renderSteps,
            screenshots: true,
            format: 'jpeg',
            quality: 50,
            previewWidth: steps.length > 2 ? SMALL_PREVIEW_WIDTH : PREVIEW_WIDTH,
            timeoutMs: stepsTimeout(renderSteps.map((step) => step.delay))
          },
          abortSignal
        )
        setAgentView(file.rel, result.logs)
        return {
          path: file.rel,
          captures: result.screenshots.filter(Boolean).length,
          console_errors: errorLines(result.logs),
          images: images(
            result,
            steps.map((_, index) => `Step ${index + 1}`)
          )
        }
      },
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    eval_js: tool({
      description:
        'Run JavaScript in the page last opened with show_html (or the newest design page) and return the last expression\'s value as JSON. The page is loaded fresh for each call, so put setup and checks in one snippet and return an object with everything you need. Time limit 10 seconds.',
      inputSchema: z.object({
        code: z.string().describe("JavaScript to run. The last expression's value is returned."),
        purpose: z.string().optional().describe('Short label for what this check is doing, shown to the user.')
      }),
      execute: async ({ code }, { abortSignal }) => evalIn(await agentViewPath(), code, abortSignal)
    }),

    screenshot: tool({
      description: 'Screenshot an HTML page (1440x900 viewport) and see it in this result. Loads the page fresh.',
      inputSchema: z.object({ path: z.string().describe('HTML file relative to the design folder') }),
      execute: async ({ path }, { abortSignal }) => {
        const file = resolveFile(path, true)
        const output = await screenshotOf(file.rel, abortSignal)
        setAgentView(file.rel, [])
        return output
      },
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    eval_js_user_view: tool({
      description: `Run JavaScript in the page the user is looking at and return the last expression's value. ${USER_VIEW_NOTE} For ordinary checks use eval_js.`,
      inputSchema: z.object({
        code: z.string().describe("JavaScript to run. The last expression's value is returned."),
        purpose: z.string().optional().describe('Short label for what this check is doing, shown to the user.')
      }),
      execute: async ({ code }, { abortSignal }) => evalIn(await userViewPath(), code, abortSignal)
    }),

    screenshot_user_view: tool({
      description: `Screenshot the page the user is looking at. ${USER_VIEW_NOTE}`,
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => screenshotOf(await userViewPath(), abortSignal),
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    snapshot_element: tool({
      description: `Capture one element of the page the user is looking at as a PNG (first match of a CSS selector), saved into the design folder: save_to_project_path, or exports/<filename>.png with the user told where it is. ${USER_VIEW_NOTE}`,
      inputSchema: z.object({
        filename: z.string().optional().describe("File name without extension for exports/. Default 'snapshot'."),
        save_to_project_path: z.string().optional().describe('Where to save, relative to the design folder, ending in .png'),
        scale: z.number().optional().describe('Resolution multiplier: 0.5, 1, 2, 3 or 4. Default 2.'),
        selector: z.string().describe('CSS selector; the first match is captured.')
      }),
      execute: async ({ filename, save_to_project_path, scale = 2, selector }, { abortSignal }): Promise<VisualOutput> => {
        let target: string
        if (save_to_project_path) {
          if (!/\.png$/i.test(save_to_project_path)) throw new Error('save_to_project_path must end in .png.')
          target = resolveInside(ctx.root, cleanPath(save_to_project_path))
        } else {
          target = resolveInside(ctx.root, `exports/${safeName(filename ?? '', 'snapshot')}.png`)
        }
        const page = await userViewPath()
        const factor = clamp(scale, 0.5, 4)
        const result = await render(
          { url: pageUrl(page), ...DESKTOP, selector, scale: factor, screenshots: true, format: 'png', previewWidth: PREVIEW_WIDTH },
          abortSignal
        )
        const data = result.screenshots[0]
        if (!data) throw new Error(errorLines(result.logs).join(' ') || `Could not capture ${selector}.`)
        const written = await writeTracked(ctx, target, Buffer.from(data, 'base64'))
        if (!save_to_project_path) ctx.onNotify('Snapshot saved', `${written.path} is in the design folder.`)
        const size = result.sizes?.[0]
        return {
          page,
          path: written.path,
          ...(size ? { width: size.width, height: size.height } : {}),
          scale: factor,
          images: images(result, [`${selector} from ${page}`])
        }
      },
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    view_image: tool({
      description:
        'Look at an image file in the design folder (PNG, JPEG, GIF, WebP, BMP or SVG), shown at most 1000px on its long side. Images from other projects are not available.',
      inputSchema: z.object({ path: z.string().describe('Image file path relative to the design folder') }),
      execute: async ({ path }, { abortSignal }): Promise<VisualOutput> => {
        const file = resolveFile(path)
        const data = await readFile(file.abs)
        const meta = readImageMetadata(data)
        const width = meta.width ?? 0
        const height = meta.height ?? 0
        const longSide = Math.max(width, height)
        const summary = { path: file.rel, format: meta.format, width: meta.width, height: meta.height }
        const direct =
          (meta.format === 'png' || meta.format === 'jpeg' || meta.format === 'webp') &&
          longSide > 0 &&
          longSide <= VIEW_MAX_SIDE &&
          data.length <= VIEW_DIRECT_MAX_BYTES
        if (direct) {
          const mediaType = meta.format === 'jpeg' ? 'image/jpeg' : meta.format === 'webp' ? 'image/webp' : 'image/png'
          return { ...summary, images: [{ label: file.rel, mediaType, data: data.toString('base64') }] }
        }
        // Rendered by the host: the viewport matches the image and the scale factor shrinks (or enlarges) it.
        const natural = longSide > 0 ? { width, height } : { width: 1000, height: 1000 }
        const fitted = Math.max(natural.width, natural.height) > 4096 ? 4096 / Math.max(natural.width, natural.height) : 1
        const viewport = {
          width: Math.max(100, Math.round(natural.width * fitted)),
          height: Math.max(100, Math.round(natural.height * fitted))
        }
        const longViewport = Math.max(viewport.width, viewport.height)
        const scale = clamp(longViewport > VIEW_MAX_SIDE ? VIEW_MAX_SIDE / longViewport : Math.min(4, 500 / longViewport), 0.25, 4)
        const result = await render(
          { url: pageUrl(file.rel, false), ...viewport, scale, settleMs: 100, screenshots: true, format: 'jpeg', quality: 85 },
          abortSignal
        )
        const size = result.sizes?.[0]
        return {
          ...summary,
          ...(size ? { shown_at: `${size.width}x${size.height}` } : {}),
          images: result.screenshots[0] ? [{ label: file.rel, mediaType: 'image/jpeg', data: result.screenshots[0] }] : []
        }
      },
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    image_metadata: tool({
      description:
        'Read an image file\'s size, format, whether the format and the file support transparency, whether any pixel is actually transparent (decoded for PNG, BMP; null when unknown), and whether it is animated with its frame count. PNG, JPEG, GIF, WebP, BMP and SVG.',
      inputSchema: z.object({ path: z.string().describe('Image file path relative to the design folder') }),
      execute: async ({ path }) => {
        const file = resolveFile(path)
        const data = await readFile(file.abs)
        return { path: file.rel, bytes: data.length, ...readImageMetadata(data) }
      }
    }),

    ready_for_verification: tool({
      description:
        "Call when a piece of work is finished. Opens the file in the user's preview, then checks it at 1440, 834 and 390px wide: console errors, missing local files, a blank page or empty #root, horizontal overflow and broken images. Returns the findings and a screenshot per width; fix what it reports. No separate verifier runs in Deskmates.",
      inputSchema: z.object({
        path: z.string().describe('HTML file to show to the user'),
        skip_verifier_agent: z
          .boolean()
          .optional()
          .describe('For minor changes: check only at 1440px, without screenshots. The file is still opened for the user.')
      }),
      execute: async ({ path, skip_verifier_agent = false }, { abortSignal }): Promise<VisualOutput> => {
        const file = resolveFile(path, true)
        ctx.showInPreview?.(file.rel)
        noteUserView(ctx.projectId, file.rel)

        const findings: string[] = []
        for (const missing of await findMissingReferences(ctx.root, file.abs)) {
          findings.push(`Missing file: ${missing} is referenced but doesn't exist.`)
        }
        const consoleErrors = new Set<string>()
        const broken = new Set<string>()
        const checked: Array<Record<string, unknown>> = []
        const shots: ToolImage[] = []
        let blankReported = false

        for (const viewport of skip_verifier_agent ? VERIFY_VIEWPORTS.slice(0, 1) : VERIFY_VIEWPORTS) {
          const result = await render(
            {
              url: pageUrl(file.rel),
              width: viewport.width,
              height: viewport.height,
              script: PROBE_SCRIPT,
              screenshots: !skip_verifier_agent,
              fullPage: true,
              maxHeight: viewport.height * 2,
              format: 'jpeg',
              quality: 50,
              previewWidth: viewport.preview
            },
            abortSignal
          )
          for (const message of errorLines(result.logs, 50)) consoleErrors.add(message)
          const probe = result.scriptResult as Probe | undefined
          if (!probe) {
            findings.push(`Could not inspect the page at ${viewport.width}px: ${result.scriptError ?? 'no result'}`)
          } else {
            if (probe.emptyRoot && !blankReported) {
              findings.push("#root is empty: the page's app didn't render.")
              blankReported = true
            } else if (probe.blank && !blankReported) {
              findings.push('The page looks blank: no text, images or components rendered.')
              blankReported = true
            }
            if (probe.overflow) {
              findings.push(
                `Horizontal overflow at ${viewport.width}px: the page is ${probe.scrollWidth}px wide.` +
                  (probe.wide.length ? ` Sticking out: ${probe.wide.join(', ')}.` : '')
              )
            }
            for (const src of probe.broken) broken.add(src)
            checked.push({
              width: viewport.width,
              page_height: probe.scrollHeight,
              text_characters: probe.textLength,
              horizontal_overflow: probe.overflow
            })
          }
          shots.push(...images(result, [`${viewport.label} ${viewport.width}px`]))
        }
        for (const src of broken) findings.push(`Broken image: ${src}`)
        findings.unshift(...[...consoleErrors].slice(0, 10).map((message) => `Console error: ${message}`))

        return {
          path: file.rel,
          shown_to_user: true,
          ok: findings.length === 0,
          findings,
          checked,
          next:
            findings.length > 0
              ? 'Fix these problems, then call ready_for_verification again.'
              : 'No problems found. Look over the screenshots before you finish.',
          images: shots
        }
      },
      toModelOutput: ({ output }) => toModelOutput(output, withImages)
    }),

    verification_feedback: tool({
      description:
        "Record the verification verdict once checking is done: 'done' when the output is right, 'needs_work' with a specific description of real problems.",
      inputSchema: z.object({
        description: z.string().optional().describe('Required for needs_work: what is broken and how you know.'),
        verdict: z.enum(['done', 'needs_work'])
      }),
      execute: async ({ description, verdict }) => {
        if (verdict === 'needs_work' && !description?.trim()) {
          throw new Error('Describe what needs fixing when the verdict is needs_work.')
        }
        remember(verdicts, ctx.taskId, { verdict, ...(description?.trim() ? { description: description.trim() } : {}) })
        return { recorded: true, verdict, ...(description?.trim() ? { description: description.trim() } : {}) }
      }
    }),

    gen_pptx: tool({
      description: `Export the deck the user is looking at to a .pptx, one full-slide picture per slide (editable text export isn't available in Deskmates), saved into the design folder: save_to_project_path, or exports/<filename>.pptx with the user told where it is. Speaker notes come from <script type="application/json" id="speaker-notes">. Returns flags to check: duplicate_adjacent (showJs probably didn't change slide), slide_size_mismatch (wrong selector or the deck is still scaled), no_speaker_notes. ${USER_VIEW_NOTE}`,
      inputSchema: z.object({
        filename: z.string().optional().describe("File name without extension. Default 'deck'."),
        fontSwaps: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .optional()
          .describe('Font families to replace before capture.'),
        googleFontImports: z.array(z.string()).optional().describe('Google Font families to load before capture.'),
        height: z.number().describe('Slide height in CSS px (e.g. 1080).'),
        hideSelectors: z.array(z.string()).optional().describe('Selectors to hide before capture: nav arrows, progress bars…'),
        mode: z.enum(['editable', 'screenshots']).optional().describe("Only 'screenshots' is available; 'editable' falls back to it."),
        offer_google_slides: z.boolean().optional().describe('Not available in Deskmates; ignored.'),
        resetTransformSelector: z
          .string()
          .optional()
          .describe('Element to unscale and force to width x height before capture (for <deck-stage>, pass "deck-stage").'),
        save_to_project_path: z.string().optional().describe("Where to save, relative to the design folder (e.g. 'export/deck.pptx')."),
        slides: z
          .array(
            z.object({
              delay: z.number().optional().describe('Milliseconds to wait after showJs. Default 600.'),
              selector: z.string().describe("CSS selector for this slide's root element."),
              showJs: z.string().optional().describe('JavaScript that shows this slide, e.g. "goToSlide(0)".')
            })
          )
          .min(1)
          .max(200)
          .describe('One entry per slide, in order.'),
        width: z.number().describe('Slide width in CSS px (e.g. 1920).')
      }),
      execute: async (input, { abortSignal }) => {
        const width = Math.round(clamp(input.width, 100, 4096))
        const height = Math.round(clamp(input.height, 100, 4096))
        let target: string
        if (input.save_to_project_path) {
          if (!/\.pptx$/i.test(input.save_to_project_path)) throw new Error('save_to_project_path must end in .pptx.')
          target = resolveInside(ctx.root, cleanPath(input.save_to_project_path))
        } else {
          target = resolveInside(ctx.root, `exports/${safeName(input.filename ?? '', 'deck')}.pptx`)
        }
        const page = await userViewPath()
        const scale = clamp(1920 / width, 1, 2)
        const options = JSON.stringify({
          hide: input.hideSelectors ?? [],
          fonts: input.googleFontImports ?? [],
          reset: input.resetTransformSelector ?? null,
          swaps: input.fontSwaps ?? [],
          width,
          height
        })
        const steps = input.slides.map((slide) => ({
          code: `await (${DECK_SETUP})(${options});\n${slide.showJs ?? ''}`,
          delay: clamp(slide.delay ?? 600, 0, 30_000),
          selector: slide.selector
        }))
        const result = await render(
          {
            url: pageUrl(page),
            width,
            height,
            scale,
            steps,
            screenshots: true,
            format: 'png',
            script: SPEAKER_NOTES_SCRIPT,
            timeoutMs: stepsTimeout(steps.map((step) => step.delay))
          },
          abortSignal
        )

        const rawNotes = result.scriptResult
        const notes = Array.isArray(rawNotes)
          ? rawNotes.map((item: unknown) =>
              typeof item === 'string' ? item : typeof item === 'object' && item ? String((item as { notes?: unknown }).notes ?? '') : ''
            )
          : []
        const pptx = new PptxGenJS()
        pptx.defineLayout({ name: 'DESKMATES', width: width / 144, height: height / 144 })
        pptx.layout = 'DESKMATES'
        const expected = { width: Math.round(width * scale), height: Math.round(height * scale) }
        const duplicates: number[] = []
        const mismatched: Array<{ slide: number; size: string }> = []
        const failed: number[] = []
        result.screenshots.forEach((data, index) => {
          const slide = pptx.addSlide()
          if (data) {
            slide.addImage({ data: `data:image/png;base64,${data}`, x: 0, y: 0, w: width / 144, h: height / 144 })
          } else {
            failed.push(index + 1)
          }
          if (notes[index]) slide.addNotes(notes[index])
          if (data && index > 0 && data === result.screenshots[index - 1]) duplicates.push(index + 1)
          const size = result.sizes?.[index]
          if (data && size && (Math.abs(size.width - expected.width) > 2 || Math.abs(size.height - expected.height) > 2)) {
            mismatched.push({ slide: index + 1, size: `${Math.round(size.width / scale)}x${Math.round(size.height / scale)}` })
          }
        })
        const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
        const written = await writeTracked(ctx, target, buffer)
        if (!input.save_to_project_path) ctx.onNotify('Presentation saved', `${written.path} is in the design folder.`)
        return {
          path: written.path,
          page,
          slides: input.slides.length,
          mode: 'screenshots',
          flags: {
            duplicate_adjacent: duplicates,
            slide_size_mismatch: mismatched,
            no_speaker_notes: notes.every((note) => !note),
            failed_slides: failed
          },
          ...(input.mode === 'editable' ? { note: 'Editable export is not available; each slide is a picture.' } : {}),
          console_errors: errorLines(result.logs)
        }
      }
    }),

    super_inline_html: tool({
      description:
        'Bundle an HTML file with its local stylesheets, scripts, images, fonts and media (as data URIs) into one self-contained file written to the design folder. Web links (https://…) stay links. Reports missing files and anything left unbundled.',
      inputSchema: z.object({
        input_path: z.string().describe('HTML file to bundle, relative to the design folder'),
        output_path: z.string().describe('Where to write the bundled file, relative to the design folder')
      }),
      execute: async ({ input_path, output_path }) => {
        const input = resolveFile(input_path, true)
        const output = resolveInside(ctx.root, cleanPath(output_path))
        if (!/\.html?$/i.test(output)) throw new Error('output_path must end in .html.')
        if (output === input.abs) throw new Error('Write the bundle to a different file than its source.')
        const report = await inlineHtml(ctx.root, input.abs)
        const written = await writeTracked(ctx, output, report.html)
        return {
          path: written.path,
          size_bytes: Buffer.byteLength(report.html),
          inlined: report.inlined,
          missing: report.missing,
          skipped: report.skipped
        }
      }
    }),

    bundle_project: tool({
      description:
        'Bundle an HTML design into one self-contained file (like super_inline_html) saved next to it as <name>.bundle.html. Deskmates has no public hosting, so no URL is created: the result gives the file\'s location on this PC.',
      inputSchema: z.object({ input_path: z.string().describe('HTML file to bundle, relative to the design folder') }),
      execute: async ({ input_path }) => {
        const input = resolveFile(input_path, true)
        const output = join(dirname(input.abs), `${stem(input.abs)}.bundle.html`)
        const report = await inlineHtml(ctx.root, input.abs)
        const written = await writeTracked(ctx, output, report.html)
        return {
          url: null,
          bundled_path: written.path,
          local_path: output,
          size_bytes: Buffer.byteLength(report.html),
          expires_at: null,
          inlined: report.inlined,
          missing: report.missing,
          skipped: report.skipped,
          note: 'Deskmates has no public file hosting, so there is no URL to give another service. The self-contained file is at local_path; the user can upload or share it themselves.'
        }
      }
    }),

    show_pdf_export_dialog: tool({
      description:
        'Export an HTML file to PDF, saved next to it in the design folder (Deskmates has no print dialog; the user is told where the PDF is). Only for print-ready documents: built on <deck-stage> or <doc-page>, or declaring <meta name="omelette-owns-print">. A -print copy must carry <meta name="omelette-print-source">. allow_non_print_document exports any other page as one PDF page sized to the design.',
      inputSchema: z.object({
        allow_non_print_document: z
          .boolean()
          .optional()
          .describe('Export a page that is not print-ready anyway, as one page the size of the rendered design.'),
        project_relative_file_path: z.string().describe('HTML file relative to the design folder')
      }),
      execute: async ({ allow_non_print_document = false, project_relative_file_path }, { abortSignal }) => {
        const file = resolveFile(project_relative_file_path, true)
        const html = await readFile(file.abs, 'utf8')
        const printBased = PRINT_BASED.test(html)
        if (/-print(\.dc)?\.html?$/i.test(file.abs) && !PRINT_SOURCE_META.test(html)) {
          throw new Error(
            `${file.rel} is a -print copy without its <meta name="omelette-print-source"> stamp. Regenerate it from a fresh read of its source.`
          )
        }
        if (!printBased && !allow_non_print_document) {
          throw new Error(
            `${file.rel} is not print-ready: it has no <deck-stage> or <doc-page> and no <meta name="omelette-owns-print">. Make it print-based first, or set allow_non_print_document to export it as it looks on screen.`
          )
        }
        const result = await render(
          {
            url: pageUrl(file.rel),
            ...DESKTOP,
            settleMs: 500,
            pdf: true,
            pdfOptions: printBased ? { preferCSSPageSize: true, noMargins: true } : { fitToContent: true },
            timeoutMs: 60_000
          },
          abortSignal
        )
        if (!result.pdf) throw new Error('The page could not be printed to PDF.')
        const bytes = Buffer.from(result.pdf, 'base64')
        const pages = (await PDFDocument.load(bytes)).getPageCount()
        const target = join(dirname(file.abs), `${stem(file.abs).replace(/-print(\.dc)?$/i, '').replace(/\.dc$/i, '')}.pdf`)
        const written = await writeTracked(ctx, target, bytes)
        ctx.onNotify('PDF saved', `${written.path} is in the design folder.`)
        return {
          path: written.path,
          local_path: target,
          pages,
          size_bytes: bytes.length,
          print_based: printBased,
          console_errors: errorLines(result.logs),
          note: 'Saved into the design folder instead of opening a print dialog; the user has been told where it is.'
        }
      }
    }),

    present_fs_item_for_download: tool({
      description:
        "Hand a file, a folder or the whole design to the user. Deskmates has no download cards: a file is pointed out to the user where it is; a folder (or the whole design, when path is empty) is zipped into downloads/<name>.zip and the user is told where it is.",
      inputSchema: z.object({
        label: z.string().optional().describe('Name to show the user (defaults to the item name or "Project").'),
        origin: z.string().optional().describe('Which export flow produced this, when it is a fallback.'),
        path: z.string().optional().describe('File or folder relative to the design folder; omit or "" for the whole design.')
      }),
      execute: async ({ label, path = '' }) => {
        const root = realRoot(ctx.root)
        const target = path.trim() ? resolveInside(ctx.root, cleanPath(path)) : root
        if (!existsSync(target)) throw new Error(`Not found: ${path}`)
        const info = await stat(target)
        const name = safeName(label ?? '', path.trim() ? basename(target) : 'Project')
        if (info.isFile()) {
          ctx.onNotify('Ready to download', `${name}: ${target}`)
          return { path: rel(target), local_path: target, size_bytes: info.size, note: 'The user was told where the file is.' }
        }

        const downloads = join(root, 'downloads')
        const zip = new JSZip()
        let files = 0
        let total = 0
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const abs = join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.has(entry.name) && abs !== downloads) await walk(abs)
            } else if (entry.isFile()) {
              const data = await readFile(abs)
              files++
              total += data.length
              if (files > MAX_ZIP_FILES || total > MAX_ZIP_BYTES) {
                throw new Error(`This folder is too big to zip here (over ${MAX_ZIP_FILES} files or ${MAX_ZIP_BYTES / 1024 / 1024} MB).`)
              }
              zip.file(relative(target, abs).split('\\').join('/'), data)
            }
          }
        }
        await walk(target)
        const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
        const zipPath = join(downloads, `${name}.zip`)
        const written = await writeTracked(ctx, zipPath, buffer)
        ctx.onNotify('Ready to download', `${name}.zip is in the design folder: ${zipPath}`)
        return { path: written.path, local_path: zipPath, files, size_bytes: buffer.length }
      }
    }),

    get_public_file_url: tool({
      description:
        "Deskmates has no public file hosting, so this never returns a URL; it confirms the file exists and gives its location on this PC so the user can upload or share it themselves.",
      inputSchema: z.object({ project_relative_file_path: z.string().describe('File relative to the design folder') }),
      execute: async ({ project_relative_file_path }) => {
        const file = resolveFile(project_relative_file_path)
        return {
          url: null,
          path: file.rel,
          local_path: file.abs,
          note: 'There is no public URL in Deskmates. Tell the user the file is at local_path if they need to upload it somewhere.'
        }
      }
    }),

    export_video: tool({
      description:
        'Record an animated page of this design to a video file (MP4, WebM or GIF), frame by frame, so every frame is exact. Use it to deliver motion graphics or animated videos. A page built on the motion-stage engine (copy_starter_component "animations_v3.jsx") declares its own size, frame rate and length; otherwise give them, or the length of the page’s CSS animations is used. The file is saved in the design folder (exports/ by default).',
      inputSchema: z.object({
        path: z.string().describe('The .html or .dc.html page to record, relative to the design folder.'),
        format: z.enum(['mp4', 'webm', 'gif']).optional().describe('Defaults to mp4.'),
        width: z.number().int().min(16).max(3840).optional(),
        height: z.number().int().min(16).max(3840).optional(),
        fps: z.number().int().min(1).max(60).optional(),
        duration: z.number().positive().max(300).optional().describe('Length in seconds.'),
        output: z.string().optional().describe('Where to save, relative to the design folder, e.g. "exports/Launch.mp4".')
      }),
      execute: async ({ path, format = 'mp4', width, height, fps, duration, output }, { abortSignal }) => {
        if (!ctx.render?.recordVideo) throw new Error('Video recording needs the Deskmates app window.')
        const page = resolveFile(path, true)
        const base = basename(page.rel).replace(/\.(dc\.)?html?$/i, '') || 'video'
        const target = (output?.trim() || `exports/${base}.${format}`).replace(/\\/g, '/')
        if (!target.toLowerCase().endsWith(`.${format}`)) throw new Error(`output must end in .${format}.`)
        const out = resolveInside(ctx.root, cleanPath(target))
        const result = await ctx.render.recordVideo(
          { url: previewUrl(ctx.projectId, page.rel.split('/').map(encodeURIComponent).join('/')), out, format, width, height, fps, duration },
          abortSignal
        )
        ctx.onChangesUpdated()
        return {
          path: rel(result.path),
          format: result.format,
          size: `${result.width}x${result.height}`,
          fps: result.fps,
          seconds: Number(result.duration.toFixed(2)),
          frames: result.frames,
          note: 'Tell the user where the video is; present_fs_item_for_download offers it as a download.'
        }
      }
    })
  }
}
