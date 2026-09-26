import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class PathOutsideProjectError extends Error {
  constructor(input: string) {
    super(`This path is outside the project folder: ${input}`)
    this.name = 'PathOutsideProjectError'
  }
}

export function realRoot(root: string): string {
  return realpathSync.native(root)
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolves `input` against the project folder and guarantees the result stays inside it,
 * following symlinks and junctions on the deepest part of the path that already exists.
 */
export function resolveInside(root: string, input: string): string {
  const base = realRoot(root)
  const candidate = resolve(base, input)
  if (!isInside(base, candidate)) throw new PathOutsideProjectError(input)

  let existing = candidate
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  const followed = resolve(realpathSync.native(existing), relative(existing, candidate))
  if (!isInside(base, followed)) throw new PathOutsideProjectError(input)
  return candidate
}

export function toProjectRelative(root: string, absPath: string): string {
  const rel = relative(realRoot(root), absPath)
  return rel === '' ? '.' : rel.split(sep).join('/')
}
