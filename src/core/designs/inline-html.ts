import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { realRoot, resolveInside, toProjectRelative } from '../fs/safe-path'

export interface InlineReport {
  html: string
  /** How many references were replaced by the files' contents. */
  inlined: number
  /** Local references whose file doesn't exist, relative to the design folder. */
  missing: string[]
  /** References left untouched, each with the reason. */
  skipped: string[]
}

const MAX_ASSET_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_BYTES = 80 * 1024 * 1024
const MAX_IMPORT_DEPTH = 8

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.vtt': 'text/vtt',
  '.txt': 'text/plain'
}

const mimeFor = (path: string): string => MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

const TOKEN_RE =
  /<!--[\s\S]*?-->|<(script)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>|<(style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/style\s*>|<([a-zA-Z][\w:.-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const ATTR_RE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi
const RELATIVE_IMPORT_RE = /\bimport\s*(?:[\w*{}\s,$]+from\s*)?\(?\s*['"]\.{0,2}\//

/** Attributes holding one URL, per tag. */
const URL_ATTRIBUTES: Record<string, string[]> = {
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  input: ['src'],
  image: ['href', 'xlink:href']
}
const SRCSET_TAGS = new Set(['img', 'source'])
const UNBUNDLED_TAGS: Record<string, string> = { iframe: 'src', embed: 'src', object: 'data' }

interface Attribute {
  name: string
  value: string | null
  start: number
  end: number
}

function parseAttributes(text: string): Attribute[] {
  const attributes: Attribute[] = []
  for (const match of text.matchAll(ATTR_RE)) {
    attributes.push({
      name: match[1].toLowerCase(),
      value: match[2] ?? match[3] ?? match[4] ?? null,
      start: match.index,
      end: match.index + match[0].length
    })
  }
  return attributes
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** Rewrites some attributes of a tag's attribute text: a string replaces the value, null removes it. */
function rewriteAttributes(text: string, changes: Map<Attribute, string | null>): string {
  let out = text
  const ordered = [...changes.entries()].sort((a, b) => b[0].start - a[0].start)
  for (const [attribute, value] of ordered) {
    const replacement = value === null ? '' : `${attribute.name}="${escapeAttribute(value)}"`
    out = out.slice(0, attribute.start) + replacement + out.slice(attribute.end)
  }
  return out
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => Promise<string>
): Promise<string> {
  // A copy, because `replace` may recurse into another replaceAsync with the same pattern.
  const regex = new RegExp(pattern.source, pattern.flags)
  const parts: string[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text))) {
    parts.push(text.slice(last, match.index), await replace(match))
    last = match.index + match[0].length
    if (match[0].length === 0) regex.lastIndex++
  }
  parts.push(text.slice(last))
  return parts.join('')
}

const escapeScript = (code: string): string => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
const escapeStyle = (css: string): string => css.replace(/<\/(style)/gi, '<\\/$1')

type Located = { abs: string; fragment: string } | 'outside' | null

/**
 * Walks an HTML file's local references. With `dryRun` it only checks that they exist (reading
 * stylesheets to follow theirs); otherwise it replaces them with the files' contents.
 */
class Inliner {
  inlined = 0
  readonly missing = new Set<string>()
  readonly skipped = new Set<string>()
  private total = 0
  private readonly base: string

  constructor(
    private readonly root: string,
    private readonly dryRun: boolean
  ) {
    this.base = realRoot(root)
  }

  /** Resolves a local reference; null for URLs, data: URIs and fragments, 'outside' for paths leaving the folder. */
  locate(ref: string, baseDir: string): Located {
    const trimmed = decodeEntities(ref).trim()
    if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return null
    const cut = trimmed.search(/[?#]/)
    const pathPart = cut === -1 ? trimmed : trimmed.slice(0, cut)
    const hash = trimmed.indexOf('#')
    let decoded = pathPart
    try {
      decoded = decodeURIComponent(pathPart)
    } catch {
      // Keep it as written.
    }
    const target = decoded.startsWith('/') ? resolve(this.base, `.${decoded}`) : resolve(baseDir, decoded)
    try {
      return { abs: resolveInside(this.root, relative(this.base, target)), fragment: hash === -1 ? '' : trimmed.slice(hash) }
    } catch {
      return 'outside'
    }
  }

  private rel(abs: string): string {
    return toProjectRelative(this.root, abs)
  }

  /** The file behind a reference, or null (recorded as missing or skipped) when it can't be used. */
  private async file(ref: string, baseDir: string, what: string): Promise<{ abs: string; fragment: string } | null> {
    const located = this.locate(ref, baseDir)
    if (located === null) return null
    if (located === 'outside') {
      this.skipped.add(`${ref}: outside the design folder`)
      return null
    }
    if (!existsSync(located.abs)) {
      this.missing.add(this.rel(located.abs))
      return null
    }
    const info = await stat(located.abs)
    if (!info.isFile()) {
      this.skipped.add(`${ref}: not a file`)
      return null
    }
    if (info.size > MAX_ASSET_BYTES) {
      this.skipped.add(`${ref}: ${what} larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB`)
      return null
    }
    return located
  }

  private async read(abs: string): Promise<Buffer> {
    const data = await readFile(abs)
    this.total += data.length
    if (this.total > MAX_TOTAL_BYTES) {
      throw new Error(`The bundle would be larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB. Remove or shrink large assets first.`)
    }
    return data
  }

  /** A data: URI for a local reference, or null to leave it as it is. */
  async dataUri(ref: string, baseDir: string): Promise<string | null> {
    const found = await this.file(ref, baseDir, 'file')
    if (!found || this.dryRun) return null
    const data = await this.read(found.abs)
    this.inlined++
    return `data:${mimeFor(found.abs)};base64,${data.toString('base64')}${found.fragment}`
  }

  async css(text: string, baseDir: string, depth = 0): Promise<string> {
    const imported = await replaceAsync(text, CSS_IMPORT_RE, async (match) => {
      const ref = match[2] ?? match[4]
      if (depth >= MAX_IMPORT_DEPTH) {
        this.skipped.add(`${ref}: @import nested too deeply`)
        return match[0]
      }
      const found = await this.file(ref, baseDir, 'stylesheet')
      if (!found) return match[0]
      const inner = await this.css((await this.read(found.abs)).toString('utf8'), dirname(found.abs), depth + 1)
      if (this.dryRun) return match[0]
      this.inlined++
      const media = match[5].trim()
      return media ? `@media ${media} {\n${inner}\n}` : inner
    })
    return replaceAsync(imported, CSS_URL_RE, async (match) => {
      const uri = await this.dataUri(match[2], baseDir)
      return uri ? `url("${uri}")` : match[0]
    })
  }

  private async srcset(value: string, baseDir: string): Promise<string | null> {
    // Commas inside data: URIs would split them into bogus candidates.
    if (/data:/i.test(value)) return null
    let changed = false
    const candidates = await Promise.all(
      value.split(',').map(async (candidate) => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/)
        const uri = url ? await this.dataUri(url, baseDir) : null
        if (!uri) return candidate.trim()
        changed = true
        return [uri, ...descriptor].join(' ')
      })
    )
    return changed ? candidates.join(', ') : null
  }

  async html(html: string, htmlAbs: string): Promise<string> {
    const baseDir = dirname(htmlAbs)
    const deferred: string[] = []
    const out = await replaceAsync(html, TOKEN_RE, async (match) => {
      if (match[1]) return this.script(match[2], match[0], baseDir, deferred)
      if (match[4]) {
        const css = await this.css(match[6], baseDir)
        return `<style${match[5]}>${css}</style>`
      }
      if (match[7]) return this.tag(match[7].toLowerCase(), match[8], match[0], baseDir)
      return match[0]
    })
    if (deferred.length === 0) return out
    const end = out.toLowerCase().lastIndexOf('</body>')
    const scripts = deferred.join('\n')
    return end === -1 ? `${out}\n${scripts}` : `${out.slice(0, end)}${scripts}\n${out.slice(end)}`
  }

  private async script(attrText: string, original: string, baseDir: string, deferred: string[]): Promise<string> {
    const attributes = parseAttributes(attrText)
    const src = attributes.find((a) => a.name === 'src')
    if (!src?.value) return original
    const found = await this.file(src.value, baseDir, 'script')
    if (!found || this.dryRun) return original
    const code = (await this.read(found.abs)).toString('utf8')
    this.inlined++
    const isModule = attributes.some((a) => a.name === 'type' && a.value?.trim().toLowerCase() === 'module')
    if (isModule && RELATIVE_IMPORT_RE.test(code)) {
      this.skipped.add(`${src.value}: it imports other files, which are not bundled`)
    }
    const drop = new Map<Attribute, string | null>()
    for (const attribute of attributes) {
      if (['src', 'integrity', 'crossorigin', 'defer', 'async'].includes(attribute.name)) drop.set(attribute, null)
    }
    const tag = `<script${rewriteAttributes(attrText, drop).replace(/\s+$/, '')}>${escapeScript(code)}</script>`
    // A deferred classic script inlined in place would run before the page below it exists.
    const later = !isModule && attributes.some((a) => a.name === 'defer' || a.name === 'async')
    if (later) {
      deferred.push(tag)
      return ''
    }
    return tag
  }

  private async tag(name: string, attrText: string, original: string, baseDir: string): Promise<string> {
    const attributes = parseAttributes(attrText)
    const get = (key: string) => attributes.find((a) => a.name === key)
    const changes = new Map<Attribute, string | null>()

    if (name === 'link') {
      const rel = (get('rel')?.value ?? '').toLowerCase().split(/\s+/)
      const href = get('href')
      if (!href?.value) return original
      if (rel.includes('stylesheet')) {
        const found = await this.file(href.value, baseDir, 'stylesheet')
        if (!found) return original
        const css = await this.css((await this.read(found.abs)).toString('utf8'), dirname(found.abs))
        if (this.dryRun) return original
        this.inlined++
        const media = get('media')?.value
        return `<style${media ? ` media="${escapeAttribute(media)}"` : ''}>\n${escapeStyle(css)}\n</style>`
      }
      if (rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'preload' || r === 'mask-icon')) {
        const uri = await this.dataUri(href.value, baseDir)
        if (uri) changes.set(href, uri)
      } else if (this.locate(href.value, baseDir)) {
        this.skipped.add(`${href.value}: <link rel="${rel.join(' ')}"> is not bundled`)
      }
    } else if (name === 'x-import') {
      const from = get('from')
      if (from?.value && this.locate(from.value, baseDir)) {
        const found = await this.file(from.value, baseDir, 'component')
        if (found) this.skipped.add(`${from.value}: components loaded with <x-import> stay separate files`)
      }
    } else if (UNBUNDLED_TAGS[name]) {
      const ref = get(UNBUNDLED_TAGS[name])
      if (ref?.value && this.locate(ref.value, baseDir)) {
        const found = await this.file(ref.value, baseDir, 'file')
        if (found) this.skipped.add(`${ref.value}: <${name}> content is not bundled`)
      }
    } else {
      for (const key of URL_ATTRIBUTES[name] ?? []) {
        const attribute = get(key)
        if (!attribute?.value) continue
        const uri = await this.dataUri(attribute.value, baseDir)
        if (uri) changes.set(attribute, uri)
      }
      if (SRCSET_TAGS.has(name)) {
        const srcset = get('srcset')
        if (srcset?.value) {
          const value = await this.srcset(decodeEntities(srcset.value), baseDir)
          if (value) changes.set(srcset, value)
        }
      }
    }

    const style = get('style')
    if (style?.value && /url\(/i.test(style.value)) {
      const css = await this.css(decodeEntities(style.value), baseDir)
      if (css !== decodeEntities(style.value)) changes.set(style, css)
    }

    if (changes.size === 0) return original
    return `<${original.slice(1, 1 + name.length)}${rewriteAttributes(attrText, changes)}>`
  }
}

/** Inlines an HTML file's local stylesheets, scripts, images, fonts and media into one self-contained page. */
export async function inlineHtml(root: string, htmlAbs: string): Promise<InlineReport> {
  const inliner = new Inliner(root, false)
  const html = await inliner.html(await readFile(htmlAbs, 'utf8'), htmlAbs)
  return { html, inlined: inliner.inlined, missing: [...inliner.missing], skipped: [...inliner.skipped] }
}

/** Local files an HTML page (and its stylesheets) refers to that don't exist. */
export async function findMissingReferences(root: string, htmlAbs: string): Promise<string[]> {
  const inliner = new Inliner(root, true)
  await inliner.html(await readFile(htmlAbs, 'utf8'), htmlAbs)
  return [...inliner.missing]
}
