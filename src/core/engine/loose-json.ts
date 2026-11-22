/**
 * Reads the JSON schema blocks of an operating prompt, which are JSON as people paste it rather than
 * strict JSON: quotes left unescaped inside descriptions ("Use "select:<name>" for…"), descriptions
 * that run over several lines, single-quoted strings ('^(0|[1-9])$'), backslashes such as \d or \s
 * that JSON doesn't allow, and the odd trailing comma. Strict JSON is tried first; the repair only
 * runs when that fails.
 */

/** Strict JSON first, then the repaired text; null when neither parses. */
export function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the repair.
  }
  try {
    return JSON.parse(repairJson(text))
  } catch {
    return null
  }
}

const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])

/**
 * Rewrites near-JSON as JSON. A quote closes a string only where JSON could go on after it: a key's
 * quote before `:`, a value's quote before `}` / `]`, or before `,` when the next thing is another
 * key (in an object) or another value (in an array). Any other quote is part of the text.
 */
export function repairJson(text: string): string {
  const out: string[] = []
  /** The containers we are in: '{' or '['. */
  const stack: string[] = []
  /** Whether the next string in the current object is a key. */
  let expectKey = false
  let i = 0
  const n = text.length

  const skipSpace = (from: number): number => {
    let j = from
    while (j < n && /\s/.test(text[j]!)) j++
    return j
  }

  /** Whether a quote at `at` can end a string, given what follows it. */
  const closes = (at: number, isKey: boolean): boolean => {
    const j = skipSpace(at + 1)
    const next = text[j]
    if (isKey) return next === ':'
    if (next === undefined) return true
    // Only the bracket of the container we are in can follow: `"…"]` inside an object's text is text.
    const container = stack[stack.length - 1]
    if (next === '}' || next === ']') return (next === '}' && container === '{') || (next === ']' && container === '[')
    if (next !== ',') return false
    const k = skipSpace(j + 1)
    const after = text[k]
    if (after === undefined) return true
    if (stack[stack.length - 1] === '{') {
      // Another key must follow: "name": … (a trailing comma before } is tolerated too).
      if (after === '}') return true
      if (after !== '"' && after !== "'") return false
      const keyEnd = text.indexOf(after, k + 1)
      if (keyEnd === -1) return false
      const key = text.slice(k + 1, keyEnd)
      return !/[\n"]/.test(key) && text[skipSpace(keyEnd + 1)] === ':'
    }
    // In an array: another value.
    return /["'{\[\-0-9tfn\]]/.test(after)
  }

  /** Copies one string starting at the quote `at`, escaped as JSON; returns the index after it. */
  const readString = (at: number, isKey: boolean): number => {
    const quote = text[at]!
    let j = at + 1
    let value = ''
    while (j < n) {
      const ch = text[j]!
      if (ch === '\\') {
        const next = text[j + 1]
        if (next === undefined) break
        if (next === quote && quote === "'") value += "'"
        else if (next === "'") value += "'"
        else if (VALID_ESCAPES.has(next)) value += `\\${next}`
        else value += `\\\\${next === '\n' ? '\\n' : next}`
        j += 2
        continue
      }
      if (ch === quote && closes(j, isKey)) {
        out.push(`"${value}"`)
        return j + 1
      }
      if (ch === '"') value += '\\"'
      else if (ch === '\n') value += '\\n'
      else if (ch === '\r') value += ''
      else if (ch === '\t') value += '\\t'
      else if (ch < ' ') value += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
      else value += ch
      j++
    }
    // Unterminated: close it so the parse fails or succeeds on its own merits.
    out.push(`"${value}"`)
    return j
  }

  while (i < n) {
    const ch = text[i]!
    if (ch === '"' || ch === "'") {
      const isKey = stack[stack.length - 1] === '{' && expectKey
      i = readString(i, isKey)
      if (isKey) expectKey = false
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      expectKey = ch === '{'
      out.push(ch)
      i++
      continue
    }
    if (ch === '}' || ch === ']') {
      // Drop a trailing comma before the closing bracket.
      for (let k = out.length - 1; k >= 0; k--) {
        if (/^\s*$/.test(out[k]!)) continue
        if (out[k] === ',') out.splice(k, 1)
        break
      }
      stack.pop()
      expectKey = false
      out.push(ch)
      i++
      continue
    }
    if (ch === ',') {
      expectKey = stack[stack.length - 1] === '{'
      out.push(ch)
      i++
      continue
    }
    if (ch === ':') {
      expectKey = false
      out.push(ch)
      i++
      continue
    }
    out.push(ch)
    i++
  }
  return out.join('')
}
