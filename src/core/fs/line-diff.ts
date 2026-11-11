/** How many lines a change added and removed, as a diff summary shows them ("+12 −3"). */
export interface LineDelta {
  added: number
  removed: number
}

/** Above this many table cells the exact comparison is skipped for a cheaper estimate. */
const EXACT_CELL_LIMIT = 4_000_000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\n|\r/)
  // A final newline ends the last line; it doesn't start an empty one.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Lines the two sides have in common, in order (the longest common subsequence), two rows at a time. */
function commonLines(a: string[], b: string[]): number {
  let previous = new Uint32Array(b.length + 1)
  let current = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    ;[previous, current] = [current, previous]
  }
  return previous[b.length]
}

/** For very large edits: lines present on both sides, whatever their order. Never under-counts what is shared. */
function sharedLines(a: string[], b: string[]): number {
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  let shared = 0
  for (const line of b) {
    const left = counts.get(line) ?? 0
    if (left > 0) {
      counts.set(line, left - 1)
      shared++
    }
  }
  return shared
}

/** Counts the lines added and removed going from `before` to `after`. */
export function lineDelta(before: string, after: string): LineDelta {
  const a = splitLines(before)
  const b = splitLines(after)

  // Most edits touch a small part of a file: drop what matches at both ends first.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  const kept = midA.length * midB.length <= EXACT_CELL_LIMIT ? commonLines(midA, midB) : sharedLines(midA, midB)
  return { added: midB.length - kept, removed: midA.length - kept }
}
