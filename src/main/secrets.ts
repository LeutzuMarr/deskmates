import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PROVIDERS, type ProviderId } from '../shared/protocol'
import type { Dpapi } from './dpapi'

type StoredSecrets = Partial<Record<ProviderId, string>>
type Keys = Partial<Record<ProviderId, string>>

/** Marks an entry encrypted straight with Windows DPAPI; entries without it are the older safeStorage format. */
const DPAPI_PREFIX = 'dpapi:'

export interface SecretStoreDeps {
  dpapi: Dpapi
  /**
   * Reads an entry in the older format (Electron safeStorage), or throws. Those entries depend on a
   * key Chromium keeps in its `Local State` file, which isn't always written to disk before the app
   * exits, so they could become unreadable after a restart; each readable one is moved to DPAPI.
   */
  legacyDecrypt: (base64: string) => string
}

/** Encrypted-at-rest API key storage: a JSON file of Windows DPAPI blobs, bound to this Windows user. */
export class SecretStore {
  private cache: Keys | null = null
  private loading: Promise<Keys> | null = null

  constructor(
    private readonly file: string,
    private readonly deps: SecretStoreDeps
  ) {}

  private read(): StoredSecrets {
    if (!existsSync(this.file)) return {}
    try {
      return JSON.parse(readFileSync(this.file, 'utf-8')) as StoredSecrets
    } catch {
      console.warn('[secrets] secrets.json could not be read; it was moved aside and saved keys must be entered again.')
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        // Best effort; the corrupt file may be locked or already gone.
      }
      return {}
    }
  }

  private write(data: StoredSecrets): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
  }

  private legacyReadable(encoded: string): boolean {
    try {
      this.deps.legacyDecrypt(encoded)
      return true
    } catch {
      return false
    }
  }

  /** Every saved key, decrypted. Loaded once per run; older-format entries are converted on the way. */
  async all(): Promise<Keys> {
    if (this.cache) return { ...this.cache }
    this.loading ??= this.load().finally(() => (this.loading = null))
    return { ...(await this.loading) }
  }

  private async load(): Promise<Keys> {
    const stored = this.read()
    const keys: Keys = {}
    const blobs: Record<string, string> = {}
    const migrate: Keys = {}
    for (const provider of PROVIDERS) {
      const entry = stored[provider]
      if (!entry) continue
      if (entry.startsWith(DPAPI_PREFIX)) {
        blobs[provider] = entry.slice(DPAPI_PREFIX.length)
        continue
      }
      try {
        migrate[provider] = this.deps.legacyDecrypt(entry)
      } catch {
        console.warn(`[secrets] the saved ${provider} key can't be decrypted any more; it needs to be entered again.`)
      }
    }

    const opened = await this.deps.dpapi.unprotect(blobs)
    for (const [provider, plain] of Object.entries(opened)) {
      if (plain) keys[provider as ProviderId] = plain
      else console.warn(`[secrets] the saved ${provider} key can't be decrypted; it needs to be entered again.`)
    }

    if (Object.keys(migrate).length > 0) {
      const sealed = await this.deps.dpapi.protect(migrate as Record<string, string>)
      const latest = this.read()
      for (const [provider, blob] of Object.entries(sealed)) latest[provider as ProviderId] = DPAPI_PREFIX + blob
      this.write(latest)
      Object.assign(keys, migrate)
    }

    this.cache = keys
    return keys
  }

  /** Providers with a key that can actually be used, so Settings never shows "Saved" for a dead one. */
  status(): ProviderId[] {
    if (this.cache) {
      const cached = this.cache
      return PROVIDERS.filter((provider) => Boolean(cached[provider]))
    }
    const stored = this.read()
    return PROVIDERS.filter((provider) => {
      const entry = stored[provider]
      if (!entry) return false
      return entry.startsWith(DPAPI_PREFIX) || this.legacyReadable(entry)
    })
  }

  async set(provider: ProviderId, key: string | null): Promise<ProviderId[]> {
    if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`)
    const current = await this.all()
    const stored = this.read()
    if (!key) {
      delete stored[provider]
      delete current[provider]
    } else {
      const sealed = await this.deps.dpapi.protect({ [provider]: key })
      stored[provider] = DPAPI_PREFIX + sealed[provider]
      current[provider] = key
    }
    this.write(stored)
    this.cache = current
    return this.status()
  }
}
