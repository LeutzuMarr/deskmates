import { PROVIDERS, type ProviderId } from '../../shared/protocol'

/** Holds API keys in memory for the lifetime of the core process. Never persisted here. */
export class KeyStore {
  private readonly keys = new Map<ProviderId, string>()

  constructor(initial?: Partial<Record<ProviderId, string>>) {
    this.set(initial ?? {})
  }

  /** Replaces every key. Empty or whitespace-only values are dropped rather than stored. */
  set(keys: Partial<Record<ProviderId, string | undefined>>): void {
    this.keys.clear()
    for (const provider of PROVIDERS) {
      const trimmed = keys[provider]?.trim()
      if (trimmed) this.keys.set(provider, trimmed)
    }
  }

  get(provider: ProviderId): string | undefined {
    return this.keys.get(provider)
  }

  /** Providers that currently have a key, in PROVIDERS order. */
  providers(): ProviderId[] {
    return PROVIDERS.filter((provider) => this.keys.has(provider))
  }
}

/** Reads provider API keys from environment variables, for developer/CLI use. */
export function keysFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ProviderId, string>> {
  const keys: Partial<Record<ProviderId, string>> = {}
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) keys.google = env.GOOGLE_GENERATIVE_AI_API_KEY
  if (env.OPENAI_API_KEY) keys.openai = env.OPENAI_API_KEY
  if (env.DESKMATES_COMPATIBLE_API_KEY) keys.compatible = env.DESKMATES_COMPATIBLE_API_KEY
  if (env.OPENROUTER_API_KEY) keys.openrouter = env.OPENROUTER_API_KEY
  if (env.NVIDIA_API_KEY) keys.nvidia = env.NVIDIA_API_KEY
  if (env.GROQ_API_KEY) keys.groq = env.GROQ_API_KEY
  if (env.DEEPSEEK_API_KEY) keys.deepseek = env.DEEPSEEK_API_KEY
  if (env.MISTRAL_API_KEY) keys.mistral = env.MISTRAL_API_KEY
  if (env.TOGETHER_API_KEY) keys.together = env.TOGETHER_API_KEY
  if (env.XAI_API_KEY) keys.xai = env.XAI_API_KEY
  return keys
}
