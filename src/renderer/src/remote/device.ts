/**
 * The pairing that links this phone or iPad to the PC, kept on the device for good. It lives in
 * localStorage (read synchronously at start) and is mirrored into IndexedDB, so one store being
 * cleared on its own doesn't sign the device out. Nothing here is ever sent to a server.
 */
import { decodeLibraryLink, decodePairing, type NotesLibrary } from '../../../shared/remote-crypto'
import type { RemoteDevice } from './relay'

export const DEVICE_STORAGE = 'deskmates:remote-device'
const MIRROR_DB = 'deskmates-device'
const MIRROR_STORE = 'kv'

function openMirror(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MIRROR_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(MIRROR_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function mirror(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const db = await openMirror()
  try {
    return await new Promise((resolve, reject) => {
      const request = run(db.transaction(MIRROR_STORE, mode).objectStore(MIRROR_STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

function isDevice(value: unknown): value is RemoteDevice {
  const v = value as Partial<RemoteDevice> | null
  return Boolean(v && typeof v.relay === 'string' && typeof v.device === 'string' && typeof v.key === 'string')
}

export function readDevice(): RemoteDevice | null {
  try {
    const raw = localStorage.getItem(DEVICE_STORAGE)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return isDevice(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function saveDevice(device: RemoteDevice): Promise<void> {
  try {
    localStorage.setItem(DEVICE_STORAGE, JSON.stringify(device))
  } catch {
    // Private mode or a full store: the IndexedDB copy still keeps it.
  }
  await mirror('readwrite', (store) => store.put(device, DEVICE_STORAGE)).catch(() => undefined)
}

/** The pairing, from localStorage or else from the IndexedDB copy (which then refills localStorage). */
export async function restoreDevice(): Promise<RemoteDevice | null> {
  const local = readDevice()
  if (local) {
    // Keep the copy current, e.g. for devices paired before the copy existed.
    void mirror('readwrite', (store) => store.put(local, DEVICE_STORAGE)).catch(() => undefined)
    return local
  }
  const copy = await mirror('readonly', (store) => store.get(DEVICE_STORAGE)).catch(() => null)
  if (!isDevice(copy)) return null
  try {
    localStorage.setItem(DEVICE_STORAGE, JSON.stringify(copy))
  } catch {
    // Ignore: the copy is returned either way.
  }
  return copy
}

export type PairingResult = { ok: true; device: RemoteDevice } | { ok: false; reason: 'not-a-pairing' | 'expired' }

/**
 * Reads the "Add a phone" link (from the address bar or a scanned QR code). The link carries the
 * pairing in its #pair= fragment; a bare fragment value is accepted too.
 */
export function pairingFromText(text: string, now = Date.now()): PairingResult {
  const trimmed = text.trim()
  let fragment: string | null = null
  const hash = trimmed.indexOf('#')
  if (hash >= 0) fragment = new URLSearchParams(trimmed.slice(hash + 1)).get('pair')
  else if (/^[A-Za-z0-9_-]{40,}$/.test(trimmed)) fragment = trimmed
  if (!fragment) return { ok: false, reason: 'not-a-pairing' }
  const pairing = decodePairing(fragment, now)
  if (!pairing) {
    // Tell an old code apart from something that was never a pairing.
    return decodePairing(fragment, 0) ? { ok: false, reason: 'expired' } : { ok: false, reason: 'not-a-pairing' }
  }
  return {
    ok: true,
    device: { relay: pairing.relay, anon: pairing.anon, device: pairing.device, key: pairing.key, pc: pairing.pc, vapid: pairing.vapid, ...(pairing.lib ? { lib: pairing.lib } : {}) }
  }
}

/** Asks the browser to keep this site's data even when the device runs low on space. */
export async function keepDataForGood(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** The device's name as the PC lists it. iPadOS Safari reports itself as a Mac, so touch tells them apart. */
export function deviceName(): string {
  const ua = navigator.userAgent
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Browser'
}

// ---- the notes library (synced notes) ----

/** Where synced notes live: the relay to reach and the library on it. */
export interface LibraryAccess {
  relay: string
  anon: string
  lib: NotesLibrary
}

const LIBRARY_STORAGE = 'deskmates:notes-library'

function isLibrary(value: unknown): value is LibraryAccess {
  const v = value as Partial<LibraryAccess> | null
  return Boolean(v && typeof v.relay === 'string' && typeof v.anon === 'string' && v.lib?.id && v.lib.key && v.lib.token)
}

export async function saveLibrary(access: LibraryAccess): Promise<void> {
  try {
    localStorage.setItem(LIBRARY_STORAGE, JSON.stringify(access))
  } catch {
    // The IndexedDB copy keeps it.
  }
  await mirror('readwrite', (store) => store.put(access, LIBRARY_STORAGE)).catch(() => undefined)
}

/** The library this device syncs: one saved from a link, or the one that came with pairing. */
export async function restoreLibrary(device: RemoteDevice | null): Promise<LibraryAccess | null> {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (isLibrary(parsed)) return parsed
  } catch {
    // Fall through to the copy.
  }
  const copy = await mirror('readonly', (store) => store.get(LIBRARY_STORAGE)).catch(() => null)
  if (isLibrary(copy)) {
    await saveLibrary(copy)
    return copy
  }
  if (device?.lib) {
    const access = { relay: device.relay, anon: device.anon, lib: device.lib }
    await saveLibrary(access)
    return access
  }
  return null
}

/** Reads an "Open my notes" link's #library= fragment. */
export function libraryFromHash(hash: string): LibraryAccess | null {
  const fragment = new URLSearchParams(hash.replace(/^#/, '')).get('library')
  const link = fragment ? decodeLibraryLink(fragment) : null
  return link ? { relay: link.relay, anon: link.anon, lib: link.lib } : null
}
