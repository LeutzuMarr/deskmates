/**
 * Offscreen page rendering, done by the Electron host (the core has no browser of its own). The core
 * asks for a page to be loaded in a hidden window and gets back screenshots, the result of a script,
 * console output or a PDF.
 */
export interface RenderRequest {
  /** What to load: a `deskmates-preview://design/<projectId>/<file>` URL. */
  url: string
  /** Viewport size in CSS pixels. Defaults to 1440×900. */
  width?: number
  height?: number
  /** Extra wait after load, for fonts and animations to settle. */
  settleMs?: number
  /**
   * Scripts run one after another; after each, a screenshot is taken when `screenshots` is set. A step
   * can also wait before its capture and capture a single element instead of the request's target.
   */
  steps?: Array<string | RenderStep>
  /** Script to run after load (and after `steps`); its awaited, JSON-serialisable value is returned. */
  script?: string
  /**
   * Take screenshots: one after each step, or one after load when there are no steps (taken after
   * `script` runs, so the script measures the page at the requested viewport).
   */
  screenshots?: boolean
  /** Capture the whole page height instead of just the viewport. */
  fullPage?: boolean
  /** Tallest full-page capture in CSS pixels. Defaults to 8000. */
  maxHeight?: number
  /** Capture only the first element matching this CSS selector. */
  selector?: string
  /** Device scale factor for captures (0.25–4). */
  scale?: number
  /** Encoding of `screenshots`. Defaults to PNG. */
  format?: 'png' | 'jpeg'
  /** JPEG quality, 1–100. Defaults to 80. */
  quality?: number
  /** Also return a small JPEG copy of each capture, at most this many pixels wide, for a model to look at. */
  previewWidth?: number
  /** Print the page to PDF instead of (or as well as) screenshots. */
  pdf?: boolean
  pdfOptions?: RenderPdfOptions
  /** Time limit for each script and step, in milliseconds. Defaults to 10 s. */
  scriptTimeoutMs?: number
  /** Time limit for the whole request, in milliseconds. Defaults to 30 s. */
  timeoutMs?: number
}

export interface RenderStep {
  /** Script run before the capture, awaited like `script`. */
  code?: string
  /** Wait after the code and before the capture, in milliseconds. */
  delay?: number
  /** Capture only this element for this step. */
  selector?: string
}

export interface RenderPdfOptions {
  /** Use the page's own CSS `@page` size (for print-ready documents). */
  preferCSSPageSize?: boolean
  /** One page exactly as large as the rendered content. */
  fitToContent?: boolean
  /** A named paper size, or a size in CSS pixels. */
  pageSize?: 'A4' | 'Letter' | { width: number; height: number }
  landscape?: boolean
  /** No page margins instead of Chromium's default 1 cm. */
  noMargins?: boolean
}

export interface RenderLog {
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface RenderResult {
  /** Base64 images in the requested format, in order. An empty string marks a capture that failed (see `logs`). */
  screenshots: string[]
  /** Pixel size of each screenshot. */
  sizes?: Array<{ width: number; height: number }>
  /** Base64 JPEG copies of the screenshots, when `previewWidth` was set. */
  previews?: string[]
  /** The script's value, JSON-serialised. */
  scriptResult?: unknown
  /** Set when `script` threw or timed out. */
  scriptError?: string
  /** Base64 PDF when `pdf` was requested. */
  pdf?: string
  /** Console output and page errors collected while the page ran. */
  logs: RenderLog[]
  /** Set when the page couldn't be loaded or the request failed. */
  error?: string
}

export type VideoFormat = 'mp4' | 'webm' | 'gif'

/** Records a design page to a video file. Unset sizes, rate and length come from the page's
 *  `window.__deskmatesVideo` (the motion-stage engine sets it), then from its CSS animations. */
export interface VideoRequest {
  /** A `deskmates-preview://design/<projectId>/<file>` URL. */
  url: string
  format?: VideoFormat
  width?: number
  height?: number
  fps?: number
  /** Length in seconds. */
  duration?: number
}

export interface VideoResult {
  path: string
  format: VideoFormat
  width: number
  height: number
  fps: number
  duration: number
  frames: number
}

export interface RenderClient {
  render(request: RenderRequest, signal?: AbortSignal): Promise<RenderResult>
  /** Records `request` into `out`, a path inside the design folder. Absent when there is no host. */
  recordVideo?(request: VideoRequest & { out: string }, signal?: AbortSignal): Promise<VideoResult>
}
