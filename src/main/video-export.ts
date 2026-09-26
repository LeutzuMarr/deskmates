/**
 * Records a design page to a video file. The page is loaded offscreen with its clock taken over
 * (see video-clock.ts), stepped one frame at a time, captured, and piped as raw frames into FFmpeg.
 */
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join, resolve, sep } from 'node:path'
import type { VideoFormat, VideoRequest, VideoResult } from '../core/render/types'
import { designFolder } from '../core/designs/files'
import { PREVIEW_SCHEME } from '../shared/design-bridge'

export const VIDEO_LIMITS = {
  minSide: 16,
  maxSide: 3840,
  maxFps: 60,
  maxSeconds: 300
} as const

const DEFAULT_FPS = 30
const DEFAULT_SECONDS = 5
const FALLBACK_SIZE = { width: 1920, height: 1080 }
const LOAD_TIMEOUT_MS = 20_000
const SETTLE_ROUNDS = 6

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let cachedFfmpeg: string | null | undefined

/** FFmpeg from DESKMATES_FFMPEG, PATH or a winget install; null when there is none. */
export function findFfmpeg(): string | null {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg
  const candidates: string[] = []
  if (process.env.DESKMATES_FFMPEG) candidates.push(process.env.DESKMATES_FFMPEG)
  const where = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
  if (where.status === 0) candidates.push(...where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  const local = process.env.LOCALAPPDATA
  if (local) {
    candidates.push(join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'))
    const packages = join(local, 'Microsoft', 'WinGet', 'Packages')
    try {
      for (const pkg of readdirSync(packages).filter((name) => /ffmpeg/i.test(name))) {
        for (const build of readdirSync(join(packages, pkg))) candidates.push(join(packages, pkg, build, 'bin', 'ffmpeg.exe'))
      }
    } catch {
      // No winget packages folder.
    }
  }
  cachedFfmpeg = candidates.find((path) => existsSync(path)) ?? null
  return cachedFfmpeg
}

export const FFMPEG_MISSING =
  'Video export needs FFmpeg. Install it (for example run "winget install Gyan.FFmpeg" in a terminal), then restart Deskmates.'

/** FFmpeg arguments for raw BGRA frames on stdin, encoded to `format` at `out`. */
export function ffmpegArgs(format: VideoFormat, width: number, height: number, fps: number, out: string): string[] {
  const input = ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', '-']
  if (format === 'gif') {
    const scale = width > 960 ? 'scale=960:-2:flags=lanczos,' : ''
    return [
      ...input,
      '-filter_complex',
      `[0:v]${scale}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
      '-loop',
      '0',
      out
    ]
  }
  if (format === 'webm') {
    return [...input, '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', out]
  }
  return [
    ...input,
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    out
  ]
}

interface PageVideo {
  width?: number
  height?: number
  fps?: number
  duration?: number
  seekable: boolean
  /** Longest finite CSS/Web animation, in seconds, as a fallback length. */
  animationSeconds: number
}

const PAGE_VIDEO_SCRIPT = `(async () => {
  try { if (window.DCSupport && window.DCSupport.ready) await window.DCSupport.ready } catch {}
  try { await document.fonts.ready } catch {}
  const v = window.__deskmatesVideo || {}
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined)
  let longest = 0
  for (const animation of document.getAnimations()) {
    try {
      const end = animation.effect.getComputedTiming().endTime
      if (Number.isFinite(end)) longest = Math.max(longest, end / 1000)
    } catch {}
  }
  return {
    width: num(v.width), height: num(v.height), fps: num(v.fps), duration: num(v.duration),
    seekable: typeof v.seek === 'function', animationSeconds: longest
  }
})()`

async function exec<T>(contents: WebContents, code: string): Promise<T> {
  return (await contents.executeJavaScript(code, true)) as T
}

async function load(contents: WebContents, url: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      contents.loadURL(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The design took too long to load for recording.')), LOAD_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export interface RecordOptions extends VideoRequest {
  /** Absolute path of the file to write. */
  out: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** Records the page at `url` (a deskmates-preview URL) to `out`. */
export async function recordVideo(options: RecordOptions): Promise<VideoResult> {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error(FFMPEG_MISSING)
  if (!options.url.startsWith(`${PREVIEW_SCHEME}://design/`)) throw new Error('Only design pages can be recorded.')
  const format: VideoFormat = options.format ?? 'mp4'

  const window = new BrowserWindow({
    show: false,
    width: options.width ?? FALLBACK_SIZE.width,
    height: options.height ?? FALLBACK_SIZE.height,
    useContentSize: true,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      disableDialogs: true,
      spellcheck: false
    }
  })
  const contents = window.webContents
  contents.setAudioMuted(true)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('dom-ready', () => {
    void contents.insertCSS('::-webkit-scrollbar { width: 0 !important; height: 0 !important; }').catch(() => undefined)
  })

  try {
    window.setContentSize(options.width ?? FALLBACK_SIZE.width, options.height ?? FALLBACK_SIZE.height)
    const separator = options.url.includes('?') ? '&' : '?'
    await load(contents, `${options.url}${separator}record=1`)
    const hasClock = await exec<boolean>(contents, 'Boolean(window.__dmTime)')
    if (!hasClock) throw new Error('The page could not be prepared for recording.')
    // Let start-up timers, fonts and images settle while the page's clock is still at zero.
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      await exec(contents, 'window.__dmTime.advanceTo(0)')
      await wait(80)
    }
    const page = await exec<PageVideo>(contents, PAGE_VIDEO_SCRIPT)

    const width = Math.round(clamp(options.width ?? page.width ?? FALLBACK_SIZE.width, VIDEO_LIMITS.minSide, VIDEO_LIMITS.maxSide))
    const height = Math.round(clamp(options.height ?? page.height ?? FALLBACK_SIZE.height, VIDEO_LIMITS.minSide, VIDEO_LIMITS.maxSide))
    const fps = Math.round(clamp(options.fps ?? page.fps ?? DEFAULT_FPS, 1, VIDEO_LIMITS.maxFps))
    const seconds = clamp(
      options.duration ?? page.duration ?? (page.animationSeconds > 0 ? Math.min(page.animationSeconds, 60) : DEFAULT_SECONDS),
      1 / fps,
      VIDEO_LIMITS.maxSeconds
    )
    window.setContentSize(width, height)
    await exec(contents, 'window.__dmTime.painted()')

    const frames = Math.max(1, Math.round(seconds * fps))
    const child = spawn(ffmpeg, ffmpegArgs(format, width, height, fps, options.out), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    const onAbort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for (let frame = 0; frame < frames; frame++) {
        if (options.signal?.aborted) throw new Error('Recording was stopped.')
        const ms = (frame * 1000) / fps
        await exec(
          contents,
          `(async () => { await window.__dmTime.advanceTo(${ms}); ${page.seekable ? `await window.__deskmatesVideo.seek(${ms / 1000});` : ''} await window.__dmTime.painted() })()`
        )
        contents.invalidate()
        let image = await contents.capturePage(undefined, { stayHidden: true })
        const size = image.getSize()
        if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'good' })
        if (!child.stdin.write(image.toBitmap())) await once(child.stdin, 'drain')
        options.onProgress?.((frame + 1) / frames)
      }
      child.stdin.end()
      const code = await exited
      if (code !== 0) throw new Error(`FFmpeg could not encode the video${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : '.'}`)
    } catch (error) {
      child.kill()
      throw error
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
    return { path: options.out, format, width, height, fps, duration: frames / fps, frames }
  } finally {
    window.destroy()
  }
}

let queue: Promise<unknown> = Promise.resolve()

/** One recording at a time: each holds an offscreen window and an encoder. */
export function queueRecording(options: RecordOptions): Promise<VideoResult> {
  const next = queue.then(
    () => recordVideo(options),
    () => recordVideo(options)
  )
  queue = next.catch(() => undefined)
  return next
}

const PROJECT_IN_URL = new RegExp(`^${PREVIEW_SCHEME}://design/([0-9a-f-]{36})/`, 'i')

/** A recording the core asked for: its file must land inside that design's own folder. */
export function recordForCore(dataDir: string, request: VideoRequest & { out: string }): Promise<VideoResult> {
  const project = PROJECT_IN_URL.exec(request.url)?.[1]
  if (!project) return Promise.reject(new Error('Only design pages can be recorded.'))
  const folder = resolve(designFolder(dataDir, project))
  const out = resolve(request.out)
  if (!out.startsWith(folder + sep)) return Promise.reject(new Error('The video must be saved inside the design folder.'))
  mkdirSync(dirname(out), { recursive: true })
  return queueRecording({ ...request, out })
}
