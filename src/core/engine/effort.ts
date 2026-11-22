/**
 * The effort level the user picked, as each agent gets it: the operating prompt's own
 * `<reasoning_effort>` value (read from the effort table at the top of the Fable 5.2 file), a plain
 * line for models that don't know that tag, and the model's own reasoning setting where it has one.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { DEFAULT_EFFORT, EFFORT_LABELS, type EffortLevel, isEffortLevel } from '../../shared/effort'
import type { ThinkingMode } from '../../shared/protocol'
import { myPromptPath } from './my-prompt'

/** The prompt's table, used when the file has none: low 8, medium 10, high 30, extra 80, max. */
const FALLBACK: Record<EffortLevel, string> = { low: '8', medium: '10', high: '30', extra: '80', max: 'max' }

let cache: { path: string; mtimeMs: number; table: Record<EffortLevel, string> } | null = null

/** The `<reasoning_effort>` value for each level, from the prompt's "| level | value |" table. */
export function effortTable(path = myPromptPath()): Record<EffortLevel, string> {
  try {
    if (!existsSync(path)) return FALLBACK
    const { mtimeMs } = statSync(path)
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.table
    // The table sits above the first heading; read only that much.
    const head = readFileSync(path, 'utf8').slice(0, 4000).split(/\n# /)[0] ?? ''
    const table = { ...FALLBACK }
    for (const match of head.matchAll(/^\|\s*(low|medium|high|extra|max)\s*\|\s*`?([\w.]+)`?\s*\|/gim)) {
      table[match[1]!.toLowerCase() as EffortLevel] = match[2]!
    }
    cache = { path, mtimeMs, table }
    return table
  } catch {
    return FALLBACK
  }
}

const PLAIN: Record<EffortLevel, string> = {
  low: 'answer quickly and briefly; think only as much as the task needs, and skip extra checking',
  medium: 'the usual balance of speed and care',
  high: 'think longer before acting, consider alternatives, and check your work before you finish',
  extra: 'work carefully and thoroughly: plan first, verify facts and results, and check the finished work against the request',
  max: 'be as thorough as you can: plan, research and verify every part, and check the finished work closely before you report it'
}

/** The plain line saying what the level means, for models that don't know the tag. */
export function effortPlainLine(level: EffortLevel | undefined): string {
  const chosen = isEffortLevel(level) ? level : DEFAULT_EFFORT
  return `Effort level: ${EFFORT_LABELS[chosen]} (the user's setting in Deskmates): ${PLAIN[chosen]}.`
}

/** The lines every agent's instructions start with when the prompt has no preamble of its own. */
export function effortLines(level: EffortLevel | undefined, path?: string): string {
  const chosen = isEffortLevel(level) ? level : DEFAULT_EFFORT
  return [`\`<reasoning_effort>${effortTable(path)[chosen]}</reasoning_effort>\``, effortPlainLine(chosen)].join('\n')
}

// ---- Extended thinking (the on/off switch next to the effort level) ----

let thinkingSource: () => ThinkingMode | undefined = () => 'auto'

export function setThinkingSource(read: () => ThinkingMode | undefined): void {
  thinkingSource = read
}

export function currentThinking(): ThinkingMode {
  try {
    const mode = thinkingSource()
    return mode === 'on' || mode === 'off' ? mode : 'auto'
  } catch {
    return 'auto'
  }
}

/** The prompt's <thinking_mode> value for the switch (null keeps the file's own value). */
export function thinkingTagValue(mode: ThinkingMode): string | null {
  return mode === 'on' ? 'interleaved' : mode === 'off' ? 'disabled' : null
}

/** The plain line saying what the switch means, for every model. Empty for 'auto'. */
export function thinkingPlainLine(mode: ThinkingMode): string {
  if (mode === 'on') return "Extended thinking: on (the user's setting in Deskmates): think the problem through before every reply and between tool calls, then answer."
  if (mode === 'off') return "Extended thinking: off (the user's setting in Deskmates): answer straight away without a long think first; still check facts and results before you claim them."
  return ''
}

let source: () => EffortLevel | undefined = () => DEFAULT_EFFORT

/** Where the current level comes from (the app's settings); main.ts sets it at start. */
export function setEffortSource(read: () => EffortLevel | undefined): void {
  source = read
}

/** The level the user picked, right now. */
export function currentEffort(): EffortLevel {
  try {
    const level = source()
    return isEffortLevel(level) ? level : DEFAULT_EFFORT
  } catch {
    return DEFAULT_EFFORT
  }
}

type ProviderOptions = Record<string, Record<string, unknown>>

/**
 * The model's own reasoning setting for a level, where the model has one: OpenAI's reasoning models
 * (o-series, GPT-5) and Gemini's thinking models. Undefined for everything else.
 */
export function effortProviderOptions(provider: string, modelId: string, level: EffortLevel | undefined, thinking: ThinkingMode = currentThinking()): ProviderOptions | undefined {
  const picked = isEffortLevel(level) ? level : DEFAULT_EFFORT
  // Thinking on: at least a high setting. Off: the least the model allows.
  const chosen: EffortLevel = thinking === 'on' && (picked === 'low' || picked === 'medium') ? 'high' : picked
  if (thinking === 'off') {
    if (provider === 'openai' && /^gpt-5/i.test(modelId)) return { openai: { reasoningEffort: 'minimal' } }
    if (provider === 'openai' && /^o\d/i.test(modelId)) return { openai: { reasoningEffort: 'low' } }
    if (provider === 'google' && /gemini-[3-9]/i.test(modelId) && !/image|tts|embedding|live|audio/i.test(modelId)) return { google: { thinkingConfig: { includeThoughts: false, thinkingLevel: 'low' } } }
    if (provider === 'google' && /gemini-2\.5/i.test(modelId) && !/image|tts|embedding|live|audio/i.test(modelId)) {
      return { google: { thinkingConfig: { includeThoughts: false, thinkingBudget: /pro/i.test(modelId) ? 128 : 0 } } }
    }
    return undefined
  }
  if (provider === 'openai' && /^(o\d|gpt-5)/i.test(modelId)) {
    const effort = chosen === 'low' ? 'low' : chosen === 'medium' ? 'medium' : 'high'
    return { openai: { reasoningEffort: effort } }
  }
  if (provider === 'google' && /gemini-(2\.5|[3-9])/i.test(modelId) && !/image|tts|embedding|live|audio/i.test(modelId)) {
    if (/gemini-[3-9]/i.test(modelId)) return { google: { thinkingConfig: { includeThoughts: true, thinkingLevel: chosen === 'low' || chosen === 'medium' ? chosen : 'high' } } }
    const flash = /flash/i.test(modelId)
    const budgets: Record<EffortLevel, number> = { low: 1024, medium: 4096, high: 12_288, extra: 24_576, max: flash ? 24_576 : 32_768 }
    return { google: { thinkingConfig: { includeThoughts: true, thinkingBudget: budgets[chosen] } } }
  }
  return undefined
}
