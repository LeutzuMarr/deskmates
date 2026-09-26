import { describe, expect, it } from 'vitest'
import { KeyStore, keysFromEnv } from '../../src/core/models/keys'
import { HOSTED_PROVIDERS, ModelService, isFreeModel, pickDefaultModel } from '../../src/core/models/providers'
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/protocol'

/** A fetch stub that fails the test immediately if it is ever called. */
const noNetwork: typeof fetch = (async () => {
  throw new Error('this test must not hit the network')
}) as typeof fetch

/** Builds a fetch stub that answers with a canned status/body and lets the test inspect the request. */
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const { status, body } = handler(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const settingsOf = (overrides: Partial<Settings> = {}): (() => Settings) => {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides }
  return () => settings
}

describe('pickDefaultModel', () => {
  it('picks the highest -flash version for google', () => {
    expect(
      pickDefaultModel('google', [
        'gemini-2.5-flash',
        'gemini-3.8-flash',
        'gemini-3.8-flash-lite',
        'gemini-3.1-pro-preview'
      ])
    ).toBe('gemini-3.8-flash')
  })

  it('picks the highest -mini version for openai, and undefined for an empty list', () => {
    expect(pickDefaultModel('openai', ['gpt-5', 'gpt-5.2-mini', 'gpt-5-mini'])).toBe('gpt-5.2-mini')
    expect(pickDefaultModel('openai', [])).toBeUndefined()
  })
})

describe('ModelService.listModels', () => {
  it('sends the Google API key as a header, never in the URL, and keeps only usable Gemini models', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> | undefined
    const fetchImpl = fakeFetch((url, init) => {
      capturedUrl = url
      capturedHeaders = init?.headers as Record<string, string>
      return {
        status: 200,
        body: {
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-1.0-pro-vision', supportedGenerationMethods: ['countTokens'] }
          ]
        }
      }
    })
    const service = new ModelService(new KeyStore({ google: 'k1' }), settingsOf(), fetchImpl)
    const ids = await service.listModels('google')
    expect(ids).toEqual(['gemini-2.5-flash'])
    expect(capturedUrl).not.toContain('k1')
    expect(capturedHeaders?.['x-goog-api-key']).toBe('k1')
  })

  it('filters OpenAI model ids down to chat-capable models', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-large' }, { id: 'gpt-realtime' }] }
    }))
    const service = new ModelService(new KeyStore({ openai: 'k2' }), settingsOf(), fetchImpl)
    expect(await service.listModels('openai')).toEqual(['gpt-5'])
  })

  it('formats a provider error from a non-OK response', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 400, body: { error: { message: 'API key not valid' } } }))
    const service = new ModelService(new KeyStore({ google: 'k1' }), settingsOf(), fetchImpl)
    await expect(service.listModels('google')).rejects.toThrow('Google Gemini said 400: API key not valid')
  })
})

describe('ModelService.resolve', () => {
  it('throws when nothing is configured, and when the provider key is missing', () => {
    const noModel = new ModelService(new KeyStore(), settingsOf(), noNetwork)
    expect(() => noModel.resolve(null)).toThrow(/Pick a model first/)

    const noKey = new ModelService(new KeyStore(), settingsOf(), noNetwork)
    expect(() => noKey.resolve({ provider: 'google', modelId: 'gemini-3.8-flash' })).toThrow(/Google Gemini API key/)
  })

  it('builds a google model when a key is present', () => {
    const service = new ModelService(new KeyStore({ google: 'k1' }), settingsOf(), noNetwork)
    const result = service.resolve({ provider: 'google', modelId: 'gemini-3.8-flash' })
    expect(result.provider).toBe('google')
    expect(result.modelId).toBe('gemini-3.8-flash')
    expect((result.model as { modelId: string }).modelId).toBe('gemini-3.8-flash')
  })
})

describe('KeyStore', () => {
  it('drops empty and whitespace-only keys, and lists providers in PROVIDERS order', () => {
    const store = new KeyStore()
    store.set({ compatible: '   ', openai: 'abc', google: '  xyz  ' })
    expect(store.providers()).toEqual(['google', 'openai'])
    expect(store.get('google')).toBe('xyz')
    expect(store.get('compatible')).toBeUndefined()
  })
})

/** A fetch stub whose server isn't there: every request fails to connect, like a closed port. */
const connectionRefused: typeof fetch = (async () => {
  throw new TypeError('fetch failed')
}) as typeof fetch

