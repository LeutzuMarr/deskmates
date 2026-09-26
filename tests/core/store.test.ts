import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'

let repos: Repos

beforeEach(() => {
  repos = createRepos(openDatabase(':memory:'))
})

describe('settings', () => {
  it('returns defaults and persists updates', () => {
    expect(repos.settings.get().maxSteps).toBe(40)
    const next = repos.settings.update({ maxSteps: 12, defaultModel: { provider: 'google', modelId: 'gemini-x' } })
    expect(next.maxSteps).toBe(12)
    expect(repos.settings.get().defaultModel).toEqual({ provider: 'google', modelId: 'gemini-x' })
  })

  it('ignores unknown keys', () => {
    repos.settings.update({ nope: 1 } as never)
    expect(repos.settings.get()).not.toHaveProperty('nope')
  })

  it('defaults to an empty appearance and round-trips an appearance update', () => {
    expect(repos.settings.get().appearance).toEqual({
      logo: null,
      uiFont: null,
      replyFont: null,
      idleAnimation: null,
      workingAnimation: null
    })
    const next = repos.settings.update({
      appearance: {
        logo: 'data:image/png;base64,x',
        uiFont: { name: 'MyFont', dataUrl: 'data:font/woff2;base64,y' },
        replyFont: null,
        idleAnimation: { name: 'Dots', json: '{"v":"5"}', fonts: [{ name: 'AnimFont', dataUrl: 'data:font/ttf;base64,z' }] },
        workingAnimation: null
      }
    })
    expect(next.appearance).toEqual({
      logo: 'data:image/png;base64,x',
      uiFont: { name: 'MyFont', dataUrl: 'data:font/woff2;base64,y' },
      replyFont: null,
      idleAnimation: { name: 'Dots', json: '{"v":"5"}', fonts: [{ name: 'AnimFont', dataUrl: 'data:font/ttf;base64,z' }] },
      workingAnimation: null
    })
    expect(repos.settings.get().appearance).toEqual(next.appearance)
  })
})

describe('projects and tasks', () => {
  it('stores messages in order and deletes everything with the project', () => {
    const project = repos.projects.create('Notes', 'C:\\notes')
    const task = repos.tasks.create(project.id)
    expect(task).toMatchObject({ status: 'idle', title: 'New task', plan: [], autoApprove: [] })

    repos.tasks.appendMessages(task.id, [{ role: 'user', content: 'hi' }], 1000)
    repos.tasks.appendMessages(task.id, [{ role: 'assistant', content: 'hello' }], 2000)
    const stored = repos.tasks.messages(task.id)
    expect(stored.map((m) => m.message.role)).toEqual(['user', 'assistant'])
    expect(stored.map((m) => m.at)).toEqual([1000, 2000])

    const updated = repos.tasks.update(task.id, { status: 'running', plan: [{ text: 'a', status: 'pending' }] })
    expect(updated.plan).toHaveLength(1)
    expect(repos.tasks.update(task.id, { error: null }).status).toBe('running')

    repos.projects.delete(project.id)
    expect(repos.tasks.get(task.id)).toBeUndefined()
    expect(repos.tasks.messages(task.id)).toEqual([])
  })

  it('keeps the model when a project update leaves it out', () => {
    const project = repos.projects.create('A', 'C:\\a')
    repos.projects.update(project.id, { model: { provider: 'openai', modelId: 'gpt-x' } })
    expect(repos.projects.update(project.id, { name: 'B' }).model).toEqual({ provider: 'openai', modelId: 'gpt-x' })
    expect(repos.projects.update(project.id, { model: null }).model).toBeNull()
  })

  it('resets tasks that were running when the app stopped', () => {
    const project = repos.projects.create('A', 'C:\\a')
    const task = repos.tasks.create(project.id)
    repos.tasks.update(task.id, { status: 'running' })
    const reset = repos.tasks.resetInterrupted()
    expect(reset.map((t) => t.id)).toEqual([task.id])
    expect(repos.tasks.require(task.id)).toMatchObject({ status: 'idle', error: expect.stringContaining('closed') })
  })
})

describe('memories, changes and usage', () => {
  it('stores memories per project', () => {
    const a = repos.projects.create('A', 'C:\\a')
    const b = repos.projects.create('B', 'C:\\b')
    const memory = repos.memories.add(a.id, 'Prefers short answers')
    repos.memories.add(b.id, 'Other project')
    expect(repos.memories.list(a.id).map((m) => m.content)).toEqual(['Prefers short answers'])
    expect(repos.memories.delete(memory.id, b.id)).toBe(false)
    expect(repos.memories.delete(memory.id, a.id)).toBe(true)
    expect(repos.memories.list(a.id)).toEqual([])
  })

  it('records changes and marks them undone', () => {
    const project = repos.projects.create('A', 'C:\\a')
    const task = repos.tasks.create(project.id)
    const change = repos.changes.insert({
      id: 'c1',
      taskId: task.id,
      path: 'notes/a.txt',
      absPath: 'C:\\a\\notes\\a.txt',
      kind: 'modify',
      backup: 'C:\\snap\\c1.bak',
      movedTo: null,
      movedToAbs: null
    })
    expect(change.undone).toBe(false)
    repos.changes.markUndone('c1')
    expect(repos.changes.list(task.id)).toEqual([expect.objectContaining({ id: 'c1', undone: true, path: 'notes/a.txt' })])
    expect(repos.changes.list(task.id)[0]).not.toHaveProperty('absPath')
  })

  it('adds up usage per day and provider', () => {
    repos.usage.add('google', 1, 100, 20, '2026-09-18')
    repos.usage.add('google', 2, 50, 10, '2026-09-18')
    repos.usage.add('openai', 1, 5, 5, '2026-09-18')
    expect(repos.usage.list()).toEqual([
      { day: '2026-09-18', provider: 'google', requests: 3, inputTokens: 150, outputTokens: 30 },
      { day: '2026-09-18', provider: 'openai', requests: 1, inputTokens: 5, outputTokens: 5 }
    ])
  })
})
