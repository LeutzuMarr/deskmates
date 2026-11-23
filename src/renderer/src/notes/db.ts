/**
 * The notes library on this device (IndexedDB). Everything a notebook needs lives here first, so
 * writing and browsing never wait on the network; syncing copies it elsewhere later.
 *
 * Every change to a synced record goes through `save`, which also notes it in the outbox in the
 * same transaction, so a change can never be saved without being queued for sync.
 *
 * Schema changes: bump DB_VERSION and add a step to `upgrade`. Never rewrite an earlier step,
 * since devices upgrade from whatever version they have.
 */
import { DEFAULT_PAGE_STYLE, pageDimensions, type Item, type Page, type PageStyle } from './model'

export const DB_NAME = 'deskmates-notes'
export const DB_VERSION = 2

export interface Folder {
  id: string
  name: string
  parentId: string | null
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

export interface Notebook {
  id: string
  title: string
  /** One of the cover colours the library offers, or "asset:<id>" for a picture. */
  cover: string
  folderId: string | null
  /** The paper new pages get. */
  pageStyle?: PageStyle
  /** The page last open, to come back to it. */
  lastPageId?: string
  favorite?: boolean
  createdAt: number
  updatedAt: number
  /** Set when moved to the trash; null while in the library. */
  trashedAt: number | null
  /** Set when emptied from the trash (kept so the deletion syncs). */
  deletedAt?: number | null
}

export interface Asset {
  id: string
  mime: string
  blob: Blob
  name?: string
  createdAt: number
}

/** Stores whose records sync between devices. */
export type SyncedStore = 'folders' | 'notebooks' | 'pages' | 'items' | 'templates' | 'packs' | 'stickers' | 'cards' | 'recordings'
type StoreName = SyncedStore | 'meta' | 'assets' | 'outbox'

export interface OutboxEntry {
  key: string
  store: SyncedStore | 'assets'
  id: string
  at: number
}

function upgrade(db: IDBDatabase, tx: IDBTransaction, from: number): void {
  if (from < 1) {
    db.createObjectStore('folders', { keyPath: 'id' })
    const notebooks = db.createObjectStore('notebooks', { keyPath: 'id' })
    notebooks.createIndex('folderId', 'folderId')
    db.createObjectStore('meta')
  }
  if (from < 2) {
    db.createObjectStore('pages', { keyPath: 'id' }).createIndex('notebookId', 'notebookId')
    const items = db.createObjectStore('items', { keyPath: 'id' })
    items.createIndex('pageId', 'pageId')
    items.createIndex('notebookId', 'notebookId')
    db.createObjectStore('assets', { keyPath: 'id' })
    db.createObjectStore('templates', { keyPath: 'id' })
    db.createObjectStore('packs', { keyPath: 'id' })
    db.createObjectStore('stickers', { keyPath: 'id' }).createIndex('packId', 'packId')
    db.createObjectStore('cards', { keyPath: 'id' }).createIndex('notebookId', 'notebookId')
    db.createObjectStore('recordings', { keyPath: 'id' }).createIndex('notebookId', 'notebookId')
    db.createObjectStore('outbox', { keyPath: 'key' })
    // Notebooks made before pages existed get their first page.
    if (from === 1) {
      const pages = tx.objectStore('pages')
      tx.objectStore('notebooks').getAll().onsuccess = (event) => {
        const now = Date.now()
        for (const n of (event.target as IDBRequest<Notebook[]>).result) pages.put(makePage(n.id, 0, DEFAULT_PAGE_STYLE, now))
      }
    }
  }
}

let opening: Promise<IDBDatabase> | null = null

export function openNotesDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => upgrade(request.result, request.transaction!, event.oldVersion)
    request.onsuccess = () => {
      const db = request.result
      // Another tab opened a newer version: let it upgrade, and reopen next time.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    request.onerror = () => {
      opening = null
      reject(request.error)
    }
    request.onblocked = () => undefined
  })
  return opening
}

