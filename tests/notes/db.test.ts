import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeNotesDb, createNotebook, DB_NAME, getMeta, getNotebook, listNotebooks, setMeta, trashNotebook, updateNotebook } from '../../src/renderer/src/notes/db'

afterEach(async () => {
  await closeNotesDb()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
})

describe('notes library', () => {
  it('keeps notebooks, newest first, and survives reopening the database', async () => {
    await createNotebook({ title: 'Math' }, 1000)
    await createNotebook({ title: 'Physics', cover: 'olive' }, 2000)
    await closeNotesDb()
    const list = await listNotebooks()
    expect(list.map((n) => n.title)).toEqual(['Physics', 'Math'])
    expect(list[0]!.cover).toBe('olive')
    expect(list[1]!.cover).toBe('clay')
  })

  it('names a notebook with no title', async () => {
    const notebook = await createNotebook({ title: '   ' })
    expect(notebook.title).toBe('Untitled notebook')
  })

  it('renames without accepting an empty name, and moves to the trash', async () => {
    const notebook = await createNotebook({ title: 'Chemistry' }, 1000)
    await updateNotebook(notebook.id, { title: '' }, 1500)
    expect((await getNotebook(notebook.id))!.title).toBe('Chemistry')
    await updateNotebook(notebook.id, { title: 'Organic chemistry' }, 2000)
    expect((await getNotebook(notebook.id))!).toMatchObject({ title: 'Organic chemistry', updatedAt: 2000 })
    await trashNotebook(notebook.id, 3000)
    expect(await listNotebooks()).toEqual([])
    expect((await getNotebook(notebook.id))!.trashedAt).toBe(3000)
  })

  it('stores small settings', async () => {
    expect(await getMeta('lastOpened')).toBeNull()
    await setMeta('lastOpened', { id: 'abc' })
    expect(await getMeta('lastOpened')).toEqual({ id: 'abc' })
  })
})
