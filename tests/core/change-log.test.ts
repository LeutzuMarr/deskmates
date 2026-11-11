import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeLog } from '../../src/core/fs/change-log'
import { PathOutsideProjectError, resolveInside, toProjectRelative } from '../../src/core/fs/safe-path'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'

let base: string
let root: string
let repos: Repos
let log: ChangeLog
let taskId: string

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-')))
  root = join(base, 'project')
  mkdirSync(root)
  repos = createRepos(openDatabase(':memory:'))
  const project = repos.projects.create('P', root)
  taskId = repos.tasks.create(project.id).id
  log = new ChangeLog(repos.changes, join(base, 'snapshots'))
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('resolveInside', () => {
  it('accepts paths inside the project', () => {
    expect(resolveInside(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'))
    expect(resolveInside(root, '.')).toBe(root)
    expect(resolveInside(root, join(root, 'x.md'))).toBe(join(root, 'x.md'))
  })

  it('rejects paths that leave the project', () => {
    expect(() => resolveInside(root, '../outside.txt')).toThrow(PathOutsideProjectError)
    expect(() => resolveInside(root, 'C:\\Windows\\win.ini')).toThrow(PathOutsideProjectError)
    expect(() => resolveInside(root, 'a/../../x')).toThrow(PathOutsideProjectError)
  })

  it('allows names that merely start with two dots', () => {
    expect(resolveInside(root, '..notes.txt')).toBe(join(root, '..notes.txt'))
  })

  it('rejects junctions that point outside the project', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'link'), 'junction')
    expect(() => resolveInside(root, 'link/secret.txt')).toThrow(PathOutsideProjectError)
  })

  it('makes project-relative paths with forward slashes', () => {
    expect(toProjectRelative(root, join(root, 'a', 'b.txt'))).toBe('a/b.txt')
    expect(toProjectRelative(root, root)).toBe('.')
  })
})

describe('ChangeLog', () => {
  const file = () => join(root, 'notes', 'a.txt')

  it('undoes a created file by removing it', () => {
    mkdirSync(join(root, 'notes'))
    log.record(taskId, root, file(), 'create')
    writeFileSync(file(), 'new')
    const [change] = repos.changes.list(taskId)
    expect(change).toMatchObject({ path: 'notes/a.txt', kind: 'create', undone: false })
    log.undo(change!.id)
    expect(existsSync(file())).toBe(false)
    expect(repos.changes.list(taskId)[0]!.undone).toBe(true)
  })

  it('undoes a modification by restoring the old content', () => {
    mkdirSync(join(root, 'notes'))
    writeFileSync(file(), 'old')
    const change = log.record(taskId, root, file(), 'modify')
    writeFileSync(file(), 'new')
    log.undo(change.id)
    expect(readFileSync(file(), 'utf8')).toBe('old')
  })

  it('undoes a deleted file and a deleted empty folder', () => {
    mkdirSync(join(root, 'notes'))
    writeFileSync(file(), 'keep me')
    const fileChange = log.record(taskId, root, file(), 'delete')
    rmSync(file())
    log.undo(fileChange.id)
    expect(readFileSync(file(), 'utf8')).toBe('keep me')

    const folder = join(root, 'empty')
    mkdirSync(folder)
    const folderChange = log.record(taskId, root, folder, 'delete')
    rmdirSync(folder)
    log.undo(folderChange.id)
    expect(existsSync(folder)).toBe(true)
  })

  it('undoes a move by moving the file back', () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    const change = log.record(taskId, root, join(root, 'a.txt'), 'move', join(root, 'b.txt'))
    expect(change.movedTo).toBe('b.txt')
    renameSync(join(root, 'a.txt'), join(root, 'b.txt'))
    log.undo(change.id)
    expect(existsSync(join(root, 'a.txt'))).toBe(true)
    expect(existsSync(join(root, 'b.txt'))).toBe(false)
  })

  it('undoes everything in reverse order', () => {
    writeFileSync(join(root, 'a.txt'), 'v1')
    log.record(taskId, root, join(root, 'a.txt'), 'modify')
    writeFileSync(join(root, 'a.txt'), 'v2')
    log.record(taskId, root, join(root, 'a.txt'), 'modify')
    writeFileSync(join(root, 'a.txt'), 'v3')
    log.undoAll(taskId)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1')
    expect(repos.changes.list(taskId).every((c) => c.undone)).toBe(true)
  })
})

describe('ChangeLog.stats', () => {
  const file = (name: string) => join(root, name)

  it('counts lines added and removed against the file as it was before the task', () => {
    writeFileSync(file('a.txt'), 'one\ntwo\nthree\n')
    log.record(taskId, root, file('a.txt'), 'modify')
    writeFileSync(file('a.txt'), 'one\n2\nthree\nfour\n')
    // A second edit of the same file still compares against the first snapshot.
    log.record(taskId, root, file('a.txt'), 'modify')
    writeFileSync(file('a.txt'), 'one\n2\nthree\nfour\nfive\n')

    log.record(taskId, root, file('new.txt'), 'create')
    writeFileSync(file('new.txt'), 'a\nb\n')

    expect(log.stats(taskId)).toEqual({ added: 5, removed: 1, files: 2 })
  })

  it('counts a deleted file as removed lines and leaves undone changes out', () => {
    writeFileSync(file('gone.txt'), 'x\ny\nz')
    log.record(taskId, root, file('gone.txt'), 'delete')
    rmSync(file('gone.txt'))
    const created = log.record(taskId, root, file('made.txt'), 'create')
    writeFileSync(file('made.txt'), 'hello\n')
    expect(log.stats(taskId)).toEqual({ added: 1, removed: 3, files: 2 })

    log.undo(created.id)
    expect(log.stats(taskId)).toEqual({ added: 0, removed: 3, files: 1 })
  })

  it('counts a file that is not text as changed without counting lines', () => {
    writeFileSync(file('img.bin'), Buffer.from([0, 1, 2, 0, 3]))
    log.record(taskId, root, file('img.bin'), 'modify')
    writeFileSync(file('img.bin'), Buffer.from([9, 0, 9]))
    expect(log.stats(taskId)).toEqual({ added: 0, removed: 0, files: 1 })
  })

  it('is empty for a task that changed nothing', () => {
    expect(log.stats(taskId)).toEqual({ added: 0, removed: 0, files: 0 })
  })
})
