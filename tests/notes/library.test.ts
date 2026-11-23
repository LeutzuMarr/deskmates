import 'fake-indexeddb/auto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeNotesDb, copyPages, createFolder, createNotebook, DB_NAME, deleteFolder, listFolders, listNotebooks, listPageItems, listPages, save, searchNotes, updateNotebook } from '../../src/renderer/src/notes/db'
import { buildStore } from '../../scripts/store-files'
import { BUILTIN_TEMPLATES } from '../../src/renderer/src/notes/templates/builtin'
import type { Item } from '../../src/renderer/src/notes/model'

afterEach(async () => {
  await closeNotesDb()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
  })
})

function text(notebookId: string, pageId: string, value: string): Item<'text'> {
  return { id: `t-${value.length}-${Math.random()}`, pageId, notebookId, kind: 'text', z: 1, data: { x: 0, y: 0, width: 200, text: value, size: 18, color: '#000', font: 'sans' }, createdAt: 1, updatedAt: 1, deletedAt: null }
}

describe('folders', () => {
  it('moves what was in a deleted folder up to its parent', async () => {
    const school = await createFolder('School', null)
    const grade = await createFolder('Grade 10', school.id)
    const math = await createNotebook({ title: 'Math', folderId: grade.id })
    await deleteFolder(grade.id)
    expect((await listFolders()).map((f) => f.name)).toEqual(['School'])
    expect((await listNotebooks()).find((n) => n.id === math.id)!.folderId).toBe(school.id)
  })
})

describe('pages', () => {
  it('copies a page with its items into another notebook, between two pages', async () => {
    const a = await createNotebook({ title: 'A' })
    const b = await createNotebook({ title: 'B', firstPages: [{}, {}] })
    const [source] = await listPages(a.id)
    await save({ items: [text(a.id, source!.id, 'hello')] })
    const target = await listPages(b.id)
    const [copy] = await copyPages([source!.id], b.id, target[0]!.order, target[1]!.order)
    const pages = await listPages(b.id)
    expect(pages.map((p) => p.id)).toEqual([target[0]!.id, copy!.id, target[1]!.id])
    const items = await listPageItems(copy!.id)
    expect(items).toHaveLength(1)
    expect(items[0]!.notebookId).toBe(b.id)
  })

  it('starts a notebook from a template', async () => {
    const n = await createNotebook({ title: 'Week', pageTemplate: 'builtin:week' })
    expect((await listPages(n.id))[0]!.template).toBe('builtin:week')
  })
})

describe('search', () => {
  it('finds typed text and titles, not trashed notebooks', async () => {
    const bio = await createNotebook({ title: 'Biologie' })
    const [page] = await listPages(bio.id)
    await save({ items: [text(bio.id, page!.id, 'Mitocondria este centrala energetică a celulei')] })
    const hits = await searchNotes('centrala')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ pageId: page!.id, pageNumber: 1 })
    expect(hits[0]!.snippet).toContain('centrala')
    expect((await searchNotes('biol')).map((h) => h.notebook.id)).toEqual([bio.id])
    await updateNotebook(bio.id, { title: 'Bio' })
    expect(await searchNotes('')).toEqual([])
  })
})

describe('store files', () => {
  it('lists every pack with its templates and sticker files', () => {
    const { catalog, packs } = buildStore(join(__dirname, '../../src/renderer/remote-public/store/stickers'))
    const list = (catalog as { packs: Array<{ id: string; stickers: number; templates: number }> }).packs
    expect(list.map((p) => p.id)).toEqual(['study', 'algebra', 'geometry', 'physics', 'sciences', 'biology', 'anatomy'])
    for (const p of list) {
      expect(p.stickers).toBeGreaterThan(10)
      expect(p.templates).toBeGreaterThan(1)
    }
    const anatomy = packs.anatomy as { templates: Array<{ id: string; group: string }>; stickers: Array<{ file: string }> }
    expect(anatomy.templates[0]).toMatchObject({ id: 'store:anatomy:plate', group: 'Anatomie' })
    expect(anatomy.stickers.some((s) => s.file === '/store/stickers/anatomy/anatomical-heart.svg')).toBe(true)
  })

  it('has unique built-in template ids', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
