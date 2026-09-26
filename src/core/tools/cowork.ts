import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { glob, readFile, readdir, stat } from 'node:fs/promises'
import { delimiter, dirname, extname, join, relative, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { resolveInside, toProjectRelative } from '../fs/safe-path'
import type { ToolContext } from './context'
import { fileTools, writeTracked } from './files'
import { officeTools } from './office'
import { runPowerShell, type ShellResult } from './shell'
import { readOnlySubagentTools } from './agent-tools'
import { webFetchText, webSearchResults } from './web'

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'out', 'build'])
const DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.xlsx', '.pptx'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_GREP_FILE_BYTES = 1024 * 1024
const MAX_WORKFLOW_AGENTS = 20

/** A tool's name and one-line description, for the tool-search tools. */
export interface ToolListing {
  name: string
  description: string
}

/** Runs another tool's implementation directly, for tools that are thin variants of an existing one. */
export function callTool<T>(target: unknown, input: unknown): Promise<T> {
  const execute = (target as { execute?: (input: unknown, options: unknown) => Promise<T> }).execute
  if (!execute) throw new Error('That tool has no implementation.')
  return execute(input, { toolCallId: 'internal', messages: [] })
}

/**
 * Models trained on POSIX shells sometimes write `/c/Users/...`, which means `C:/Users/...` here; and
 * the Cowork prompt's sandbox folders (uploads, outputs, the home folder) are all the project folder.
 */
export function nativePath(input: string): string {
  const sandbox = /^(?:computer:\/\/)?(?:\/mnt\/user-data\/(?:uploads|outputs)|\/home\/claude)(?:\/|$)(.*)$/.exec(input)
  if (sandbox) return sandbox[1] || '.'
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(input)
  return drive ? `${drive[1].toUpperCase()}:/${input.slice(3)}` : input
}

/** Case-insensitive word match of a query against tool names and descriptions, best first. */
export function searchTools(listings: ToolListing[], query: string, limit: number): ToolListing[] {
  const words = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
  const selected = /^select:(.+)$/i.exec(query.trim())
  if (selected) {
    const names = new Set(selected[1].split(',').map((n) => n.trim()))
    return listings.filter((t) => names.has(t.name))
  }
  return listings
    .map((t) => {
      const hay = `${t.name} ${t.description}`.toLowerCase()
      const score = words.reduce((sum, w) => sum + (t.name.toLowerCase().includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0)
      return { t, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t)
}

let bashPath: string | null | undefined

/** Git for Windows' bash, found next to git.exe on PATH; null when Git isn't installed. */
function findBash(): string | null {
  if (bashPath !== undefined) return bashPath
  const candidates: string[] = []
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'git.exe'))) candidates.push(join(dirname(dir), 'bin', 'bash.exe'))
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  bashPath = candidates.find((path) => existsSync(path)) ?? null
  return bashPath
}

function runBash(bash: string, command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((settle) => {
    const child = spawn(bash, ['-lc', command], { cwd, windowsHide: true, env: { ...process.env, CHERE_INVOKING: '1' } })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (text: string, chunk: string): string => (text.length > 30_000 ? text : (text + chunk).slice(0, 30_000))
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout = cap(stdout, chunk)))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = cap(stderr, chunk)))
    const kill = (): void => {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined)
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ exitCode: code, stdout, stderr, timedOut })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ exitCode: null, stdout, stderr: error.message, timedOut })
    })
  })
}

/** Walks the files under `start` (a file or folder), skipping build and dependency folders. */
async function* walkFiles(start: string): AsyncGenerator<string> {
  const info = await stat(start)
  if (info.isFile()) {
    yield start
    return
  }
  for (const item of await readdir(start, { withFileTypes: true })) {
    const abs = join(start, item.name)
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) yield* walkFiles(abs)
    } else if (item.isFile()) yield abs
  }
}

