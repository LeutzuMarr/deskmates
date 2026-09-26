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

export function agentTools(ctx: ToolContext) {
  return {
    ...memoryTools(ctx),

    update_plan: tool({
      description:
        'Show your step-by-step plan for this task and keep it current. Send the whole list every time. Mark the step you are working on as in_progress and finished steps as done.',
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
      }),
      execute: async ({ items }) => {
        ctx.onPlan(items)
        return { ok: true, items: items.length }
      }
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
