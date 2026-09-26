import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { guide, designList, designRead, designWrite, designCreate, type Call } from './actions'

export const SERVER_NAME = 'deskmates'
export const SERVER_VERSION = '0.1.0'

/** The server instructions any MCP client shows its model when connecting. */
export const SERVER_INSTRUCTIONS = `Deskmates is a Windows desktop app the user runs: a Work tab where an assistant works in project folders, a Design tab of web pages the user designs with AI and edits by hand in a live preview, and bot PCs (small Linux computers where the user's bots browse the web and send messages). Designs are one self-contained index.html each, with inline CSS, responsive at 1440/834/390 px, keeping every data-dm-id attribute, and no trackers. Never type passwords or one-time codes into a bot PC, and never message anyone except the user from a bot's accounts. Call deskmates_guide before your first Deskmates action in a conversation.`
/** Turns a thrown action into a tool error result; a success into a text result. */
async function asToolResult(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await run() }] }
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true
    }
  }
}

/**
 * Builds the Deskmates MCP server over a `call` function (the real WebSocket
 * client in production, a fake in tests). Connect it to a transport yourself.
 */
export function createDeskmatesServer(options: { call: Call; dataDir: string; appVersion?: string }): McpServer {
  const { call } = options
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: SERVER_INSTRUCTIONS
  })

  server.registerTool('deskmates_guide', {
    description:
      'Prints the Deskmates guide for coding agents: how the Design tab works, the design rules, the bot PCs and the check-in. Call it before your first Deskmates action in a conversation.',
    inputSchema: {}
  }, () => asToolResult(async () => guide(options.dataDir)))

  server.registerTool('design_list', {
    description: 'Lists the user\u2019s designs (id, name and folder). Designs are projects of kind "design".',
    inputSchema: {}
  }, () => asToolResult(async () => JSON.stringify(await designList(call), null, 2)))

  server.registerTool('design_read', {
    description: 'Reads a design\u2019s index.html. Keep every data-dm-id attribute when you change it.',
    inputSchema: { id: z.string().describe('The design id from design_list.') }
  }, (args) => asToolResult(async () => (await designRead(call, args.id)).html))

  server.registerTool('design_write', {
    description:
      'Replaces a design\u2019s index.html. One self-contained file with inline CSS, responsive at 1440/834/390 px, keep every data-dm-id, no trackers. The preview reloads by itself. Don\u2019t edit while the Deskmates assistant works on it.',
    inputSchema: {
      id: z.string().describe('The design id.'),
      html: z.string().describe('The complete new HTML.')
    }
  }, (args) => asToolResult(async () => {
    const saved = await designWrite(call, args.id, args.html)
    return `Saved. The preview reloads by itself (updatedAt ${saved.updatedAt}).`
  }))

  server.registerTool('design_create', {
    description: 'Creates a new design. With a prompt, the Deskmates assistant also starts building it.',
    inputSchema: {
      name: z.string().describe('The design\u2019s name.'),
      prompt: z.string().optional().describe('An optional first instruction for the assistant.')
    }
  }, (args) => asToolResult(async () => {
    const created = await designCreate(call, args.name, args.prompt)
    return `Created "${created.project.name}" (${created.project.id}) in ${created.project.folder}.`
  }))
  // The pc tools stay stubs until stage 2; the guide's PC section says so too.
  const pcNotReady = (): Promise<CallToolResult> =>
    asToolResult(async () => {
      throw new Error("Bot PCs aren't set up on this computer yet. Open Deskmates → Bots → Set up bot PCs first.")
    })

  server.registerTool('pc_list', {
    description: 'Lists the bot PCs and whether each is busy. Check this before using a PC, and don\u2019t interrupt a busy one.',
    inputSchema: {}
  }, () => pcNotReady())

  server.registerTool('pc_exec', {
    description: 'Runs a shell command on a bot PC. Never type passwords or one-time codes into a PC.',
    inputSchema: {
      pc: z.string().describe('The PC name from pc_list.'),
      command: z.string().describe('The command to run.')
    }
  }, () => pcNotReady())

  server.registerTool('pc_open', {
    description: 'Opens a page in a bot PC\u2019s browser. For logins, ask the user to use Take over in Deskmates.',
    inputSchema: {
      pc: z.string().describe('The PC name from pc_list.'),
      url: z.string().describe('The page to open.')
    }
  }, () => pcNotReady())

  server.registerTool('pc_screenshot', {
    description: 'Takes a screenshot of a bot PC so you can see its screen.',
    inputSchema: { pc: z.string().describe('The PC name from pc_list.') }
  }, () => pcNotReady())

  return server
}

/** Creates the server and connects it to stdio; resolves when it closes. */
export async function runMcpServerOnStdio(options: { call: Call; dataDir: string; appVersion?: string }): Promise<void> {
  const server = createDeskmatesServer(options)
  await server.connect(new StdioServerTransport())
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve()
  })
}

