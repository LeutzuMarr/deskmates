import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { guardRiskyTools, runTool } from '../../src/core/tools/shared-prompt-tools'
import { ensureFreebuffPromptTools, PROMPT_MCP_KEY } from '../../src/core/terminals/prompt-tools-config'
import { createPromptServer } from '../../src/bridge/prompt-mcp'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dm-home-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('risky prompt tools outside the Work tab', () => {
  const tools: ToolSet = {
    bash_tool: tool({ description: 'run', inputSchema: z.object({ command: z.string() }), execute: async ({ command }) => `ran ${command}` }),
    web_search: tool({ description: 'search', inputSchema: z.object({ query: z.string() }), execute: async () => 'results' })
  }

  it('asks before a risky tool and runs nothing on no', async () => {
    const asked: string[] = []
    const guarded = guardRiskyTools(tools, async (_name, detail) => {
      asked.push(detail)
      return false
    })
    await expect(runTool(guarded, 'bash_tool', { command: 'dir' })).rejects.toThrow(/didn't allow bash_tool/)
    expect(asked).toEqual(['run bash_tool (command: dir)'])
    expect(await runTool(guarded, 'web_search', { query: 'x' })).toBe('results')
    expect(asked).toHaveLength(1)
  })

  it('runs a risky tool on yes, and refuses names that do not exist', async () => {
    const guarded = guardRiskyTools(tools, async () => true)
    expect(await runTool(guarded, 'bash_tool', { command: 'dir' })).toBe('ran dir')
    await expect(runTool(guarded, 'made_up_tool', {})).rejects.toThrow(/no made_up_tool tool/)
  })
})

describe("Freebuff's home mcp.json", () => {
  it('adds the server next to the user’s own servers and leaves a broken file alone', () => {
    mkdirSync(join(home, '.agents'))
    const file = join(home, '.agents', 'mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: 'x' } } }))
    expect(ensureFreebuffPromptTools('C:\\kit\\deskmates.cmd', home)).toBe('written')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    expect(config.mcpServers.mine).toEqual({ command: 'x' })
    expect(config.mcpServers[PROMPT_MCP_KEY].env).toEqual({ DESKMATES_AGENT: 'Freebuff' })
    expect(readFileSync(file, 'utf8').charCodeAt(0)).not.toBe(0xfeff)
    expect(ensureFreebuffPromptTools('C:\\kit\\deskmates.cmd', home)).toBe('unchanged')
    writeFileSync(file, '{ not json')
    expect(ensureFreebuffPromptTools('C:\\kit\\deskmates.cmd', home)).toBe('skipped')
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})

describe('the deskmates-prompt MCP server', () => {
  const connect = async (call: Parameters<typeof createPromptServer>[0]['call']) => {
    const server = await createPromptServer({ call, folder: 'D:\\proj', agent: 'Freebuff' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(b)
    return client
  }

  it('lists the prompt tools and runs them in the agent’s folder', async () => {
    const calls: unknown[] = []
    const client = await connect((async (method: string, params: unknown) => {
      if (method === 'promptTools.list') return [{ name: 'memory_write', description: 'Write memory.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
      calls.push(params)
      return { text: 'Saved /a.md' }
    }) as never)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['memory_write'])
    const result = await client.callTool({ name: 'memory_write', arguments: { path: '/a.md' } })
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe('Saved /a.md')
    expect(calls).toEqual([{ folder: 'D:\\proj', agent: 'Freebuff', name: 'memory_write', input: { path: '/a.md' } }])
  })

  it('still starts when Deskmates is not running, and says so', async () => {
    const client = await connect((async () => {
      throw new Error('not running')
    }) as never)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['deskmates_prompt_status'])
  })
})
