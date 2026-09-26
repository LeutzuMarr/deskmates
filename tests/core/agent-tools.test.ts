import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentTools } from '../../src/core/tools/agent-tools'
import { makeTestContext, runTool, type TestContext } from './helpers'

let t: TestContext
let tools: ReturnType<typeof agentTools>

beforeEach(() => {
  t = makeTestContext()
  tools = agentTools(t.ctx)
})
afterEach(() => t.cleanup())

describe('remember and forget', () => {
  it('adds then removes a memory, notifying the context both times', async () => {
    const saved = await runTool(tools.remember, { fact: 'Prefers dark mode' })
    expect(saved.saved).toBe(true)
    expect(t.repos.memories.list(t.projectId)).toHaveLength(1)

    const forgotten = await runTool(tools.forget, { id: saved.id })
    expect(forgotten).toEqual({ deleted: saved.id })
    expect(t.repos.memories.list(t.projectId)).toHaveLength(0)
    expect(t.events.memory).toBe(2)
  })

  it('refuses to forget a memory that belongs to another project', async () => {
    const other = t.repos.projects.create('Other', 'C:\\other')
    const memory = t.repos.memories.add(other.id, 'Not yours')
    await expect(runTool(tools.forget, { id: memory.id })).rejects.toThrow(
      'No memory with that id in this project.'
    )
  })
})

describe('update_plan', () => {
  it('pushes the whole plan to the task', async () => {
    const items = [{ text: 'Step one', status: 'in_progress' as const }]
    const result = await runTool(tools.update_plan, { items })
    expect(result).toEqual({ ok: true, items: 1 })
    expect(t.events.plans).toEqual([items])
  })
})

describe('notify_user', () => {
  it('shows a notification to the user', async () => {
    const result = await runTool(tools.notify_user, { title: 'Done', message: 'Task finished' })
    expect(result).toEqual({ shown: true })
    expect(t.events.notes).toEqual([{ title: 'Done', body: 'Task finished' }])
  })
})
