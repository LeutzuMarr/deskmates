/**
 * Builds the service worker for the phone web app: takes src/renderer/sw/sw.js and fills in the
 * exact files the notes page needs (its HTML, every chunk it loads now or later, its CSS and the
 * fonts that CSS uses, plus the icons and manifest), and a version that changes when any of them do.
 * Nothing from the rest of Deskmates is kept offline.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Plugin, Rollup } from 'vite'

type OutputAsset = Rollup.OutputAsset
type OutputBundle = Rollup.OutputBundle
type OutputChunk = Rollup.OutputChunk

interface Options {
  /** The HTML entry, as the build names it (e.g. "notes.html"). */
  entryHtml: string
  /** The URL that serves that page (clean URLs: "/notes"). */
  pageUrl: string
  /** Files from the public folder to keep too. */
  extra: string[]
  template: string
}

/** The notes page's files, walked from its entry chunk. Exported for tests. */
export function notesFiles(bundle: OutputBundle, entryHtml: string): string[] {
  const chunks = Object.values(bundle).filter((f): f is OutputChunk => f.type === 'chunk')
  const entry = chunks.find((c) => c.isEntry && c.facadeModuleId?.replace(/\\/g, '/').endsWith(`/${entryHtml}`))
  if (!entry) throw new Error(`notes-precache: no entry chunk for ${entryHtml}`)
  const files = new Set<string>()
  const seen = new Set<string>()
  const walk = (fileName: string): void => {
    if (seen.has(fileName)) return
    seen.add(fileName)
    const chunk = bundle[fileName]
    if (!chunk || chunk.type !== 'chunk') return
    files.add(chunk.fileName)
    const meta = (chunk as OutputChunk & { viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> } }).viteMetadata
    meta?.importedCss.forEach((f) => files.add(f))
    meta?.importedAssets.forEach((f) => files.add(f))
    for (const next of [...chunk.imports, ...chunk.dynamicImports]) walk(next)
  }
  walk(entry.fileName)
  // Fonts and images that the CSS points at.
  for (const file of [...files]) {
    if (!file.endsWith('.css')) continue
    const css = bundle[file] as OutputAsset | undefined
    const source = typeof css?.source === 'string' ? css.source : css ? new TextDecoder().decode(css.source) : ''
    for (const match of source.matchAll(/url\(\s*['"]?\/?([^'")?#]+)/g)) {
      const ref = match[1]!
      if (bundle[ref]) files.add(ref)
    }
  }
  return [...files].sort()
}

export function notesPrecache(options: Options): Plugin {
  return {
    name: 'deskmates-notes-precache',
    apply: 'build',
    generateBundle(_output, bundle) {
      const urls = [options.pageUrl, ...notesFiles(bundle, options.entryHtml).map((f) => `/${f}`), ...options.extra]
      const template = readFileSync(options.template, 'utf8')
      // The HTML changes whenever its hashed files do, so hashing the list (and the worker) is enough.
      const version = createHash('sha256').update(template).update(urls.join('\n')).digest('hex').slice(0, 12)
      const source = template.replace("'__VERSION__'", () => JSON.stringify(version)).replace('__PRECACHE__', () => JSON.stringify(urls, null, 2))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    }
  }
}
