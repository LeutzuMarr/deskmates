import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './context'
import { MAX_SUBAGENTS } from '../engine/subagents'
import { fileTools } from './files'
import { officeTools } from './office'

export function memoryTools(ctx: ToolContext) {
  return {
    remember: tool({
      description:
        'Save a durable preference or fact about this project so future tasks can use it. Never save passwords, API keys or other secrets.',
      inputSchema: z.object({ fact: z.string().min(1).max(500) }),
      execute: async ({ fact }) => {
        const memory = ctx.memories.add(ctx.projectId, fact.trim())
        ctx.onMemoryUpdated()
        return { saved: true, id: memory.id }
      }
    }),

    forget: tool({
      description: 'Delete a previously saved memory by its id.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        if (!ctx.memories.delete(id, ctx.projectId)) throw new Error('No memory with that id in this project.')
        ctx.onMemoryUpdated()
        return { deleted: id }
      }
    })
  }
}

type PlanStatus = 'pending' | 'in_progress' | 'done'

/** Shows a plan on the task list: Deskmates' items, or Claude in Chrome's approach and domains. */
export function runPlan(
  ctx: Pick<ToolContext, 'onPlan'>,
  items: Array<{ text: string; status: PlanStatus }> | undefined,
  domains?: string[],
  approach?: string[]
): Record<string, unknown> {
  const list = items?.length ? items : (approach ?? []).slice(0, 20).map((text, i) => ({ text: text.slice(0, 200), status: (i === 0 ? 'in_progress' : 'pending') as PlanStatus }))
  if (list.length === 0) throw new Error('Send items (the task list), or approach (the steps of a Chrome task).')
  ctx.onPlan(list)
  return {
    ok: true,
    items: list.length,
    ...(domains?.length ? { domains, note: "The plan is on the user's task list. Each site is still asked about once, the first time you act on it." } : {})
  }
}

export function agentTools(ctx: ToolContext) {
  return {
    ...memoryTools(ctx),

    update_plan: tool({
      description:
        "The task list the user watches under the chat. For any request with more than one step, call it as your very first tool call with the whole plan (short steps, the one you start in_progress, the rest pending), and again each time a step finishes (that step done, the next in_progress) or the plan changes. Send the whole list every time. Between steps, write one short sentence saying what you are doing now, and say what you found as soon as you find it, so the user always knows where you are.",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              text: z.string().min(1).max(200),
              status: z.enum(['pending', 'in_progress', 'done'])
            })
          )
          .min(1)
          .max(20)
          .optional(),
        // The Claude in Chrome form of the same tool: the sites a browser task will use and its steps.
        domains: z.array(z.string()).optional().describe('Chrome tasks: the sites you will visit'),
        approach: z.array(z.string().min(1)).max(20).optional().describe('Chrome tasks: the steps, in order (the first becomes in_progress)')
      }),
      execute: async ({ items, domains, approach }) => runPlan(ctx, items, domains, approach)
    }),

    notify_user: tool({
      description: 'Show a short desktop notification to the user, for example when a long task finishes.',
      inputSchema: z.object({
        title: z.string().min(1).max(80),
        message: z.string().min(1).max(300)
      }),
      execute: async ({ title, message }) => {
        ctx.onNotify(title, message)
        return { shown: true }
      }
    })
  }
}

/** The tools a delegated child may use: safe file reads plus memory, nothing that writes or runs commands. */
export function readOnlySubagentTools(ctx: ToolContext): ToolSet {
  const { list_files, read_file, search_files } = fileTools(ctx)
  const { read_document } = officeTools(ctx)
  const { remember } = memoryTools(ctx)
  return { list_files, read_file, search_files, read_document, remember }
}

/** The `delegate` tool a run gets when sub-agents are wired up (spec 5.1); merged only when ctx.subagents is present. */
export function subagentTools(ctx: ToolContext) {
  return {
    delegate: tool({
      description: `Run up to ${MAX_SUBAGENTS} independent sub-agents in parallel and get each one's report. Use this for a task you can split into separate focused questions, for example researching different parts of the project at the same time. Each sub-agent gets its own context and can only read files and use memory - it cannot write files or run commands. Their reports come back as the final text of each sub-agent.`,
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              id: z.string().min(1).max(50).describe('A short unique name for this sub-agent, used to match its report.'),
              instruction: z
                .string()
                .min(1)
                .max(2000)
                .describe('The focused task for this sub-agent, written as a self-contained assignment.')
            })
          )
          .min(1)
          .max(MAX_SUBAGENTS)
      }),
      execute: async ({ tasks }) => {
        if (!ctx.subagents) throw new Error('Sub-agents are not set up yet.')
        const results = await ctx.subagents.run({
          tasks,
          model: ctx.modelRef,
          tools: readOnlySubagentTools(ctx)
        })
        return { results }
      }
    })
  }
}
