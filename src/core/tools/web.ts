/** Web search and page fetching for the agents, with no API key: DuckDuckGo's HTML results page and plain fetch. */

const FETCH_TIMEOUT_MS = 20_000
const MAX_PAGE_BYTES = 3 * 1024 * 1024
const MAX_TEXT_CHARS = 40_000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39|#x27);/gi, (whole, name: string) => {
    const lower = name.toLowerCase()
    if (lower in ENTITIES) return ENTITIES[lower]
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10))
    return whole
  })
}

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** Result links on DuckDuckGo's HTML page go through a redirect carrying the real address in `uddg`. */
function realUrl(href: string): string {
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const url = new URL(absolute, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : url.toString()
  } catch {
    return absolute
  }
}

/** Parses DuckDuckGo's HTML results page. */
export function parseSearchResults(html: string, limit = 8): SearchResult[] {
  const results: SearchResult[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1)
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const snippet = /<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block)
    const url = realUrl(decodeEntities(link[1]))
    if (!/^https?:\/\//i.test(url) || url.includes('duckduckgo.com/y.js')) continue
    results.push({ title: stripTags(link[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' })
    if (results.length >= limit) break
  }
  return results
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function webSearchResults(query: string, signal?: AbortSignal): Promise<SearchResult[] | string> {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: withTimeout(signal)
  })
  if (!response.ok) throw new Error(`The search didn't work (HTTP ${response.status}). Try again or fetch a known page with web_fetch.`)
  const results = parseSearchResults(await response.text())
  return results.length > 0 ? results : 'No results.'
}

/** Readable text from an HTML page: drops scripts, styles and markup, keeps line breaks between blocks. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  const body = html
    .replace(/<head[\s>][\s\S]*?<\/head>/i, ' ')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return { title, text }
}

export async function webFetchText(address: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  const url = new URL(address)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be fetched.')
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,application/json,*/*' }, signal: withTimeout(signal), redirect: 'follow' })
  if (!response.ok) throw new Error(`The page answered HTTP ${response.status}.`)
  const type = response.headers.get('content-type') ?? ''
  if (/pdf|image|audio|video|octet-stream|zip/i.test(type)) {
    throw new Error(`This address returns ${type || 'a binary file'}, not a page. Save it into the project (for example with a command) and read it from there.`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const raw = buffer.subarray(0, MAX_PAGE_BYTES).toString('utf8')
  const { title, text } = /html/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : { title: '', text: raw }
  return { url: response.url, title, text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS }
}
