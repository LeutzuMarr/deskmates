/**
 * The handle returned by `installEditor`.
 */
export interface EditorHandle {
  /** Removes every listener, the overlay and all timers. */
  destroy(): void
  /** The doctype (when present) plus the cleaned <html> markup, with `data-dm-id` kept. */
  serialize(): string
  /** Selects the element with the given `data-dm-id`, or deselects when it doesn't exist. */
  selectById(id: string): void
}

/**
 * Installs the editor into `win` (the design page's window) and returns a handle.
 */
export function installEditor(win: Window & typeof globalThis): EditorHandle