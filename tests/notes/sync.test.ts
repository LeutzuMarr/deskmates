import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeNotesDb, createNotebook, DB_NAME, getAsset, getNotebook, listNotebooks, listOutbox, listPages, putAsset, save, updateNotebook } from '../../src/renderer/src/notes/db'
import { openJson, sealJson, syncOnce, type Rpc } from '../../src/renderer/src/notes/sync/sync'
import { newNotesLibrary } from '../../src/shared/remote-crypto'
import type { LibraryAccess } from '../../src/renderer/src/remote/device'

/** The Supabase functions, in memory, with the same rules (newer wins, parts by id). */
function fakeServer(): { rpc: Rpc; rows: Map<string, { store: string; id: string; updated: number; body: string; seq: number }> } {
  const rows = new Map<string, { store: string; id: string; updated: number; body: string; seq: number }>()
  const parts = new Map<string, string>()
  let seq = 0
  const rpc: Rpc = async (fn, args) => {
    if (fn === 'notes_push') {
      let written = 0
      for (const r of args.p_rows as Array<{ store: string; id: string; updated: number; body: string }>) {
        const key = `${r.store}:${r.id}`
        const existing = rows.get(key)
        if (existing && existing.updated > r.updated) continue
        rows.set(key, { ...r, seq: ++seq })
        written++
      }
      return written
    }
    if (fn === 'notes_pull') return [...rows.values()].filter((r) => r.seq > (args.p_since as number)).sort((a, b) => a.seq - b.seq).slice(0, args.p_limit as number)
    if (fn === 'notes_put_part') {
      parts.set(`${args.p_id}:${args.p_part}`, args.p_data as string)
      return null
    }
    if (fn === 'notes_get_part') return parts.get(`${args.p_id}:${args.p_part}`) ?? null
    throw new Error(fn)
  }
  return { rpc, rows }
}

/** A second device: same server, empty local database. */
async function wipeDevice(): Promise<void> {
  await closeNotesDb()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
  })
}

const access: LibraryAccess = { relay: 'https://x.supabase.co', anon: 'anon', lib: newNotesLibrary() }

afterEach(wipeDevice)

describe('sync', () => {
  it('encrypts so the server only sees sealed text', async () => {
    const sealed = await sealJson(access.lib.key, { title: 'Secret biology notes' })
    expect(sealed).not.toContain('biology')
    expect(await openJson(access.lib.key, sealed)).toEqual({ title: 'Secret biology notes' })
    const other = newNotesLibrary()
    await expect(openJson(other.key, sealed)).rejects.toBeTruthy()
  })

  it('carries notebooks, pages and pictures to another device', async () => {
    const server = fakeServer()
    const notebook = await createNotebook({ title: 'Fizică' })
    const picture = await putAsset(new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' }))
    await syncOnce(access, server.rpc)
    expect(await listOutbox()).toEqual([])
    for (const row of server.rows.values()) expect(row.body).not.toContain('Fizică')

    await wipeDevice()
    const changes: string[] = []
    await syncOnce(access, server.rpc, (c) => changes.push(...c.notebooks))
    expect((await listNotebooks()).map((n) => n.title)).toEqual(['Fizică'])
    expect(await listPages(notebook.id)).toHaveLength(1)
    expect(changes).toContain(notebook.id)
    const copy = await getAsset(picture.id)
    expect(new Uint8Array(await copy!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    // What came from sync isn't sent back.
    expect(await listOutbox()).toEqual([])
  })

  it('keeps the newer change when both devices changed a record', async () => {
    const server = fakeServer()
    const notebook = await createNotebook({ title: 'A' }, 1000)
    await syncOnce(access, server.rpc)
    // Elsewhere, later: renamed to "B".
    const remote = { ...(await getNotebook(notebook.id))!, title: 'B', updatedAt: 5000 }
    await server.rpc('notes_push', { p_rows: [{ store: 'notebooks', id: notebook.id, updated: 5000, body: await sealJson(access.lib.key, remote) }] })
    // Here, earlier: renamed to "C".
    await updateNotebook(notebook.id, { title: 'C' }, 3000)
    await syncOnce(access, server.rpc)
    expect((await getNotebook(notebook.id))!.title).toBe('B')
    // And a newer local change wins on the server.
    await updateNotebook(notebook.id, { title: 'D' }, 9000)
    await syncOnce(access, server.rpc)
    await wipeDevice()
    await syncOnce(access, server.rpc)
    expect((await getNotebook(notebook.id))!.title).toBe('D')
  })

  it('syncs deletions too', async () => {
    const server = fakeServer()
    const notebook = await createNotebook({ title: 'Old' })
    await syncOnce(access, server.rpc)
    const now = Date.now() + 10
    await save({ notebooks: [{ ...(await getNotebook(notebook.id))!, deletedAt: now, updatedAt: now }] })
    await syncOnce(access, server.rpc)
    await wipeDevice()
    await syncOnce(access, server.rpc)
    expect(await listNotebooks()).toEqual([])
  })
})

describe('first sync', () => {
  it('sends notes that were made before syncing was set up, but not store stickers', async () => {
    const server = fakeServer()
    const notebook = await createNotebook({ title: 'Made offline' })
    const { clearOutbox, listOutbox: outbox, putAsset: put } = await import('../../src/renderer/src/notes/db')
    await put(new Blob(['<svg/>'], { type: 'image/svg+xml' }), { id: 'store:study:dm-bravo', fromSync: true })
    // As if made before the outbox existed.
    await clearOutbox(await outbox())
    await syncOnce(access, server.rpc)
    expect([...server.rows.values()].some((r) => r.store === 'notebooks' && r.id === notebook.id)).toBe(true)
    expect([...server.rows.values()].some((r) => r.id === 'store:study:dm-bravo')).toBe(false)
  })
})
