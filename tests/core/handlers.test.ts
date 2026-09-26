import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { EventBus } from '../../src/core/events'
import { ChangeLog } from '../../src/core/fs/change-log'
import { TaskRunner } from '../../src/core/engine/runner'
import { KeyStore } from '../../src/core/models/keys'
import { ModelService } from '../../src/core/models/providers'
import { createHandlers } from '../../src/core/server/handlers'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import { buildTools } from '../../src/core/tools'
import type { CoreEvent, PhoneInfo, RpcMethod } from '../../src/shared/protocol'

type TestApi = Record<RpcMethod, (params: any) => any>
type ModelResolverStub = { resolve: () => { model: MockLanguageModelV4; provider: 'google'; modelId: string } }

interface Fixture {
  db: DatabaseSync
  base: string
  root: string
  repos: Repos
  events: CoreEvent[]
  runner: TaskRunner
  api: TestApi
  projectId: string
  taskId: string
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

function makeFixture(models?: ModelResolverStub, phone?: { info(): PhoneInfo }): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-handlers-')))
  const root = join(base, 'project')
  mkdirSync(root)
  const db = openDatabase(':memory:')
  const repos = createRepos(db)
  const bus = new EventBus()
  const keys = new KeyStore()
  const modelService = new ModelService(keys, () => repos.settings.get())
  const changes = new ChangeLog(repos.changes, join(base, 'snapshots'))
  const runner = new TaskRunner({ repos, bus, models: models ?? textOnly(), changes, createTools: buildTools })
  const handlers = createHandlers({ repos, bus, runner, changes, models: modelService, keys, version: '0.1.0', dataDir: base, phone })

  const events: CoreEvent[] = []
  bus.on((event) => events.push(event))

  const api = handlers as unknown as TestApi
  const project = repos.projects.create('Test', root)
  const task = repos.tasks.create(project.id)

  const fixture: Fixture = {
    db,
    base,
    root,
    repos,
    events,
    runner,
    api,
    projectId: project.id,
    taskId: task.id,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    fixture.cleanup()
  }
})

