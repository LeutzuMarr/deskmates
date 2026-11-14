import { describe, expect, it } from 'vitest'
import { decodePairing, encodePairing, newKey, open, seal } from '../../src/shared/remote-crypto'

describe('phone ↔ PC encryption', () => {
  it('round trip', async () => {
    const key = newKey()
    const sealed = await seal(key, 'to-pc', 1, { hello: 'Duo' })
    expect(await open(key, 'to-pc', sealed, 0)).toEqual({ payload: { hello: 'Duo' }, counter: 1 })
  })

  it('rejects replay, tamper, the wrong direction and an unknown device key', async () => {
    const key = newKey()
    const sealed = await seal(key, 'to-pc', 5, 'x')
    expect(await open(key, 'to-pc', sealed, 5)).toBeNull()
    expect(await open(key, 'to-phone', sealed, 0)).toBeNull()
    expect(await open(newKey(), 'to-pc', sealed, 0)).toBeNull()
    const bytes = sealed.split('')
    bytes[20] = bytes[20] === 'A' ? 'B' : 'A'
    expect(await open(key, 'to-pc', bytes.join(''), 0)).toBeNull()
    expect(await open(key, 'to-pc', 'garbage', 0)).toBeNull()
  })

  it('pairing payload expires after five minutes', () => {
    const now = Date.now()
    const text = encodePairing({ v: 1, relay: 'https://x.supabase.co', anon: 'k', device: 'd', key: newKey(), pc: 'PC', vapid: 'v', until: now + 5 * 60_000 })
    expect(decodePairing(text, now)?.device).toBe('d')
    expect(decodePairing(text, now + 5 * 60_000 + 1)).toBeNull()
    expect(decodePairing('nonsense', now)).toBeNull()
  })
})
