/**
 * Syncing notes between the user's devices through their Supabase project.
 *
 * Every record is encrypted on the device (AES-GCM, with the library key that came with pairing)
 * before it leaves; the server stores sealed text it can't read. Each device keeps working on its
 * own copy and syncs when it's online: first it takes what changed elsewhere (newer wins, record by
 * record, and deletions are records too), then it sends what changed here (the outbox).
 * Pictures, PDFs and audio go up in encrypted parts and come down when a device lacks them.
 */
import { fromBase64Url, toBase64Url } from '../../../../shared/remote-crypto'
import type { LibraryAccess } from '../../remote/device'
import { clearOutbox, getAsset, getMeta, getRecord, listOutbox, putAsset, queueEverything, save, setMeta, type OutboxEntry, type SyncedStore } from '../db'

const PART_CHARS = 900_000
const PUSH_BATCH = 200

export type SyncState = { status: 'off' } | { status: 'syncing' } | { status: 'synced'; at: number } | { status: 'offline'; at: number | null } | { status: 'error'; message: string; at: number | null }

export interface SyncChange {
  stores: Set<SyncedStore | 'assets'>
  notebooks: Set<string>
}

// ---- encryption ----

const enc = new TextEncoder()
const dec = new TextDecoder()
const keys = new Map<string, Promise<CryptoKey>>()

function keyOf(key: string): Promise<CryptoKey> {
  let k = keys.get(key)
  if (!k) {
    k = crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
    keys.set(key, k)
  }
  return k
}

export async function sealBytes(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(key), bytes))
  const out = new Uint8Array(iv.length + cipher.length)
  out.set(iv)
  out.set(cipher, iv.length)
  return toBase64Url(out)
}

export async function openBytes(key: string, sealed: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = fromBase64Url(sealed)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await keyOf(key), bytes.slice(12)))
}

export async function sealJson(key: string, value: unknown): Promise<string> {
  return sealBytes(key, enc.encode(JSON.stringify(value)))
}

export async function openJson<T>(key: string, sealed: string): Promise<T> {
  return JSON.parse(dec.decode(await openBytes(key, sealed))) as T
}

// ---- the server ----

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>

/** Calls a function on the Supabase project (PostgREST RPC). */
export function supabaseRpc(access: LibraryAccess): Rpc {
  return async (fn, args) => {
    const response = await fetch(`${access.relay.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: access.anon, authorization: `Bearer ${access.anon}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_library: access.lib.id, p_token: access.lib.token, ...args })
    })
    if (!response.ok) throw new Error(`Sync failed (${response.status})`)
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }
}

interface Row {
  store: SyncedStore | 'assets'
  id: string
  updated: number
  body: string
  seq: number
}

interface AssetMeta {
  id: string
  mime: string
  name?: string
  parts: number
  updatedAt: number
}

function updatedOf(record: unknown): number {
  const r = record as { updatedAt?: number; createdAt?: number }
  return r.updatedAt ?? r.createdAt ?? 0
}

function notebookOf(store: string, record: unknown): string | null {
  const r = record as { notebookId?: string; id?: string }
  if (store === 'notebooks') return r.id ?? null
  return r.notebookId ?? null
}

