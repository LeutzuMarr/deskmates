import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { DEFAULT_SETTINGS, PROVIDER_LABELS, type ModelCheck, type ModelRef, type ProviderId, type Settings } from '../../shared/protocol'
import { OPENCODE_DEFAULT_MODEL } from '../terminals/managed'
import type { KeyStore } from './keys'
import { hasNoQuota, NO_QUOTA_MESSAGE } from './quota'

const PICK_MODEL_ERROR = 'Pick a model first: open Settings, add an API key and choose a default model.'

export interface ResolvedModel {
  model: LanguageModel
  provider: ProviderId
  modelId: string
  /** True for CLI-backed providers (OpenCode/agy): the runner routes the task to a terminal session
   *  instead of calling `model`; the `model` value below is an inert stand-in that must never be used. */
  cli: boolean
}

/** Turns a model reference into a ready-to-call language model. Task 9's agent runner depends on this shape. */
export interface ModelResolver {
  resolve(ref: ModelRef | null): ResolvedModel
}

const stripTrailingSlashes = (url: string): string => url.replace(/\/+$/, '')

type HostedProviderId = 'openrouter' | 'nvidia' | 'groq' | 'deepseek' | 'mistral' | 'together' | 'xai'
type LocalProviderId = 'ollama' | 'lmstudio'

/** One entry of an OpenAI-style `/models` response, with the optional fields some providers add. */
interface ListedModel {
  id: string
  type?: string
  active?: boolean
  pricing?: Record<string, unknown>
  capabilities?: { completion_chat?: boolean }
  architecture?: { output_modalities?: string[] }
}

interface HostedProvider {
  baseURL: string
  /** Offered when the provider's model list can't be fetched; the first one present is the default pick. */
  fallback: string[]
  keep?: (model: ListedModel) => boolean
}

/** OpenAI-compatible hosted APIs that take a bearer key. Base URLs are fixed so a key only ever goes to its own provider. */
export const HOSTED_PROVIDERS: Record<HostedProviderId, HostedProvider> = {
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    fallback: [
      'deepseek/deepseek-chat-v3-0324:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen3-coder:free',
      'openrouter/auto'
    ],
    keep: (model) => !model.architecture?.output_modalities || model.architecture.output_modalities.includes('text')
  },
  nvidia: {
    baseURL: 'https://integrate.api.nvidia.com/v1',
    fallback: [
      'meta/llama-3.3-70b-instruct',
      'openai/gpt-oss-120b',
      'deepseek-ai/deepseek-r1',
      'qwen/qwen2.5-coder-32b-instruct'
    ]
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    fallback: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    keep: (model) => model.active !== false
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    fallback: ['deepseek-chat', 'deepseek-reasoner']
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    fallback: ['mistral-small-latest', 'mistral-large-latest', 'codestral-latest'],
    keep: (model) => model.capabilities?.completion_chat !== false
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    fallback: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-Coder-32B-Instruct'
    ],
    keep: (model) => !model.type || model.type === 'chat'
  },
  xai: {
    baseURL: 'https://api.x.ai/v1',
    fallback: ['grok-4', 'grok-3-mini', 'grok-code-fast-1']
  }
}

const isHostedProvider = (provider: ProviderId): provider is HostedProviderId => provider in HOSTED_PROVIDERS

const LOCAL_URL_SETTING = { ollama: 'ollamaBaseUrl', lmstudio: 'lmstudioBaseUrl' } as const

/** Local servers answer at once or not at all; don't leave the model picker hanging on a dead port. */
const LOCAL_TIMEOUT_MS = 5000

const NON_CHAT_MODEL = /(embed|rerank|retriev|reward|moderation|whisper|tts|transcribe|guard|safety|ocr|image|imagine)/i

/** Model entries from a `/models` body: OpenAI-style `{ data: [...] }`, or a bare array (Together). */
function listedModels(body: unknown): ListedModel[] {
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is ListedModel => typeof (entry as ListedModel | null)?.id === 'string')
}