const TYPE_EXTS: Record<string, string[]> = {
  js: ['.js', '.mjs', '.cjs', '.jsx'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  py: ['.py'],
  md: ['.md', '.markdown'],
  json: ['.json'],
  css: ['.css', '.scss', '.less'],
  html: ['.html', '.htm'],
  java: ['.java'],
  go: ['.go'],
  rust: ['.rs'],
  cs: ['.cs'],
  cpp: ['.c', '.cc', '.cpp', '.h', '.hpp']
}

/** A small glob matcher for Grep's `glob` filter (`*`, `**`, `?`, `{a,b}`), matched against the path relative to the search root. */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else source += '[^/]*'
    } else if (ch === '?') source += '[^/]'
    else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) source += '\\{'
      else {
        source += `(${pattern.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`
        i = end
      }
    } else source += ch.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  // A pattern without a slash matches the file name anywhere, like ripgrep's --glob.
  return new RegExp(pattern.includes('/') ? `^${source}$` : `(^|/)${source}$`, 'i')
}

export interface GrepOptions {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-i'?: boolean
  '-n'?: boolean
  '-A'?: number
  '-B'?: number
  '-C'?: number
  context?: number
  head_limit?: number
  offset?: number
  multiline?: boolean
}

/** ripgrep-like search over the project's text files, in JavaScript so it needs nothing installed. */
export async function grepFiles(root: string, options: GrepOptions): Promise<string> {
  const start = resolveInside(root, nativePath(options.path ?? '.'))
  const flags = `${options['-i'] ? 'i' : ''}${options.multiline ? 's' : ''}g`
  let regex: RegExp
  try {
    regex = new RegExp(options.pattern, flags)
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
  const mode = options.output_mode ?? 'files_with_matches'
  const filter = options.glob ? globToRegExp(options.glob) : null
  const exts = options.type ? TYPE_EXTS[options.type.toLowerCase()] ?? [`.${options.type.toLowerCase()}`] : null
  const before = options['-B'] ?? options['-C'] ?? options.context ?? 0
  const after = options['-A'] ?? options['-C'] ?? options.context ?? 0
  const showLines = options['-n'] ?? true
  const out: string[] = []
  const base = (await stat(start)).isFile() ? dirname(start) : start

  for await (const abs of walkFiles(start)) {
    const rel = relative(base, abs).split(sep).join('/')
    if (filter && !filter.test(rel)) continue
    if (exts && !exts.includes(extname(abs).toLowerCase())) continue
    if ((await stat(abs)).size > MAX_GREP_FILE_BYTES) continue
    const buffer = await readFile(abs)
    if (buffer.subarray(0, 8000).includes(0)) continue
    const text = buffer.toString('utf8')
    regex.lastIndex = 0
    if (options.multiline) {
      const found = text.match(regex)
      if (!found) continue
      if (mode === 'files_with_matches') out.push(abs)
      else if (mode === 'count') out.push(`${abs}:${found.length}`)
      else found.forEach((m) => out.push(`${abs}:${m}`))
      continue
    }
    const lines = text.split(/\r?\n/)
    const hits: number[] = []
    lines.forEach((line, index) => {
      regex.lastIndex = 0
      if (regex.test(line)) hits.push(index)
    })
    if (hits.length === 0) continue
    if (mode === 'files_with_matches') out.push(abs)
    else if (mode === 'count') out.push(`${abs}:${hits.length}`)
    else {
      const shown = new Set<number>()
      for (const hit of hits) for (let i = Math.max(0, hit - before); i <= Math.min(lines.length - 1, hit + after); i++) shown.add(i)
      for (const i of [...shown].sort((a, b) => a - b)) out.push(`${abs}:${showLines ? `${i + 1}:` : ''}${lines[i].slice(0, 500)}`)
    }
  }
  const offset = options.offset ?? 0
  const limited = options.head_limit === 0 ? out.slice(offset) : out.slice(offset, offset + (options.head_limit ?? 250))
  if (limited.length === 0) return mode === 'count' ? 'No matches' : 'No matches found'
  return limited.join('\n') + (out.length > offset + limited.length ? `\n[${out.length - offset - limited.length} more results; use offset to see them]` : '')
}

/** Runs a Workflow script: plain JavaScript with agent()/parallel()/pipeline()/log()/phase() hooks. */
async function runWorkflow(
  ctx: ToolContext,
  script: string,
  args: unknown,
  signal: AbortSignal | undefined
): Promise<{ result: unknown; log: string[]; agents: number }> {
  if (!ctx.subagents) throw new Error('Sub-agents are not set up in this app, so workflows cannot run.')
  const subagents = ctx.subagents
  const lines: string[] = []
  let agents = 0
  const agent = async (prompt: string, opts: { label?: string } = {}): Promise<string | null> => {
    if (signal?.aborted) throw new Error('Stopped.')
    if (++agents > MAX_WORKFLOW_AGENTS) throw new Error(`A workflow may start at most ${MAX_WORKFLOW_AGENTS} agents.`)
    const [report] = await subagents.run({
      tasks: [{ id: opts.label ?? `agent-${agents}`, instruction: String(prompt) }],
      model: ctx.modelRef,
      tools: readOnlySubagentTools(ctx)
    })
    return report?.error ? null : (report?.text ?? null)
  }
  const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)))
  const pipeline = async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>): Promise<unknown[]> =>
    Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stages) {
          try {
            value = await stage(value, item, index)
          } catch {
            return null
          }
        }
        return value
      })
    )
  const body = script.replace(/export\s+const\s+meta\s*=/, 'const meta =')
  const sandbox = {
    agent,
    parallel,
    pipeline,
    log: (message: unknown) => void lines.push(String(message)),
    phase: (title: unknown) => void lines.push(`# ${String(title)}`),
    args,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    JSON,
    Math,
    console: { log: (...parts: unknown[]) => void lines.push(parts.map(String).join(' ')) }
  }
  const run = runInNewContext(`(async () => {\n${body}\n})()`, sandbox, { timeout: 5_000 }) as Promise<unknown>
  return { result: await run, log: lines, agents }
}