/** One round: take changes from elsewhere, then send ours. */
export async function syncOnce(access: LibraryAccess, rpc: Rpc = supabaseRpc(access), onChange?: (change: SyncChange) => void): Promise<void> {
  const key = access.lib.key
  const metaKey = `syncSeq:${access.lib.id}`
  const change: SyncChange = { stores: new Set(), notebooks: new Set() }
  const missingAssets: AssetMeta[] = []

  // 0. The first time with this library, what's already on this device is queued to go up too
  // (before pulling, so what arrives from elsewhere isn't sent back).
  const seeded = `syncSeeded:${access.lib.id}`
  if (!(await getMeta<boolean>(seeded))) {
    await queueEverything()
    await setMeta(seeded, true)
  }

  // 1. Pull.
  let since = (await getMeta<number>(metaKey)) ?? 0
  for (;;) {
    const rows = (await rpc('notes_pull', { p_since: since, p_limit: 300 })) as Row[]
    if (!rows?.length) break
    const byStore = new Map<SyncedStore, unknown[]>()
    for (const row of rows) {
      since = Math.max(since, Number(row.seq))
      let record: unknown
      try {
        record = await openJson(key, row.body)
      } catch {
        continue // Not ours, or damaged: skip it.
      }
      if (row.store === 'assets') {
        const meta = record as AssetMeta
        if (!(await getAsset(meta.id))) missingAssets.push(meta)
        continue
      }
      const local = await getRecord(row.store, row.id)
      if (local && updatedOf(local) > updatedOf(record)) continue
      byStore.set(row.store, [...(byStore.get(row.store) ?? []), record])
      change.stores.add(row.store)
      const notebook = notebookOf(row.store, record)
      if (notebook) change.notebooks.add(notebook)
    }
    if (byStore.size) await save(Object.fromEntries(byStore), { fromSync: true })
    await setMeta(metaKey, since)
    if (rows.length < 300) break
  }

  // 2. Pictures, PDFs and audio this device doesn't have yet.
  for (const meta of missingAssets) {
    try {
      const parts: string[] = []
      for (let i = 0; i < meta.parts; i++) {
        const part = (await rpc('notes_get_part', { p_id: meta.id, p_part: i })) as string | null
        if (part === null) throw new Error('missing part')
        parts.push(part)
      }
      const bytes = await openBytes(key, parts.join(''))
      await putAsset(new Blob([bytes], { type: meta.mime }), { id: meta.id, name: meta.name, fromSync: true })
      change.stores.add('assets')
    } catch {
      // Try again next time.
    }
  }
  if (change.stores.size) onChange?.(change)

  // 3. Push.
  const outbox = await listOutbox()
  const assetEntries = outbox.filter((e) => e.store === 'assets')
  const recordEntries = outbox.filter((e) => e.store !== 'assets')
  for (const entry of assetEntries) {
    const asset = await getAsset(entry.id)
    if (!asset) {
      await clearOutbox([entry])
      continue
    }
    const sealed = await sealBytes(key, new Uint8Array(await asset.blob.arrayBuffer()))
    const parts = Math.max(1, Math.ceil(sealed.length / PART_CHARS))
    for (let i = 0; i < parts; i++) await rpc('notes_put_part', { p_id: asset.id, p_part: i, p_data: sealed.slice(i * PART_CHARS, (i + 1) * PART_CHARS) })
    const meta: AssetMeta = { id: asset.id, mime: asset.mime, name: asset.name, parts, updatedAt: asset.createdAt }
    await rpc('notes_push', { p_rows: [{ store: 'assets', id: asset.id, updated: asset.createdAt, body: await sealJson(key, meta) }] })
    await clearOutbox([entry])
  }
  for (let i = 0; i < recordEntries.length; i += PUSH_BATCH) {
    const batch = recordEntries.slice(i, i + PUSH_BATCH)
    const rows: Array<Omit<Row, 'seq'>> = []
    const sent: OutboxEntry[] = []
    for (const entry of batch) {
      const record = await getRecord(entry.store as SyncedStore, entry.id)
      sent.push(entry)
      if (!record) continue
      rows.push({ store: entry.store, id: entry.id, updated: updatedOf(record), body: await sealJson(key, record) })
    }
    if (rows.length) await rpc('notes_push', { p_rows: rows })
    await clearOutbox(sent)
  }
}

// ---- running it ----

class Syncer {
  private access: LibraryAccess | null = null
  private running: Promise<void> | null = null
  private again = false
  private timer = 0
  private interval = 0
  state: SyncState = { status: 'off' }
  private lastOk: number | null = null
  private readonly stateListeners = new Set<(s: SyncState) => void>()
  private readonly changeListeners = new Set<(c: SyncChange) => void>()

  start(access: LibraryAccess | null): void {
    this.access = access
    window.clearInterval(this.interval)
    if (!access) {
      this.set({ status: 'off' })
      return
    }
    void getMeta<number>(`syncedAt:${access.lib.id}`).then((at) => {
      this.lastOk = at
      this.now()
    })
    this.interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') this.now()
    }, 60_000)
  }

  onState(listener: (s: SyncState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.state)
    return () => this.stateListeners.delete(listener)
  }

  onChange(listener: (c: SyncChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private set(state: SyncState): void {
    this.state = state
    for (const l of this.stateListeners) l(state)
  }

  /** Syncs a few seconds after the last local change. */
  soon(): void {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.now(), 4000)
  }

  now(): void {
    const access = this.access
    if (!access) return
    if (!navigator.onLine) {
      this.set({ status: 'offline', at: this.lastOk })
      return
    }
    if (this.running) {
      this.again = true
      return
    }
    this.set({ status: 'syncing' })
    this.running = syncOnce(access, supabaseRpc(access), (change) => {
      for (const l of this.changeListeners) l(change)
    })
      .then(async () => {
        this.lastOk = Date.now()
        await setMeta(`syncedAt:${access.lib.id}`, this.lastOk)
        this.set({ status: 'synced', at: this.lastOk })
      })
      .catch((error: unknown) => this.set({ status: navigator.onLine ? 'error' : 'offline', message: error instanceof Error ? error.message : String(error), at: this.lastOk } as SyncState))
      .finally(() => {
        this.running = null
        if (this.again) {
          this.again = false
          this.now()
        }
      })
  }
}

export const syncer = new Syncer()

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => syncer.now())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncer.now()
  })
}
