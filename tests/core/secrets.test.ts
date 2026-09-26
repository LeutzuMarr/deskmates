import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Dpapi } from '../../src/main/dpapi'
import { SecretStore } from '../../src/main/secrets'

/** Stands in for Windows DPAPI: "encrypts" by reversing and tagging, so tests can tell blobs from keys. */
function fakeDpapi(): Dpapi & { calls: number } {
  const fake = {
    calls: 0,
    async protect(items: Record<string, string>) {
      fake.calls++
      return Object.fromEntries(Object.entries(items).map(([k, v]) => [k, `sealed(${[...v].reverse().join('')})`]))
    },
    async unprotect(items: Record<string, string>) {
      fake.calls++
      return Object.fromEntries(
        Object.entries(items).map(([k, v]) => {
          const match = /^sealed\((.*)\)$/.exec(v)
          return [k, match ? [...match[1]].reverse().join('') : null]
        })
      )
    }
  }
  return fake
}

function setup(initial?: Record<string, string>) {
  const file = join(mkdtempSync(join(tmpdir(), 'dm-secrets-')), 'secrets.json')
  if (initial) writeFileSync(file, JSON.stringify(initial))
  const dpapi = fakeDpapi()
  const legacyDecrypt = (b64: string): string => {
    if (!b64.startsWith('legacy-ok:')) throw new Error('Error while decrypting the ciphertext')
    return b64.slice('legacy-ok:'.length)
  }
  const store = new SecretStore(file, { dpapi, legacyDecrypt })
  return { file, dpapi, store, saved: () => JSON.parse(readFileSync(file, 'utf8')) }
}

describe('SecretStore', () => {
  it('saves keys encrypted, never in plain text, and reads them back in a new session', async () => {
    const first = setup()
    expect(await first.store.set('nvidia', 'nvapi-123')).toEqual(['nvidia'])
    expect(readFileSync(first.file, 'utf8')).not.toContain('nvapi-123')
    expect(first.saved().nvidia).toMatch(/^dpapi:/)

    const reopened = new SecretStore(first.file, { dpapi: first.dpapi, legacyDecrypt: () => { throw new Error('no') } })
    expect(reopened.status()).toEqual(['nvidia'])
    expect(await reopened.all()).toEqual({ nvidia: 'nvapi-123' })
  })

  it('moves readable older-format keys to DPAPI and hides ones that can no longer be read', async () => {
    const { store, saved } = setup({ google: 'legacy-ok:AIza-1', openai: 'legacy-broken' })
    expect(store.status()).toEqual(['google'])
    expect(await store.all()).toEqual({ google: 'AIza-1' })
    expect(saved().google).toMatch(/^dpapi:/)
    expect(store.status()).toEqual(['google'])
  })

  it('decrypts once per run and removes keys', async () => {
    const { store, dpapi, saved } = setup()
    await store.set('google', 'AIza-2')
    const calls = dpapi.calls
    await store.all()
    await store.all()
    expect(dpapi.calls).toBe(calls)
    expect(await store.set('google', null)).toEqual([])
    expect(saved().google).toBeUndefined()
    expect(await store.all()).toEqual({})
  })

  it('rejects unknown providers and starts empty without a file', async () => {
    const { store, file } = setup()
    await expect(store.set('nope' as never, 'x')).rejects.toThrow(/Unknown provider/)
    expect(store.status()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })
})

describe('SecretStore loading', () => {
  it('shares one decrypt between callers that ask at the same time', async () => {
    const { store, dpapi } = setup({ google: 'dpapi:sealed(1-azIA)' })
    const [a, b] = await Promise.all([store.all(), store.all()])
    expect(a).toEqual({ google: 'AIza-1' })
    expect(b).toEqual({ google: 'AIza-1' })
    expect(dpapi.calls).toBe(1)
  })
})
