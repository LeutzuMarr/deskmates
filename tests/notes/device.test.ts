import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { encodePairing, type PairingPayload } from '../../src/shared/remote-crypto'
import { DEVICE_STORAGE, pairingFromText, readDevice, restoreDevice, saveDevice } from '../../src/renderer/src/remote/device'

class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
  clear(): void {
    this.data.clear()
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const payload: PairingPayload = { v: 1, relay: 'https://x.supabase.co', anon: 'anon', device: 'dev1', key: 'k'.repeat(43), pc: 'DESKTOP', vapid: 'vap', until: 10_000 }
const fragment = encodePairing(payload)

describe('pairing link', () => {
  it('reads the link the PC shows, from a full URL or a bare fragment', () => {
    for (const text of [`https://deskmates.example/#pair=${fragment}`, `  #pair=${fragment}\n`, fragment]) {
      const result = pairingFromText(text, 5_000)
      expect(result).toEqual({ ok: true, device: { relay: payload.relay, anon: 'anon', device: 'dev1', key: payload.key, pc: 'DESKTOP', vapid: 'vap' } })
    }
  })

  it('tells an expired code apart from something else', () => {
    expect(pairingFromText(`https://deskmates.example/#pair=${fragment}`, 20_000)).toEqual({ ok: false, reason: 'expired' })
    expect(pairingFromText('https://example.com/menu', 5_000)).toEqual({ ok: false, reason: 'not-a-pairing' })
    expect(pairingFromText('https://deskmates.example/#pair=garbage', 5_000)).toEqual({ ok: false, reason: 'not-a-pairing' })
  })
})

describe('keeping the pairing', () => {
  beforeEach(() => storage.clear())

  it('comes back from the IndexedDB copy when localStorage was cleared', async () => {
    const result = pairingFromText(fragment, 5_000)
    if (!result.ok) throw new Error('expected a pairing')
    await saveDevice(result.device)
    expect(readDevice()).toEqual(result.device)
    storage.clear()
    expect(readDevice()).toBeNull()
    expect(await restoreDevice()).toEqual(result.device)
    // …and localStorage is filled in again.
    expect(JSON.parse(storage.getItem(DEVICE_STORAGE)!)).toEqual(result.device)
  })

  it('ignores something that isn’t a pairing', () => {
    storage.setItem(DEVICE_STORAGE, '{"hello":1}')
    expect(readDevice()).toBeNull()
  })
})
