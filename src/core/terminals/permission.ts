/**
 * Recognizes a terminal agent asking for permission (read a file, run a command, …) on the mirrored
 * screen of an attached terminal, and turns the user's answer into the keystrokes that agent's
 * prompt expects. OpenCode's prompt is matched exactly; other agents fall back to the common
 * numbered-choice and y/n prompt shapes.
 */
import type { TerminalPermissionPrompt, TerminalTool } from '../../shared/protocol'

/** A key the attach helper can press: a named key or one character. */
export type TerminalKey = 'enter' | 'escape' | 'tab' | 'left' | 'right' | 'up' | 'down' | 'space' | string

interface Detected {
  prompt: TerminalPermissionPrompt
  keys: Record<string, TerminalKey[]>
}

/** Box-drawing and block characters TUIs draw borders with. */
const BORDER = /[─-▟]/g

const clean = (line: string): string => line.replace(BORDER, ' ').replace(/\s+/g, ' ').trim()

const keyOf = (parts: string[]): string => parts.join('\u0001').slice(0, 400)

/**
 * OpenCode (1.x TUI): a "△ Permission required" box with a title line (icon + what it wants) and
 * the options Allow once / Allow always / Reject; ←/→ move, Enter picks, Esc rejects. "Allow
 * always" then asks Confirm / Cancel. The selection starts on the first option in both.
 */
function detectOpenCode(lines: string[]): Detected | null {
  const header = lines.findIndex((line) => /Permission required/.test(line))
  if (header < 0) return null
  const rest = lines.slice(header + 1)
  const optionsAt = rest.findIndex((line) => /Allow once/.test(line) && /Reject/.test(line))
  if (optionsAt >= 0) {
    const body = rest.slice(0, optionsAt).filter((line) => line && !/^[⇆↔]|enter\s|esc\s/i.test(line))
    const title = (body[0] ?? 'OpenCode wants permission').replace(/^[^\p{L}\p{N}]+/u, '').trim()
    const detail = body.slice(1, 7).join('\n') || null
    return {
      prompt: {
        key: keyOf(['opencode', title, detail ?? '']),
        title,
        detail,
        options: [
          { id: 'once', label: 'Allow once' },
          { id: 'always', label: 'Allow always' },
          { id: 'reject', label: 'Reject', danger: true }
        ]
      },
      keys: { once: ['enter'], always: ['right', 'enter', 'enter'], reject: ['escape'] }
    }
  }
  const confirmAt = rest.findIndex((line) => /\bConfirm\b/.test(line) && /\bCancel\b/.test(line))
  if (confirmAt >= 0) {
    const body = rest.slice(0, confirmAt).filter(Boolean)
    const title = (body[0] ?? 'Always allow this?').replace(/^[^\p{L}\p{N}]+/u, '').trim()
    return {
      prompt: {
        key: keyOf(['opencode-always', title]),
        title,
        detail: body.slice(1, 7).join('\n') || null,
        options: [
          { id: 'confirm', label: 'Confirm always' },
          { id: 'cancel', label: 'Back' }
        ]
      },
      keys: { confirm: ['enter'], cancel: ['right', 'enter'] }
    }
  }
  return null
}

const QUESTION = /\b(allow|permission|approve|proceed|do you want|are you sure|confirm|trust)\b/i
const NUMBERED = /^(?:[>❯›●○◯•*]\s*)?(\d)[.)]\s+(.+)$/
const YES_NO = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i

/** Other agents: a question followed by numbered choices (press the digit), or a (y/n) prompt. */
function detectGeneric(lines: string[]): Detected | null {
  const tail = lines.slice(-18)
  for (let i = tail.length - 1; i >= 0; i--) {
    if (!QUESTION.test(tail[i]) || NUMBERED.test(tail[i])) continue
    const options: Array<{ id: string; label: string }> = []
    for (const line of tail.slice(i + 1)) {
      const match = NUMBERED.exec(line)
      if (match && !options.some((option) => option.id === match[1])) options.push({ id: match[1], label: match[2].replace(/\s*\(.*?\)\s*$/, '').trim() })
    }
    if (options.length >= 2) {
      return {
        prompt: {
          key: keyOf(['numbered', tail[i], ...options.map((o) => o.label)]),
          title: tail[i],
          detail: null,
          options: options.map((o) => ({ ...o, danger: /^(no|deny|reject|cancel)\b/i.test(o.label) }))
        },
        keys: Object.fromEntries(options.map((o) => [o.id, [o.id]]))
      }
    }
    if (YES_NO.test(tail[i]) && i >= tail.length - 3) {
      return {
        prompt: {
          key: keyOf(['yes-no', tail[i]]),
          title: tail[i],
          detail: null,
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No', danger: true }
          ]
        },
        keys: { yes: ['y', 'enter'], no: ['n', 'enter'] }
      }
    }
    return null
  }
  return null
}

/** The permission prompt on `screen`, with the keys that answer each option; null when there is none. */
export function detectPermission(tool: TerminalTool, screen: string): Detected | null {
  const lines = screen.split('\n').map(clean)
  const found = tool === 'opencode' ? (detectOpenCode(lines) ?? detectGeneric(lines)) : (detectGeneric(lines) ?? detectOpenCode(lines))
  return found
}
