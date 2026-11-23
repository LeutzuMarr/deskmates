/**
 * End-to-end encryption between a paired phone and the PC, for Deskmates from anywhere. The relay in
 * between (Supabase Realtime) only ever sees these sealed strings. Runs on WebCrypto, so the same
 * code works in the core (Node) and on the phone (the browser).
 *
 * Each message carries a counter that only goes up, per direction: a replayed or reordered message
 * is refused, and AES-GCM refuses anything tampered with or sealed with another key.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
  const binary = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** A fresh 256-bit key, base64url. */
export function newKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** A random id for a device and its channel. */
export function newId(bytes = 16): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>

async function importKey(key: string): Promise<Key> {
  return crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Which way a message goes, so a message can't be bounced back at its sender. */
export type Direction = 'to-pc' | 'to-phone'

export async function seal(key: string, direction: Direction, counter: number, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = enc.encode(JSON.stringify({ d: direction, c: counter, p: payload }))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), plain))
  const out = new Uint8Array(iv.length + cipher.length)
  out.set(iv)
  out.set(cipher, iv.length)
  return toBase64Url(out)
}

/** The payload, or null for anything tampered with, from another key, the wrong way, or not newer than `lastCounter`. */
export async function open(key: string, direction: Direction, sealed: string, lastCounter: number): Promise<{ payload: unknown; counter: number } | null> {
  try {
    const bytes = fromBase64Url(sealed)
    if (bytes.length < 13) return null
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await importKey(key), bytes.slice(12))
    const message = JSON.parse(dec.decode(plain)) as { d?: unknown; c?: unknown; p?: unknown }
    if (message.d !== direction || typeof message.c !== 'number' || message.c <= lastCounter) return null
    return { payload: message.p, counter: message.c }
  } catch {
    return null
  }
}

/**
 * The notes library shared by the user's devices: its id on the relay, the key notes are
 * encrypted with before they leave a device, and the token that lets a device read and write it.
 */
export interface NotesLibrary {
  id: string
  key: string
  token: string
}

export function newNotesLibrary(): NotesLibrary {
  return { id: newId(16), key: newKey(), token: newId(32) }
}

/** What an "Open my notes" link carries in its #fragment: the relay and the library, no phone pairing. */
export interface LibraryLink {
  v: 1
  relay: string
  anon: string
  lib: NotesLibrary
}

export function encodeLibraryLink(link: LibraryLink): string {
  return toBase64Url(enc.encode(JSON.stringify(link)))
}

export function decodeLibraryLink(text: string): LibraryLink | null {
  try {
    const link = JSON.parse(dec.decode(fromBase64Url(text))) as LibraryLink
    if (link.v !== 1 || !link.relay || !link.anon || !link.lib?.id || !link.lib.key || !link.lib.token) return null
    return link
  } catch {
    return null
  }
}

/** What the "Add a phone" QR code and link carry, in the URL's #fragment (never sent to any server). */
export interface PairingPayload {
  v: 1
  /** The Supabase project URL and its publishable key, for the relay. */
  relay: string
  anon: string
  /** This phone's id (also its channel) and its key. */
  device: string
  key: string
  /** The PC's name, shown on the phone. */
  pc: string
  /** The PC's public key for web push. */
  vapid: string
  /** Pairing must finish before this (ms). */
  until: number
  /** The notes library, so the device's notes sync with the user's other devices. */
  lib?: NotesLibrary
}

export function encodePairing(payload: PairingPayload): string {
  return toBase64Url(enc.encode(JSON.stringify(payload)))
}

export function decodePairing(text: string, now = Date.now()): PairingPayload | null {
  try {
    const payload = JSON.parse(dec.decode(fromBase64Url(text))) as PairingPayload
    if (payload.v !== 1 || !payload.device || !payload.key || !payload.relay) return null
    if (now > payload.until) return null
    return payload
  } catch {
    return null
  }
}

/** The relay channel a device talks on. */
export const channelFor = (device: string): string => `dm-${device}`
