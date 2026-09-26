import { mkdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** Only UUID-shaped first segments are project ids; everything else is ignored. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Temp files (including the core's index.html.tmp-<uuid>) are never reported. */
function isTempFile(base: string): boolean {
  return base.startsWith('~') || base.startsWith('.') || base.toLowerCase().includes('.tmp')
}

/**
 * Watches <dataDir>/designs for external edits of a design's index.html, so
 * agents can change designs with their own file tools and the preview still
 * reloads. The core's own writes are suppressed via noteOwnWrite, and designs
 * the assistant is working on are skipped through isBusy.
 */
export class DesignWatcher {
  private readonly root: string
  private readonly onExternalChange: (projectId: string, updatedAt: number) => void
  private readonly isBusy?: (projectId: string) => boolean
  private readonly debounceMs: number
  private watcher: FSWatcher | null = null
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastOwnWrite = new Map<string, number>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: {
    root: string
    onExternalChange: (projectId: string, updatedAt: number) => void
    isBusy?: (projectId: string) => boolean
    debounceMs?: number
  }) {
    this.root = options.root
    this.onExternalChange = options.onExternalChange
    this.isBusy = options.isBusy
    this.debounceMs = options.debounceMs ?? 300
  }

  /** Creates the designs folder if missing and starts watching it recursively. */
  start(): void {
    this.stopped = false
    try {
      mkdirSync(this.root, { recursive: true })
    } catch {
      // A read-only or missing parent: the retry loop below keeps trying.
    }
    this.open()
  }

  private open(): void {
    if (this.stopped) return
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        this.handleChange(filename)
      })
      this.watcher.on('error', () => this.scheduleReopen())
    } catch {
      this.scheduleReopen()
    }
  }

  /** If the folder was deleted (or the watcher died), watch again once it's back. */
  private scheduleReopen(): void {
    if (this.stopped || this.retryTimer) return
    this.closeWatcher()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, 500)
    this.retryTimer.unref?.()
  }

  /** Handles one fs.watch event; never throws out of the callback. */
  private handleChange(filename: string | null): void {
    try {
      if (this.stopped || filename === null) return
      const segments = filename.split(/[\\/]+/)
      const projectId = segments[0]
      if (!UUID_PATTERN.test(projectId)) return
      if (!segments[segments.length - 1].toLowerCase().startsWith('index.html')) return
      if (isTempFile(segments[segments.length - 1])) return

      // Restart the per-project debounce on every event.
      const pending = this.timers.get(projectId)
      if (pending) clearTimeout(pending)
      const timer = setTimeout(() => {
        this.timers.delete(projectId)
        this.report(projectId)
      }, this.debounceMs)
      timer.unref?.()
      this.timers.set(projectId, timer)
    } catch {
      // Watching must never crash the core, whatever the event contains.
    }
  }

  /** After the debounce: stat index.html and report it unless suppressed. */
  private report(projectId: string): void {
    try {
      let mtimeMs: number
      try {
        mtimeMs = statSync(join(this.root, projectId, 'index.html')).mtimeMs
      } catch {
        return
      }
      if (this.lastOwnWrite.get(projectId) === mtimeMs) return
      if (this.isBusy?.(projectId)) return
      this.onExternalChange(projectId, mtimeMs)
    } catch {
      // See handleChange.
    }
  }

  /**
   * Records that the core itself wrote index.html for this project at this
   * mtime, so the resulting watcher events don't report it as an external edit.
   */
  noteOwnWrite(projectId: string, mtimeMs: number): void {
    this.lastOwnWrite.set(projectId, mtimeMs)
  }

  /** Closes the watcher and clears every timer. Safe to call twice. */
  stop(): void {
    this.stopped = true
    this.closeWatcher()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private closeWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // Already closed when the watched folder was deleted.
      }
      this.watcher = null
    }
  }
}
