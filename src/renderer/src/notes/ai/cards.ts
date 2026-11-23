/**
 * Flashcards, per notebook, on the device (so studying works offline) and synced like everything
 * else. Studying uses Leitner boxes: a card you know moves up a box and comes back later; one you
 * don't goes back to box 1 and comes back soon.
 */
import { getByIndex, newId, save } from '../db'

export interface Card {
  id: string
  notebookId: string
  front: string
  back: string
  /** 1 (new or missed) … 5 (well known). */
  box: number
  /** When it's next due (ms). */
  due: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

const DAY = 24 * 60 * 60 * 1000
/** How long until a card in each box comes back. */
const WAIT = [0, 0, DAY, 3 * DAY, 7 * DAY, 16 * DAY]

export async function listCards(notebookId: string): Promise<Card[]> {
  return (await getByIndex<Card>('cards', 'notebookId', notebookId)).filter((c) => !c.deletedAt).sort((a, b) => a.createdAt - b.createdAt)
}

export async function addCards(notebookId: string, pairs: Array<{ front: string; back: string }>, now = Date.now()): Promise<Card[]> {
  const cards = pairs
    .map((p) => ({ front: p.front.trim(), back: p.back.trim() }))
    .filter((p) => p.front && p.back)
    .map((p, i): Card => ({ id: newId(), notebookId, front: p.front, back: p.back, box: 1, due: now, createdAt: now + i, updatedAt: now + i, deletedAt: null }))
  if (cards.length) await save({ cards })
  return cards
}

export function graded(card: Card, knew: boolean, now = Date.now()): Card {
  const box = knew ? Math.min(5, card.box + 1) : 1
  return { ...card, box, due: now + WAIT[box]!, updatedAt: now }
}

export async function gradeCard(card: Card, knew: boolean, now = Date.now()): Promise<Card> {
  const next = graded(card, knew, now)
  await save({ cards: [next] })
  return next
}

export async function deleteCard(card: Card, now = Date.now()): Promise<void> {
  await save({ cards: [{ ...card, deletedAt: now, updatedAt: now }] })
}

/** The cards to study now: due ones first (lowest box first), then a few not yet due if none are. */
export function studyOrder(cards: Card[], now = Date.now()): Card[] {
  const due = cards.filter((c) => c.due <= now).sort((a, b) => a.box - b.box || a.due - b.due)
  return due.length ? due : [...cards].sort((a, b) => a.due - b.due).slice(0, 10)
}
