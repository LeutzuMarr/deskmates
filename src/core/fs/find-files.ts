/**
 * Project files whose path matches what the user typed after "@" in the message box. A bounded walk:
 * it skips the folders nobody means (dependencies, builds, version control) and stops early, so a
 * huge folder never makes the box lag.
 */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.cache', '.venv', 'venv', '__pycache__', '.deskmates', 'coverage', 'test-results'])
const MAX_VISITED = 20_000

/** Up to `limit` paths relative to `root` (forward slashes), best matches first. */
export function findFiles(root: string, query: string, limit = 30): string[] {
  const wanted = query.trim().toLowerCase().replace(/\\/g, '/')
  const hits: Array<{ path: string; score: number }> = []
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || visited > MAX_VISITED) return
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++visited > MAX_VISITED) return
      if (SKIP.has(entry.name)) continue
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).split(sep).join('/')
      const lower = rel.toLowerCase()
      const name = entry.name.toLowerCase()
      if (!wanted || lower.includes(wanted)) {
        // A name that starts with the query beats one that only contains it; shorter paths first.
        const score = (name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : 2) * 1000 + rel.length
        hits.push({ path: entry.isDirectory() ? `${rel}/` : rel, score })
      }
      if (entry.isDirectory()) walk(abs, depth + 1)
    }
  }
  walk(root, 0)
  return hits
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((hit) => hit.path)
}
