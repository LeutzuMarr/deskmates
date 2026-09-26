import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { realRoot, resolveInside, toProjectRelative } from '../fs/safe-path'
import type { ToolContext } from './context'

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'out', 'build'])
const MAX_READ_BYTES = 256 * 1024
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_MATCHES = 100
const MAX_ENTRIES = 500

const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0)

/** Writes a file inside the project and records the change so it can be undone. */
export async function writeTracked(
  ctx: ToolContext,
  absPath: string,
  data: string | Uint8Array
): Promise<{ path: string; created: boolean }> {
  const existed = existsSync(absPath)
  ctx.changes.record(ctx.taskId, ctx.root, absPath, existed ? 'modify' : 'create')
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, data)
  ctx.onChangesUpdated()
  return { path: toProjectRelative(ctx.root, absPath), created: !existed }
}

export function fileTools(ctx: ToolContext) {
  const rel = (absPath: string) => toProjectRelative(ctx.root, absPath)

  return {
    list_files: tool({
      description: 'List files and folders in the project. All paths are relative to the project folder.',
      inputSchema: z.object({
        path: z.string().default('.').describe('Folder to list, relative to the project folder'),
        depth: z.number().int().min(1).max(4).default(1).describe('How many folder levels to include')
      }),
      execute: async ({ path = '.', depth = 1 }) => {
        const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = []
        let truncated = false
        const walk = async (dir: string, level: number): Promise<void> => {
          const items = await readdir(dir, { withFileTypes: true })
          items.sort((a, b) => a.name.localeCompare(b.name))
          for (const item of items) {
            if (entries.length >= MAX_ENTRIES) {
              truncated = true
              return
            }
            const abs = join(dir, item.name)
            if (item.isDirectory()) {
              entries.push({ path: `${rel(abs)}/`, type: 'dir' })
              if (level < depth && !SKIP_DIRS.has(item.name)) await walk(abs, level + 1)
            } else if (item.isFile()) {
              entries.push({ path: rel(abs), type: 'file', size: (await stat(abs)).size })
            }
          }
        }
        await walk(resolveInside(ctx.root, path), 1)
        return { entries, truncated }
      }
    }),

    read_file: tool({
      description:
        'Read a text file. Returns up to 400 lines by default; use offset and limit to read more of a long file. For Word, Excel, PowerPoint or PDF files use read_document.',
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().int().min(1).optional().describe('First line to read, starting at 1'),
        limit: z.number().int().min(1).max(2000).optional().describe('How many lines to read (default 400)')
      }),
      execute: async ({ path, offset = 1, limit = 400 }) => {
        const abs = resolveInside(ctx.root, path)
        const handle = await open(abs)
        const buffer = Buffer.alloc(MAX_READ_BYTES + 1)
        let bytesRead = 0
        try {
          bytesRead = (await handle.read(buffer, 0, buffer.length, 0)).bytesRead
        } finally {
          await handle.close()
        }
        const content = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES))
        if (isBinary(content)) {
          return { path: rel(abs), binary: true, note: 'This is a binary file. Use read_document for documents.' }
        }
        const lines = content.toString('utf8').split(/\r?\n/)
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        return {
          path: rel(abs),
          totalLines: lines.length,
          startLine: offset,
          endLine: offset + slice.length - 1,
          cutAtBytes: bytesRead > MAX_READ_BYTES ? MAX_READ_BYTES : undefined,
          content: slice.join('\n')
        }
      }
    }),

    write_file: tool({
      description:
        'Create a file or replace its whole content. Missing folders are created. The user can undo every change.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const result = await writeTracked(ctx, resolveInside(ctx.root, path), content)
        return { ...result, bytes: Buffer.byteLength(content) }
      }
    }),

    edit_file: tool({
      description:
        'Replace exact text in a file. old_text must match the file exactly, including spaces; read the file first. Fails if the text appears more than once unless replace_all is true.',
      inputSchema: z.object({
        path: z.string(),
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().default(false)
      }),
      execute: async ({ path, old_text, new_text, replace_all = false }) => {
        const abs = resolveInside(ctx.root, path)
        const current = await readFile(abs, 'utf8')
        let oldText = old_text
        let newText = new_text
        if (!current.includes(oldText) && current.includes('\r\n')) {
          oldText = old_text.replace(/\r?\n/g, '\r\n')
          newText = new_text.replace(/\r?\n/g, '\r\n')
        }
        const count = current.split(oldText).length - 1
        if (count === 0) throw new Error('old_text was not found in the file. Read the file again and copy the exact text.')
        if (count > 1 && !replace_all) {
          throw new Error(`old_text appears ${count} times. Include more surrounding text to make it unique, or set replace_all.`)
        }
        const updated = replace_all ? current.split(oldText).join(newText) : current.replace(oldText, () => newText)
        await writeTracked(ctx, abs, updated)
        return { path: rel(abs), replacements: replace_all ? count : 1 }
      }
    }),

    move_path: tool({
      description: 'Move or rename a file or folder inside the project. Fails if the destination exists.',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }) => {
        const source = resolveInside(ctx.root, from)
        const target = resolveInside(ctx.root, to)
        if (!existsSync(source)) throw new Error(`Not found: ${from}`)
        if (existsSync(target)) throw new Error(`The destination already exists: ${to}`)
        ctx.changes.record(ctx.taskId, ctx.root, source, 'move', target)
        await mkdir(dirname(target), { recursive: true })
        await rename(source, target)
        ctx.onChangesUpdated()
        return { from: rel(source), to: rel(target) }
      }
    }),

    delete_path: tool({
      description:
        'Delete a file or an empty folder. The user must approve every deletion, and it can be undone afterwards.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const abs = resolveInside(ctx.root, path)
        if (abs === realRoot(ctx.root)) throw new Error('Refusing to delete the project folder itself.')
        const info = await stat(abs)
        if (info.isDirectory()) {
          if ((await readdir(abs)).length > 0) {
            throw new Error('Only files and empty folders can be deleted. Delete the files inside it first.')
          }
          ctx.changes.record(ctx.taskId, ctx.root, abs, 'delete')
          await rmdir(abs)
        } else {
          ctx.changes.record(ctx.taskId, ctx.root, abs, 'delete')
          await rm(abs)
        }
        ctx.onChangesUpdated()
        return { deleted: rel(abs) }
      }
    }),

    search_files: tool({
      description: 'Search text files in the project for a word or phrase (or a regular expression). Returns up to 100 matching lines.',
      inputSchema: z.object({
        query: z.string().min(1),
        path: z.string().default('.').describe('Folder or file to search, relative to the project folder'),
        regex: z.boolean().default(false),
        file_pattern: z.string().optional().describe('Only search files whose name ends with this, for example ".md"')
      }),
      execute: async ({ query, path = '.', regex = false, file_pattern }) => {
        const pattern = regex ? new RegExp(query, 'i') : null
        const needle = query.toLowerCase()
        const suffix = file_pattern?.toLowerCase()
        const matches: Array<{ path: string; line: number; text: string }> = []
        let filesScanned = 0

        const scanFile = async (abs: string): Promise<void> => {
          if ((await stat(abs)).size > MAX_SEARCH_FILE_BYTES) return
          const buffer = await readFile(abs)
          if (isBinary(buffer)) return
          filesScanned++
          buffer
            .toString('utf8')
            .split(/\r?\n/)
            .forEach((text, index) => {
              if (matches.length >= MAX_MATCHES) return
              if (pattern ? pattern.test(text) : text.toLowerCase().includes(needle)) {
                matches.push({ path: rel(abs), line: index + 1, text: text.slice(0, 300) })
              }
            })
        }

        const walk = async (dir: string): Promise<void> => {
          for (const item of await readdir(dir, { withFileTypes: true })) {
            if (matches.length >= MAX_MATCHES) return
            const abs = join(dir, item.name)
            if (item.isDirectory()) {
              if (!SKIP_DIRS.has(item.name)) await walk(abs)
            } else if (item.isFile() && (!suffix || item.name.toLowerCase().endsWith(suffix))) {
              await scanFile(abs)
            }
          }
        }

        const start = resolveInside(ctx.root, path)
        if ((await stat(start)).isFile()) await scanFile(start)
        else await walk(start)
        return { matches, filesScanned, truncated: matches.length >= MAX_MATCHES }
      }
    })
  }
}