describe('local providers (Ollama, LM Studio)', () => {
  it('lists installed chat models from the configured base URL, without any key', async () => {
    const urls: string[] = []
    let sentHeaders: unknown
    const fetchImpl = fakeFetch((url, init) => {
      urls.push(url)
      sentHeaders = init?.headers
      return { status: 200, body: { data: [{ id: 'qwen3:8b' }, { id: 'nomic-embed-text:latest' }, { id: 'llama3.2:latest' }] } }
    })
    const service = new ModelService(new KeyStore(), settingsOf({ ollamaBaseUrl: 'http://127.0.0.1:9999/v1/' }), fetchImpl)
    expect(await service.listModels('ollama')).toEqual(['llama3.2:latest', 'qwen3:8b'])
    expect(urls).toEqual(['http://127.0.0.1:9999/v1/models'])
    expect(sentHeaders).toBeUndefined()
  })

  it("falls back to Ollama's /api/tags when /v1/models isn't available", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.endsWith('/api/tags')
        ? { status: 200, body: { models: [{ name: 'mistral:7b' }] } }
        : { status: 404, body: { error: { message: 'not found' } } }
    )
    const service = new ModelService(new KeyStore(), settingsOf(), fetchImpl)
    expect(await service.listModels('ollama')).toEqual(['mistral:7b'])
  })

  it('reports a clear "not running" error when the server is unreachable', async () => {
    const service = new ModelService(new KeyStore(), settingsOf(), connectionRefused)
    await expect(service.listModels('ollama')).rejects.toThrow(
      "Ollama isn't running at http://localhost:11434/v1. Start it, then try again."
    )
    await expect(service.listModels('lmstudio')).rejects.toThrow("LM Studio isn't running at http://localhost:1234/v1.")
  })

  it('says so when the server runs but has no models, and rejects a malformed base URL', async () => {
    const empty = new ModelService(new KeyStore(), settingsOf(), fakeFetch(() => ({ status: 200, body: { data: [] } })))
    await expect(empty.listModels('lmstudio')).rejects.toThrow(/no models downloaded/)

    const badUrl = new ModelService(new KeyStore(), settingsOf({ lmstudioBaseUrl: 'localhost:1234' }), noNetwork)
    await expect(badUrl.listModels('lmstudio')).rejects.toThrow(/valid LM Studio server URL/)
  })

  it('resolves a local model without a key', () => {
    const service = new ModelService(new KeyStore(), settingsOf(), noNetwork)
    const result = service.resolve({ provider: 'lmstudio', modelId: 'qwen2.5-7b-instruct' })
    expect(result).toMatchObject({ provider: 'lmstudio', modelId: 'qwen2.5-7b-instruct', cli: false })
    expect((result.model as { modelId: string }).modelId).toBe('qwen2.5-7b-instruct')
  })
})

