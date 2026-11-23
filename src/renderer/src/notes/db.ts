/**
 * The notes library on this device (IndexedDB). Everything a notebook needs lives here first, so
 * writing and browsing never wait on the network; syncing copies it elsewhere later.
 *
 * Schema changes: bump DB_VERSION and add a step to `upgrade`. Never rewrite an earlier step,
 * since devices upgrade from whatever version they have.
 */

export const DB_NAME = 'deskmates-notes'
export const DB_VERSION = 1

export interface Folder {
  id: string
  name: string
  parentId: string | null
  createdAt: number
  updatedAt: number
}

export interface Notebook {
  id: string
  title: string
  /** One of the cover colours the library offers. */
  cover: string
  folderId: string | null
  createdAt: number
  updatedAt: number
  /** Set when moved to the trash; null while in the library. */
  trashedAt: number | null
}

type StoreName = 'folders' | 'notebooks' | 'meta'

function upgrade(db: IDBDatabase, from: number): void {
  if (from < 1) {
    db.createObjectStore('folders', { keyPath: 'id' })
    const notebooks = db.createObjectStore('notebooks', { keyPath: 'id' })
    notebooks.createIndex('folderId', 'folderId')
    db.createObjectStore('meta')
  }
}

let opening: Promise<IDBDatabase> | null = null

export function openNotesDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion)
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

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openNotesDb()
  return db.transaction(name, mode).objectStore(name)
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const COVERS = ['clay', 'olive', 'ink', 'sky', 'plum', 'sand'] as const

// ---- notebooks ----

export async function listNotebooks(): Promise<Notebook[]> {
  const all = await done((await store('notebooks', 'readonly')).getAll() as IDBRequest<Notebook[]>)
  return all.filter((n) => n.trashedAt === null).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getNotebook(id: string): Promise<Notebook | null> {
  return (await done((await store('notebooks', 'readonly')).get(id) as IDBRequest<Notebook | undefined>)) ?? null
}

export async function createNotebook(input: { title: string; cover?: string; folderId?: string | null }, now = Date.now()): Promise<Notebook> {
  const notebook: Notebook = {
    id: newId(),
    title: input.title.trim() || 'Untitled notebook',
    cover: input.cover ?? COVERS[0],
    folderId: input.folderId ?? null,
    createdAt: now,
    updatedAt: now,
    trashedAt: null
  }
  await done((await store('notebooks', 'readwrite')).add(notebook))
  return notebook
}

export async function updateNotebook(id: string, changes: Partial<Pick<Notebook, 'title' | 'cover' | 'folderId'>>, now = Date.now()): Promise<Notebook | null> {
  const current = await getNotebook(id)
  if (!current) return null
  const next: Notebook = { ...current, ...changes, updatedAt: now }
  if (changes.title !== undefined) next.title = changes.title.trim() || current.title
  await done((await store('notebooks', 'readwrite')).put(next))
  return next
}

export async function trashNotebook(id: string, now = Date.now()): Promise<void> {
  const current = await getNotebook(id)
  if (!current) return
  await done((await store('notebooks', 'readwrite')).put({ ...current, trashedAt: now, updatedAt: now }))
}

// ---- small settings ----

export async function getMeta<T>(key: string): Promise<T | null> {
  return ((await done((await store('meta', 'readonly')).get(key))) as T | undefined) ?? null
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await done((await store('meta', 'readwrite')).put(value, key))
}
