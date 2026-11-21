/**
 * The operating prompt's mcp__Claude_Docs__* tools, run locally. A "doc" is a folder in the project,
 * Docs/<slug>/, with one Markdown file per tab and a .doc.json holding the ids, tab titles and
 * comments. The prompt's own schemas are loose (container, ref, payload objects), so the guide tool
 * spells out exactly which shapes these tools take, and every refusal says what to send instead.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Tool } from 'ai'
import type { ToolContext } from './context'
import { callTool } from './cowork'
import { writeTracked } from './files'

type Input = Record<string, unknown>
type Run = (input: Input, options: { abortSignal?: AbortSignal }) => Promise<unknown>

interface Tab {
  id: string
  title: string
  /** The Markdown file, relative to the project folder. */
  file: string
}

interface Comment {
  id: string
  parent: string | null
  tab: string | null
  text: string
  author: 'claude'
  at: string
  resolved: boolean
}

interface Doc {
  id: string
  title: string
  folder: string
  tabs: Tab[]
  comments: Comment[]
  created: string
  updated: string
}

const DOCS_DIR = 'Docs'
const META = '.doc.json'

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const obj = (value: unknown): Input => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Input) : {})
const newId = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'doc'

export const DOCS_GUIDE = [
  'Claude Docs in Deskmates: each doc is a folder in the project, Docs/<name>/, with one Markdown file per tab. The user opens them from the project folder; there is no claude.ai link. Ids are the ones these tools return; never make one up.',
  '',
  'Create a doc: mcp__Claude_Docs__batch {container: {kind: "project", create: {name: "<title>", doc: {markdown: "# Title\\n\\n<?claude block s1?>", blocks: {s1: {type: "pending", intent: "…"}}}}}, batch: []}.',
  '  Block types: pending {intent} (a placeholder to fill later), date {value}, mention {user}. The result gives the doc id, the first tab id and its file.',
  'Fill a pending block: mcp__Claude_Docs__update {container: {kind: "project", id: "<doc id>"}, ref: {object: "node", id: "<block key>"}, payload: {markdown: "## Heading\\n\\nBody"}}.',
  'Replace a whole tab: update with ref {object: "file", id: "<tab id>"} and payload {markdown}. Replace text inside a tab: payload {find: "old text", markdown: "new text"}.',
  'Rename: update ref {object: "project", id} or {object: "file", id} with payload {title}.',
  'Read: mcp__Claude_Docs__read ref {object: "project", id} (lists tabs), {object: "file", id} (a tab\'s Markdown), {object: "utterance", id} (a comment).',
  'New tab: mcp__Claude_Docs__create {container, object: "file", payload: {title, markdown}}. Comment: object "utterance", payload {text, parent?, tab?}. Append to a tab: object "node", payload {tab, markdown}. Save an export into the doc folder: object "blob", payload {from: {object: "file", id}, format}.',
  'Delete a tab or comment: mcp__Claude_Docs__delete {container, ref}. A doc keeps at least one tab.',
  'Comments: mcp__Claude_Docs__query {container, object: "utterance"} lists them; update a comment with payload {resolved: true} to resolve it.',
  'Export: mcp__Claude_Docs__export {container, file: "<tab id>", format: markdown|text|html|notion|docx|pdf} returns base64.',
  'Batch: mcp__Claude_Docs__batch {container: {kind: "project", id}, batch: [{op: "update"|"create"|"delete"|"read", ...the same fields}]} applies them in order and stops at the first error.',
  'List every doc in the project: mcp__Claude_Docs__read {ref: {object: "project", id: "*"}}.'
].join('\n')

