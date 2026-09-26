import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { EventBus } from '../../src/core/events'
import { ChangeLog } from '../../src/core/fs/change-log'
import { TaskRunner } from '../../src/core/engine/runner'
import { KeyStore } from '../../src/core/models/keys'
import { ModelService } from '../../src/core/models/providers'
import { createHandlers } from '../../src/core/server/handlers'
import type { HandlerContext } from '../../src/core/server/rpc-server'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import { buildTools } from '../../src/core/tools'
import { MAX_DESIGN_HTML_BYTES, type CoreEvent, type RpcMethod } from '../../src/shared/protocol'

type TestApi = Record<RpcMethod, (params: any, context?: HandlerContext) => any>
type ModelResolverStub = { resolve: () => { model: MockLanguageModelV4; provider: 'google'; modelId: string } }

interface Fixture {
  db: DatabaseSync
  base: string
  repos: Repos
  events: CoreEvent[]
  runner: TaskRunner
  api: TestApi
  designWrites: Array<{ projectId: string; updatedAt: number }>
  cleanup(): void
}

const textChunks = (delta = 'done') =>
  [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
  ] as any[]

/** Streams a plain text reply only. */
const textOnly = (): ModelResolverStub => ({
  resolve: () => ({
    model: new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks() }) }) }),
    provider: 'google',
    modelId: 'test-model'
  })
})

/** First call streams a write_file tool call; later calls stream a plain text reply. */
const writeThenText = (target: { path: string; content: string }): ModelResolverStub => {
  let callCount = 0
  return {
    resolve: () => ({
      model: new MockLanguageModelV4({
        doStream: async () => {
          callCount++
          if (callCount === 1) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  {
                    type: 'tool-call',
                    toolCallId: 'c1',
                    toolName: 'write_file',
                    input: JSON.stringify(target)
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }
                  }
                ] as any[]
              })
            }
          }
          return { stream: simulateReadableStream({ chunks: textChunks() }) }
        }
      }),
      provider: 'google',
      modelId: 'test-model'
    })
  }
}

let fixtures: Fixture[] = []

function makeFixture(models?: ModelResolverStub): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-designs-')))
  const db = openDatabase(':memory:')
  const repos = createRepos(db)
  const bus = new EventBus()
  const keys = new KeyStore()
  const modelService = new ModelService(keys, () => repos.settings.get())
  const changes = new ChangeLog(repos.changes, join(base, 'snapshots'))
  const runner = new TaskRunner({ repos, bus, models: models ?? textOnly(), changes, createTools: buildTools })
  const designWrites: Array<{ projectId: string; updatedAt: number }> = []
  const handlers = createHandlers({
    repos,
    bus,
    runner,
    changes,
    models: modelService,
    keys,
    version: '0.1.0',
    dataDir: base,
    agentKit: {
      guidePath: join(base, 'agent-kit', 'DESKMATES-AGENTS.md'),
      commandPath: join(base, 'agent-kit', 'deskmates.cmd')
    },
    onDesignWritten: (projectId, updatedAt) => designWrites.push({ projectId, updatedAt })
  })

  const events: CoreEvent[] = []
  bus.on((event) => events.push(event))

  const fixture: Fixture = {
    db,
    base,
    repos,
    events,
    runner,
    api: handlers as unknown as TestApi,
    designWrites,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db?.close()
    fixture.cleanup()
  }
})

const designFolder = (f: Fixture, id: string): string => join(f.base, 'designs', id)

