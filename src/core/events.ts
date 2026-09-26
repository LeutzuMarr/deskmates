import type { CoreEvent } from '../shared/protocol'

export type CoreEventListener = (event: CoreEvent) => void

export class EventBus {
  private readonly listeners = new Set<CoreEventListener>()

  on(listener: CoreEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: CoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[core] event listener failed', error)
      }
    }
  }
}
