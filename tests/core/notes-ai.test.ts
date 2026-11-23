import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'
import { buildTools } from '../../src/core/tools'
import type { RpcMethod } from '../../src/shared/protocol'

type Api = Record<RpcMethod, (params: any) => any>

const reply = () => ({
  resolve: () => ({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Fotosinteza are loc în cloroplaste.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
          ] as any[]
        })
      })
    }),
    provider: 'google' as const,
    modelId: 'test-model'
  })
})

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function setup() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-notes-ai-')))
  const db = openDatabase(':memory:')
  const repos = createRepos(db)
  const bus = new EventBus()
  const keys = new KeyStore()
  const changes = new ChangeLog(repos.changes, join(base, 'snapshots'))
  const runner = new TaskRunner({ repos, bus, models: reply(), changes, createTools: buildTools })
  const api = createHandlers({ repos, bus, runner, changes, models: new ModelService(keys, () => repos.settings.get()), keys, version: '0.1.0', dataDir: base }) as unknown as Api
  cleanups.push(() => {
    db.close()
    rmSync(base, { recursive: true, force: true })
  })
  return { base, repos, runner, api }
}

describe('notes.ask', () => {
  it('asks in a "Notes" project answered by Freebuff, and keeps one chat going', async () => {
    const { repos, runner, api } = setup()
    // Never reach a real model (Freebuff) from a test: record what would be sent.
    const sent: Array<{ id: string; text: string; images: unknown[] }> = []
    runner.send = (async (id: string, text: string, images: unknown[]) => {
      sent.push({ id, text, images })
    }) as typeof runner.send

    const image = { dataUrl: 'data:image/jpeg;base64,AAAA', name: 'page.jpg' }
    const first = await api['notes.ask']({ text: 'Explică-mi pagina', images: [image], title: 'Biologie, p. 3' })
    const project = repos.projects.list().find((p) => p.name === 'Notes')!
    expect(project.model).toEqual({ provider: 'freebuff', modelId: 'current' })
    expect(repos.tasks.list(project.id).map((t) => t.title)).toEqual(['Biologie, p. 3'])
    expect(sent[0]).toEqual({ id: first.taskId, text: 'Explică-mi pagina', images: [image] })

    const second = await api['notes.ask']({ text: 'Și mitocondria?', taskId: first.taskId })
    expect(second.taskId).toBe(first.taskId)
    expect(repos.projects.list().filter((p) => p.name === 'Notes')).toHaveLength(1)

    // A model picked in the notes app answers from then on.
    await api['notes.ask']({ text: 'Altă întrebare', taskId: first.taskId, freebuffModel: 'GLM 5.3 Flash' })
    expect(repos.projects.list().find((p) => p.name === 'Notes')!.model).toEqual({ provider: 'freebuff', modelId: 'GLM 5.3 Flash' })

    await expect(api['notes.ask']({ text: '   ' })).rejects.toThrow('Ask something first.')
  })
})

describe('notes.reply', () => {
  it('gives the replies after a moment, without the pictures', async () => {
    const { base, repos, runner, api } = setup()
    const folder = join(base, 'p')
    mkdirSync(folder)
    const project = repos.projects.create('Test', folder)
    const task = repos.tasks.create(project.id)
    const before = Date.now() - 1
    await runner.send(task.id, 'Unde are loc fotosinteza?', [])
    await runner.whenIdle(task.id)
    const result = await api['notes.reply']({ taskId: task.id, after: before })
    expect(result.status).toBe('idle')
    expect(result.replies.map((r: { text: string }) => r.text)).toEqual(['Fotosinteza are loc în cloroplaste.'])
    expect((await api['notes.reply']({ taskId: task.id, after: Date.now() + 1000 })).replies).toEqual([])
  })
})