describe('designs.create', () => {
  it('creates the folder with starter html, a design project and one task', async () => {
    const f = makeFixture()

    const result = await f.api['designs.create']({ name: 'Landing <Page> & Co' })
    expect(result.project.kind).toBe('design')
    expect(result.project.folder).toBe(designFolder(f, result.project.id))

    const file = join(result.project.folder, 'index.html')
    expect(existsSync(file)).toBe(true)
    const html = readFileSync(file, 'utf8')
    expect(html).toContain('<title>Landing &lt;Page&gt; &amp; Co</title>')
    expect(html).toContain('<h1>Landing &lt;Page&gt; &amp; Co</h1>')
    expect(html).toContain('Describe your design in the chat, or click anything here to edit it.')
    expect(html).toContain('<!doctype html>')

    expect(f.repos.tasks.list(result.project.id)).toHaveLength(1)
    expect(f.events.some((e) => e.type === 'project.updated' && e.project.id === result.project.id)).toBe(true)
    expect(f.events.some((e) => e.type === 'task.updated' && e.task.id === result.task.id)).toBe(true)
  })

  it('with a prompt, the task runs with the trimmed prompt', async () => {
    const f = makeFixture()

    const result = await f.api['designs.create']({ name: 'Poster', prompt: '  Make it blue  ' })
    await f.runner.whenIdle(result.task.id)

    const { task, timeline } = await f.api['tasks.get']({ id: result.task.id })
    expect(task.status).toBe('idle')
    expect(timeline[0]).toMatchObject({ kind: 'user', text: 'Make it blue' })
    expect(timeline[timeline.length - 1].kind).toBe('assistant')
  })

  it('rejects an empty or over-long name', async () => {
    const f = makeFixture()

    await expect(f.api['designs.create']({ name: '   ' })).rejects.toThrow(
      'Give the design a name (up to 120 characters).'
    )
    await expect(f.api['designs.create']({ name: 'x'.repeat(121) })).rejects.toThrow(
      'Give the design a name (up to 120 characters).'
    )
  })
})

describe('designs.read and designs.save', () => {
  it('round trips html and emits design.updated with source editor', async () => {
    const f = makeFixture()
    const { project } = await f.api['designs.create']({ name: 'Round' })

    const read1 = await f.api['designs.read']({ projectId: project.id })
    expect(read1.html).toContain('Round')
    expect(typeof read1.updatedAt).toBe('number')

    const saved = '<!doctype html><html><body><p>Edited in the preview</p></body></html>'
    const result = await f.api['designs.save']({ projectId: project.id, html: saved, reason: 'test' })
    expect(typeof result.updatedAt).toBe('number')

    const read2 = await f.api['designs.read']({ projectId: project.id })
    expect(read2.html).toBe(saved)

    const updates = f.events.filter((e) => e.type === 'design.updated')
    expect(updates).toEqual([
      { type: 'design.updated', projectId: project.id, updatedAt: result.updatedAt, source: 'editor' }
    ])
  })

  it('throws when saving over 5 MB', async () => {
    const f = makeFixture()
    const { project } = await f.api['designs.create']({ name: 'Big' })

    const big = 'a'.repeat(MAX_DESIGN_HTML_BYTES + 1)
    expect(() => f.api['designs.save']({ projectId: project.id, html: big, reason: 'test' })).toThrow(
      'This design file is too large (over 5 MB).'
    )
  })

  it('saves other plain pages by path but never over a Design Component or outside the folder', async () => {
    const f = makeFixture()
    const { project } = await f.api['designs.create']({ name: 'Pages' })
    const folder = designFolder(f, project.id)
    mkdirSync(join(folder, 'pages'))
    writeFileSync(join(folder, 'pages', 'about.html'), '<p>old</p>')
    writeFileSync(join(folder, 'Card.dc.html'), '<x-dc><p>{{ title }}</p></x-dc>')

    await f.api['designs.save']({ projectId: project.id, html: '<p>new</p>', reason: 'test', path: 'pages/about.html' })
    expect(readFileSync(join(folder, 'pages', 'about.html'), 'utf8')).toBe('<p>new</p>')
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toContain('Pages')

    expect(() =>
      f.api['designs.save']({ projectId: project.id, html: '<p>rendered</p>', reason: 'test', path: 'Card.dc.html' })
    ).toThrow(/Design component files/)
    expect(readFileSync(join(folder, 'Card.dc.html'), 'utf8')).toBe('<x-dc><p>{{ title }}</p></x-dc>')
    expect(() => f.api['designs.save']({ projectId: project.id, html: 'x', reason: 'test', path: '../escape.html' })).toThrow(/outside/)
    expect(() => f.api['designs.save']({ projectId: project.id, html: 'x', reason: 'test', path: 'notes.txt' })).toThrow(/\.html/)
  })

  it('lists the viewable pages newest first', async () => {
    const f = makeFixture()
    const { project } = await f.api['designs.create']({ name: 'List' })
    const folder = designFolder(f, project.id)
    mkdirSync(join(folder, 'pages'))
    mkdirSync(join(folder, 'node_modules'))
    writeFileSync(join(folder, 'Landing.dc.html'), 'x')
    writeFileSync(join(folder, 'pages', 'about.html'), 'x')
    writeFileSync(join(folder, 'node_modules', 'skip.html'), 'x')
    writeFileSync(join(folder, 'deck-stage.js'), 'x')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(folder, 'index.html'), past, past)

    const files = await f.api['designs.files']({ projectId: project.id })
    expect(files.map((file: { path: string }) => file.path).sort()).toEqual(['Landing.dc.html', 'index.html', 'pages/about.html'])
    expect(files[files.length - 1].path).toBe('index.html')
    expect(files.find((file: { path: string }) => file.path === 'Landing.dc.html').kind).toBe('dc')
  })

  it('gives design conversations the Design Component tools', async () => {
    const f = makeFixture()
    const { project, task } = await f.api['designs.create']({ name: 'Tools' })
    const tools = buildTools({
      taskId: task.id,
      projectId: project.id,
      root: project.folder,
      changes: new ChangeLog(f.repos.changes, join(f.base, 'snapshots')),
      memories: f.repos.memories,
      modelRef: { provider: 'google', modelId: 'm' },
      projectKind: 'design',
      onPlan: () => {},
      onNotify: () => {},
      onChangesUpdated: () => {},
      onMemoryUpdated: () => {}
    })
    for (const name of ['dc_write', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'copy_starter_component', 'show_to_user']) {
      expect(tools[name], name).toBeDefined()
    }
  })

  it('throws when reading or saving a work project', async () => {
    const f = makeFixture()
    const work = f.repos.projects.create('Work', join(f.base, 'work-folder'))

    expect(() => f.api['designs.read']({ projectId: work.id })).toThrow("That project isn't a design.")
    expect(() => f.api['designs.save']({ projectId: work.id, html: '<p>x</p>', reason: 'test' })).toThrow(
      "That project isn't a design."
    )
  })

  it('throws while the assistant is changing the design', async () => {
    const f = makeFixture()
    const { project, task } = await f.api['designs.create']({ name: 'Busy' })
    void f.api['tasks.send']({ id: task.id, text: 'Keep working' })

    expect(() => f.api['designs.save']({ projectId: project.id, html: '<p>x</p>', reason: 'test' })).toThrow(
      "The assistant is changing this design right now. Try again when it's done."
    )
    await f.runner.whenIdle(task.id)
  })
})