/** Closes the database (tests, and before deleting it). */
export async function closeNotesDb(): Promise<void> {
  if (!opening) return
  const db = await opening.catch(() => null)
  db?.close()
  opening = null
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
  })
}

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openNotesDb()
  return db.transaction(name, mode).objectStore(name)
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ---- generic access ----

export async function getRecord<T>(name: StoreName, id: string): Promise<T | null> {
  return ((await done((await store(name, 'readonly')).get(id))) as T | undefined) ?? null
}

export async function getAllRecords<T>(name: StoreName): Promise<T[]> {
  return (await done((await store(name, 'readonly')).getAll())) as T[]
}

export async function getByIndex<T>(name: StoreName, index: string, value: string): Promise<T[]> {
  return (await done((await store(name, 'readonly')).index(index).getAll(value))) as T[]
}

/**
 * Saves records of one or more stores in one transaction, and queues them for sync. `fromSync`
 * is set when the records came from another device, so they aren't sent back.
 */
export async function save(changes: Partial<Record<SyncedStore, unknown[]>>, options: { fromSync?: boolean } = {}): Promise<void> {
  const names = Object.keys(changes).filter((k) => (changes[k as SyncedStore]?.length ?? 0) > 0) as SyncedStore[]
  if (names.length === 0) return
  const db = await openNotesDb()
  const tx = db.transaction([...names, 'outbox'], 'readwrite')
  const outbox = tx.objectStore('outbox')
  const now = Date.now()
  for (const name of names) {
    const target = tx.objectStore(name)
    for (const record of changes[name]!) {
      target.put(record)
      if (!options.fromSync) {
        const id = (record as { id: string }).id
        outbox.put({ key: `${name}:${id}`, store: name, id, at: now } satisfies OutboxEntry)
      }
    }
  }
  await finished(tx)
}

/** Removes records for good from this device (after a sync, or for local-only data). */
export async function purge(name: StoreName, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await openNotesDb()
  const tx = db.transaction(name, 'readwrite')
  for (const id of ids) tx.objectStore(name).delete(id)
  await finished(tx)
}

// ---- assets (pictures, PDFs, audio, sticker art) ----

export async function putAsset(blob: Blob, options: { name?: string; id?: string; fromSync?: boolean } = {}): Promise<Asset> {
  const asset: Asset = { id: options.id ?? newId(), mime: blob.type || 'application/octet-stream', blob, name: options.name, createdAt: Date.now() }
  const db = await openNotesDb()
  const tx = db.transaction(['assets', 'outbox'], 'readwrite')
  tx.objectStore('assets').put(asset)
  if (!options.fromSync) tx.objectStore('outbox').put({ key: `assets:${asset.id}`, store: 'assets', id: asset.id, at: asset.createdAt } satisfies OutboxEntry)
  await finished(tx)
  return asset
}

export function getAsset(id: string): Promise<Asset | null> {
  return getRecord<Asset>('assets', id)
}

// ---- notebooks ----

export const COVERS = ['clay', 'olive', 'ink', 'sky', 'plum', 'sand', 'mint', 'rose'] as const

