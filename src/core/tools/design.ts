import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { PlanItem } from '../../shared/protocol'
import { realRoot, resolveInside, toProjectRelative } from '../fs/safe-path'
import type { ToolContext } from './context'
import { grepFiles, searchTools, type ToolListing } from './cowork'
import { writeTracked } from './files'
import { webFetchText, webSearchResults } from './web'

const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const MAX_GITHUB_FILES = 150
const MAX_GITHUB_FILE_BYTES = 512 * 1024
const RUN_SCRIPT_TIMEOUT_MS = 60_000

const NO_LOCAL_FOLDER =
  "No local folder is mounted in Deskmates. Ask the user to put the files into this design's folder (they can open it from the design's menu), then use read_file/list_files."
const NO_FIG_FILE =
  'No .fig file is mounted in Deskmates, and Figma files can\'t be read here. Ask the user to export what you need (SVG, PNG or copied text) into the design folder.'

async function github(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Deskmates' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  })
  if (response.status === 404) throw new Error('Not found. Deskmates can only read public GitHub repositories; check the owner, repo and ref.')
  if (response.status === 403 || response.status === 429) throw new Error("GitHub's limit for requests without an account was reached. Try again in a while.")
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`)
  return response.json()
}

async function githubRaw(owner: string, repo: string, ref: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  const url = `${GITHUB_RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Couldn't read ${path} (HTTP ${response.status}).`)
  return Buffer.from(await response.arrayBuffer())
}

interface TreeEntry {
  path: string
  type: string
  size?: number
}

async function githubTree(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const tree = (await github(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal)) as {
    tree: TreeEntry[]
    truncated: boolean
  }
  return { entries: tree.tree, truncated: tree.truncated }
}

const isText = (buffer: Buffer): boolean => !buffer.subarray(0, 8000).includes(0)

/** Replaces exact strings one after another; fails (changing nothing) if any is missing or not unique. */
export function applyEdits(content: string, edits: Array<{ old_string: string; new_string: string }>): string {
  let updated = content
  edits.forEach((edit, index) => {
    let oldText = edit.old_string
    let newText = edit.new_string
    if (!updated.includes(oldText) && updated.includes('\r\n')) {
      oldText = oldText.replace(/\r?\n/g, '\r\n')
      newText = newText.replace(/\r?\n/g, '\r\n')
    }
    const count = updated.split(oldText).length - 1
    if (count === 0) throw new Error(`Edit ${index + 1}: old_string was not found. Read the file again and copy the exact text.`)
    if (count > 1) throw new Error(`Edit ${index + 1}: old_string appears ${count} times; include more surrounding text so it is unique.`)
    updated = updated.replace(oldText, () => newText)
  })
  return updated
}

export function designTools(ctx: ToolContext, listTools: () => ToolListing[] = () => []): ToolSet {
  const inside = (path: string): string => resolveInside(ctx.root, path)
  const rel = (abs: string): string => toProjectRelative(ctx.root, abs)
  let todos: Array<{ id: string; name: string; done: boolean }> = []

  const deleteTracked = async (abs: string): Promise<number> => {
    const info = await stat(abs)
    if (!info.isDirectory()) {
      ctx.changes.record(ctx.taskId, ctx.root, abs, 'delete')
      await rm(abs)
      return 1
    }
    let count = 0
    for (const item of await readdir(abs)) count += await deleteTracked(join(abs, item))
    ctx.changes.record(ctx.taskId, ctx.root, abs, 'delete')
    await rm(abs, { recursive: true, force: true })
    return count
  }

  const copyTracked = async (from: string, to: string): Promise<number> => {
    const info = await stat(from)
    if (!info.isDirectory()) {
      await writeTracked(ctx, to, await readFile(from))
      return 1
    }
    let count = 0
    await mkdir(to, { recursive: true })
    for (const item of await readdir(from)) count += await copyTracked(join(from, item), join(to, item))
    return count
  }

  return {
    grep: tool({
      description: 'Search file contents in the design folder with a regular expression; returns matching lines with line numbers.',
      inputSchema: z.object({ pattern: z.string().min(1), path: z.string().optional() }),
      execute: async ({ pattern, path }) => grepFiles(ctx.root, { pattern, path, output_mode: 'content', '-n': true, head_limit: 200 })
    }),

    delete_file: tool({
      description: 'Delete files or folders from the design folder. The user approves it, and it can be undone.',
      inputSchema: z.object({ paths: z.array(z.string().min(1)).min(1).max(50) }),
      execute: async ({ paths }) => {
        let files = 0
        const deleted: string[] = []
        for (const path of paths) {
          const abs = inside(path)
          if (abs === realRoot(ctx.root)) throw new Error('Refusing to delete the design folder itself.')
          if (!existsSync(abs)) throw new Error(`Not found: ${path}`)
          files += await deleteTracked(abs)
          deleted.push(rel(abs))
        }
        ctx.onChangesUpdated()
        return { deleted, files }
      }
    }),

    copy_files: tool({
      description: 'Copy (or move) files and folders within the design folder.',
      inputSchema: z.object({
        files: z
          .array(z.object({ src: z.string().min(1), dest: z.string().min(1), move: z.boolean().optional(), asset: z.unknown().optional() }))
          .min(1)
          .max(50)
      }),
      execute: async ({ files }) => {
        const done: Array<{ from: string; to: string; files: number; moved: boolean }> = []
        for (const item of files) {
          const from = inside(item.src)
          const to = inside(item.dest)
          if (!existsSync(from)) throw new Error(`Not found: ${item.src}`)
          const count = await copyTracked(from, to)
          if (item.move) await deleteTracked(from)
          done.push({ from: rel(from), to: rel(to), files: count, moved: Boolean(item.move) })
        }
        ctx.onChangesUpdated()
        return { copied: done }
      }
    }),

    str_replace_edit: tool({
      description:
        'Replace exact text in a file; pass one old_string/new_string pair or several in `edits`, applied in order and all-or-nothing. Each old_string must be unique in the file.',
      inputSchema: z.object({
        path: z.string().min(1),
        old_string: z.string().optional(),
        new_string: z.string().optional(),
        edits: z.array(z.object({ old_string: z.string().min(1), new_string: z.string() })).optional()
      }),
      execute: async ({ path, old_string, new_string, edits }) => {
        const list = edits ?? (old_string !== undefined ? [{ old_string, new_string: new_string ?? '' }] : [])
        if (list.length === 0) throw new Error('Pass old_string and new_string, or an edits list.')
        const abs = inside(path)
        const updated = applyEdits(await readFile(abs, 'utf8'), list)
        await writeTracked(ctx, abs, updated)
        return { path: rel(abs), edits: list.length }
      }
    }),

    update_todos: tool({
      description: 'Keep your to-do list for this task: add items, complete them or remove them. The list shows in the task\'s plan panel.',
      inputSchema: z.object({
        operations: z
          .array(z.object({ type: z.enum(['add', 'remove', 'complete']), id: z.string().optional(), name: z.string().optional() }))
          .min(1)
      }),
      execute: async ({ operations }) => {
        for (const op of operations) {
          const key = op.id ?? op.name
          if (op.type === 'add') {
            if (!op.name) throw new Error('"add" needs a name.')
            todos.push({ id: op.id ?? String(todos.length + 1), name: op.name, done: false })
          } else {
            const found = todos.find((t) => t.id === key || t.name === key)
            if (!found) throw new Error(`No to-do "${key}".`)
            if (op.type === 'complete') found.done = true
            else todos = todos.filter((t) => t !== found)
          }
        }
        const firstOpen = todos.findIndex((t) => !t.done)
        const plan: PlanItem[] = todos.slice(0, 20).map((t, i) => ({
          text: t.name.slice(0, 200),
          status: t.done ? 'done' : i === firstOpen ? 'in_progress' : 'pending'
        }))
        if (plan.length > 0) ctx.onPlan(plan)
        return { todos }
      }
    }),

    read_skill_prompt: tool({
      description: 'Read an installed skill\'s instructions by name.',
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const loaded = ctx.skills?.load(name) ?? ctx.skills?.load(name.replace(/^.*:/, ''))
        if (!loaded) {
          const installed = ctx.skills?.list().filter((s) => s.enabled).map((s) => s.name) ?? []
          throw new Error(`No enabled skill named "${name}". Installed: ${installed.join(', ') || 'none'}. Carry on with your own judgement.`)
        }
        return { name: loaded.name, instructions: loaded.instructions, files: loaded.files }
      }
    }),

    get_comments: tool({
      description: 'Read review comments on this design. Deskmates has no comment threads, so there are never any.',
      inputSchema: z.object({ offset: z.number().int().min(0).optional() }),
      execute: async () => ({ comments: [], note: 'Deskmates has no comments; the user gives feedback in this chat.' })
    }),

    resolve_comments: tool({
      description: 'Mark review comments as resolved. Deskmates has no comment threads, so this does nothing.',
      inputSchema: z.object({ comment_ids: z.array(z.string()), resolved: z.boolean() }),
      execute: async () => ({ changed: 0, note: 'Deskmates has no comments.' })
    }),

    set_project_title: tool({
      description: 'Rename this design.',
      inputSchema: z.object({ title: z.string().min(1).max(120) }),
      execute: async ({ title }) => {
        if (!ctx.renameProject) throw new Error('Renaming is not available here.')
        ctx.renameProject(title.trim())
        return { renamed: title.trim() }
      }
    }),

    connect_github: tool({
      description: 'Deskmates reads public GitHub repositories directly; there is no account to connect.',
      inputSchema: z.object({}),
      execute: async () => ({ connected: false, note: 'No GitHub account is connected. Public repositories can be read with the github_* tools; ask the user for owner/repo.' })
    }),

    github_prompt_install: tool({
      description: 'Deskmates has no GitHub app to install; public repositories work without it.',
      inputSchema: z.object({}),
      execute: async () => ({ shown: false, note: 'Not needed: public repositories can be read directly. Private ones are not available.' })
    }),

    github_list_repos: tool({
      description: 'List repositories of the connected GitHub account. With no account in Deskmates, ask the user which public repository to use.',
      inputSchema: z.object({ owner: z.string().optional() }),
      execute: async ({ owner }, { abortSignal }) => {
        if (!owner) return { repos: [], note: 'No GitHub account is connected. Ask the user for the owner/repo of a public repository.' }
        const repos = (await github(`/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`, abortSignal)) as Array<{
          full_name: string
          default_branch: string
          private: boolean
          description: string | null
        }>
        return repos.map((r) => ({ full_name: r.full_name, default_branch: r.default_branch, private: r.private, description: r.description }))
      }
    }),

    github_get_tree: tool({
      description: 'List the files of a public GitHub repository at a ref (branch, tag or commit).',
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().min(1),
        path_prefix: z.string().optional(),
        depth: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        regex_filter: z.string().optional()
      }),
      execute: async ({ owner, repo, ref, path_prefix, depth, limit = 500, regex_filter }, { abortSignal }) => {
        const { entries, truncated } = await githubTree(owner, repo, ref, abortSignal)
        const prefix = path_prefix?.replace(/^\/+|\/+$/g, '')
        const filter = regex_filter ? new RegExp(regex_filter) : null
        const base = prefix ? prefix.split('/').length : 0
        const shown = entries
          .filter((e) => !prefix || e.path === prefix || e.path.startsWith(`${prefix}/`))
          .filter((e) => !depth || e.path.split('/').length - base <= depth)
          .filter((e) => !filter || filter.test(e.path))
        return {
          entries: shown.slice(0, limit).map((e) => ({ path: e.path, type: e.type === 'tree' ? 'dir' : 'file', size: e.size })),
          total: shown.length,
          truncated: truncated || shown.length > limit
        }
      }
    }),

    github_read_files: tool({
      description: 'Read text files from a public GitHub repository without copying them into the design.',
      inputSchema: z.object({ owner: z.string().min(1), repo: z.string().min(1), ref: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(20) }),
      execute: async ({ owner, repo, ref, paths }, { abortSignal }) => {
        const out: Array<{ path: string; content?: string; note?: string }> = []
        for (const path of paths) {
          const data = await githubRaw(owner, repo, ref, path, abortSignal)
          if (!isText(data)) out.push({ path, note: `Binary file, ${data.length} bytes; copy it in with github_copy_files.` })
          else out.push({ path, content: data.subarray(0, MAX_GITHUB_FILE_BYTES).toString('utf8') })
        }
        return out
      }
    }),

    github_search_code: tool({
      description: 'Search the text files of a public GitHub repository at a ref for a regular expression.',
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().min(1),
        query: z.string().min(1),
        path_prefix: z.string().optional(),
        case_sensitive: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional()
      }),
      execute: async ({ owner, repo, ref, query, path_prefix, case_sensitive, limit = 100 }, { abortSignal }) => {
        const regex = new RegExp(query, case_sensitive ? '' : 'i')
        const prefix = path_prefix?.replace(/^\/+|\/+$/g, '')
        const { entries } = await githubTree(owner, repo, ref, abortSignal)
        const files = entries
          .filter((e) => e.type === 'blob' && (e.size ?? 0) <= MAX_GITHUB_FILE_BYTES)
          .filter((e) => !prefix || e.path.startsWith(`${prefix}/`) || e.path === prefix)
          .filter((e) => !/\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|otf|mp4|mp3|lock)$/i.test(e.path))
        const matches: Array<{ path: string; line: number; text: string }> = []
        let scanned = 0
        for (const file of files.slice(0, MAX_GITHUB_FILES)) {
          if (matches.length >= limit) break
          const data = await githubRaw(owner, repo, ref, file.path, abortSignal).catch(() => null)
          scanned++
          if (!data || !isText(data)) continue
          data
            .toString('utf8')
            .split(/\r?\n/)
            .forEach((text, index) => {
              if (matches.length < limit && regex.test(text)) matches.push({ path: file.path, line: index + 1, text: text.slice(0, 300) })
            })
        }
        return { matches, filesScanned: scanned, filesSkipped: Math.max(0, files.length - MAX_GITHUB_FILES) }
      }
    }),

    github_copy_files: tool({
      description: 'Copy files from a public GitHub repository into the design folder (by paths, or everything under path_prefix).',
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().min(1),
        paths: z.array(z.string().min(1)).optional(),
        path_prefix: z.string().optional(),
        dest: z.string().optional()
      }),
      execute: async ({ owner, repo, ref, paths, path_prefix, dest = '.' }, { abortSignal }) => {
        let wanted = paths ?? []
        if (wanted.length === 0) {
          if (!path_prefix) throw new Error('Pass paths or a path_prefix.')
          const prefix = path_prefix.replace(/^\/+|\/+$/g, '')
          const { entries } = await githubTree(owner, repo, ref, abortSignal)
          wanted = entries.filter((e) => e.type === 'blob' && (e.path === prefix || e.path.startsWith(`${prefix}/`))).map((e) => e.path)
        }
        if (wanted.length > MAX_GITHUB_FILES) throw new Error(`That is ${wanted.length} files; copy at most ${MAX_GITHUB_FILES} at a time.`)
        const copied: string[] = []
        for (const path of wanted) {
          const data = await githubRaw(owner, repo, ref, path, abortSignal)
          const result = await writeTracked(ctx, inside(join(dest, path)), data)
          copied.push(result.path)
        }
        return { copied }
      }
    }),

    github_compare: tool({
      description: 'List the files changed between two refs of a public GitHub repository.',
      inputSchema: z.object({ owner: z.string().min(1), repo: z.string().min(1), base: z.string().min(1), head: z.string().min(1), path_prefix: z.string().optional() }),
      execute: async ({ owner, repo, base, head, path_prefix }, { abortSignal }) => {
        const compare = (await github(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
          abortSignal
        )) as { files?: Array<{ filename: string; status: string; previous_filename?: string }>; ahead_by: number; behind_by: number }
        const prefix = path_prefix?.replace(/^\/+|\/+$/g, '')
        const files = (compare.files ?? []).filter((f) => !prefix || f.filename.startsWith(prefix))
        return { aheadBy: compare.ahead_by, behindBy: compare.behind_by, files: files.map((f) => ({ path: f.filename, status: f.status, from: f.previous_filename })) }
      }
    }),

    ask_user: tool({
      description:
        'Ask the user a few structured questions (chips, segmented, select, color, slider or freeform). They appear as a form in the chat; end your turn after calling this, and the answers arrive as the next message.',
      inputSchema: z.object({
        title: z.string().min(1),
        prompt: z.string().optional(),
        follow_up: z.boolean().optional(),
        questions: z
          .array(
            z.object({
              id: z.string().min(1),
              kind: z.enum(['chips', 'segmented', 'select', 'color', 'slider', 'freeform']),
              title: z.string().min(1),
              subtitle: z.string().optional(),
              options: z.array(z.union([z.string(), z.object({ label: z.string(), value: z.string().optional() })])).optional(),
              multi: z.boolean().optional(),
              min: z.number().optional(),
              max: z.number().optional(),
              step: z.number().optional(),
              default: z.union([z.number(), z.string()]).optional(),
              placeholder: z.string().optional(),
              accept: z.string().optional()
            })
          )
          .min(1)
          .max(8)
      }),
      execute: async ({ questions }) => ({ shown: true, questions: questions.length, note: 'The form is on screen. End your turn now; the answers arrive as the next user message.' })
    }),

    local_ls: tool({
      description: 'List a mounted local folder. Deskmates has no mounted folders; the files must be in the design folder.',
      inputSchema: z.object({ path: z.string(), depth: z.number().optional(), filter: z.string().optional(), offset: z.number().optional(), ignore_common_ignored_dirs: z.boolean().optional() }),
      execute: async (): Promise<string> => {
        throw new Error(NO_LOCAL_FOLDER)
      }
    }),
    local_read: tool({
      description: 'Read from a mounted local folder. Deskmates has no mounted folders; the files must be in the design folder.',
      inputSchema: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
      execute: async (): Promise<string> => {
        throw new Error(NO_LOCAL_FOLDER)
      }
    }),
    local_grep: tool({
      description: 'Search a mounted local folder. Deskmates has no mounted folders; the files must be in the design folder.',
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), paths: z.array(z.string()).optional(), filter: z.string().optional(), offset: z.number().optional() }),
      execute: async (): Promise<string> => {
        throw new Error(NO_LOCAL_FOLDER)
      }
    }),
    local_copy_to_project: tool({
      description: 'Copy from a mounted local folder. Deskmates has no mounted folders; the files must be in the design folder.',
      inputSchema: z.object({ files: z.array(z.object({ src: z.string(), dest: z.string() })) }),
      execute: async (): Promise<string> => {
        throw new Error(NO_LOCAL_FOLDER)
      }
    }),

    fig_ls: tool({
      description: 'List a mounted .fig file. Figma files are not supported in Deskmates.',
      inputSchema: z.object({ path: z.string().optional(), depth: z.number().optional() }),
      execute: async (): Promise<string> => {
        throw new Error(NO_FIG_FILE)
      }
    }),
    fig_read: tool({
      description: 'Read from a mounted .fig file. Figma files are not supported in Deskmates.',
      inputSchema: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
      execute: async (): Promise<string> => {
        throw new Error(NO_FIG_FILE)
      }
    }),
    fig_grep: tool({
      description: 'Search a mounted .fig file. Figma files are not supported in Deskmates.',
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), offset: z.number().optional() }),
      execute: async (): Promise<string> => {
        throw new Error(NO_FIG_FILE)
      }
    }),
    fig_copy_files: tool({
      description: 'Copy from a mounted .fig file. Figma files are not supported in Deskmates.',
      inputSchema: z.object({ files: z.array(z.object({ src: z.string(), dest: z.string() })) }),
      execute: async (): Promise<string> => {
        throw new Error(NO_FIG_FILE)
      }
    }),
    fig_screenshot: tool({
      description: 'Render a node of a mounted .fig file. Figma files are not supported in Deskmates.',
      inputSchema: z.object({ node_id: z.string() }),
      execute: async (): Promise<string> => {
        throw new Error(NO_FIG_FILE)
      }
    }),
    fig_materialize: tool({
      description: 'Extract components from a mounted .fig file. Figma files are not supported in Deskmates.',
      inputSchema: z.object({
        components: z.array(z.string()).optional(),
        frames: z.array(z.string()).optional(),
        dest: z.string().optional(),
        moduleFormat: z.string().optional(),
        overwrite: z.boolean().optional(),
        tokens: z.boolean().optional(),
        typography: z.boolean().optional()
      }),
      execute: async (): Promise<string> => {
        throw new Error(NO_FIG_FILE)
      }
    }),

    snip: tool({
      description: 'Mark part of the conversation as no longer needed. Deskmates trims long conversations on its own, so this only acknowledges.',
      inputSchema: z.object({ from_id: z.string(), to_id: z.string(), reason: z.string().optional() }),
      execute: async () => ({ ok: true, note: 'Noted. Long conversations are trimmed automatically.' })
    }),

    web_search: tool({
      description: 'Search the web and get the top results (title, address, snippet).',
      inputSchema: z.object({ query: z.string().min(2) }),
      execute: async ({ query }, { abortSignal }) => webSearchResults(query, abortSignal)
    }),

    web_fetch: tool({
      description: 'Fetch a web page (http or https) and get its readable text.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }, { abortSignal }) => webFetchText(url, abortSignal)
    }),

    tool_search_tool_bm25: tool({
      description: 'Find tools by keywords. Every tool listed is already loaded and can be called directly.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
      execute: async ({ query, limit = 5 }) => {
        const found = searchTools(listTools(), query, limit)
        return found.length > 0 ? found : 'No matching tools.'
      }
    }),

    run_script: tool({
      description:
        'Run an async JavaScript snippet for batch work on the design\'s files. Available: readFile(path), writeFile(path, text), listFiles(path?), exists(path), log(...). Paths are relative to the design folder; writes can be undone. The user approves each script.',
      inputSchema: z.object({ code: z.string().min(1), purpose: z.string().optional() }),
      execute: async ({ code }) => {
        const logs: string[] = []
        const api = {
          readFile: async (path: string) => readFile(inside(String(path)), 'utf8'),
          writeFile: async (path: string, text: string) => (await writeTracked(ctx, inside(String(path)), String(text))).path,
          listFiles: async (path = '.') => (await readdir(inside(String(path)), { withFileTypes: true })).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)),
          exists: async (path: string) => existsSync(inside(String(path))),
          log: (...parts: unknown[]) => void logs.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')),
          console: { log: (...parts: unknown[]) => void logs.push(parts.map(String).join(' ')) },
          JSON,
          Math
        }
        const run = runInNewContext(`(async () => {\n${code}\n})()`, api, { timeout: 5_000 }) as Promise<unknown>
        const result = await Promise.race([
          run,
          new Promise((_, reject) => setTimeout(() => reject(new Error('The script ran longer than a minute and was stopped.')), RUN_SCRIPT_TIMEOUT_MS))
        ])
        return { result: result ?? null, logs }
      }
    })
  }
}