describe('designs.save from a connected agent', () => {
  it('an agent-caller save emits design.updated with source external and calls onDesignWritten', async () => {
    const f = makeFixture()
    const { project } = await f.api['designs.create']({ name: 'Agent edit' })

    f.events.length = 0
    const html = '<!doctype html><html><body><p>Edited by an agent</p></body></html>'
    const saved = await f.api['designs.save'](
      { projectId: project.id, html, reason: 'external' },
      { caller: 'agent' }
    )

    const updates = f.events.filter((e) => e.type === 'design.updated')
    expect(updates).toEqual([
      { type: 'design.updated', projectId: project.id, updatedAt: saved.updatedAt, source: 'external' }
    ])
    expect(f.designWrites).toEqual([{ projectId: project.id, updatedAt: saved.updatedAt }])
  })

  it('an app-caller save (context omitted, as the UI does) still emits source editor', async () => {
    const f = makeFixture()
    const { project } = await f.api['designs.create']({ name: 'Editor edit' })

    f.events.length = 0
    const saved = await f.api['designs.save']({ projectId: project.id, html: '<p>hand edit</p>', reason: 'test' })

    const updates = f.events.filter((e) => e.type === 'design.updated')
    expect(updates).toEqual([
      { type: 'design.updated', projectId: project.id, updatedAt: saved.updatedAt, source: 'editor' }
    ])
    expect(f.designWrites).toEqual([{ projectId: project.id, updatedAt: saved.updatedAt }])
  })
})

describe('app.info', () => {
  it('reports the agentKit paths from HandlerServices', async () => {
    const f = makeFixture()

    const info = await f.api['app.info']({})

    expect(info.agentKit).toEqual({
      guidePath: join(f.base, 'agent-kit', 'DESKMATES-AGENTS.md'),
      commandPath: join(f.base, 'agent-kit', 'deskmates.cmd')
    })
  })
})

