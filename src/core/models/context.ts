/**
 * How much a model can read at once, and so how much chat history fits beside the system prompt and
 * the tool list. Sending more than the window doesn't fail loudly: most providers cut the start,
 * which is the system prompt and the earliest tool results, and the model then answers from what
 * it no longer has. Better to drop the oldest turns ourselves, and say that we did.
 */
import type { ProviderId } from '../../shared/protocol'

/** Roughly how many characters one token is, for English text and JSON. Errs on the short side. */
export const CHARS_PER_TOKEN = 3.5

/** Context windows by model id, most specific first. Unknown models fall back by provider. */
const BY_MODEL: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/gpt-6|gpt-5\.\d|gpt-4\.1/i, 1_000_000],
  [/gpt-5/i, 400_000],
  [/gpt-4o|o\d(-mini)?\b/i, 128_000],
  [/claude.*haiku/i, 100_000],
  [/claude/i, 200_000],
  [/deepseek.*v4|muse spark|luna|terra/i, 1_000_000],
  [/deepseek/i, 128_000],
  [/solar/i, 500_000],
  [/muse ember/i, 375_000],
  [/nemotron|glyph|beam/i, 256_000],
  [/grok/i, 256_000],
  [/llama-?4/i, 1_000_000],
  [/qwen|llama|mistral|mixtral|gemma|phi/i, 32_000]
]

const BY_PROVIDER: Partial<Record<ProviderId, number>> = {
  google: 1_000_000,
  openai: 128_000,
  xai: 256_000,
  // Local servers load models with a small window unless the user raised it.
  ollama: 16_000,
  lmstudio: 16_000
}

/** The model's context window in tokens (a careful estimate). */
export function contextTokens(provider: ProviderId, modelId: string): number {
  for (const [pattern, tokens] of BY_MODEL) if (pattern.test(modelId)) return tokens
  return BY_PROVIDER[provider] ?? 128_000
}

/** Tokens kept free for the model's own reply and thinking. */
const REPLY_RESERVE_TOKENS = 16_000
const MIN_HISTORY_CHARS = 24_000
const MAX_HISTORY_CHARS = 400_000

/**
 * The characters of chat history to send: the window, less the system prompt, the tool list and
 * room for the reply. Never below a floor that keeps the current turn, nor above the old fixed cap.
 */
export function historyBudgetChars(input: { provider: ProviderId; modelId: string; instructionsChars: number; toolsChars: number }): number {
  const windowChars = contextTokens(input.provider, input.modelId) * CHARS_PER_TOKEN
  const free = windowChars - REPLY_RESERVE_TOKENS * CHARS_PER_TOKEN - input.instructionsChars - input.toolsChars
  return Math.round(Math.min(MAX_HISTORY_CHARS, Math.max(MIN_HISTORY_CHARS, free)))
}

/** About how many characters a tool list costs in the request: names, descriptions and schemas. */
export function toolsChars(tools: Record<string, unknown>): number {
  let total = 0
  for (const [name, t] of Object.entries(tools)) {
    const description = String((t as { description?: unknown }).description ?? '')
    // The JSON schema is built from the zod schema at send time; ~400 characters is a typical one.
    total += name.length + description.length + 400
  }
  return total
}
