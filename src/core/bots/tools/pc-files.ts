/**
 * The pc-files tool group: read/write inside the bot PC's own persistent storage ("data/...",
 * `/home/bot/data` in the container — this is the bot's memory, since it survives between runs)
 * and the folder shared with every other bot ("shared/...", `/shared`). Goes through the agent
 * service's `/files` endpoint for read/write, which already enforces the data/shared sandbox
 * server-side (see `bot-image/agent.py`'s `resolve_safe_path`); `resolvePcPath` below applies the
 * same "data/..." or "shared/..." rule client-side too, since listing goes through `/exec`
 * (`ls`), which the agent does not sandbox itself.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { AgentClient } from './agent-client'

const MAX_READ_BYTES = 512 * 1024

// Fixed container-side roots (see `bot-image/Dockerfile` and `local-wsl-host.ts`'s `runContainer`,
// which always bind-mounts a bot's storage to `/home/bot/data` and the shared folder to `/shared`).
const DATA_ROOT = '/home/bot/data'
const SHARED_ROOT = '/shared'

interface PcPath {
  /** Exactly what to send as `/files?path=...` to the agent. */
  filesPath: string
  /** The absolute path inside the container, for listing via `/exec`. */
  containerPath: string
}

/** Mirrors agent.py's `resolve_safe_path` segment checks: only "data/..." or "shared/...", no empty/"."/".." segments. */
function resolvePcPath(input: string, options: { allowRoot?: boolean } = {}): PcPath {
  const trimmed = input.trim()
  const invalid = (): never => {
    throw new Error('Give a path under "data/" (your own storage) or "shared/" (shared with other bots).')
  }
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) invalid()

  const parts = trimmed.split('/')
  const root = parts[0] === 'data' ? DATA_ROOT : parts[0] === 'shared' ? SHARED_ROOT : null
  if (!root) invalid()

  const segments = parts.slice(1).filter((s) => s !== '')
  if (segments.some((s) => s === '.' || s === '..')) throw new Error('That path is invalid.')
  if (segments.length === 0 && !options.allowRoot) throw new Error('That path needs to name a file, not just a folder.')

  const rel = segments.join('/')
  return { filesPath: rel ? `${parts[0]}/${rel}` : (parts[0] as string), containerPath: rel ? `${root}/${rel}` : (root as string) }
}

/** Builds the pc-files tool set. `agent` is fresh per run (see `runner.ts`). */
export function pcFilesTools(agent: AgentClient) {
  return {
    list_pc_files: tool({
      description:
        'List files and folders under your own storage ("data/...") or the folder shared with other bots ("shared/..."). Pass "data" or "shared" alone to list the top level.',
      inputSchema: z.object({ path: z.string().default('data') }),
      execute: async ({ path }) => {
        const resolved = resolvePcPath(path, { allowRoot: true })
        const result = await agent.exec(['ls', '-1AF', '--', resolved.containerPath])
        if (result.code !== 0) throw new Error(result.stderr.trim() || `Couldn't list ${resolved.filesPath}.`)
        const entries = result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            if (line.endsWith('/')) return { name: line.slice(0, -1), type: 'dir' as const }
            const name = /[*@=|]$/.test(line) ? line.slice(0, -1) : line
            return { name, type: 'file' as const }
          })
        return { path: resolved.filesPath, entries }
      }
    }),

    read_pc_file: tool({
      description: 'Read a text file from your own storage ("data/...") or the shared folder ("shared/...").',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => {
        const resolved = resolvePcPath(path)
        const bytes = await agent.readFile(resolved.filesPath)
        const truncated = bytes.length > MAX_READ_BYTES
        return { path: resolved.filesPath, truncated, content: bytes.subarray(0, MAX_READ_BYTES).toString('utf8') }
      }
    }),

    write_pc_file: tool({
      description:
        'Create or replace a text file in your own storage ("data/...") or the shared folder ("shared/..."). Your own storage survives between runs — use it to remember what you already did, so you never repeat yourself.',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path, content }) => {
        const resolved = resolvePcPath(path)
        const result = await agent.writeFile(resolved.filesPath, content)
        return { path: resolved.filesPath, bytes: result.bytes }
      }
    })
  }
}