describe('projects.delete for designs', () => {
  it('removes a design folder but keeps a work folder', async () => {
    const f = makeFixture()
    const { project } = await f.api['designs.create']({ name: 'Gone' })
    const workFolder = join(f.base, 'work-folder')
    mkdirSync(workFolder)
    const work = f.repos.projects.create('Work', workFolder)

    await f.api['projects.delete']({ id: project.id })
    expect(existsSync(designFolder(f, project.id))).toBe(false)

    await f.api['projects.delete']({ id: work.id })
    expect(existsSync(workFolder)).toBe(true)
  })
})
describe('assistant design changes', () => {
  it('a write_file in a design task emits design.updated with source assistant', async () => {
    const f = makeFixture(
      writeThenText({ path: 'index.html', content: '<!doctype html><html><body><h1>New</h1></body></html>' })
    )
    const { project, task } = await f.api['designs.create']({ name: 'Redesign' })

    await f.api['tasks.send']({ id: task.id, text: 'Redesign the page' })
    await f.runner.whenIdle(task.id)

    const updates = f.events.filter((e) => e.type === 'design.updated' && e.projectId === project.id)
    expect(updates.length).toBeGreaterThan(0)
    for (const update of updates) {
      expect(update).toMatchObject({ source: 'assistant' })
    }
    expect(readFileSync(join(project.folder, 'index.html'), 'utf8')).toContain('<h1>New</h1>')
  })

  it('changes.undoAll on a design task emits design.updated with source assistant', async () => {
    const f = makeFixture(writeThenText({ path: 'notes.txt', content: 'assistant wrote this' }))
    const { project, task } = await f.api['designs.create']({ name: 'Undo design' })

    await f.api['tasks.send']({ id: task.id, text: 'Write a note' })
    await f.runner.whenIdle(task.id)

    f.events.length = 0
    await f.api['changes.undoAll']({ taskId: task.id })

    const updates = f.events.filter((e) => e.type === 'design.updated' && e.projectId === project.id)
    expect(updates).toEqual([expect.objectContaining({ source: 'assistant' })])
  })

  it('changes.undo (a single change) on a design task emits design.updated with source assistant', async () => {
    const f = makeFixture(writeThenText({ path: 'notes.txt', content: 'assistant wrote this' }))
    const { project, task } = await f.api['designs.create']({ name: 'Undo one' })

    await f.api['tasks.send']({ id: task.id, text: 'Write a note' })
    await f.runner.whenIdle(task.id)

    const changes = await f.api['changes.list']({ taskId: task.id })
    expect(changes.length).toBeGreaterThan(0)

    f.events.length = 0
    await f.api['changes.undo']({ id: changes[0].id })

    const updates = f.events.filter((e) => e.type === 'design.updated' && e.projectId === project.id)
    expect(updates).toEqual([expect.objectContaining({ source: 'assistant' })])
  })

  it('changes.undoAll on a work task emits no design.updated', async () => {
    const f = makeFixture(writeThenText({ path: 'notes.txt', content: 'assistant wrote this' }))
    const work = f.repos.projects.create('Work', join(f.base, 'work'))
    const task = f.repos.tasks.create(work.id)

    await f.api['tasks.send']({ id: task.id, text: 'Write a note' })
    await f.runner.whenIdle(task.id)

    f.events.length = 0
    await f.api['changes.undoAll']({ taskId: task.id })
    expect(f.events.some((e) => e.type === 'design.updated')).toBe(false)
  })
})

describe('the kind migration', () => {
  it('reads projects from a previous schema version as work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deskmates-migration-'))
    fixtures.push({
      db: null as unknown as DatabaseSync,
      base: dir,
      repos: null as unknown as Repos,
      events: [],
      runner: null as unknown as TaskRunner,
      api: null as unknown as TestApi,
      designWrites: [],
      cleanup: () => rmSync(dir, { recursive: true, force: true })
    })
    const file = join(dir, 'app.db')

    // Build the previous schema by hand: projects without `kind`, user_version = 1.
    const old = new DatabaseSync(file)
    old.exec(
      `CREATE TABLE projects (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL);`
    )
    old.prepare('INSERT INTO projects (id, name, folder, model, created_at) VALUES (?, ?, ?, NULL, ?)').run(
      'p1', 'Old project', 'C:\\old', 1000
    )
    old.exec('PRAGMA user_version = 1')
    old.close()

    const db = openDatabase(file)
    const repos = createRepos(db)
    const projects = repos.projects.list()
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: 'p1', kind: 'work' })

    // New designs still keep their kind.
    const design = repos.projects.create('New design', join(dir, 'designs', 'p2'), 'design', 'p2')
    expect(repos.projects.require(design.id).kind).toBe('design')
    db.close()
  })

  it('a fresh database defaults new projects to work', () => {
    const f = makeFixture()
    const project = f.repos.projects.create('Plain', 'C:\\plain')
    expect(project.kind).toBe('work')
    expect(f.repos.projects.require(project.id).name).toBe('Plain')
  })
})