import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignWatcher } from '../../src/core/designs/watcher'

const ID = '5f0b3c2e-1a4b-4c8d-9e2f-3a1b2c3d4e5f'
const OTHER_ID = 'a1b2c3d4-e5f6-4789-8a0b-c1d2e3f4a5b6'
const DEBOUNCE_MS = 120
const WAIT_MS = 1500

let root: string
let changes: Array<{ projectId: string; updatedAt: number }>
let watcher: DesignWatcher | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deskmates-watcher-'))
  changes = []
})

afterEach(() => {
  watcher?.stop()
  watcher = null
  rmSync(root, { recursive: true, force: true })
})

function startWatcher(options?: { isBusy?: (projectId: string) => boolean }): DesignWatcher {
  watcher = new DesignWatcher({
    root,
    onExternalChange: (projectId, updatedAt) => changes.push({ projectId, updatedAt }),
    isBusy: options?.isBusy,
    debounceMs: DEBOUNCE_MS
  })
  watcher.start()
  return watcher
}

function writeIndex(id: string, html: string): void {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'index.html'), html, 'utf8')
}

function waitForCount(count: number): Promise<void> {
  return vi.waitFor(() => {
    expect(changes.length).toBeGreaterThanOrEqual(count)
  }, { timeout: WAIT_MS })
}

/** Resolves after `ms`, so a test can prove nothing happened. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('DesignWatcher', () => {
  it('reports an external write once, debounced', async () => {
    startWatcher()
    writeIndex(ID, '<p>one</p>')
    await waitForCount(1)

    // Two writes inside the debounce window collapse into one event.
    const before = changes.length
    writeIndex(ID, '<p>two</p>')
    writeIndex(ID, '<p>three</p>')
    await waitForCount(before + 1)
    await sleep(DEBOUNCE_MS * 2)
    expect(changes.length).toBe(before + 1)
    expect(changes[0].projectId).toBe(ID)
    expect(typeof changes[0].updatedAt).toBe('number')
  })

  it('ignores an own write', async () => {
    writeIndex(ID, '<p>seed</p>')
    const w = startWatcher()
    await sleep(400) // Let the initial-state events settle before the test proper.
    changes.length = 0

    writeIndex(ID, '<p>the core wrote this</p>')
    const { statSync } = await import('node:fs')
    const mtime = statSync(join(root, ID, 'index.html')).mtimeMs
    w.noteOwnWrite(ID, mtime)

    await sleep(1000)
    expect(changes).toEqual([])
  })

  it('ignores a design the assistant is busy on', async () => {
    startWatcher({ isBusy: (projectId) => projectId === ID })
    writeIndex(ID, '<p>busy</p>')
    await sleep(1200)
    expect(changes).toEqual([])
  })

  it('ignores non-UUID folders', async () => {
    startWatcher()
    writeIndex('not-a-uuid', '<p>x</p>')
    writeIndex(join('nested', 'deep', 'path'), '<p>x</p>')
    await sleep(1200)
    expect(changes).toEqual([])
  })

  it('ignores temp files', async () => {
    startWatcher()
    writeIndex(ID, '<p>keep</p>')
    await waitForCount(1)
    changes.length = 0

    writeFileSync(join(root, ID, 'index.html.tmp-abc'), '<p>temp</p>', 'utf8')
    writeFileSync(join(root, ID, '~draft.html'), '<p>temp</p>', 'utf8')
    writeFileSync(join(root, ID, '.hidden.html'), '<p>temp</p>', 'utf8')
    await sleep(1000)
    expect(changes).toEqual([])
  })

  it('stops reporting after stop()', async () => {
    startWatcher().stop()
    writeIndex(ID, '<p>after stop</p>')
    await sleep(1000)
    expect(changes).toEqual([])
  })

  it('reports each project separately', async () => {
    startWatcher()
    writeIndex(ID, '<p>a</p>')
    writeIndex(OTHER_ID, '<p>b</p>')
    await waitForCount(2)
    const ids = changes.map((change) => change.projectId).sort()
    expect(ids).toEqual([ID, OTHER_ID].sort())
  })
})
