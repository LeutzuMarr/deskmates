import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TaskRunner } from '../../src/core/engine/runner'
import { createRepos, type Repos } from '../../src/core/store/repos'
import { openDatabase } from '../../src/core/store/db'
import type { DatabaseSync } from 'node:sqlite'
import { ChangeLog } from '../../src/core/fs/change-log'
import { EventBus } from '../../src/core/events'
import { fileTools } from '../../src/core/tools/files'
import { MockLanguageModelV4 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('TaskRunner', () => {
  let db: DatabaseSync
  let repos: Repos
  let bus: EventBus
  let changes: ChangeLog
  let tmpDir: string
  let taskId: string
  let projectId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    repos = createRepos(db)
    bus = new EventBus()
    tmpDir = mkdtempSync(join(tmpdir(), 'deskmates-runner-test-'))
    changes = new ChangeLog(repos.changes, join(tmpDir, '.snapshots'))
    
    const project = repos.projects.create('Test', tmpDir)
    projectId = project.id
    const task = repos.tasks.create(projectId, 'New task')
    taskId = task.id
    repos.settings.update({ maxSteps: 10 })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('1. plain text reply', async () => {
    const chunks = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
    ]

    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => ({ stream: simulateReadableStream({ chunks: chunks as any[] }) })
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    await runner.send(taskId, 'Say hello')
    await runner.whenIdle(taskId)

    const task = repos.tasks.require(taskId)
    expect(task.status).toBe('idle')
    expect(task.title).toBe('Say hello')
    
    const msgs = repos.tasks.messages(taskId)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].message.role).toBe('user')
    expect(msgs[1].message.role).toBe('assistant')
    
    const timeline = runner.timeline(taskId)
    expect(timeline).toHaveLength(2)
    expect(timeline[0].kind).toBe('user')
    expect(timeline[1].kind).toBe('assistant')
    
    const usage = repos.usage.list()
    expect(usage).toHaveLength(1)
  })

  it('2. write_file tool call', async () => {
    let callCount = 0
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => {
            callCount++
            if (callCount === 1) {
              return { stream: simulateReadableStream({ chunks: [
                { type: 'tool-call', toolCallId: 'c1', toolName: 'write_file', input: '{"path":"new.txt","content":"file contents"}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
              ] as any[] }) }
            }
            return { stream: simulateReadableStream({ chunks: [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'done' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
            ] as any[] }) }
          }
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    let doneEmitted = false
    bus.on((ev: any) => {
      if (ev.type === 'task.item' && ev.item.kind === 'tool' && ev.item.state === 'done') {
        doneEmitted = true
      }
    })

    await runner.send(taskId, 'Write a file')
    await runner.whenIdle(taskId)

    expect(existsSync(join(tmpDir, 'new.txt'))).toBe(true)
    
    const changeList = repos.changes.list(taskId)
    expect(changeList).toHaveLength(1)
    expect(changeList[0].kind).toBe('create')
    
    expect(doneEmitted).toBe(true)
    expect(repos.tasks.require(taskId).status).toBe('idle')
  })

  it('3. delete_path on an existing file then approve', async () => {
    writeFileSync(join(tmpDir, 'del.txt'), 'content')
    let callCount = 0
    
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => {
            callCount++
            if (callCount === 1) {
              return { stream: simulateReadableStream({ chunks: [
                { type: 'tool-call', toolCallId: 'c1', toolName: 'delete_path', input: '{"path":"del.txt"}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
              ] as any[] }) }
            }
            return { stream: simulateReadableStream({ chunks: [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'deleted' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
            ] as any[] }) }
          }
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    let notifyEmitted = false
    bus.on((ev: any) => { if (ev.type === 'notify') notifyEmitted = true })

    await runner.send(taskId, 'Delete del.txt')
    await runner.whenIdle(taskId)

    expect(repos.tasks.require(taskId).status).toBe('waiting-approval')
    expect(existsSync(join(tmpDir, 'del.txt'))).toBe(true)
    expect(notifyEmitted).toBe(true)

    // Find pending approval
    const tl = runner.timeline(taskId)
    const toolItem = tl.find(i => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    expect(toolItem).toBeDefined()
    const approvalId = toolItem.approvalId

    await runner.respond(taskId, approvalId, true)
    await runner.whenIdle(taskId)

    expect(repos.tasks.require(taskId).status).toBe('idle')
    expect(existsSync(join(tmpDir, 'del.txt'))).toBe(false)
  })

  it('4. denied delete_path', async () => {
    writeFileSync(join(tmpDir, 'keep.txt'), 'content')
    let callCount = 0
    
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => {
            callCount++
            if (callCount === 1) {
              return { stream: simulateReadableStream({ chunks: [
                { type: 'tool-call', toolCallId: 'c1', toolName: 'delete_path', input: '{"path":"keep.txt"}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
              ] as any[] }) }
            }
            return { stream: simulateReadableStream({ chunks: [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'ok' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
            ] as any[] }) }
          }
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    await runner.send(taskId, 'Delete keep.txt')
    await runner.whenIdle(taskId)

    const tl = runner.timeline(taskId)
    const toolItem = tl.find(i => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    await runner.respond(taskId, toolItem.approvalId, false)
    await runner.whenIdle(taskId)

    expect(existsSync(join(tmpDir, 'keep.txt'))).toBe(true)
    expect(repos.tasks.require(taskId).status).toBe('idle')
    
    const finalTl = runner.timeline(taskId)
    const deniedTool = finalTl.find(i => i.kind === 'tool') as any
    expect(deniedTool.state).toBe('denied')
  })

  it('5. always: true for delete_path autoApprove', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'a')
    writeFileSync(join(tmpDir, 'b.txt'), 'b')
    let callCount = 0
    
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => {
            callCount++
            if (callCount === 1) { // 1st run
              return { stream: simulateReadableStream({ chunks: [
                { type: 'tool-call', toolCallId: 'c1', toolName: 'delete_path', input: '{"path":"a.txt"}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
              ] as any[] }) }
            }
            if (callCount === 2) { // After approval
              return { stream: simulateReadableStream({ chunks: [
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'deleted a' },
                { type: 'text-end', id: 't1' },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
              ] as any[] }) }
            }
            // 3rd run (second send)
            if (callCount === 3) {
               return { stream: simulateReadableStream({ chunks: [
                { type: 'tool-call', toolCallId: 'c2', toolName: 'delete_path', input: '{"path":"b.txt"}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
              ] as any[] }) }
            }
            // 4th run
            return { stream: simulateReadableStream({ chunks: [
              { type: 'text-start', id: 't2' },
              { type: 'text-delta', id: 't2', delta: 'deleted b' },
              { type: 'text-end', id: 't2' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
            ] as any[] }) }
          }
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    await runner.send(taskId, 'Delete a.txt')
    await runner.whenIdle(taskId)

    const tl = runner.timeline(taskId)
    const toolItem = tl.find(i => i.kind === 'tool' && i.state === 'awaiting-approval') as any
    await runner.respond(taskId, toolItem.approvalId, true, true) // always = true
    await runner.whenIdle(taskId)

    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(false)
    expect(repos.tasks.require(taskId).autoApprove).toContain('delete_path')

    await runner.send(taskId, 'Delete b.txt')
    await runner.whenIdle(taskId)

    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(false)
    expect(repos.tasks.require(taskId).status).toBe('idle')
  })

  it('6. stop() during a slow stream', async () => {
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'long' },
                { type: 'text-delta', id: 't1', delta: 'message' },
                { type: 'text-end', id: 't1' },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
              ] as any[],
              chunkDelayInMs: 200
            })
          })
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    // Do not await send so we can stop it
    const p = runner.send(taskId, 'hello')
    runner.stop(taskId)
    await runner.whenIdle(taskId)
    await p.catch(() => {})

    const task = repos.tasks.require(taskId)
    expect(task.status).toBe('idle')
    expect(task.error).toBe('Stopped.')
  })

  it('7. doStream throws 401 error', async () => {
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => {
            const err = new Error('Auth failed')
            ;(err as any).statusCode = 401
            throw err
          }
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    await runner.send(taskId, 'fail')
    await runner.whenIdle(taskId)

    const task = repos.tasks.require(taskId)
    expect(task.status).toBe('error')
    expect(task.error).toContain('API key was rejected')
  })

  it('8. send while waiting for approval rejects', async () => {
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => ({ stream: simulateReadableStream({ chunks: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'delete_path', input: '{"path":"a.txt"}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } }
          ] as any[] }) })
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    await runner.send(taskId, 'first')
    await runner.whenIdle(taskId)

    expect(repos.tasks.require(taskId).status).toBe('waiting-approval')
    
    await expect(runner.send(taskId, 'second')).rejects.toThrow(/pending approval/)
  })

  it('9. synchronous model resolve failure does not leave a stuck run', async () => {
    const textStream = () => simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'ok' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
      ] as any[]
    })

    const models = {
      resolve: (ref: any) => {
        if (!ref) {
          throw new Error('Pick a model first: go to Settings and choose one')
        }
        return {
          model: new MockLanguageModelV4({ doStream: async () => ({ stream: textStream() }) }),
          provider: ref.provider,
          modelId: ref.modelId
        }
      }
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    await runner.send(taskId, 'hello')
    await runner.whenIdle(taskId)

    const task = repos.tasks.require(taskId)
    expect(task.status).toBe('error')
    expect(task.error).toContain('Pick a model first')
    expect(runner.isRunning(taskId)).toBe(false)

    repos.projects.update(projectId, { model: { provider: 'google', modelId: 'test-model' } })
    await runner.send(taskId, 'hello again')
    expect(runner.isRunning(taskId)).toBe(true)
    await runner.whenIdle(taskId)

    expect(repos.tasks.require(taskId).status).toBe('idle')
  })

  it('10. answering the same approval twice is rejected', async () => {
    writeFileSync(join(tmpDir, 'dup-a.txt'), 'a')
    writeFileSync(join(tmpDir, 'dup-b.txt'), 'b')
    let callCount = 0

    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({
          doStream: async () => {
            callCount++
            if (callCount === 1) {
              return { stream: simulateReadableStream({ chunks: [
                { type: 'tool-call', toolCallId: 'd1', toolName: 'delete_path', input: '{"path":"dup-a.txt"}' },
                { type: 'tool-call', toolCallId: 'd2', toolName: 'delete_path', input: '{"path":"dup-b.txt"}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
              ] as any[] }) }
            }
            return { stream: simulateReadableStream({ chunks: [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'deleted' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
            ] as any[] }) }
          }
        }),
        provider: 'google' as const,
        modelId: 'test-model'
      })
    }

    const runner = new TaskRunner({
      repos, bus, models, changes, createTools: (ctx) => fileTools(ctx)
    })

    await runner.send(taskId, 'Delete both files')
    await runner.whenIdle(taskId)

    expect(repos.tasks.require(taskId).status).toBe('waiting-approval')

    const tl = runner.timeline(taskId)
    const toolItems = tl.filter((i) => i.kind === 'tool' && i.state === 'awaiting-approval') as any[]
    expect(toolItems).toHaveLength(2)
    const id1 = toolItems[0].approvalId
    const id2 = toolItems[1].approvalId
    expect(id1).not.toBe(id2)

    await runner.respond(taskId, id1, true)
    await expect(runner.respond(taskId, id1, true)).rejects.toThrow('That approval is no longer pending.')
    await runner.respond(taskId, id2, true)
    await runner.whenIdle(taskId)

    expect(existsSync(join(tmpDir, 'dup-a.txt'))).toBe(false)
    expect(existsSync(join(tmpDir, 'dup-b.txt'))).toBe(false)
    expect(repos.tasks.require(taskId).status).toBe('idle')

    const stored = repos.tasks.messages(taskId)
    const toolParts = stored
      .filter((m) => m.message.role === 'tool')
      .flatMap((m) => (Array.isArray(m.message.content) ? (m.message.content as any[]) : []))
    const responses = toolParts.filter((p) => p.type === 'tool-approval-response')
    expect(responses).toHaveLength(2)
    expect(responses.filter((r) => r.approvalId === id1)).toHaveLength(1)
    expect(responses.filter((r) => r.approvalId === id2)).toHaveLength(1)
  })

  it('routes to TerminalsService.execute when the resolved provider is CLI-backed (opencode)', async () => {
    const calls: Array<{ tool: string; folder: string; prompt: string; model?: string }> = []
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({ doStream: async () => { throw new Error('never called') } }),
        provider: 'opencode' as const,
        modelId: 'opencode/big-pickle',
        cli: true as const
      })
    }

    const runner = new TaskRunner({
      repos,
      bus,
      models,
      changes,
      createTools: (ctx) => fileTools(ctx),
      getTerminals: () => ({
        execute: async (tool: string, folder: string, prompt: string, model?: string) => {
          calls.push({ tool, folder, prompt, model })
          return { text: 'PONG' }
        }
      }) as any
    })

    await runner.send(taskId, 'Ping the CLI')
    await runner.whenIdle(taskId)

    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('opencode')
    expect(calls[0].folder).toBe(tmpDir)
    expect(calls[0].model).toBe('opencode/big-pickle')
    expect(calls[0].prompt).toContain('Ping the CLI')

    const msgs = repos.tasks.messages(taskId)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].message.role).toBe('assistant')
    expect(msgs[1].message.content).toBe('PONG')

    expect(repos.tasks.require(taskId).status).toBe('idle')
    // A CLI run never touches the API-usage ledger.
    expect(repos.usage.list()).toHaveLength(0)
  })

  it('fails the task when the CLI run reports an error', async () => {
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({ doStream: async () => { throw new Error('never called') } }),
        provider: 'agy' as const,
        modelId: 'default',
        cli: true as const
      })
    }

    const runner = new TaskRunner({
      repos,
      bus,
      models,
      changes,
      createTools: (ctx) => fileTools(ctx),
      getTerminals: () => ({
        execute: async () => ({ text: '', error: 'Daily quota exceeded' })
      }) as any
    })

    await runner.send(taskId, 'Run anyway')
    await runner.whenIdle(taskId)

    const task = repos.tasks.require(taskId)
    expect(task.status).toBe('error')
    expect(task.error).toContain('quota')
  })

  it('emits design.updated after a CLI turn on a design project', async () => {
    const design = repos.projects.create('Poster', join(tmpDir, 'designs', 'p1'), 'design')
    const designTask = repos.tasks.create(design.id, 'Make it blue')
    const seen: string[] = []
    bus.on((ev: any) => {
      if (ev.type === 'design.updated') seen.push(ev.projectId)
    })

    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({ doStream: async () => { throw new Error('never called') } }),
        provider: 'opencode' as const,
        modelId: 'opencode/big-pickle',
        cli: true as const
      })
    }

    const runner = new TaskRunner({
      repos,
      bus,
      models,
      changes,
      createTools: (ctx) => fileTools(ctx),
      getTerminals: () => ({ execute: async () => ({ text: 'edited index.html' }) }) as any
    })

    await runner.send(designTask.id, 'Make it blue')
    await runner.whenIdle(designTask.id)

    expect(repos.tasks.require(designTask.id).status).toBe('idle')
    expect(seen).toContain(design.id)
  })

  // The Work tab routes a whole turn through OpenCode, and OpenCode's cold start was measured at
  // 15–45s before the model is even reached. These two cover the two ways that used to read as a
  // hung app: no output at all, and a Stop button that did nothing.

  it("hands the CLI turn the run's abort signal, so the Work tab's Stop actually stops it", async () => {
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({ doStream: async () => { throw new Error('never called') } }),
        provider: 'opencode' as const,
        modelId: 'opencode/big-pickle',
        cli: true as const
      })
    }

    let seenSignal: AbortSignal | undefined
    let killIt: (() => void) | undefined
    const cliKilled = new Promise<void>((resolve) => {
      killIt = resolve
    })

    const runner = new TaskRunner({
      repos,
      bus,
      models,
      changes,
      createTools: (ctx) => fileTools(ctx),
      getTerminals: () =>
        ({
          execute: async (_tool: string, _folder: string, _prompt: string, _model: string | undefined, options?: any) => {
            seenSignal = options?.signal
            // A real CLI run only ends when the process is killed; hold here until Stop does it.
            options?.signal?.addEventListener('abort', () => killIt?.(), { once: true })
            await cliKilled
            return { text: '', stopped: true }
          }
        }) as any
    })

    await runner.send(taskId, 'What model are you?')
    await vi.waitFor(() => expect(repos.tasks.require(taskId).status).toBe('running'))

    runner.stop(taskId)
    await runner.whenIdle(taskId)

    // The signal reached the terminal service, and stopping ended the run instead of waiting it out.
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    const task = repos.tasks.require(taskId)
    expect(task.status).toBe('idle')
    expect(task.error).toBe('Stopped.')
  })

  it('streams a CLI reply into the timeline as it arrives instead of only after the process exits', async () => {
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({ doStream: async () => { throw new Error('never called') } }),
        provider: 'opencode' as const,
        modelId: 'opencode/big-pickle',
        cli: true as const
      })
    }

    const streamed: string[] = []
    bus.on((ev: any) => {
      if (ev.type === 'task.item' && ev.item?.kind === 'assistant') streamed.push(ev.item.text)
    })

    let finishRun: (() => void) | undefined
    const holdOpen = new Promise<void>((resolve) => {
      finishRun = resolve
    })

    const runner = new TaskRunner({
      repos,
      bus,
      models,
      changes,
      createTools: (ctx) => fileTools(ctx),
      getTerminals: () =>
        ({
          execute: async (_tool: string, _folder: string, _prompt: string, _model: string | undefined, options?: any) => {
            // The CLI answers, then stays alive for a while — the shape that used to show nothing.
            options?.onItem?.({ kind: 'assistant', id: 'a1', at: 1, text: 'I am big-pickle' })
            await holdOpen
            return { text: 'I am big-pickle' }
          }
        }) as any
    })

    await runner.send(taskId, 'What model are you?')
    await vi.waitFor(() => expect(streamed).toContain('I am big-pickle'))

    // The user could read the reply while the CLI was still running.
    expect(repos.tasks.require(taskId).status).toBe('running')
    expect(repos.tasks.messages(taskId).some((m) => m.message.role === 'assistant')).toBe(false)

    finishRun?.()
    await runner.whenIdle(taskId)

    expect(repos.tasks.require(taskId).status).toBe('idle')
    const stored = repos.tasks.messages(taskId)
    expect(stored[stored.length - 1].message.content).toBe('I am big-pickle')
  })

  it('keeps the answer a stopped CLI run had already produced, and reports the stop', async () => {
    const models = {
      resolve: () => ({
        model: new MockLanguageModelV4({ doStream: async () => { throw new Error('never called') } }),
        provider: 'opencode' as const,
        modelId: 'opencode/big-pickle',
        cli: true as const
      })
    }

    const runner = new TaskRunner({
      repos,
      bus,
      models,
      changes,
      createTools: (ctx) => fileTools(ctx),
      getTerminals: () =>
        ({
          execute: async () => ({ text: 'I am big-pickle', stopped: true })
        }) as any
    })

    await runner.send(taskId, 'What model are you?')
    await runner.whenIdle(taskId)

    const task = repos.tasks.require(taskId)
    expect(task.status).toBe('idle')
    expect(task.error).toBe('Stopped.')
    const stored = repos.tasks.messages(taskId)
    expect(stored[stored.length - 1].message.content).toBe('I am big-pickle')
  })
})