describe('hosted OpenAI-compatible providers', () => {
  it('sends the key as a bearer header to the fixed base URL and lists free OpenRouter models first', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> | undefined
    const fetchImpl = fakeFetch((url, init) => {
      capturedUrl = url
      capturedHeaders = init?.headers as Record<string, string>
      return {
        status: 200,
        body: {
          data: [
            { id: 'openai/gpt-5', pricing: { prompt: '0.00000125', completion: '0.00001' } },
            { id: 'meta-llama/llama-3.3-70b-instruct:free', pricing: { prompt: '0', completion: '0' } },
            { id: 'acme/zero-cost', pricing: { prompt: '0', completion: '0' } },
            { id: 'google/gemini-image', architecture: { output_modalities: ['image'] } }
          ]
        }
      }
    })
    const service = new ModelService(new KeyStore({ openrouter: 'or-key' }), settingsOf(), fetchImpl)
    expect(await service.listModels('openrouter')).toEqual([
      'acme/zero-cost',
      'meta-llama/llama-3.3-70b-instruct:free',
      'openai/gpt-5'
    ])
    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/models')
    expect(capturedUrl).not.toContain('or-key')
    expect(capturedHeaders?.Authorization).toBe('Bearer or-key')
  })

  it("reads Together's bare-array response and keeps only chat models", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', pricing: { input: 0.88, output: 0.88 } },
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', type: 'chat', pricing: { input: 0, output: 0 } },
        { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' }
      ]
    }))
    const service = new ModelService(new KeyStore({ together: 'tk' }), settingsOf(), fetchImpl)
    expect(await service.listModels('together')).toEqual([
      'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo'
    ])
  })

  it('drops non-chat models such as speech, guard and inactive ones', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: {
        data: [
          { id: 'llama-3.3-70b-versatile', active: true },
          { id: 'whisper-large-v3', active: true },
          { id: 'meta-llama/llama-guard-4-12b', active: true },
          { id: 'old-model', active: false }
        ]
      }
    }))
    const service = new ModelService(new KeyStore({ groq: 'gk' }), settingsOf(), fetchImpl)
    expect(await service.listModels('groq')).toEqual(['llama-3.3-70b-versatile'])
  })

  it('offers the curated fallback when the list fails, but surfaces a rejected key', async () => {
    const down = new ModelService(new KeyStore({ nvidia: 'nk' }), settingsOf(), connectionRefused)
    expect(await down.listModels('nvidia')).toEqual(HOSTED_PROVIDERS.nvidia.fallback)

    const erroring = new ModelService(new KeyStore({ xai: 'xk' }), settingsOf(), fakeFetch(() => ({ status: 500, body: {} })))
    expect(await erroring.listModels('xai')).toEqual(HOSTED_PROVIDERS.xai.fallback)

    const rejected = fakeFetch(() => ({ status: 401, body: { error: { message: 'Invalid API key' } } }))
    const badKey = new ModelService(new KeyStore({ mistral: 'bad' }), settingsOf(), rejected)
    await expect(badKey.listModels('mistral')).rejects.toThrow('Mistral said 401: Invalid API key')
  })

  it('requires the key to list or resolve, and builds a model when it is set', async () => {
    const noKey = new ModelService(new KeyStore(), settingsOf(), noNetwork)
    await expect(noKey.listModels('deepseek')).rejects.toThrow('Add your DeepSeek API key in Settings.')
    expect(() => noKey.resolve({ provider: 'groq', modelId: 'llama-3.3-70b-versatile' })).toThrow(/Groq API key/)

    const withKey = new ModelService(new KeyStore({ deepseek: 'dk' }), settingsOf(), noNetwork)
    const result = withKey.resolve({ provider: 'deepseek', modelId: 'deepseek-chat' })
    expect(result).toMatchObject({ provider: 'deepseek', modelId: 'deepseek-chat', cli: false })
  })

  it('picks the first curated default that the provider lists', () => {
    expect(pickDefaultModel('groq', ['allam-2-7b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'])).toBe(
      'llama-3.3-70b-versatile'
    )
    expect(pickDefaultModel('xai', ['grok-unknown'])).toBe('grok-unknown')
  })
})

describe('isFreeModel', () => {
  it('recognises free ids and zero prices, and treats unknown pricing as paid', () => {
    expect(isFreeModel({ id: 'qwen/qwen3-coder:free' })).toBe(true)
    expect(isFreeModel({ id: 'x', pricing: { prompt: '0', completion: '0' } })).toBe(true)
    expect(isFreeModel({ id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } })).toBe(false)
    expect(isFreeModel({ id: 'meta/llama-3.3-70b-instruct' })).toBe(false)
  })
})

describe('keysFromEnv', () => {
  it('reads the new providers from their usual environment variables', () => {
    expect(keysFromEnv({ OPENROUTER_API_KEY: 'a', GROQ_API_KEY: 'b', XAI_API_KEY: 'c' })).toEqual({
      openrouter: 'a',
      groq: 'b',
      xai: 'c'
    })
  })
})

describe('ModelService.checkModel', () => {
  const chatReply = JSON.stringify({
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  })

  it('tells a model the key can call from one the provider only lists', async () => {
    const realFetch = globalThis.fetch
    const service = new ModelService(new KeyStore({ nvidia: 'nvapi-test' }), settingsOf())
    try {
      globalThis.fetch = (async () =>
        new Response('{"status":404,"title":"Not Found","detail":"Function not found for account"}', { status: 404 })) as typeof fetch
      expect(await service.checkModel({ provider: 'nvidia', modelId: 'moonshotai/kimi-k2.6' })).toEqual({ usable: false, detail: 'Not available for your key.' })

      globalThis.fetch = (async () => new Response(chatReply, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
      expect((await service.checkModel({ provider: 'nvidia', modelId: 'google/gemma-4-31b-it' })).usable).toBe(true)

      globalThis.fetch = (async () => new Response('{"error":"slow down"}', { status: 429 })) as typeof fetch
      expect(await service.checkModel({ provider: 'nvidia', modelId: 'x/y' })).toEqual({ usable: true, detail: 'Available, but rate-limited right now.' })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