describe('createHandlers', () => {
  it('1. projects.create validates the folder and rejects duplicates', async () => {
    const f = makeFixture()

    expect(() => f.api['projects.create']({ name: 'X', folder: join(f.base, 'nope') })).toThrow(
      "That folder doesn't exist."
    )

    const other = join(f.base, 'other')
    mkdirSync(other)
    const project = await f.api['projects.create']({ name: '  My Project  ', folder: other })
    expect(project.name).toBe('My Project')
    expect(project.folder).toBe(realpathSync.native(other))

    expect(() => f.api['projects.create']({ name: 'Dup', folder: other })).toThrow(
      'This folder is already a project.'
    )

    const second = join(f.base, 'second')
    mkdirSync(second)
    const unnamed = await f.api['projects.create']({ name: '   ', folder: second })
    expect(unnamed.name).toBe('second')

    expect(f.events.some((event) => event.type === 'project.updated')).toBe(true)
  })

  it('2. tasks.create + tasks.send + whenIdle yields a timeline with a user item and an assistant item', async () => {
    const f = makeFixture()

    const created = await f.api['tasks.create']({ projectId: f.projectId })
    expect(created.status).toBe('idle')
    expect(f.events.some((event) => event.type === 'task.updated' && event.task.id === created.id)).toBe(true)

    await f.api['tasks.send']({ id: created.id, text: 'Say hello' })
    await f.runner.whenIdle(created.id)

    const { task, timeline } = await f.api['tasks.get']({ id: created.id })
    expect(task.status).toBe('idle')
    expect(task.title).toBe('Say hello')
    expect(timeline).toHaveLength(2)
    expect(timeline[0].kind).toBe('user')
    expect(timeline[1].kind).toBe('assistant')
  })

  it('3. changes.undoAll restores files written by a write_file step', async () => {
    const f = makeFixture(writeThenText({ path: 'new.txt', content: 'file contents' }))

    await f.api['tasks.send']({ id: f.taskId, text: 'Write a file' })
    await f.runner.whenIdle(f.taskId)

    const target = join(f.root, 'new.txt')
    expect(existsSync(target)).toBe(true)
    expect(await f.api['changes.list']({ taskId: f.taskId })).toHaveLength(1)

    await f.api['changes.undoAll']({ taskId: f.taskId })
    expect(existsSync(target)).toBe(false)

    const changes = await f.api['changes.list']({ taskId: f.taskId })
    expect(changes).toHaveLength(1)
    expect(changes[0].undone).toBe(true)
    expect(f.events.some((event) => event.type === 'changes.updated' && event.taskId === f.taskId)).toBe(true)
  })

  it('4. memory.add / delete emit memory.updated', async () => {
    const f = makeFixture()

    await f.api['memory.add']({ projectId: f.projectId, content: 'tea before work' })
    let updated = f.events.filter((event) => event.type === 'memory.updated')
    expect(updated).toHaveLength(1)
    expect(updated[0].projectId).toBe(f.projectId)
    expect(updated[0].memories.map((m) => m.content)).toEqual(['tea before work'])

    const memories = await f.api['memory.list']({ projectId: f.projectId })
    expect(memories).toHaveLength(1)

    await f.api['memory.delete']({ id: memories[0].id, projectId: f.projectId })
    updated = f.events.filter((event) => event.type === 'memory.updated')
    expect(updated).toHaveLength(2)
    expect(updated[1].memories).toEqual([])
    expect(await f.api['memory.list']({ projectId: f.projectId })).toEqual([])
  })

  it('5. projects.instructions.set writes DESKMATES.md', async () => {
    const f = makeFixture()

    const content = '# Project rules\n\nAlways test before finishing.'
    await f.api['projects.instructions.set']({ id: f.projectId, content })

    const instructionsPath = join(f.root, 'DESKMATES.md')
    expect(existsSync(instructionsPath)).toBe(true)
    expect(readFileSync(instructionsPath, 'utf8')).toBe(content)

    const got = await f.api['projects.instructions.get']({ id: f.projectId })
    expect(got.path).toBe(instructionsPath)
    expect(got.content).toBe(content)
  })

  it('6. tasks.delete removes the task and its snapshots folder', async () => {
    const f = makeFixture(writeThenText({ path: 'a.txt', content: 'new contents' }))
    writeFileSync(join(f.root, 'a.txt'), 'old contents')

    await f.api['tasks.send']({ id: f.taskId, text: 'Change a.txt' })
    await f.runner.whenIdle(f.taskId)

    const snapshotDir = join(f.base, 'snapshots', f.taskId)
    expect(existsSync(snapshotDir)).toBe(true)
    expect(readdirSync(snapshotDir).length).toBeGreaterThan(0)

    await f.api['tasks.delete']({ id: f.taskId })

    expect(f.repos.tasks.get(f.taskId)).toBeUndefined()
    expect(existsSync(snapshotDir)).toBe(false)
    expect(f.events.some((event) => event.type === 'task.deleted' && event.taskId === f.taskId)).toBe(true)
  })

  it('7. settings.update validates maxSteps, stores appearance and emits settings.updated; app.info reports keys', async () => {
    const f = makeFixture()

    expect(() => f.api['settings.update']({ maxSteps: 201 })).toThrow(/between 1 and 200/)
    expect(() => f.api['settings.update']({ maxSteps: 0 })).toThrow(/between 1 and 200/)
    expect(() => f.api['settings.update']({ maxSteps: 2.5 })).toThrow(/between 1 and 200/)

    const appearance = {
      logo: 'data:image/png;base64,AAAA',
      uiFont: null,
      replyFont: null,
      idleAnimation: null,
      workingAnimation: null
    }
    const settings = await f.api['settings.update']({
      globalInstructions: 'Be tidy.',
      appearance,
      maxSteps: 7
    })
    expect(settings.maxSteps).toBe(7)
    expect(settings.globalInstructions).toBe('Be tidy.')
    expect(settings.appearance).toEqual(appearance)
    expect(f.events.some((event) => event.type === 'settings.updated' && event.settings.maxSteps === 7)).toBe(true)

    const info = await f.api['app.info']({})
    expect(info.version).toBe('0.1.0')
    expect(f.base.startsWith(info.dataDir)).toBe(true)
    expect(info.keys).toEqual([])
  })

  it('8. settings.update manages the phone pairing code, and phone.info reports the listener state', async () => {
    const f = makeFixture()

    // phone.info without a wiring service is the "not set up here" sentinel.
    expect(() => f.api['phone.info']({})).toThrow(/isn't set up/)

    // A malformed code is refused...
    expect(() => f.api['settings.update']({ pairingCode: 'abc' })).toThrow(/6 digits/)
    expect(() => f.api['settings.update']({ phoneAccess: 'yes' })).toThrow(/true or false/)

    // ...and enabling the feature always lands on a fresh six-digit code.
    const enabled = await f.api['settings.update']({ phoneAccess: true })
    expect(enabled.phoneAccess).toBe(true)
    expect(enabled.pairingCode).toMatch(/^\d{6}$/)
    expect(f.repos.settings.get().pairingCode).toBe(enabled.pairingCode)
    expect(f.events.some((event) => event.type === 'settings.updated' && (event.settings as { phoneAccess: boolean }).phoneAccess === true)).toBe(true)

    // A caller-supplied valid code is kept, not replaced.
    const kept = await f.api['settings.update']({ pairingCode: '123456' })
    expect(kept.pairingCode).toBe('123456')

    // An empty code means "generate a fresh one".
    const regenerated = await f.api['settings.update']({ pairingCode: '' })
    expect(regenerated.pairingCode).toMatch(/^\d{6}$/)
    expect(regenerated.pairingCode).not.toBe('123456')

    // Announce then recall state.
    const listener = { info: (): PhoneInfo => ({ enabled: true, port: 8642, urls: ['http://192.168.1.5:8642'], error: null }) }
    const withPhone = makeFixture(textOnly(), listener)
    expect(withPhone.api['phone.info']({})).toEqual(listener.info())
    expect(() => withPhone.api['settings.update']({ phoneAccess: false })).not.toThrow()
  })

  it('9. phone.info stays happy even before a phone server has ever synced', async () => {
    const f = makeFixture(textOnly(), { info: () => ({ enabled: false, port: null, urls: [], error: null }) })
    const info = f.api['phone.info']({})
    expect(info).toEqual({ enabled: false, port: null, urls: [], error: null })
  })
})