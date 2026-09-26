import { afterEach, describe, expect, it } from 'vitest'
import { simulateReadableStream, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import {
  MAX_SUBAGENTS,
  SUBAGENT_STOP_STEPS,
  createSubagentRunner,
  runSubagents,
  type SubagentRunRequest
} from '../../src/core/engine/subagents'
import { agentTools, subagentTools } from '../../src/core/tools/agent-tools'
import { buildTools } from '../../src/core/tools'
import { makeTestContext, runTool, type TestContext } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeCtx(): TestContext {
  const t = makeTestContext()
  cleanups.push(t.cleanup)
  return t
}

/** Helper matching the ModelResolver shape the runner passes into the subagent deps. */
function modelsDeps(model: MockLanguageModelV4) {
  return {
    models: {
      resolve: () => ({ model, provider: 'google' as const, modelId: 'test-model', cli: false })
    }
  }
}

/** A deps object that hands out a fresh scripted model per resolve call (one per child); mocks lets the test inspect them. */
function sequencedDeps(makeModel: () => MockLanguageModelV4) {
  const mocks: MockLanguageModelV4[] = []
  const models = {
    resolve: () => {
      const model = makeModel()
      mocks.push(model)
      return { model, provider: 'google' as const, modelId: 'test-model', cli: false }
    }
  }
  return { models, mocks }
}

function textStream(text: string, id = 't1') {
  return simulateReadableStream({
    chunks: [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: text },
      { type: 'text-end', id },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
    ] as any[]
  })
}

function toolCallStream(toolName: string, toolCallId = 'c1', input = '{}') {
  return simulateReadableStream({
    chunks: [
      { type: 'tool-call', toolCallId, toolName, input },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
    ] as any[]
  })
}

function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: textStream(text) }) })
}

describe('subagentTools delegate tool', () => {
  it('is only offered by buildTools when the run has a subagent runner', () => {
    const t = makeCtx()
    expect(buildTools(t.ctx).delegate).toBeUndefined()

    t.ctx.subagents = { run: async () => [] }
    expect(buildTools(t.ctx).delegate).toBeDefined()
  })

  it('exposes only the delegate tool and validates its input against the concurrency cap', () => {
    const t = makeCtx()
    t.ctx.subagents = { run: async () => [] }
    const group = subagentTools(t.ctx)
    expect(Object.keys(group)).toEqual(['delegate'])
    const schema = (group.delegate as any).inputSchema as z.ZodType

    const task = { id: 'a', instruction: 'Investigate' }
    expect(schema.safeParse({ tasks: [] }).success).toBe(false)
    expect(schema.safeParse({ tasks: [task] }).success).toBe(true)
    expect(schema.safeParse({ tasks: Array.from({ length: MAX_SUBAGENTS }, () => task) }).success).toBe(true)
    expect(schema.safeParse({ tasks: Array.from({ length: MAX_SUBAGENTS + 1 }, () => task) }).success).toBe(false)
  })

  it('runs children through ctx.subagents with the project model and only read-only tools', async () => {
    const t = makeCtx()
    const calls: SubagentRunRequest[] = []
    t.ctx.subagents = {
      run: async (request) => {
        calls.push(request)
        return [{ id: 'a', text: 'Found it' }]
      }
    }

    const result = await runTool(subagentTools(t.ctx).delegate, {
      tasks: [{ id: 'a', instruction: 'Check the README' }]
    })

    expect(result).toEqual({ results: [{ id: 'a', text: 'Found it' }] })
    const captured = calls[0]
    expect(captured.model).toEqual({ provider: 'google', modelId: 'test-model' })
    expect(captured.tasks).toEqual([{ id: 'a', instruction: 'Check the README' }])
    expect(Object.keys(captured.tools).sort()).toEqual([
      'list_files',
      'read_document',
      'read_file',
      'remember',
      'search_files'
    ])
  })

  it('refuses to run when no subagent runner is wired, without touching the parent memory tools', async () => {
    const t = makeCtx()
    const group = agentTools(t.ctx)
    expect(typeof group.remember).toBe('object')
    expect(typeof group.forget).toBe('object')
    await expect(runTool(subagentTools(t.ctx).delegate, { tasks: [{ id: 'a', instruction: 'x' }] })).rejects.toThrow(
      'Sub-agents are not set up yet.'
    )
  })
})

