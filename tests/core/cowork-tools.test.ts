import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coworkTools, globToRegExp, nativePath, searchTools } from '../../src/core/tools/cowork'
import { applyEdits, designTools } from '../../src/core/tools/design'
import { parseSearchResults, htmlToText } from '../../src/core/tools/web'
import { buildTools } from '../../src/core/tools'
import { approvalFor } from '../../src/core/engine/approvals'
import { makeTestContext, runTool, type TestContext } from './helpers'

let t: TestContext
afterEach(() => t?.cleanup())

describe('Claude Code-style tools for the Work tab', () => {
  it('reads with line numbers, writes, and edits files, all undoable', async () => {
    t = makeTestContext()
    const tools = coworkTools(t.ctx)
    expect(await runTool(tools.Write, { file_path: join(t.root, 'notes', 'a.md'), content: 'one\ntwo\nthree' })).toMatch(/^Created notes\/a.md/)
    expect(await runTool(tools.Read, { file_path: 'notes/a.md' })).toBe('1\tone\n2\ttwo\n3\tthree')
    expect(await runTool(tools.Read, { file_path: 'notes/a.md', offset: 2, limit: 1 })).toBe('2\ttwo\n[1 more lines; use offset to read on]')
    expect(await runTool(tools.Edit, { file_path: 'notes/a.md', old_string: 'two', new_string: 'TWO' })).toBe('Edited notes/a.md (1 replacement)')
    expect(readFileSync(join(t.root, 'notes', 'a.md'), 'utf8')).toBe('one\nTWO\nthree')
    expect(t.repos.changes.list(t.taskId).length).toBe(2)
    await expect(runTool(tools.Read, { file_path: 'C:/Windows/win.ini' })).rejects.toThrow(/outside the project/)
  })

  it('globs and greps like the originals', async () => {
    t = makeTestContext()
    mkdirSync(join(t.root, 'src'))
    writeFileSync(join(t.root, 'src', 'app.ts'), 'const x = 1\n// TODO fix\nexport {}\n')
    writeFileSync(join(t.root, 'src', 'notes.md'), 'todo: nothing\n')
    const tools = coworkTools(t.ctx)
    expect(await runTool<string>(tools.Glob, { pattern: '**/*.ts' })).toBe(join(t.root, 'src', 'app.ts'))
    expect(await runTool<string>(tools.Grep, { pattern: 'todo', '-i': true })).toContain('app.ts')
    const content = await runTool<string>(tools.Grep, { pattern: 'TODO', output_mode: 'content', '-B': 1, type: 'ts' })
    expect(content).toContain(':1:const x = 1')
    expect(content).toContain(':2:// TODO fix')
    expect(await runTool<string>(tools.Grep, { pattern: 'todo', '-i': true, output_mode: 'count', glob: '*.md' })).toMatch(/notes\.md:1$/)
  })

  it('asks the user before running shell commands, workflows and scripts', () => {
    for (const name of ['Bash', 'Workflow', 'delete_file', 'run_script']) expect(approvalFor(name, [])).toBe('user-approval')
    expect(approvalFor('Read', [])).toBeUndefined()
  })

  it('shares files as cards and schedules wake-ups through the runner', async () => {
    t = makeTestContext()
    writeFileSync(join(t.root, 'report.pdf'), 'x')
    const wakeups: Array<[number, string]> = []
    t.ctx.scheduleWakeup = (ms, prompt) => void wakeups.push([ms, prompt])
    const tools = coworkTools(t.ctx)
    expect(await runTool(tools.SendUserFile, { files: ['report.pdf'], status: 'normal' })).toMatchObject({
      files: [{ path: 'report.pdf', absolutePath: join(t.root, 'report.pdf') }]
    })
    await expect(runTool(tools.SendUserFile, { files: ['missing.txt'], status: 'normal' })).rejects.toThrow(/Not found/)
    expect(await runTool(tools.ScheduleWakeup, { delaySeconds: 5, prompt: 'check again' })).toEqual({ scheduled: true, inSeconds: 60 })
    expect(wakeups).toEqual([[60_000, 'check again']])
  })

  it('gives design and work projects their own tool families, searchable by name', () => {
    t = makeTestContext()
    const work = buildTools({ ...t.ctx, projectKind: 'work' })
    const design = buildTools({ ...t.ctx, projectKind: 'design' })
    expect(Object.keys(work)).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'AskUserQuestion', 'ToolSearch']))
    expect(Object.keys(work)).not.toContain('str_replace_edit')
    expect(Object.keys(design)).toEqual(expect.arrayContaining(['grep', 'str_replace_edit', 'copy_files', 'update_todos', 'web_fetch', 'ask_user']))
    expect(Object.keys(design)).not.toContain('Bash')
    const listing = Object.entries(work).map(([name, tool]) => ({ name, description: String((tool as { description?: string }).description) }))
    expect(searchTools(listing, 'select:Read,Glob', 5).map((x) => x.name)).toEqual(['Read', 'Glob'])
    expect(searchTools(listing, 'grep', 3)[0].name).toBe('Grep')
  })

  it('translates POSIX drive paths and matches globs', () => {
    expect(nativePath('/c/Users/David/x.txt')).toBe('C:/Users/David/x.txt')
    expect(nativePath('src/a.ts')).toBe('src/a.ts')
    expect(nativePath('/mnt/user-data/uploads/brief.pdf')).toBe('brief.pdf')
    expect(nativePath('/mnt/user-data/outputs/report/final.md')).toBe('report/final.md')
    expect(nativePath('computer:///home/claude/notes.txt')).toBe('notes.txt')
    expect(nativePath('/home/claude')).toBe('.')
    expect(globToRegExp('*.ts').test('src/app.ts')).toBe(true)
    expect(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b/c.tsx')).toBe(true)
    expect(globToRegExp('src/*.ts').test('lib/app.ts')).toBe(false)
  })
})

