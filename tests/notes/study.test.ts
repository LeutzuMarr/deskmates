import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeNotesDb, DB_NAME } from '../../src/renderer/src/notes/db'
import { addCards, deleteCard, gradeCard, graded, listCards, studyOrder, type Card } from '../../src/renderer/src/notes/ai/cards'
import { jsonList } from '../../src/renderer/src/notes/ai/client'

afterEach(async () => {
  await closeNotesDb()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
  })
})

const DAY = 24 * 60 * 60 * 1000

describe('flashcards', () => {
  it('moves a known card up a box and a missed one back to the start', () => {
    const card: Card = { id: 'c', notebookId: 'n', front: 'q', back: 'a', box: 3, due: 0, createdAt: 0, updatedAt: 0, deletedAt: null }
    const known = graded(card, true, 1000)
    expect(known.box).toBe(4)
    expect(known.due).toBe(1000 + 7 * DAY)
    const missed = graded(card, false, 1000)
    expect(missed).toMatchObject({ box: 1, due: 1000 })
    expect(graded({ ...card, box: 5 }, true, 0).box).toBe(5)
  })

  it('studies due cards first, the hardest first', () => {
    const make = (id: string, box: number, due: number): Card => ({ id, notebookId: 'n', front: id, back: id, box, due, createdAt: 0, updatedAt: 0, deletedAt: null })
    const order = studyOrder([make('later', 1, 5000), make('easy', 4, 100), make('hard', 1, 200)], 1000)
    expect(order.map((c) => c.id)).toEqual(['hard', 'easy'])
    expect(studyOrder([make('later', 2, 5000)], 1000).map((c) => c.id)).toEqual(['later'])
  })

  it('keeps cards per notebook, skipping empty ones', async () => {
    await addCards('bio', [
      { front: 'Mitocondria', back: 'Centrala celulei' },
      { front: '  ', back: 'x' }
    ])
    await addCards('chem', [{ front: 'H₂O', back: 'Apă' }])
    const bio = await listCards('bio')
    expect(bio.map((c) => c.front)).toEqual(['Mitocondria'])
    const next = await gradeCard(bio[0]!, true)
    expect((await listCards('bio'))[0]!.box).toBe(next.box)
    await deleteCard(bio[0]!)
    expect(await listCards('bio')).toEqual([])
  })
})

describe('reading answers', () => {
  it('finds the JSON list in a reply, even inside text or a code block', () => {
    expect(jsonList('[{"q":"a","a":"b"}]')).toEqual([{ q: 'a', a: 'b' }])
    expect(jsonList('Sigur! ```json\n[{"q":"1+1","options":["1","2"],"answer":1}]\n``` Spor!')).toEqual([{ q: '1+1', options: ['1', '2'], answer: 1 }])
    expect(jsonList('Nu am putut face testul.')).toBeNull()
    expect(jsonList('[not json]')).toBeNull()
  })
})
