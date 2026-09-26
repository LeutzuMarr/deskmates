import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanItem } from '../../src/shared/protocol'
import { ChangeLog } from '../../src/core/fs/change-log'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import type { ToolContext } from '../../src/core/tools/context'

export interface TestContext {
  base: string
  root: string
  repos: Repos
  changes: ChangeLog
  ctx: ToolContext
  projectId: string
  taskId: string
  events: { plans: PlanItem[][]; notes: Array<{ title: string; body: string }>; changes: number; memory: number }
  cleanup(): void
}

export function makeTestContext(): TestContext {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-')))
  const root = join(base, 'project')
  mkdirSync(root)
  const repos = createRepos(openDatabase(':memory:'))
  const project = repos.projects.create('Test', root)
  const task = repos.tasks.create(project.id)
  const changes = new ChangeLog(repos.changes, join(base, 'snapshots'))
  const events: TestContext['events'] = { plans: [], notes: [], changes: 0, memory: 0 }
  const ctx: ToolContext = {
    taskId: task.id,
    projectId: project.id,
    root,
    changes,
    memories: repos.memories,
    modelRef: { provider: 'google', modelId: 'test-model' },
    onPlan: (items) => events.plans.push(items),
    onNotify: (title, body) => events.notes.push({ title, body }),
    onChangesUpdated: () => void events.changes++,
    onMemoryUpdated: () => void events.memory++
  }
  return {
    base,
    root,
    repos,
    changes,
    ctx,
    projectId: project.id,
    taskId: task.id,
    events,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

type ExecutableTool = { execute?: (input: never, options: never) => unknown }

/** Calls a tool's execute function directly, the way the agent loop would after validating input. */
export async function runTool<T = any>(tool: ExecutableTool, input: unknown): Promise<T> {
  if (!tool.execute) throw new Error('Tool has no execute function')
  const options = { toolCallId: 'test-call', messages: [], context: undefined, abortSignal: undefined }
  return (await tool.execute(input as never, options as never)) as T
}
