/**
 * Sub-agents (spec 5.1): a `delegate` tool starts child agents in parallel, each with its own
 * context and a read-only subset of tools, and reports each child's result back to the parent.
 */
import {
  ToolLoopAgent,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type ToolSet
} from 'ai'
import type { ModelRef, ProviderId } from '../../shared/protocol'

/** Hard cap on how many child agents one delegate call runs (spec: up to 4 by default). */
export const MAX_SUBAGENTS = 4
/** Stop condition for a child run (spec: default 15 steps). */
export const SUBAGENT_STOP_STEPS = 15

/** A system preamble every child gets, so the model knows its role. */
const SUBAGENT_PREAMBLE =
  'You are a focused sub-agent working on one part of a larger task. Work only on your assignment and ' +
  "finish by reporting your findings as your final message. You can read files and use memory, but you " +
  'cannot write files, run commands, or talk to the user - the parent agent receives your report instead.'

export interface SubagentTask {
  id: string
  instruction: string
}

export interface SubagentResult {
  id: string
  text: string
  error?: string
}

export interface SubagentRunRequest {
  /** One focused assignment per child. Tasks beyond MAX_SUBAGENTS are dropped. */
  tasks: SubagentTask[]
  /** Which model the children use; resolved through the same resolver as the parent. */
  model: ModelRef
  /** The read-only tool subset the children may use. */
  tools: ToolSet
  /** Extra system context every child gets in addition to its own instruction. */
  instructions?: string
  abortSignal?: AbortSignal
}

/** Injected into a run so the delegate tool can start children; absent until wired. */
export interface SubagentRunner {
  run(request: SubagentRunRequest): Promise<SubagentResult[]>
}

/** The runner only needs the same model resolver the parent run uses. */
export interface SubagentDeps {
  models: {
    resolve(ref: ModelRef | null): { model: LanguageModel; provider: ProviderId; modelId: string; cli?: boolean }
  }
}

export function createSubagentRunner(deps: SubagentDeps): SubagentRunner {
  return { run: (request) => runSubagents(deps, request) }
}

/**
 * Runs the child agents with a simple promise pool of width MAX_SUBAGENTS. Each child gets a
 * ToolLoopAgent with a model resolved through the same resolver, the shared read-only tools and a
 * step cap; every child's final output is returned, and a failing child yields an error without
 * affecting the others.
 */
export async function runSubagents(deps: SubagentDeps, request: SubagentRunRequest): Promise<SubagentResult[]> {
  const tasks = request.tasks.slice(0, MAX_SUBAGENTS)
  return promisePool(tasks, MAX_SUBAGENTS, async (task) => {
    const { model, cli } = deps.models.resolve(request.model)
    // CLI-backed providers route the parent run outside the tool loop, so children can't be spawned.
    if (cli) {
      return {
        id: task.id,
        text: '',
        error: "This model runs through a local CLI session, which can't spawn subagents yet. Pick an API-backed model."
      }
    }
    return runChild(model, request, task)
  })
}

async function runChild(model: LanguageModel, request: SubagentRunRequest, task: SubagentTask): Promise<SubagentResult> {
  try {
    const instructions = [request.instructions, SUBAGENT_PREAMBLE, `Your assignment:\n${task.instruction}`]
      .filter((part) => Boolean(part))
      .join('\n\n')

    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools: request.tools,
      stopWhen: isStepCount(SUBAGENT_STOP_STEPS)
    })

    const result = await agent.stream({
      messages: [{ role: 'user', content: task.instruction }] as ModelMessage[],
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {})
    })

    let text = ''
    let firstError: unknown = null
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        text += (part as { delta?: string; text?: string }).delta ?? (part as { text?: string }).text ?? ''
      }
      if (part.type === 'error' && !firstError) {
        firstError = part.error
      }
    }

    if (firstError) {
      return { id: task.id, text: text.trim(), error: firstError instanceof Error ? firstError.message : String(firstError) }
    }
    return { id: task.id, text: text.trim() }
  } catch (error) {
    return { id: task.id, text: '', error: error instanceof Error ? error.message : String(error) }
  }
}

/** A promise pool of the given width; per-item failures are the caller's to handle (runChild never throws). */
async function promisePool<T, R>(
  items: T[],
  width: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await run(items[index], index)
      }
    })
  )
  return results
}