import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const FONT_KEY_HKLM = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const FONT_KEY_HKCU = 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'

/** Trailing style words stripped from registry font names, in any order and combination. */
const STYLE_WORD = /^(regular|bold|italic|oblique|light|semilight|semibold|demibold|medium|black|heavy|thin|extralight|extrabold|ultralight|ultrabold|condensed|semicondensed|narrow)$/i

const stripStyleWords = (name: string): string => {
  let family = name.trim()
  for (;;) {
    const match = family.match(/\s+(\S+)\s*$/)
    if (!match || !STYLE_WORD.test(match[1])) break
    const next = family.slice(0, match.index).trim()
    if (!next) break
    family = next
  }
  return family
}

/**
 * Parses `reg query` output into sorted, deduplicated (case-insensitively) font family names.
 * Lines look like `    Segoe UI Bold (TrueType)    REG_SZ    segoeuib.ttf`.
 */
export function parseFontRegistry(output: string): string[] {
  const families = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const marker = line.indexOf('REG_SZ')
    if (marker === -1) continue
    const valueName = line.slice(0, marker).trim()
    if (!valueName) continue
    const base = valueName.replace(/\s*\((?:TrueType|OpenType)\)\s*$/i, '')
    for (const part of base.split(' & ')) {
      const family = stripStyleWords(part)
      const key = family.toLowerCase()
      if (family && !families.has(key)) families.set(key, family)
    }
  }
  return [...families.values()].sort((a, b) => a.localeCompare(b))
}

let cache: string[] | null = null

/** Font family names installed on this PC, sorted and without duplicates. */
export async function listSystemFonts(): Promise<string[]> {
  if (cache) return cache
  const [hklm, hkcu] = await Promise.all([
    run('reg', ['query', FONT_KEY_HKLM]).catch(() => ({ stdout: '' })),
    run('reg', ['query', FONT_KEY_HKCU]).catch(() => ({ stdout: '' }))
  ])
  cache = parseFontRegistry(`${hklm.stdout}\n${hkcu.stdout}`)
  return cache
}