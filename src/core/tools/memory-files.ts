/**
 * The memory folder the user's prompt describes (memory_read, memory_write, memory_append,
 * memory_str_replace, memory_delete, memory_list): Markdown documents under paths like
 * /topics/schedule.md, kept in Deskmates' data folder so every agent and every project shares them.
 *
 * Every change names the version it expects (`if_version`: a 12-character token from the last read
 * or write, or "new" for a file that doesn't exist yet), so an agent never overwrites a change it
 * hasn't seen.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Largest document a write may leave behind. */
export const MEMORY_MAX_BYTES = 100 * 1024
const LIST_CAP = 200

export function memoryVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

export interface MemoryEntry {
  path: string
  size: number
  updatedAt: string
  preview?: string
}

export class MemoryFiles {
  constructor(private readonly root: string) {}

  /** The absolute file for a memory path; refuses anything that would leave the memory folder. */
  private fileFor(path: string): string {
    const clean = `/${String(path).replace(/\\/g, '/').replace(/^\/+/, '')}`
    if (clean === '/' || clean.endsWith('/')) throw new Error(`"${path}" is a folder, not a document. Name a file, e.g. /topics/schedule.md.`)
    if (clean.split('/').some((part) => part === '..')) throw new Error('Memory paths cannot contain "..".')
    const abs = resolve(this.root, `.${clean}`)
    if (abs !== resolve(this.root) && !abs.startsWith(resolve(this.root) + sep)) throw new Error('That path is outside the memory folder.')
    return abs
  }

  private current(path: string): { abs: string; content: string | null } {
    const abs = this.fileFor(path)
    return { abs, content: existsSync(abs) ? readFileSync(abs, 'utf8') : null }
  }

  private checkVersion(path: string, content: string | null, ifVersion: string): void {
    const expected = String(ifVersion ?? '').trim()
    if (content === null) {
      if (expected !== 'new') throw new Error(`${path} doesn't exist. To create it, pass if_version "new".`)
      return
    }
    if (expected === 'new') throw new Error(`${path} already exists (version ${memoryVersion(content)}). memory_read it, then pass that version.`)
    if (expected !== memoryVersion(content)) {
      throw new Error(`${path} changed since you read it: its version is now ${memoryVersion(content)}, not ${expected}. memory_read it again and redo the change on the new text.`)
    }
  }

  private save(abs: string, path: string, content: string): string {
    if (!content.trim()) throw new Error('Empty documents are not saved. Use memory_delete to remove a document.')
    if (Buffer.byteLength(content) > MEMORY_MAX_BYTES) throw new Error(`That would make ${path} larger than ${MEMORY_MAX_BYTES} bytes. Split it into several documents.`)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return memoryVersion(content)
  }

  read(paths: string | string[]): string {
    const list = Array.isArray(paths) ? paths : [paths]
    return list
      .map((path) => {
        const { abs, content } = this.current(path)
        if (content === null) return `${path}: no such document.`
        return `${path} [version: ${memoryVersion(content)}] (updated ${statSync(abs).mtime.toISOString()})\n${content}`
      })
      .join('\n\n---\n\n')
  }

  write(path: string, content: string, ifVersion: string): string {
    const { abs, content: before } = this.current(path)
    this.checkVersion(path, before, ifVersion)
    return `Saved ${path} [version: ${this.save(abs, path, content)}]`
  }

  append(path: string, content: string, ifVersion: string): string {
    const { abs, content: before } = this.current(path)
    this.checkVersion(path, before, ifVersion)
    const merged = before === null ? content : `${before.replace(/\n+$/, '')}\n${content}`
    return `Appended to ${path} [version: ${this.save(abs, path, merged)}]`
  }

  replace(path: string, oldStr: string, newStr: string, ifVersion: string): string {
    const { abs, content } = this.current(path)
    if (content === null) throw new Error(`${path} doesn't exist.`)
    this.checkVersion(path, content, ifVersion)
    const count = content.split(oldStr).length - 1
    if (count === 0) throw new Error(`old_str isn't in ${path}. memory_read it and copy the text exactly.`)
    if (count > 1) throw new Error(`old_str is in ${path} ${count} times. Include more surrounding text so it matches once.`)
    return `Edited ${path} [version: ${this.save(abs, path, content.replace(oldStr, () => newStr))}]`
  }

  delete(path: string, ifVersion: string): string {
    const { abs, content } = this.current(path)
    if (content === null) throw new Error(`${path} doesn't exist.`)
    if (String(ifVersion ?? '').trim() === 'new') throw new Error('Pass the version from memory_read to delete a document.')
    this.checkVersion(path, content, ifVersion)
    rmSync(abs)
    return `Deleted ${path}.`
  }

  list(pathPrefix?: string | null, cursor?: string | null, includePreview = false): { entries: MemoryEntry[]; next_cursor: string | null } {
    const all: MemoryEntry[] = []
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) walk(abs)
        else if (entry.isFile()) {
          const info = statSync(abs)
          all.push({ path: `/${relative(this.root, abs).split(sep).join('/')}`, size: info.size, updatedAt: info.mtime.toISOString() })
        }
      }
    }
    walk(this.root)
    all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const prefix = pathPrefix ? `/${pathPrefix.replace(/^\/+/, '')}` : ''
    const filtered = all.filter((entry) => entry.path.startsWith(prefix) && (!cursor || entry.path > cursor))
    const page = filtered.slice(0, LIST_CAP)
    if (includePreview) {
      for (const entry of page) {
        const text = readFileSync(this.fileFor(entry.path), 'utf8')
        const described = /^description:\s*(.+)$/m.exec(text)?.[1]
        const firstLine = text.replace(/^---[\s\S]*?\n---\n/, '').split('\n').find((line) => line.trim())
        entry.preview = (described ?? firstLine ?? '').trim().slice(0, 160)
      }
    }
    return { entries: page, next_cursor: filtered.length > LIST_CAP ? page[page.length - 1]!.path : null }
  }
}
