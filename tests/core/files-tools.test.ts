import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileTools } from '../../src/core/tools/files'
import { makeTestContext, runTool, type TestContext } from './helpers'

let t: TestContext
let tools: ReturnType<typeof fileTools>

beforeEach(() => {
  t = makeTestContext()
  tools = fileTools(t.ctx)
})
afterEach(() => t.cleanup())

describe('list_files', () => {
  it('lists files and folders and does not descend into node_modules', async () => {
    mkdirSync(join(t.root, 'docs'))
    writeFileSync(join(t.root, 'docs', 'a.md'), 'hello')
    mkdirSync(join(t.root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(t.root, 'node_modules', 'pkg', 'x.js'), 'x')
    const result = await runTool(tools.list_files, { path: '.', depth: 3 })
    const paths = result.entries.map((e: { path: string }) => e.path)
    expect(paths).toContain('docs/')
    expect(paths).toContain('docs/a.md')
    expect(paths).toContain('node_modules/')
    expect(paths).not.toContain('node_modules/pkg/x.js')
  })
})

describe('read_file', () => {
  it('reads a slice of lines', async () => {
    writeFileSync(join(t.root, 'a.txt'), 'one\ntwo\nthree\nfour')
    const result = await runTool(tools.read_file, { path: 'a.txt', offset: 2, limit: 2 })
    expect(result).toMatchObject({ totalLines: 4, startLine: 2, endLine: 3, content: 'two\nthree' })
  })

  it('reads only the first 256 KB of a large file and reports the truncation', async () => {
    const MAX_READ_BYTES = 256 * 1024
    writeFileSync(join(t.root, 'big.txt'), 'a'.repeat(3 * 1024 * 1024))
    const result = await runTool(tools.read_file, { path: 'big.txt' })
    expect(result.cutAtBytes).toBe(MAX_READ_BYTES)
    expect(result.content).toBe('a'.repeat(MAX_READ_BYTES))
    expect(result.totalLines).toBe(1)
  })

  it('refuses binary files', async () => {
    writeFileSync(join(t.root, 'b.bin'), Buffer.from([1, 0, 2, 3]))
    expect(await runTool(tools.read_file, { path: 'b.bin' })).toMatchObject({ binary: true })
  })
})

describe('write_file', () => {
  it('creates folders and records a create, then a modify', async () => {
    const created = await runTool(tools.write_file, { path: 'out/report.md', content: '# Hi' })
    expect(created).toMatchObject({ path: 'out/report.md', created: true })
    expect(readFileSync(join(t.root, 'out', 'report.md'), 'utf8')).toBe('# Hi')
    await runTool(tools.write_file, { path: 'out/report.md', content: '# Hello' })
    expect(t.repos.changes.list(t.taskId).map((c) => c.kind)).toEqual(['create', 'modify'])
    expect(t.events.changes).toBe(2)
  })
})

describe('edit_file', () => {
  it('replaces unique text', async () => {
    writeFileSync(join(t.root, 'a.txt'), 'alpha beta gamma')
    const result = await runTool(tools.edit_file, { path: 'a.txt', old_text: 'beta', new_text: 'BETA' })
    expect(result.replacements).toBe(1)
    expect(readFileSync(join(t.root, 'a.txt'), 'utf8')).toBe('alpha BETA gamma')
  })

  it('explains when the text is missing or ambiguous', async () => {
    writeFileSync(join(t.root, 'a.txt'), 'x x')
    await expect(runTool(tools.edit_file, { path: 'a.txt', old_text: 'y', new_text: 'z' })).rejects.toThrow(/not found/)
    await expect(runTool(tools.edit_file, { path: 'a.txt', old_text: 'x', new_text: 'z' })).rejects.toThrow(/2 times/)
    await runTool(tools.edit_file, { path: 'a.txt', old_text: 'x', new_text: 'z', replace_all: true })
    expect(readFileSync(join(t.root, 'a.txt'), 'utf8')).toBe('z z')
  })

  it('matches text in files with Windows line endings', async () => {
    writeFileSync(join(t.root, 'w.txt'), 'line one\r\nline two\r\n')
    await runTool(tools.edit_file, { path: 'w.txt', old_text: 'line one\nline two', new_text: 'a\nb' })
    expect(readFileSync(join(t.root, 'w.txt'), 'utf8')).toBe('a\r\nb\r\n')
  })

  it('keeps dollar signs in the new text literally', async () => {
    writeFileSync(join(t.root, 'p.txt'), 'price: X')
    await runTool(tools.edit_file, { path: 'p.txt', old_text: 'X', new_text: '$& $1' })
    expect(readFileSync(join(t.root, 'p.txt'), 'utf8')).toBe('price: $& $1')
  })
})

describe('move_path and delete_path', () => {
  it('moves a file and refuses to overwrite', async () => {
    writeFileSync(join(t.root, 'a.txt'), 'a')
    writeFileSync(join(t.root, 'b.txt'), 'b')
    await expect(runTool(tools.move_path, { from: 'a.txt', to: 'b.txt' })).rejects.toThrow(/already exists/)
    await runTool(tools.move_path, { from: 'a.txt', to: 'archive/a.txt' })
    expect(existsSync(join(t.root, 'archive', 'a.txt'))).toBe(true)
    expect(t.repos.changes.list(t.taskId)[0]).toMatchObject({ kind: 'move', path: 'a.txt', movedTo: 'archive/a.txt' })
  })

  it('deletes files and empty folders but not full folders or the project itself', async () => {
    writeFileSync(join(t.root, 'a.txt'), 'a')
    mkdirSync(join(t.root, 'full'))
    writeFileSync(join(t.root, 'full', 'x.txt'), 'x')
    mkdirSync(join(t.root, 'empty'))
    await runTool(tools.delete_path, { path: 'a.txt' })
    await runTool(tools.delete_path, { path: 'empty' })
    expect(existsSync(join(t.root, 'a.txt'))).toBe(false)
    expect(existsSync(join(t.root, 'empty'))).toBe(false)
    await expect(runTool(tools.delete_path, { path: 'full' })).rejects.toThrow(/empty folders/)
    await expect(runTool(tools.delete_path, { path: '.' })).rejects.toThrow(/project folder itself/)
  })
})

describe('search_files', () => {
  it('finds text case-insensitively, filters by file name and skips binaries', async () => {
    writeFileSync(join(t.root, 'a.md'), 'Budget 2026\nnothing')
    writeFileSync(join(t.root, 'b.txt'), 'budget notes')
    writeFileSync(join(t.root, 'c.bin'), Buffer.from([0, 98, 117, 100, 103, 101, 116]))
    const all = await runTool(tools.search_files, { query: 'budget' })
    expect(all.matches.map((m: { path: string }) => m.path).sort()).toEqual(['a.md', 'b.txt'])
    const onlyMd = await runTool(tools.search_files, { query: 'budget', file_pattern: '.md' })
    expect(onlyMd.matches).toEqual([{ path: 'a.md', line: 1, text: 'Budget 2026' }])
  })
})

describe('project boundary', () => {
  it('rejects paths outside the project folder', async () => {
    await expect(runTool(tools.read_file, { path: '../secret.txt' })).rejects.toThrow(/outside the project/)
    await expect(runTool(tools.write_file, { path: 'C:\\Windows\\x.txt', content: 'x' })).rejects.toThrow(/outside the project/)
  })
})
