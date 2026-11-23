/**
 * Undo and redo. Each step records what the touched items were before and after; null means "not
 * there". Undoing puts the "before" back, so drawing, erasing, moving and recolouring all undo the
 * same way.
 */
import type { Item } from '../model'

export interface Change {
  id: string
  before: Item | null
  after: Item | null
}

export type Step = Change[]

const LIMIT = 200

export class History {
  private done: Step[] = []
  private undone: Step[] = []

  push(step: Step): void {
    if (step.length === 0) return
    this.done.push(step)
    if (this.done.length > LIMIT) this.done.shift()
    this.undone = []
  }

  /** The changes to apply to undo, or null when there's nothing to undo. */
  undo(): Array<{ id: string; state: Item | null; previous: Item | null }> | null {
    const step = this.done.pop()
    if (!step) return null
    this.undone.push(step)
    return step.map((c) => ({ id: c.id, state: c.before, previous: c.after }))
  }

  redo(): Array<{ id: string; state: Item | null; previous: Item | null }> | null {
    const step = this.undone.pop()
    if (!step) return null
    this.done.push(step)
    return step.map((c) => ({ id: c.id, state: c.after, previous: c.before }))
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }

  clear(): void {
    this.done = []
    this.undone = []
  }
}