export async function listNotebooks(): Promise<Notebook[]> {
  const all = await getAllRecords<Notebook>('notebooks')
  return all.filter((n) => n.trashedAt === null && !n.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listTrash(): Promise<Notebook[]> {
  const all = await getAllRecords<Notebook>('notebooks')
  return all.filter((n) => n.trashedAt !== null && !n.deletedAt).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
}

export function getNotebook(id: string): Promise<Notebook | null> {
  return getRecord<Notebook>('notebooks', id)
}

export function makePage(notebookId: string, order: number, style: PageStyle, now = Date.now(), extra: Partial<Page> = {}): Page {
  const [width, height] = pageDimensions(style)
  return { id: newId(), notebookId, order, ...style, width, height, createdAt: now, updatedAt: now, deletedAt: null, ...extra }
}

export async function createNotebook(
  input: { title: string; cover?: string; folderId?: string | null; pageStyle?: PageStyle; firstPage?: Partial<Page> },
  now = Date.now()
): Promise<Notebook> {
  const pageStyle = input.pageStyle ?? DEFAULT_PAGE_STYLE
  const notebook: Notebook = {
    id: newId(),
    title: input.title.trim() || 'Untitled notebook',
    cover: input.cover ?? COVERS[0],
    folderId: input.folderId ?? null,
    pageStyle,
    createdAt: now,
    updatedAt: now,
    trashedAt: null
  }
  const page = makePage(notebook.id, 0, pageStyle, now, input.firstPage)
  await save({ notebooks: [notebook], pages: [page] })
  return notebook
}

export async function updateNotebook(
  id: string,
  changes: Partial<Pick<Notebook, 'title' | 'cover' | 'folderId' | 'pageStyle' | 'lastPageId' | 'favorite'>>,
  now = Date.now()
): Promise<Notebook | null> {
  const current = await getNotebook(id)
  if (!current) return null
  const next: Notebook = { ...current, ...changes, updatedAt: now }
  if (changes.title !== undefined) next.title = changes.title.trim() || current.title
  await save({ notebooks: [next] })
  return next
}

export async function trashNotebook(id: string, now = Date.now()): Promise<void> {
  const current = await getNotebook(id)
  if (!current) return
  await save({ notebooks: [{ ...current, trashedAt: now, updatedAt: now }] })
}

export async function restoreNotebook(id: string, now = Date.now()): Promise<void> {
  const current = await getNotebook(id)
  if (!current) return
  await save({ notebooks: [{ ...current, trashedAt: null, updatedAt: now }] })
}

/** Empties a notebook out of the trash: its pages and items are marked deleted, so the deletion syncs. */
export async function deleteNotebookForGood(id: string, now = Date.now()): Promise<void> {
  const current = await getNotebook(id)
  if (!current) return
  const pages = await getByIndex<Page>('pages', 'notebookId', id)
  const items = await getByIndex<Item>('items', 'notebookId', id)
  await save({
    notebooks: [{ ...current, deletedAt: now, updatedAt: now }],
    pages: pages.map((p) => ({ ...p, deletedAt: now, updatedAt: now })),
    items: items.filter((i) => !i.deletedAt).map((i) => ({ ...i, deletedAt: now, updatedAt: now }))
  })
}

/** Moves notebooks trashed more than 30 days ago out for good. */
export async function emptyOldTrash(now = Date.now()): Promise<void> {
  const month = 30 * 24 * 60 * 60 * 1000
  for (const n of await listTrash()) if (n.trashedAt !== null && now - n.trashedAt > month) await deleteNotebookForGood(n.id, now)
}

// ---- pages and items ----

export async function listPages(notebookId: string): Promise<Page[]> {
  const pages = await getByIndex<Page>('pages', 'notebookId', notebookId)
  return pages.filter((p) => !p.deletedAt).sort((a, b) => a.order - b.order)
}

export async function listItems(notebookId: string): Promise<Item[]> {
  const items = await getByIndex<Item>('items', 'notebookId', notebookId)
  return items.filter((i) => !i.deletedAt)
}

export async function listPageItems(pageId: string): Promise<Item[]> {
  const items = await getByIndex<Item>('items', 'pageId', pageId)
  return items.filter((i) => !i.deletedAt).sort((a, b) => a.z - b.z)
}

// ---- small settings ----

export async function getMeta<T>(key: string): Promise<T | null> {
  return ((await done((await store('meta', 'readonly')).get(key))) as T | undefined) ?? null
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await done((await store('meta', 'readwrite')).put(value, key))
}

// ---- sync outbox ----

export function listOutbox(): Promise<OutboxEntry[]> {
  return getAllRecords<OutboxEntry>('outbox')
}

/** Clears outbox entries that were sent, unless the record changed again since. */
export async function clearOutbox(sent: OutboxEntry[]): Promise<void> {
  if (sent.length === 0) return
  const db = await openNotesDb()
  const tx = db.transaction('outbox', 'readwrite')
  const outbox = tx.objectStore('outbox')
  for (const entry of sent) {
    outbox.get(entry.key).onsuccess = (event) => {
      const current = (event.target as IDBRequest<OutboxEntry | undefined>).result
      if (current && current.at <= entry.at) outbox.delete(entry.key)
    }
  }
  await finished(tx)
}