export function claudeDocsImplementations(ctx: ToolContext, need: (name: string) => Tool): Record<string, Run> {
  const docsRoot = join(ctx.root, DOCS_DIR)

  const allDocs = (): Doc[] => {
    if (!existsSync(docsRoot)) return []
    const out: Doc[] = []
    for (const name of readdirSync(docsRoot)) {
      const meta = join(docsRoot, name, META)
      if (!existsSync(meta)) continue
      try {
        out.push(JSON.parse(readFileSync(meta, 'utf8')) as Doc)
      } catch {
        // A damaged .doc.json is skipped rather than failing every docs call.
      }
    }
    return out
  }
  const save = (doc: Doc): void => {
    doc.updated = new Date().toISOString()
    writeFileSync(join(ctx.root, doc.folder, META), JSON.stringify(doc, null, 2))
  }
  const findDoc = (id: string): Doc => {
    const doc = allDocs().find((d) => d.id === id)
    if (!doc) throw new Error(`There is no doc with id "${id}". Create one with mcp__Claude_Docs__batch, or list them with read {ref: {object: "project", id: "*"}}.`)
    return doc
  }
  const docFor = (input: Input): Doc => {
    const container = obj(input.container)
    const ref = obj(input.ref)
    const id = str(container.id) || (str(ref.object) === 'project' ? str(ref.id) : '')
    if (id) return findDoc(id)
    // Without a container, find the doc that holds the referenced tab or comment.
    const target = str(ref.id) || str(input.file)
    const doc = allDocs().find((d) => d.tabs.some((t) => t.id === target) || d.comments.some((c) => c.id === target))
    if (!doc) throw new Error('Say which doc: pass container {kind: "project", id: "<doc id>"}.')
    return doc
  }
  const tabOf = (doc: Doc, id: string): Tab => {
    const tab = doc.tabs.find((t) => t.id === id || t.title.toLowerCase() === id.toLowerCase())
    if (!tab) throw new Error(`Doc "${doc.title}" has no tab "${id}". Its tabs: ${doc.tabs.map((t) => `${t.id} (${t.title})`).join(', ')}.`)
    return tab
  }
  const readTab = (tab: Tab): string => {
    const abs = join(ctx.root, tab.file)
    return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  }
  /** Tab writes go through the change log, so the user can undo them like any other file change. */
  const writeTab = async (tab: Tab, markdown: string): Promise<void> => {
    await writeTracked(ctx, join(ctx.root, tab.file), markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  }
  const pendingMarker = (key: string): RegExp => new RegExp(`<!-- pending ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[^>]*-->`)
  const summary = (doc: Doc) => ({
    doc: { id: doc.id, title: doc.title, folder: doc.folder },
    tabs: doc.tabs.map((t) => ({ id: t.id, title: t.title, file: t.file })),
    note: 'Saved in the project folder. To show it to the user, present the tab file (present_files) or publish it with Artifact.'
  })

  const expandBlocks = (markdown: string, blocks: Input): string =>
    markdown.replace(/<\?claude block ([\w-]+)\?>/g, (_all, key: string) => {
      const block = obj(blocks[key])
      const type = str(block.type)
      if (type === 'pending') return `<!-- pending ${key}: ${str(block.intent).replace(/-->/g, '')} -->\n_(${str(block.intent) || 'to be written'})_`
      if (type === 'date') return str(block.value) || new Date().toISOString().slice(0, 10)
      if (type === 'mention') return str(block.user) === 'me' ? 'Me' : str(block.user)
      return str(block.text) || str(block.value)
    })

  const createDoc = async (create: Input): Promise<Doc> => {
    const docInput = obj(create.doc)
    const title = str(create.name) || str(create.title) || 'Untitled doc'
    let folderName = slug(title)
    for (let n = 2; existsSync(join(docsRoot, folderName)); n++) folderName = `${slug(title)}-${n}`
    const folder = `${DOCS_DIR}/${folderName}`
    mkdirSync(join(ctx.root, folder), { recursive: true })
    const now = new Date().toISOString()
    const tab: Tab = { id: newId('tab'), title: str(docInput.tabTitle) || title, file: `${folder}/${folderName}.md` }
    const doc: Doc = { id: newId('doc'), title, folder, tabs: [tab], comments: [], created: now, updated: now }
    await writeTab(tab, expandBlocks(str(docInput.markdown) || `# ${title}\n`, obj(docInput.blocks)))
    save(doc)
    return doc
  }

  const exportTab = async (doc: Doc, tab: Tab, format: string): Promise<{ bytes: Buffer; extension: string }> => {
    const markdown = readTab(tab)
    if (format === 'markdown' || format === 'notion') return { bytes: Buffer.from(markdown), extension: 'md' }
    if (format === 'text') return { bytes: Buffer.from(markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/[#*_`>]/g, '')), extension: 'txt' }
    if (format === 'html') {
      const body = markdownToHtml(markdown)
      return { bytes: Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${tab.title}</title></head><body>${body}</body></html>`), extension: 'html' }
    }
    if (format === 'docx' || format === 'pdf') {
      const out = `${doc.folder}/${slug(tab.title)}.${format}`
      await callTool(need(format === 'docx' ? 'create_word_document' : 'create_pdf'), { path: out, title: tab.title, content: markdown })
      return { bytes: readFileSync(join(ctx.root, out)), extension: format }
    }
    throw new Error(`Unknown format "${format}". Use markdown, text, html, notion, docx or pdf.`)
  }

  const create: Run = async (input) => {
    const doc = docFor(input)
    const payload = obj(input.payload)
    const object = str(input.object)
    if (object === 'file') {
      const title = str(payload.title) || `Tab ${doc.tabs.length + 1}`
      const tab: Tab = { id: newId('tab'), title, file: `${doc.folder}/${slug(title)}-${doc.tabs.length + 1}.md` }
      doc.tabs.push(tab)
      await writeTab(tab, expandBlocks(str(payload.markdown) || `# ${title}\n`, obj(payload.blocks)))
      save(doc)
      return { created: 'tab', tab, ...summary(doc) }
    }
    if (object === 'utterance') {
      const comment: Comment = { id: newId('c'), parent: str(payload.parent) || null, tab: str(payload.tab) || null, text: str(payload.text) || str(payload.body), author: 'claude', at: new Date().toISOString(), resolved: false }
      if (!comment.text) throw new Error('A comment needs payload {text}.')
      doc.comments.push(comment)
      save(doc)
      return { created: 'comment', comment }
    }
    if (object === 'node') {
      const tab = tabOf(doc, str(payload.tab) || doc.tabs[0]!.id)
      await writeTab(tab, `${readTab(tab).trimEnd()}\n\n${expandBlocks(str(payload.markdown), obj(payload.blocks))}`)
      save(doc)
      return { appended: tab.id, file: tab.file }
    }
    if (object === 'blob') {
      const from = obj(payload.from)
      const tab = tabOf(doc, str(from.id) || doc.tabs[0]!.id)
      const format = str(payload.format) || 'markdown'
      const { bytes, extension } = await exportTab(doc, tab, format)
      const file = `${doc.folder}/${slug(tab.title)}.${extension}`
      await writeTracked(ctx, join(ctx.root, file), bytes)
      return { created: 'file', file, bytes: bytes.length }
    }
    throw new Error('object must be "file" (a tab), "utterance" (a comment), "node" (append to a tab) or "blob" (an export saved in the doc folder).')
  }

  const read: Run = async (input) => {
    const ref = obj(input.ref)
    const object = str(ref.object)
    if (object === 'project' && (str(ref.id) === '*' || !str(ref.id))) {
      const docs = allDocs()
      return docs.length ? docs.map((d) => ({ id: d.id, title: d.title, folder: d.folder, tabs: d.tabs.length, updated: d.updated })) : 'There are no docs in this project yet.'
    }
    const doc = docFor(input)
    if (object === 'project') return { ...summary(doc), comments: doc.comments.length }
    if (object === 'file') {
      const tab = tabOf(doc, str(ref.id))
      return { tab: tab.id, title: tab.title, file: tab.file, markdown: readTab(tab) }
    }
    if (object === 'node') {
      const tab = doc.tabs.find((t) => pendingMarker(str(ref.id)).test(readTab(t)))
      return tab ? { block: str(ref.id), tab: tab.id, state: 'pending' } : { block: str(ref.id), state: 'not pending (filled or never created)' }
    }
    if (object === 'utterance') {
      const comment = doc.comments.find((c) => c.id === str(ref.id))
      if (!comment) throw new Error(`No comment "${str(ref.id)}" in this doc. List them with mcp__Claude_Docs__query.`)
      return { comment, replies: doc.comments.filter((c) => c.parent === comment.id) }
    }
    throw new Error('ref.object must be "project", "file", "node" or "utterance".')
  }

  const update: Run = async (input) => {
    const ref = obj(input.ref)
    const payload = typeof input.payload === 'string' ? { markdown: input.payload } : obj(input.payload)
    const doc = docFor(input)
    const object = str(ref.object)
    if (object === 'project') {
      if (!str(payload.title)) throw new Error('To rename a doc, send payload {title}.')
      doc.title = str(payload.title)
      save(doc)
      return { renamed: doc.id, title: doc.title }
    }
    if (object === 'node') {
      const key = str(ref.id)
      const tab = doc.tabs.find((t) => pendingMarker(key).test(readTab(t)))
      if (!tab) throw new Error(`Block "${key}" isn't pending in any tab of "${doc.title}". Read the tab to see what is there.`)
      // The marker and the italic placeholder line under it go; the new Markdown takes their place.
      const text = readTab(tab).replace(new RegExp(`${pendingMarker(key).source}\\n_\\([^\\n]*\\)_`), () => str(payload.markdown)).replace(pendingMarker(key), () => str(payload.markdown))
      await writeTab(tab, text)
      save(doc)
      return { filled: key, tab: tab.id, file: tab.file, still_pending: doc.tabs.flatMap((t) => [...readTab(t).matchAll(/<!-- pending ([\w-]+):/g)].map((m) => m[1])) }
    }
    if (object === 'file') {
      const tab = tabOf(doc, str(ref.id))
      if (str(payload.title)) tab.title = str(payload.title)
      if (typeof payload.find === 'string') {
        const current = readTab(tab)
        if (!current.includes(payload.find)) throw new Error(`The tab doesn't contain that find text. Read it first with mcp__Claude_Docs__read.`)
        await writeTab(tab, current.replace(payload.find, () => str(payload.markdown)))
      } else if (typeof payload.markdown === 'string') {
        await writeTab(tab, payload.markdown)
      } else if (!str(payload.title)) {
        throw new Error('Send payload {markdown} to replace the tab, {find, markdown} to replace part of it, or {title} to rename it.')
      }
      save(doc)
      return { updated: tab.id, title: tab.title, file: tab.file }
    }
    if (object === 'utterance') {
      const comment = doc.comments.find((c) => c.id === str(ref.id))
      if (!comment) throw new Error(`No comment "${str(ref.id)}" in this doc.`)
      if (typeof payload.resolved === 'boolean') comment.resolved = payload.resolved
      if (str(payload.text)) comment.text = str(payload.text)
      save(doc)
      return { updated: comment.id, comment }
    }
    throw new Error('ref.object must be "project", "file", "node" or "utterance".')
  }

  const remove: Run = async (input) => {
    const ref = obj(input.ref)
    const doc = docFor(input)
    const object = str(ref.object)
    if (object === 'file') {
      const tab = tabOf(doc, str(ref.id))
      if (doc.tabs.length === 1) throw new Error('last_tab: a doc keeps at least one tab. Rewrite its contents with update instead.')
      doc.tabs = doc.tabs.filter((t) => t !== tab)
      rmSync(join(ctx.root, tab.file), { force: true })
      save(doc)
      return { deleted: tab.id }
    }
    if (object === 'utterance') {
      const before = doc.comments.length
      doc.comments = doc.comments.filter((c) => c.id !== str(ref.id) && c.parent !== str(ref.id))
      if (doc.comments.length === before) throw new Error(`No comment "${str(ref.id)}" in this doc.`)
      save(doc)
      return { deleted: str(ref.id) }
    }
    throw new Error('Only tabs (ref.object "file") and comments ("utterance") can be deleted. To remove a whole doc, the user deletes its folder.')
  }

  const run = { create, read, update, delete: remove }

  return {
    mcp__Claude_Docs__guide: async () => DOCS_GUIDE,
    mcp__Claude_Docs__create: create,
    mcp__Claude_Docs__read: read,
    mcp__Claude_Docs__update: update,
    mcp__Claude_Docs__delete: remove,
    mcp__Claude_Docs__query: async (input) => {
      const doc = docFor(input)
      const tab = str(obj(input.payload).tab)
      const comments = doc.comments.filter((c) => !tab || c.tab === tab)
      return comments.length ? comments : 'No comments on this doc yet.'
    },
    mcp__Claude_Docs__export: async (input) => {
      const doc = docFor(input)
      const tab = tabOf(doc, str(input.file) || doc.tabs[0]!.id)
      const { bytes, extension } = await exportTab(doc, tab, str(input.format) || 'markdown')
      const max = Number(input.maxBytes) || 11_534_336
      if (bytes.length > max) throw new Error(`The export is ${bytes.length} bytes, over maxBytes. Save it in the doc folder instead with create {object: "blob"}.`)
      return { format: str(input.format), extension, bytes: bytes.length, base64: bytes.toString('base64') }
    },
    mcp__Claude_Docs__batch: async (input, options) => {
      const container = obj(input.container)
      const results: unknown[] = []
      let docId = str(container.id)
      if (container.create) {
        const doc = await createDoc(obj(container.create))
        docId = doc.id
        results.push({ created: 'doc', ...summary(doc) })
      }
      const ops = Array.isArray(input.batch) ? (input.batch as Input[]) : []
      for (const [index, op] of ops.entries()) {
        const name = str(op.op) || str(op.action) || (op.ref ? 'update' : 'create')
        const fn = run[name as keyof typeof run]
        if (!fn) throw new Error(`Batch step ${index + 1}: unknown op "${name}". Use create, read, update or delete.`)
        try {
          results.push(await fn({ ...op, container: op.container ?? { kind: 'project', id: docId } }, options))
        } catch (error) {
          throw new Error(`Batch step ${index + 1} (${name}) failed: ${error instanceof Error ? error.message : String(error)}. Steps before it were applied.`)
        }
      }
      if (!docId && ops.length === 0) throw new Error('Nothing to do: pass container.create to make a doc, or container.id with a batch of steps.')
      return results.length === 1 ? results[0] : results
    }
  }
}

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const inline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')

/** Enough Markdown for a doc export: headings, paragraphs, lists, quotes, code blocks and rules. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flush = (): void => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i]!)
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`)
    } else if (bullet || numbered) {
      if (para.length) {
        out.push(`<p>${inline(para.join(' '))}</p>`)
        para = []
      }
      const kind = bullet ? 'ul' : 'ol'
      if (list !== kind) {
        if (list) out.push(`</${list}>`)
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`)
    } else if (/^\s*>\s?/.test(line)) {
      flush()
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`)
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush()
      out.push('<hr>')
    } else if (!line.trim()) {
      flush()
    } else {
      if (list) flush()
      para.push(line.trim())
    }
  }
  flush()
  return out.join('\n')
}