describe('runSubagents', () => {
  it('resolves the model through the same resolver and returns each child report', async () => {
    const results = await runSubagents(modelsDeps(textModel('Alpha')), {
      tasks: [
        { id: 'a', instruction: 'one' },
        { id: 'b', instruction: 'two' }
      ],
      model: { provider: 'google', modelId: 'm' },
      tools: {}
    })
    expect(results).toEqual([
      { id: 'a', text: 'Alpha' },
      { id: 'b', text: 'Alpha' }
    ])
  })

  it('caps concurrency at MAX_SUBAGENTS with a promise pool, dropping excess tasks', async () => {
    let active = 0
    let maxActive = 0
    const stall = tool({
      inputSchema: z.object({}),
      execute: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => setTimeout(resolve, 60))
        active--
        return { ok: true }
      }
    })

    const { models } = sequencedDeps(() => {
      let calls = 0
      return new MockLanguageModelV4({
        doStream: async () =>
          calls++ === 0 ? { stream: toolCallStream('stall') } : { stream: textStream('done') }
      })
    })

    const tasks = Array.from({ length: MAX_SUBAGENTS * 2 }, (_, i) => ({
      id: `c${i}`,
      instruction: `task ${i}`
    }))

    const results = await runSubagents({ models }, {
      tasks,
      model: { provider: 'google', modelId: 'm' },
      tools: { stall }
    })

    expect(maxActive).toBe(MAX_SUBAGENTS)
    expect(maxActive).toBeLessThanOrEqual(MAX_SUBAGENTS)
    expect(results).toHaveLength(MAX_SUBAGENTS)
    expect(results.every((r) => r.text === 'done' && !r.error)).toBe(true)
  })

  it('returns every result even when a child fails, with the failure isolated to that child', async () => {
    let created = 0
    const { models } = sequencedDeps(() => {
      created++
      if (created === 1) {
        return new MockLanguageModelV4({
          doStream: async () => {
            throw new Error('boom')
          }
        })
      }
      return textModel('ok')
    })

    const results = await runSubagents({ models }, {
      tasks: [
        { id: 'a', instruction: 'first' },
        { id: 'b', instruction: 'second' }
      ],
      model: { provider: 'google', modelId: 'm' },
      tools: {}
    })

    expect(results).toHaveLength(2)
    const failed = results.find((r) => r.error)
    expect(failed?.error).toContain('boom')
    expect(failed?.text).toBe('')
    expect(results.filter((r) => !r.error).map((r) => r.text)).toContain('ok')
  })

  it('stops a child that keeps calling tools at SUBAGENT_STOP_STEPS', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: toolCallStream('ping', 'p1') })
    })

    const results = await runSubagents(modelsDeps(model), {
      tasks: [{ id: 'a', instruction: 'loop forever' }],
      model: { provider: 'google', modelId: 'm' },
      tools: {
        ping: tool({
          inputSchema: z.object({}),
          execute: async () => ({ pong: true })
        })
      }
    })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('a')
    expect(results[0].error).toBeUndefined()
    expect(model.doStreamCalls).toHaveLength(SUBAGENT_STOP_STEPS)
  })
})

describe('createSubagentRunner', () => {
  it('produces a runner wired to the resolver', async () => {
    const runner = createSubagentRunner(modelsDeps(textModel('hi')))
    const results = await runner.run({
      tasks: [{ id: 'a', instruction: 'Say hi' }],
      model: { provider: 'google', modelId: 'm' },
      tools: {}
    })
    expect(results[0].text).toBe('hi')
  })
})