/** True when the provider marks the model as free: a `:free`/`-Free` id, or zero token prices. */
export function isFreeModel(model: ListedModel): boolean {
  if (/[:-]free$/i.test(model.id)) return true
  const pricing = model.pricing
  if (!pricing) return false
  const prices = ['prompt', 'completion', 'input', 'output'].filter((key) => pricing[key] !== undefined)
  return prices.length > 0 && prices.every((key) => Number(pricing[key]) === 0)
}

/** Deduplicated ids with free models first, each group alphabetical. */
function freeFirst(models: ListedModel[]): string[] {
  const free = new Set<string>()
  const paid = new Set<string>()
  for (const model of models) (isFreeModel(model) ? free : paid).add(model.id)
  for (const id of free) paid.delete(id)
  return [...[...free].sort(), ...[...paid].sort()]
}

/** A non-OK HTTP answer, kept distinct from "couldn't connect" so callers can tell the two apart. */
class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

function compatibleModel(provider: ProviderId, baseURL: string, apiKey: string | undefined, modelId: string): LanguageModel {
  return createOpenAICompatible({ name: provider, baseURL, apiKey, includeUsage: true })(modelId)
}

/** An inert stand-in assigned to CLI-backed resolutions. It must never be called — the runner
 *  branches on `ResolvedModel.cli` before touching `model` — so both methods throw if they are. */
function cliStubModel(provider: ProviderId, modelId: string): LanguageModel {
  return {
    modelId,
    specificationVersion: 'v4',
    provider: provider,
    supportsUrl: () => false,
    doGenerate: async () => {
      throw new Error(`Internal error: ${provider} is routed through a CLI session, not called as a model.`)
    },
    doStream: async () => {
      throw new Error(`Internal error: ${provider} is routed through a CLI session, not called as a model.`)
    }
  } as unknown as LanguageModel
}

/** Highest numeric version among ids matching `pattern`'s single capture group, or undefined if none match. */
function highestByVersion(ids: string[], pattern: RegExp): string | undefined {
  let best: { id: string; version: number } | undefined
  for (const id of ids) {
    const match = pattern.exec(id)
    if (!match) continue
    const version = Number(match[1])
    if (!best || version > best.version) best = { id, version }
  }
  return best?.id
}

/** Picks a sensible default model id from a provider's model list, favoring small/fast recent models. */
export function pickDefaultModel(provider: ProviderId, ids: string[]): string | undefined {
  if (provider === 'google') {
    return highestByVersion(ids, /^gemini-(\d+(?:\.\d+)?)-flash$/) ?? ids.find((id) => id.includes('flash')) ?? ids[0]
  }
  if (provider === 'openai') {
    return (
      highestByVersion(ids, /^gpt-(\d+(?:\.\d+)?)-mini$/) ?? highestByVersion(ids, /^gpt-(\d+(?:\.\d+)?)$/) ?? ids[0]
    )
  }
  if (isHostedProvider(provider)) return HOSTED_PROVIDERS[provider].fallback.find((id) => ids.includes(id)) ?? ids[0]
  return ids[0]
}

