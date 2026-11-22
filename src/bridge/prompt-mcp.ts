/**
 * The deskmates-prompt MCP server: the tools the user's operating prompt (prompts/fable/claude-fable-5.2.md) describes,
 * under their own names and schemas, for command-line agents (Freebuff, OpenCode, Antigravity).
 * Each call runs in the Deskmates app, on the same machinery as the Work tab's tools, in the folder
 * the agent works in. Risky tools ask the user in the app first.
 *
 * It starts even when Deskmates isn't running, so the agent never fails to start because of it: it
 * then offers one tool that says so. Each call connects afresh, so an app restart doesn't break it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { jsonSchemaToZod } from '../core/connectors/schema'
import { NOT_RUNNING_MESSAGE } from './client'
import type { Call } from './actions'

export const PROMPT_SERVER_NAME = 'deskmates-prompt'

export interface PromptServerOptions {
  /** Runs one core call on a fresh connection; throws when Deskmates isn't running. */
  call: Call
  /** The folder the agent works in. */
  folder: string
  /** Who is asking, as the user reads it in question cards ("Freebuff", "OpenCode"). */
  agent: string
}

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) })

/** The input schema for the MCP SDK, from a JSON schema. A whole loose object, not a shape: a shape
 *  would drop every argument the schema doesn't list (all of them, for a tool listed without one). */
function inputSchemaOf(schema: Record<string, unknown>): z.ZodTypeAny {
  const parsed = jsonSchemaToZod(schema)
  return parsed instanceof z.ZodObject ? parsed : z.looseObject({})
}

export async function createPromptServer(options: PromptServerOptions): Promise<McpServer> {
  const server = new McpServer(
    { name: PROMPT_SERVER_NAME, version: '0.1.0' },
    {
      instructions:
        "These are the tools your operating prompt describes (plus the user's Chrome and the guides read on demand: read_chrome_instructions, read_research_instructions), run by the Deskmates app on the user's PC in your folder. Call them by these names. Tools that send, delete, share or run commands ask the user in Deskmates first; if the user says no, nothing happened. Only report results these tools actually returned."
    }
  )
  let tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = []
  try {
    tools = await options.call('promptTools.list', {})
  } catch {
    tools = []
  }
  if (tools.length === 0) {
    server.registerTool(
      'deskmates_prompt_status',
      { description: "Why the operating prompt's tools aren't here right now. Call it before telling the user anything about them.", inputSchema: {} },
      async () => text(`${NOT_RUNNING_MESSAGE} The operating prompt's tools (Gmail, memory, docs, widgets…) come from the Deskmates app. None of them can run until it is started; say so instead of guessing their results.`)
    )
    return server
  }
  for (const info of tools) {
    server.registerTool(info.name, { description: info.description, inputSchema: inputSchemaOf(info.inputSchema) }, async (raw: unknown) => {
      const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      try {
        const result = await options.call('promptTools.call', { folder: options.folder, agent: options.agent, name: info.name, input: args ?? {} })
        return text(result.text)
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true)
      }
    })
  }
  return server
}

export async function runPromptMcpServerOnStdio(options: PromptServerOptions): Promise<void> {
  const server = await createPromptServer(options)
  await server.connect(new StdioServerTransport())
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve()
  })
}
