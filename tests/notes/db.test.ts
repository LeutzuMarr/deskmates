import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { clearOutbox, closeNotesDb, createNotebook, DB_NAME, deleteNotebookForGood, getMeta, getNotebook, listNotebooks, listOutbox, listPages, listTrash, restoreNotebook, save, setMeta, trashNotebook, updateNotebook } from '../../src/renderer/src/notes/db'

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

  it('gives a new notebook its first page and queues both for sync', async () => {
    const notebook = await createNotebook({ title: 'Biology', pageStyle: { paper: 'grid', color: 'cream', size: 'a4' } })
    const pages = await listPages(notebook.id)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ paper: 'grid', color: 'cream', width: 794, height: 1123 })
    const outbox = await listOutbox()
    expect(outbox.map((e) => e.store).sort()).toEqual(['notebooks', 'pages'])
    await clearOutbox(outbox)
    expect(await listOutbox()).toEqual([])
  })

  it('keeps a change queued if it changed again while syncing', async () => {
    const notebook = await createNotebook({ title: 'Physics' })
    const sent = await listOutbox()
    await new Promise((r) => setTimeout(r, 2))
    await updateNotebook(notebook.id, { title: 'Physics II' })
    await clearOutbox(sent)
    expect((await listOutbox()).map((e) => e.key)).toEqual([`notebooks:${notebook.id}`])
  })

  it('does not queue what came from another device', async () => {
    await save({ folders: [{ id: 'f1', name: 'School', parentId: null, createdAt: 1, updatedAt: 1 }] }, { fromSync: true })
    expect(await listOutbox()).toEqual([])
  })

  it('restores from the trash and deletes for good', async () => {
    const notebook = await createNotebook({ title: 'Anatomy' })
    await trashNotebook(notebook.id)
    expect((await listTrash()).map((n) => n.id)).toEqual([notebook.id])
    await restoreNotebook(notebook.id)
    expect((await listNotebooks()).map((n) => n.id)).toEqual([notebook.id])
    await deleteNotebookForGood(notebook.id)
    expect(await listNotebooks()).toEqual([])
    expect(await listTrash()).toEqual([])
    expect(await listPages(notebook.id)).toEqual([])
  })
})