describe('Design tools', () => {
  it('applies several exact replacements atomically, or none', () => {
    expect(applyEdits('a b c', [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }])).toBe('A b C')
    expect(() => applyEdits('a b a', [{ old_string: 'a', new_string: 'x' }])).toThrow(/appears 2 times/)
    expect(() => applyEdits('a b', [{ old_string: 'b', new_string: 'B' }, { old_string: 'z', new_string: 'Z' }])).toThrow(/Edit 2/)
  })

  it('edits, copies, moves and deletes files in the design folder with undo records', async () => {
    t = makeTestContext()
    writeFileSync(join(t.root, 'index.html'), '<h1>Hi</h1><p>There</p>')
    const tools = designTools(t.ctx)
    await runTool(tools.str_replace_edit, { path: 'index.html', edits: [{ old_string: 'Hi', new_string: 'Hello' }, { old_string: 'There', new_string: 'World' }] })
    expect(readFileSync(join(t.root, 'index.html'), 'utf8')).toBe('<h1>Hello</h1><p>World</p>')
    await runTool(tools.copy_files, { files: [{ src: 'index.html', dest: 'v2/index.html' }] })
    await runTool(tools.copy_files, { files: [{ src: 'v2', dest: 'v3', move: true }] })
    expect(existsSync(join(t.root, 'v3', 'index.html'))).toBe(true)
    expect(existsSync(join(t.root, 'v2'))).toBe(false)
    expect(await runTool(tools.delete_file, { paths: ['v3'] })).toEqual({ deleted: ['v3'], files: 1 })
    expect(existsSync(join(t.root, 'v3'))).toBe(false)
    expect(t.repos.changes.list(t.taskId).length).toBeGreaterThanOrEqual(5)
  })

  it('keeps a to-do list in the plan panel and renames the design', async () => {
    t = makeTestContext()
    const renames: string[] = []
    t.ctx.renameProject = (title) => void renames.push(title)
    const tools = designTools(t.ctx)
    await runTool(tools.update_todos, { operations: [{ type: 'add', name: 'Sketch layout' }, { type: 'add', name: 'Pick colours' }] })
    await runTool(tools.update_todos, { operations: [{ type: 'complete', name: 'Sketch layout' }] })
    expect(t.events.plans.at(-1)).toEqual([
      { text: 'Sketch layout', status: 'done' },
      { text: 'Pick colours', status: 'in_progress' }
    ])
    await runTool(tools.set_project_title, { title: 'Bean There' })
    expect(renames).toEqual(['Bean There'])
  })

  it('says plainly what Deskmates does not have', async () => {
    t = makeTestContext()
    const tools = designTools(t.ctx)
    await expect(runTool(tools.local_ls, { path: '.' })).rejects.toThrow(/No local folder is mounted/)
    await expect(runTool(tools.fig_ls, {})).rejects.toThrow(/No \.fig file/)
    expect(await runTool(tools.get_comments, {})).toMatchObject({ comments: [] })
  })

  it('runs batch scripts against the design folder only', async () => {
    t = makeTestContext()
    writeFileSync(join(t.root, 'a.txt'), 'one')
    const tools = designTools(t.ctx)
    const out = await runTool(tools.run_script, { code: "const a = await readFile('a.txt'); await writeFile('b.txt', a.toUpperCase()); log('done'); return (await listFiles()).length" })
    expect(out).toEqual({ result: 2, logs: ['done'] })
    expect(readFileSync(join(t.root, 'b.txt'), 'utf8')).toBe('ONE')
    await expect(runTool(tools.run_script, { code: "await readFile('../outside.txt')" })).rejects.toThrow(/outside the project/)
  })
})

describe('web helpers', () => {
  it('reads DuckDuckGo results and page text', () => {
    const html = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example <b>A</b></a><a class="result__snippet" href="#">An &amp; example</a></div>`
    expect(parseSearchResults(html)).toEqual([{ title: 'Example A', url: 'https://example.com/a', snippet: 'An & example' }])
    expect(htmlToText('<title>T</title><style>x{}</style><h1>Hi</h1><p>One &amp; two</p><script>bad()</script>')).toEqual({ title: 'T', text: 'Hi\nOne & two' })
  })
})
