/**
 * The operating prompt's tools for agents that don't run in the Work tab's own tool loop: Freebuff,
 * OpenCode and Antigravity (through the deskmates-prompt MCP server), bots and Duo. They get the
 * same tools under the same names, built on the same machinery. The Work tab asks before risky
 * tools with an approval card in its chat; these agents have no such chat, so the tool itself asks
 * the user in the app first (the question card the agent browser already shows), and runs only on yes.
 */
import { tool, type Tool, type ToolSet } from 'ai'
import { approvalFor } from '../engine/approvals'
import { promptToolSpecs } from '../engine/my-prompt'

/** One prompt tool as an MCP server lists it: the prompt's own description and JSON schema. */
export interface PromptToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Deskmates' own tools that agents outside the tool loop get too: the task list the user watches. */
export const APP_TOOL_NAMES = ['update_plan'] as const

const UPDATE_PLAN_INFO: PromptToolInfo = {
  name: 'update_plan',
  description:
    'The task list the user watches at the end of the chat in Deskmates. For any request with more than one step, call it first with the whole plan (short steps, the one you start in_progress, the rest pending), and again each time a step finishes or the plan changes. Send the whole list every time.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text', 'status'] }
      }
    },
    required: ['items']
  }
}

/** The prompt's tools that have a schema, as the prompt describes them, plus the task list. */
export function promptToolInfos(): PromptToolInfo[] {
  const out: PromptToolInfo[] = [UPDATE_PLAN_INFO]
  for (const [name, spec] of promptToolSpecs()) {
    if (!spec.schema || typeof spec.schema !== 'object') continue
    const schema = spec.schema as Record<string, unknown>
    out.push({ name, description: spec.description || `The ${name} tool from the operating prompt.`, inputSchema: { type: 'object', ...schema } })
  }
  return out
}

/** Asks the user whether `agent` may run tool `name`; resolves true only on a yes. */
export type AskToRun = (name: string, detail: string) => Promise<boolean>

/** A short, readable account of a tool call for the question card. */
export function describeCall(name: string, input: unknown): string {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const key = ['command', 'to', 'subject', 'path', 'fileId', 'summary', 'name', 'url'].find((k) => typeof fields[k] === 'string' && fields[k])
  const value = key ? String(fields[key]).replace(/\s+/g, ' ').slice(0, 160) : ''
  return value ? `run ${name} (${key}: ${value})` : `run ${name}`
}

/**
 * Wraps every tool that the Work tab would ask about (approvalFor) so it asks first. A "no" or no
 * answer runs nothing and says so, in words the model can't mistake for a result.
 */
export function guardRiskyTools(tools: ToolSet, ask: AskToRun): ToolSet {
  const out: ToolSet = {}
  for (const [name, original] of Object.entries(tools)) {
    const execute = (original as { execute?: (input: unknown, options: unknown) => Promise<unknown> }).execute
    if (!execute || approvalFor(name, []) !== 'user-approval') {
      out[name] = original
      continue
    }
    out[name] = tool({
      ...(original as Tool),
      execute: async (input: unknown, options: unknown) => {
        const allowed = await ask(name, describeCall(name, input))
        if (!allowed) throw new Error(`The user didn't allow ${name}, so nothing was done. Don't retry it; tell the user what you wanted to do instead.`)
        return execute(input, options)
      }
    } as Tool) as Tool
  }
  return out
}

/** Only the tools the prompt names, out of a run's full tool set. */
export function pickPromptTools(all: ToolSet): ToolSet {
  const names = new Set<string>([...promptToolSpecs().keys(), ...APP_TOOL_NAMES])
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(all)) if (names.has(name)) out[name] = t
  return out
}

/** Runs one tool by name for a bridged call; the result as text, the way MCP returns it. */
export async function runTool(tools: ToolSet, name: string, input: unknown): Promise<string> {
  const chosen = tools[name] as { inputSchema?: unknown; execute?: (input: unknown, options: unknown) => Promise<unknown> } | undefined
  if (!chosen?.execute) throw new Error(`There is no ${name} tool here. Only the tools in your list exist; don't describe a result you didn't get.`)
  const result = await chosen.execute(input ?? {}, { toolCallId: 'bridge', messages: [] })
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
}