export class ModelService implements ModelResolver {
  constructor(
    private readonly keys: KeyStore,
    private readonly settings: () => Settings,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  resolve(ref: ModelRef | null): ResolvedModel {
    const target = ref ?? this.settings().defaultModel
    if (!target) throw new Error(PICK_MODEL_ERROR)
    const { provider, modelId } = target

    switch (provider) {
      case 'opencode':
      case 'agy':
        // CLI-backed: nothing to construct here — the runner routes the run through a terminal
        // session. The stub exists only to satisfy the `LanguageModel` field and throws if misused.
        return { model: cliStubModel(provider, modelId), provider, modelId, cli: true }
      case 'google': {
        const apiKey = this.keys.get('google')
        if (!apiKey) throw new Error('Add a Google Gemini API key in Settings.')
        return { model: createGoogle({ apiKey })(modelId), provider, modelId, cli: false }
      }
      case 'openai': {
        const apiKey = this.keys.get('openai')
        if (!apiKey) throw new Error('Add an OpenAI API key in Settings.')
        return { model: createOpenAI({ apiKey })(modelId), provider, modelId, cli: false }
      }
      case 'compatible': {
        const baseURL = this.settings().compatibleBaseUrl
        if (!baseURL) throw new Error('Set the server URL in Settings.')
        const model = createOpenAICompatible({
          name: 'compatible',
          baseURL,
          apiKey: this.keys.get('compatible'),
          includeUsage: true
        })(modelId)
        return { model, provider, modelId, cli: false }
      }
      case 'ollama':
      case 'lmstudio': {
        const model = compatibleModel(provider, this.localBaseUrl(provider), undefined, modelId)
        return { model, provider, modelId, cli: false }
      }
      default: {
        const apiKey = this.requireHostedKey(provider)
        const model = compatibleModel(provider, HOSTED_PROVIDERS[provider].baseURL, apiKey, modelId)
        return { model, provider, modelId, cli: false }
      }
    }
  }

  /** Lists model ids the configured key/server can actually use, narrowed to chat-capable models.
   *  CLI providers need no key: OpenCode offers the machine's working free model, agy its CLI default. */
  /**
   * Whether the key can actually call this model. Providers such as NVIDIA list every model in their
   * catalog but enable only some per account, and calling the rest fails at once with 404. One tiny
   * request tells the two apart; a rate limit still counts as usable.
   */
  async checkModel(ref: ModelRef): Promise<ModelCheck> {
    const { model, cli } = this.resolve(ref)
    if (cli) return { usable: true, detail: 'Runs through its own command line.' }
    try {
      await generateText({
        model,
        prompt: 'Reply with the single word OK.',
        maxOutputTokens: 16,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(30_000)
      })
      return { usable: true, detail: 'Your key can use this model.' }
    } catch (error) {
      const status = APICallError.isInstance(error) ? error.statusCode : undefined
      if (status === 404) return { usable: false, detail: 'Not available for your key.' }
      if (status === 401 || status === 403) return { usable: false, detail: `The provider refused your key (${status}).` }
      if (hasNoQuota(error)) return { usable: false, detail: NO_QUOTA_MESSAGE }
      if (status === 429) return { usable: true, detail: 'Available, but rate-limited right now.' }
      if (status === 502 || status === 503 || status === 504) return { usable: true, detail: 'Available, but its servers are full right now; runs will wait for a free slot.' }
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { usable: false, detail: "Not answering right now (the provider's servers for it look overloaded).", temporary: true }
      }
      return { usable: true, detail: 'Available (the test answer failed, but the model exists).' }
    }
  }

