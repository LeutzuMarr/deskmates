import { realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { designFolder } from '../core/designs/files'

/** Largest preview file served to the iframe. */
const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PreviewFile {
  kind: 'file'
  path: string
  contentType: string
  isHtml: boolean
}

export type PreviewRequest = PreviewFile | { kind: 'not-found' }

const notFound = (): PreviewRequest => ({ kind: 'not-found' })

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain'
}

/** Content type for a served file's path, or application/octet-stream. */
export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolves a deskmates-preview:// URL to a file on disk: the design project's folder, or one of
 * the scripts on the `editor` host (the direct-manipulation editor and the Design Component
 * runtime). Every escape attempt (traversal, backslashes, symlinks, non-UUID ids) is a 404.
 */
export function resolvePreviewRequest(
  url: string,
  dataDir: string,
  editorScriptPath: string,
  dcSupportPath?: string
): PreviewRequest {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return notFound()
  }

  if (parsed.host === 'editor') {
    const name = parsed.pathname.replace(/^\/+/, '')
    if (name === 'editor.js') {
      return { kind: 'file', path: editorScriptPath, contentType: 'text/javascript', isHtml: false }
    }
    if (name === 'dc-support.js' && dcSupportPath) {
      return { kind: 'file', path: dcSupportPath, contentType: 'text/javascript', isHtml: false }
    }
    return notFound()
  }

  if (parsed.host !== 'design') return notFound()

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return notFound()
  const projectId = segments[0]
  if (!UUID_RE.test(projectId)) return notFound()

  let relative = segments.slice(1).join('/')
  if (relative === '' || parsed.pathname.endsWith('/')) relative = 'index.html'

  let decoded: string
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return notFound()
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return notFound()
  if (decoded.split('/').some((segment) => segment === '..')) return notFound()

  const folder = resolve(designFolder(dataDir, projectId))
  const abs = resolve(folder, decoded)
  if (abs !== folder && !abs.startsWith(folder + sep)) return notFound()

  let stats
  try {
    stats = statSync(abs)
  } catch {
    return notFound()
  }
  if (!stats.isFile() || stats.size >= MAX_PREVIEW_FILE_BYTES) return notFound()

  // A symlink inside the design folder must not resolve outside it.
  let realFile: string
  let realRoot: string
  try {
    realFile = realpathSync.native(abs)
    realRoot = realpathSync.native(folder)
  } catch {
    return notFound()
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return notFound()

  const contentType = contentTypeFor(realFile)
  return { kind: 'file', path: realFile, contentType, isHtml: contentType === 'text/html' }
}

const EDITOR_TAG =
  '<script type="module" src="deskmates-preview://editor/editor.js" data-dm-editor></script>'

/** Inserts the editor script before the last </body>, or appends it when there is none. */
export function injectEditor(html: string): string {
  const index = html.toLowerCase().lastIndexOf('</body>')
  if (index === -1) return html + EDITOR_TAG
  return html.slice(0, index) + EDITOR_TAG + html.slice(index)
}

/**
 * Design Component files are rendered from their template by the DC runtime; the editor would
 * save the rendered DOM over that template, so it is never injected into them.
 */
export function isDesignComponentPath(path: string): boolean {
  return /\.dc\.html?$/i.test(path)
}

/** Removes every ` data-dm-id="…"` attribute, for export. */
export function stripEditorIds(html: string): string {
  return html.replace(/ data-dm-id="[^"]*"/g, '')
}

/** Content-Security-Policy for every HTML preview response. */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' deskmates-preview: https:; style-src 'unsafe-inline' deskmates-preview: https:; img-src deskmates-preview: data: blob: https:; font-src deskmates-preview: data: https:; media-src deskmates-preview: data: blob: https:; connect-src deskmates-preview: https:; frame-src https:; form-action 'none'; base-uri 'none'"

/** Headers for a successful preview response; every HTML response carries the strict CSP. */
export function previewResponseHeaders(contentType: string, isHtml: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff'
  }
  if (isHtml) headers['Content-Security-Policy'] = PREVIEW_CSP
  return headers
}