export function coworkTools(ctx: ToolContext, listTools: () => ToolListing[] = () => []): ToolSet {
  const files = fileTools(ctx)
  const office = officeTools(ctx)
  const inside = (path: string): string => resolveInside(ctx.root, nativePath(path))

  return {
    Read: tool({
      description:
        'Read a file in the project. Returns lines with line numbers (up to 2000 by default; use offset and limit for more). Word, Excel, PowerPoint and PDF files come back as text.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path, or a path relative to the project folder'),
        offset: z.number().int().min(1).optional().describe('First line to read, starting at 1'),
        limit: z.number().int().min(1).optional().describe('How many lines to read'),
        pages: z.string().optional().describe('For PDFs: ignored; the whole text is returned')
      }),
      execute: async ({ file_path, offset = 1, limit = 2000 }) => {
        const abs = inside(file_path)
        const ext = extname(abs).toLowerCase()
        if (DOCUMENT_EXTS.has(ext)) return callTool(office.read_document, { path: abs })
        if (IMAGE_EXTS.has(ext)) return `${abs} is an image (${(await stat(abs)).size} bytes). Images can't be shown as text here.`
        const buffer = await readFile(abs)
        if (buffer.subarray(0, 8000).includes(0)) return `${abs} is a binary file.`
        const lines = buffer.subarray(0, MAX_READ_BYTES).toString('utf8').split(/\r?\n/)
        if (lines.length === 1 && lines[0] === '') return `${abs} is empty.`
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const width = String(offset + slice.length).length
        const text = slice.map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`).join('\n')
        const more = offset - 1 + limit < lines.length ? `\n[${lines.length - (offset - 1 + limit)} more lines; use offset to read on]` : ''
        return text + more
      }
    }),

    Write: tool({
      description: 'Create a file or replace its whole content. Missing folders are created, and the user can undo the change.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path, or a path relative to the project folder'),
        content: z.string()
      }),
      execute: async ({ file_path, content }) => {
        const result = await writeTracked(ctx, inside(file_path), content)
        return `${result.created ? 'Created' : 'Updated'} ${result.path} (${Buffer.byteLength(content)} bytes)`
      }
    }),

    Edit: tool({
      description:
        'Replace exact text in a file. old_string must match exactly (read the file first) and be unique unless replace_all is set. The user can undo the change.',
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional()
      }),
      execute: async ({ file_path, old_string, new_string, replace_all = false }) => {
        const result = await callTool<{ path: string; replacements: number }>(files.edit_file, {
          path: inside(file_path),
          old_text: old_string,
          new_text: new_string,
          replace_all
        })
        return `Edited ${result.path} (${result.replacements} replacement${result.replacements === 1 ? '' : 's'})`
      }
    }),

    Bash: tool({
      description:
        'Run a shell command in the project folder. Uses Git Bash when Git for Windows is installed, otherwise PowerShell (the result says which). The user approves each command.',
      inputSchema: z.object({
        command: z.string().min(1),
        description: z.string().optional().describe('What the command does, in a few words'),
        timeout: z.number().int().min(1000).max(600_000).optional().describe('Timeout in milliseconds (default 120000)'),
        run_in_background: z.boolean().optional().describe('Not supported here; the command runs to completion'),
        dangerouslyDisableSandbox: z.boolean().optional()
      }),
      execute: async ({ command, timeout = 120_000 }, { abortSignal }) => {
        const bash = findBash()
        const result = bash
          ? await runBash(bash, command, ctx.root, timeout, abortSignal)
          : await runPowerShell(command, ctx.root, timeout, abortSignal)
        return { shell: bash ? 'bash' : 'powershell', ...result }
      }
    }),

    Glob: tool({
      description: 'Find files by name pattern (for example "**/*.ts" or "src/**/*.md"). Returns matching paths, newest first.',
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().optional().describe('Folder to search in; defaults to the project folder')
      }),
      execute: async ({ pattern, path }) => {
        const cwd = inside(path ?? '.')
        const found: Array<{ abs: string; mtime: number }> = []
        for await (const match of glob(pattern, { cwd, exclude: (name: string) => SKIP_DIRS.has(name) })) {
          const abs = join(cwd, match)
          const info = await stat(abs).catch(() => null)
          if (info?.isFile()) found.push({ abs, mtime: info.mtimeMs })
          if (found.length >= 1000) break
        }
        if (found.length === 0) return 'No files found'
        found.sort((a, b) => b.mtime - a.mtime)
        const shown = found.slice(0, 100).map((f) => f.abs)
        return shown.join('\n') + (found.length > 100 ? `\n[${found.length - 100} more; narrow the pattern]` : '')
      }
    }),

    Grep: tool({
      description:
        'Search file contents with a regular expression. output_mode: "files_with_matches" (default), "content" (matching lines, with -A/-B/-C context and -n line numbers) or "count". Filter with glob (e.g. "*.ts") or type (e.g. "ts").',
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().optional(),
        glob: z.string().optional(),
        type: z.string().optional(),
        output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
        '-i': z.boolean().optional(),
        '-n': z.boolean().optional(),
        '-A': z.number().int().min(0).optional(),
        '-B': z.number().int().min(0).optional(),
        '-C': z.number().int().min(0).optional(),
        context: z.number().int().min(0).optional(),
        head_limit: z.number().int().min(0).optional(),
        offset: z.number().int().min(0).optional(),
        multiline: z.boolean().optional()
      }),
      execute: async (options) => grepFiles(ctx.root, options)
    }),

    WebSearch: tool({
      description: 'Search the web and get the top results (title, address, snippet).',
      inputSchema: z.object({ query: z.string().min(2) }),
      execute: async ({ query }, { abortSignal }) => webSearchResults(query, abortSignal)
    }),

    WebFetch: tool({
      description: 'Fetch a web page (http or https) and get its readable text.',
      inputSchema: z.object({ url: z.string().url(), prompt: z.string().optional().describe('What you want from the page') }),
      execute: async ({ url }, { abortSignal }) => webFetchText(url, abortSignal)
    }),

    Agent: tool({
      description:
        'Start a sub-agent for a focused, self-contained task and get its final report. Sub-agents can read and search files but cannot change them or run commands.',
      inputSchema: z.object({
        description: z.string().optional().describe('A short name for the task'),
        prompt: z.string().min(1).describe('The full, self-contained assignment'),
        subagent_type: z.string().optional(),
        model: z.string().optional(),
        run_in_background: z.boolean().optional(),
        isolation: z.string().optional()
      }),
      execute: async ({ description, prompt }) => {
        if (!ctx.subagents) throw new Error('Sub-agents are not set up in this app.')
        const [report] = await ctx.subagents.run({
          tasks: [{ id: (description ?? 'agent').slice(0, 50), instruction: prompt }],
          model: ctx.modelRef,
          tools: readOnlySubagentTools(ctx)
        })
        if (report?.error) throw new Error(`The sub-agent failed: ${report.error}`)
        return report?.text ?? '(no report)'
      }
    }),

    Workflow: tool({
      description:
        'Run a JavaScript workflow that orchestrates several read-only sub-agents: agent(prompt, {label}), parallel(thunks), pipeline(items, ...stages), log(msg), phase(title) and args are available; the script\'s return value is the result. The user approves each workflow.',
      inputSchema: z.object({
        script: z.string().min(1),
        args: z.unknown().optional(),
        name: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        scriptPath: z.string().optional(),
        resumeFromRunId: z.string().optional()
      }),
      execute: async ({ script, args }, { abortSignal }) => runWorkflow(ctx, script, args, abortSignal)
    }),

    AskUserQuestion: tool({
      description:
        'Ask the user one to four multiple-choice questions when you are blocked on a decision only they can make. The questions appear as a card with buttons; end your turn after calling this and wait for their answers in the next message.',
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              question: z.string().min(1),
              header: z.string().max(40),
              options: z.array(z.object({ label: z.string().min(1), description: z.string(), preview: z.string().optional() })).min(2).max(4),
              multiSelect: z.boolean()
            })
          )
          .min(1)
          .max(4),
        answers: z.record(z.string(), z.string()).optional(),
        annotations: z.record(z.string(), z.unknown()).optional(),
        metadata: z.object({ source: z.string().optional() }).optional()
      }),
      execute: async ({ questions }) => ({
        shown: true,
        questions: questions.length,
        note: 'The questions are on screen. End your turn now; the answers arrive as the next user message.'
      })
    }),

    SendUserMessage: tool({
      description: 'Show the user a message in the conversation right away, word for word (for example a progress update during a long task).',
      inputSchema: z.object({ message: z.string().min(1) }),
      execute: async () => ({ shown: true })
    }),

    SendUserFile: tool({
      description: 'Show the user files from the project as cards they can open. Paths are absolute or relative to the project folder.',
      inputSchema: z.object({
        files: z.array(z.string().min(1)).min(1).max(20),
        caption: z.string().optional(),
        display: z.enum(['render', 'attach']).optional(),
        status: z.enum(['normal', 'proactive']).optional()
      }),
      execute: async ({ files: paths, caption }) => {
        const resolved = paths.map((path) => {
          const abs = inside(path)
          if (!existsSync(abs)) throw new Error(`Not found: ${path}`)
          return { path: toProjectRelative(ctx.root, abs), absolutePath: abs }
        })
        return { shown: true, files: resolved, caption: caption ?? null }
      }
    }),

    Skill: tool({
      description: 'Load an installed skill by name and get its instructions (and the files it comes with).',
      inputSchema: z.object({ skill: z.string().min(1), args: z.string().optional() }),
      execute: async ({ skill, args }) => {
        if (!ctx.skills) throw new Error('No skills are set up in this app.')
        const name = skill.replace(/^.*:/, '')
        const loaded = ctx.skills.load(skill) ?? ctx.skills.load(name)
        if (!loaded) {
          const installed = ctx.skills.list().filter((s) => s.enabled).map((s) => s.name)
          throw new Error(`No enabled skill named "${skill}". Installed: ${installed.join(', ') || 'none'}.`)
        }
        return { name: loaded.name, instructions: loaded.instructions, files: loaded.files, args: args ?? null }
      }
    }),

    SuggestSkills: tool({
      description: 'Find installed skills that match some keywords, so you can suggest one to the user.',
      inputSchema: z.object({
        keywords: z.array(z.string().min(1)).min(1).max(8),
        contextLabel: z.string().optional(),
        trigger: z.enum(['user_asked', 'proactive']).optional()
      }),
      execute: async ({ keywords }) => {
        const all = ctx.skills?.list() ?? []
        const words = keywords.map((k) => k.toLowerCase())
        const matches = all
          .filter((s) => words.some((w) => s.name.toLowerCase().includes(w)))
          .map((s) => ({ name: s.name, enabled: s.enabled }))
        return matches.length > 0 ? { matches } : { matches: [], note: 'No installed skill matches. The user can import skills in the Extras tab.' }
      }
    }),

    ToolSearch: tool({
      description: 'Find tools by keyword ("select:Name1,Name2" returns those exactly). Every tool listed is already loaded and can be called directly.',
      inputSchema: z.object({ query: z.string().min(1), max_results: z.number().int().min(1).max(50).optional() }),
      execute: async ({ query, max_results = 5 }) => {
        const found = searchTools(listTools(), query, max_results)
        return found.length > 0 ? found : 'No matching tools.'
      }
    }),

    ScheduleWakeup: tool({
      description:
        'Continue this task later on its own: after delaySeconds (60–3600), the prompt is sent to this task again, if it is not already working.',
      inputSchema: z.object({
        delaySeconds: z.number().min(1),
        reason: z.string().optional(),
        prompt: z.string().min(1),
        noop: z.boolean().optional(),
        stop: z.boolean().optional()
      }),
      execute: async ({ delaySeconds, prompt, stop }) => {
        if (stop) return { scheduled: false }
        if (!ctx.scheduleWakeup) throw new Error('Scheduled wake-ups are not available here.')
        const seconds = Math.min(Math.max(Math.round(delaySeconds), 60), 3600)
        ctx.scheduleWakeup(seconds * 1000, prompt)
        return { scheduled: true, inSeconds: seconds }
      }
    }),

    ListAgents: tool({
      description: 'List other agents you can message. Deskmates only has the sub-agents you start with Agent, which report back directly.',
      inputSchema: z.object({ q: z.string().optional(), channel: z.string().optional() }),
      execute: async () => ({ agents: [], note: 'There are no other agent sessions to message. Start a sub-agent with Agent instead.' })
    }),

    ReportFindings: tool({
      description: 'Report review findings (file, line, summary, failure scenario) as a structured list the user can read.',
      inputSchema: z.object({
        findings: z.array(
          z.object({
            file: z.string(),
            line: z.number().int().optional(),
            summary: z.string(),
            failure_scenario: z.string(),
            short_summary: z.string().optional(),
            category: z.string().optional(),
            verdict: z.string().optional(),
            outcome: z.string().optional()
          })
        ),
        level: z.string().optional()
      }),
      execute: async ({ findings }) => ({ reported: findings.length })
    }),

    RefreshMcpTools: tool({
      description: "Reconnect the user's MCP connectors and reload their tool lists.",
      inputSchema: z.object({ server: z.string().optional() }),
      execute: async () => {
        if (!ctx.connectors) return { refreshed: false, note: 'No connectors are set up.' }
        await ctx.connectors.refresh()
        return { refreshed: true, tools: Object.keys(ctx.connectors.tools()).length, note: 'New tools become available from the next task.' }
      }
    }),

    ShowOnboardingRolePicker: tool({
      description: 'Deskmates has no onboarding role picker; ask the user about their role in plain words instead.',
      inputSchema: z.object({}),
      execute: async () => ({ shown: false, note: 'Not available in Deskmates. Ask in plain words.' })
    })
  }
}