  async listModels(provider: ProviderId): Promise<string[]> {
    if (provider === 'opencode') return [OPENCODE_DEFAULT_MODEL]
    if (provider === 'agy') return ['default']

    if (provider === 'google') {
      const apiKey = this.keys.get('google')
      if (!apiKey) throw new Error('Add a Google Gemini API key in Settings.')
      const body = await this.fetchJson(
        provider,
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        { headers: { 'x-goog-api-key': apiKey } }
      )
      const models = (body.models ?? []) as Array<{ name: string; supportedGenerationMethods?: string[] }>
      return models
        .filter((m) => m.name.includes('gemini') && (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .sort()
    }

    if (provider === 'openai') {
      const apiKey = this.keys.get('openai')
      if (!apiKey) throw new Error('Add an OpenAI API key in Settings.')
      const body = await this.fetchJson(provider, 'https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      const ids = ((body.data ?? []) as Array<{ id: string }>).map((m) => m.id)
      return ids
        .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id))
        .filter((id) => !/(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct)/.test(id))
        .sort()
    }

    if (provider === 'ollama' || provider === 'lmstudio') return this.listLocalModels(provider)
    if (isHostedProvider(provider)) return this.listHostedModels(provider)

    const baseURL = this.settings().compatibleBaseUrl
    if (!baseURL) throw new Error('Set the server URL in Settings.')
    const key = this.keys.get('compatible')
    const body = await this.fetchJson(provider, `${stripTrailingSlashes(baseURL)}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {}
    })
    const ids = ((body.data ?? []) as Array<{ id: string }>).map((m) => m.id)
    return ids.sort()
  }

  /** Installed chat models on a local server: the OpenAI-compatible `/models`, else Ollama's native `/api/tags`. */
  private async listLocalModels(provider: LocalProviderId): Promise<string[]> {
    const baseURL = this.localBaseUrl(provider)
    const init = (): RequestInit => ({ signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) })
    let ids: string[] | undefined
    let failure: unknown
    try {
      ids = listedModels(await this.fetchJson(provider, `${baseURL}/models`, init())).map((m) => m.id)
    } catch (error) {
      failure = error
    }
    if (!ids && provider === 'ollama') {
      try {
        const body = await this.fetchJson(provider, `${baseURL.replace(/\/v1$/, '')}/api/tags`, init())
        ids = ((body.models ?? []) as Array<{ name?: string }>).flatMap((m) => (m.name ? [m.name] : []))
      } catch {
        // Keep the first failure: it's the one that says whether the server answered at all.
      }
    }
    if (!ids) {
      if (failure instanceof ProviderHttpError) throw failure
      throw new Error(`${PROVIDER_LABELS[provider]} isn't running at ${baseURL}. Start it, then try again.`)
    }
    const chat = [...new Set(ids.filter((id) => !/embed/i.test(id)))].sort()
    if (chat.length === 0) {
      throw new Error(
        provider === 'ollama'
          ? 'Ollama is running but has no models installed. Download one first, for example: ollama pull llama3.2'
          : 'LM Studio is running but has no models downloaded. Download one in LM Studio first.'
      )
    }
    return chat
  }

  /** Chat models from a hosted provider, free ones first. Falls back to a curated list unless the key was rejected. */
  private async listHostedModels(provider: HostedProviderId): Promise<string[]> {
    const { baseURL, fallback, keep } = HOSTED_PROVIDERS[provider]
    const apiKey = this.requireHostedKey(provider)
    try {
      const body = await this.fetchJson(provider, `${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
      const models = listedModels(body).filter((m) => !NON_CHAT_MODEL.test(m.id) && (keep?.(m) ?? true))
      if (models.length > 0) return freeFirst(models)
    } catch (error) {
      if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) throw error
    }
    return [...fallback]
  }

  private requireHostedKey(provider: HostedProviderId): string {
    const apiKey = this.keys.get(provider)
    if (!apiKey) throw new Error(`Add your ${PROVIDER_LABELS[provider]} API key in Settings.`)
    return apiKey
  }

  /** The local server's base URL from Settings (the default when blank), without trailing slashes. */
  private localBaseUrl(provider: LocalProviderId): string {
    const setting = LOCAL_URL_SETTING[provider]
    const url = stripTrailingSlashes(this.settings()[setting]?.trim() || DEFAULT_SETTINGS[setting])
    let protocol = ''
    try {
      protocol = new URL(url).protocol
    } catch {
      // Reported below.
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`Set a valid ${PROVIDER_LABELS[provider]} server URL in Settings, like ${DEFAULT_SETTINGS[setting]}.`)
    }
    return url
  }

  private async fetchJson(provider: ProviderId, url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, init)
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
      const message = errorBody?.error?.message ?? response.statusText
      throw new ProviderHttpError(`${PROVIDER_LABELS[provider]} said ${response.status}: ${message}`, response.status)
    }
    return (await response.json()) as Record<string, unknown>
  }
}
