import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_DESIGN_HTML_BYTES } from '../../shared/protocol'
import type { DesignFile } from '../../shared/protocol'
import { resolveInside } from '../fs/safe-path'

export const TOO_LARGE_ERROR = 'This design file is too large (over 5 MB).'
export const MISSING_ERROR = 'This design has no index.html.'

/** The folder holding one design's files: <dataDir>/designs/<projectId>/. */
export function designFolder(dataDir: string, projectId: string): string {
  return join(dataDir, 'designs', projectId)
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** The starter page a new design gets: one self-contained index.html. */
export function starterHtml(name: string): string {
  const title = escapeHtml(name)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: system-ui, sans-serif;
      }
      body {
        margin: 0;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 96px 24px;
      }
      h1 {
        font-size: 48px;
        line-height: 1.1;
        margin: 0 0 16px;
      }
      p {
        margin: 0;
        color: #6b6b6b;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>Describe your design in the chat, or click anything here to edit it.</p>
    </main>
  </body>
</html>
`
}

/** Reads a design's index.html. Throws when the file is missing or over the size limit. */
export function readDesign(folder: string): { html: string; updatedAt: number } {
  const file = join(folder, 'index.html')
  let stats
  try {
    stats = statSync(file)
  } catch {
    throw new Error(MISSING_ERROR)
  }
  if (stats.size > MAX_DESIGN_HTML_BYTES) throw new Error(TOO_LARGE_ERROR)
  return { html: readFileSync(file, 'utf8'), updatedAt: stats.mtimeMs }
}

export const DC_OVERWRITE_ERROR =
  "Design component files (.dc.html) are edited by asking the assistant; the preview editor can't save over them."

/** Whether a design-relative path is a Design Component, which only the assistant's tools may write. */
export const isDesignComponentFile = (path: string): boolean => /\.dc\.html?$/i.test(path.trim())

/**
 * Replaces one of a design's plain HTML pages (index.html by default) atomically: writes a temp file
 * next to it, then renames it over the page. Returns the new mtime in ms. Throws when the HTML is over
 * the size limit, when the path is not an .html page inside the folder, and for Design Component files.
 */
export function writeDesign(folder: string, html: string, path = 'index.html'): number {
  if (isDesignComponentFile(path)) throw new Error(DC_OVERWRITE_ERROR)
  if (!/\.html?$/i.test(path.trim())) throw new Error('Only .html pages can be saved from the preview.')
  if (Buffer.byteLength(html, 'utf8') > MAX_DESIGN_HTML_BYTES) throw new Error(TOO_LARGE_ERROR)
  const file = resolveInside(folder, path.trim())
  const temp = `${file}.tmp-${randomUUID()}`
  writeFileSync(temp, html, 'utf8')
  renameSync(temp, file)
  return statSync(file).mtimeMs
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build'])
const MAX_LISTED_FILES = 200

/** The design's viewable pages (.html and .dc.html, up to four folders deep), newest first. */
export function listDesignFiles(folder: string): DesignFile[] {
  const files: DesignFile[] = []
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return
      if (entry.name.startsWith('.')) continue
      const relative = prefix + entry.name
      if (entry.isDirectory()) {
        if (depth < 4 && !SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), `${relative}/`, depth + 1)
      } else if (entry.isFile() && /\.html?$/i.test(entry.name) && !entry.name.toLowerCase().includes('.tmp')) {
        const updatedAt = statSync(join(dir, entry.name)).mtimeMs
        files.push({ path: relative, updatedAt, kind: isDesignComponentFile(entry.name) ? 'dc' : 'html' })
      }
    }
  }
  walk(folder, '', 1)
  return files.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
}
