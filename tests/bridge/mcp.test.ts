import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { RpcMethod, RpcParams, RpcResult } from '../../src/shared/protocol'
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, createDeskmatesServer } from '../../src/bridge/mcp'
import { writeAgentGuide } from '../../src/core/agents/guide'
import { PCS_NOT_SET_UP, type Call } from '../../src/bridge/actions'

const DESIGN_ID = '5f0b3c2e-1a4b-4c8d-9e2f-3a1b2c3d4e5f'

const WORK_PROJECT = { id: 'p-work', name: 'Invoices', folder: 'D:\\d\\work', kind: 'work' as const, model: null, createdAt: 1 }
const DESIGN_PROJECT = { id: DESIGN_ID, name: 'Landing page', folder: 'D:\\d\\designs\\5f0b', kind: 'design' as const, model: null, createdAt: 2 }
const ANOTHER_DESIGN = { id: '8a2c4e6b-3d1f-4a9b-8c5e-7f0d1e2a3b4c', name: 'Pricing', folder: 'D:\\d\\designs\\8a2c', kind: 'design' as const, model: null, createdAt: 3 }

let tempDir: string

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

function makeDataDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'deskmates-mcp-'))
  writeAgentGuide({ dataDir: tempDir, commandPath: join(tempDir, 'agent-kit', 'deskmates.cmd'), appVersion: '0.1.0', pcs: { installed: false } })
  return tempDir
}

interface RecordedCall {
  method: RpcMethod
  params: unknown
}

/** A fake core that answers from a canned table and records every call. */
function fakeCore(replies: Partial<Record<RpcMethod, (params: unknown) => unknown>> = {}): { call: Call; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const call = (async <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
    calls.push({ method, params })
    const reply = replies[method]
    if (!reply) throw new Error(`Unexpected call to ${method}`)
    return reply(params) as RpcResult<M>
  }) as Call
  return { call, calls }
}

/** Connects a fresh server and client over linked in-memory transports. */
async function connect(replies: Partial<Record<RpcMethod, (params: unknown) => unknown>> = {}): Promise<{
  client: Client
  calls: RecordedCall[]
  dataDir: string
}> {
  const dataDir = makeDataDir()
  const { call, calls } = fakeCore(replies)
  const server = createDeskmatesServer({ call, dataDir })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, calls, dataDir }
}

/** Calls a tool and returns its text (or throws when the result is an error). */
async function callToolText(client: Client, name: string, args?: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args ?? {} })
  if (result.isError) throw new Error(resultText(result))
  return resultText(result)
}

function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return content.map((part) => part.text ?? '').join('\n')
}

describe('createDeskmatesServer', () => {
  it('lists all nine tools', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'design_create',
      'design_list',
      'design_read',
      'design_write',
      'deskmates_guide',
      'pc_exec',
      'pc_list',
      'pc_open',
      'pc_screenshot'
    ])
  })

  it('gives every tool a description', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.description, `tool ${tool.name}`).toBeTruthy()
      expect(tool.description!.length).toBeGreaterThan(10)
    }
  })

  it('sends server instructions with the key rules', async () => {
    const { client } = await connect()
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('data-dm-id')
    expect(instructions).toContain('self-contained')
    expect(instructions).toContain('1440/834/390')
    expect(instructions).toContain('password')
    expect(instructions).toContain('deskmates_guide')
    expect(SERVER_INSTRUCTIONS).toBe(instructions)
  })

  it('reports the server name and version', async () => {
    const { client } = await connect()
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME)
    expect(client.getServerVersion()?.version).toBe(SERVER_VERSION)
  })

  it('deskmates_guide returns the written guide file', async () => {
    const { client, dataDir } = await connect()
    const text = await callToolText(client, 'deskmates_guide')
    expect(text).toBe(readFileSync(join(dataDir, 'agent-kit', 'DESKMATES-AGENTS.md'), 'utf8'))
  })

  it('design_list returns only the designs as JSON', async () => {
    const { client, calls } = await connect({
      'projects.list': () => [WORK_PROJECT, DESIGN_PROJECT, ANOTHER_DESIGN]
    })
    const text = await callToolText(client, 'design_list')
    expect(calls).toEqual([{ method: 'projects.list', params: {} }])
    expect(JSON.parse(text)).toEqual([
      { id: DESIGN_PROJECT.id, name: DESIGN_PROJECT.name, folder: DESIGN_PROJECT.folder },
      { id: ANOTHER_DESIGN.id, name: ANOTHER_DESIGN.name, folder: ANOTHER_DESIGN.folder }
    ])
  })

  it('design_read returns the html', async () => {
    const { client } = await connect({ 'designs.read': () => ({ html: '<p>hi</p>', updatedAt: 5 }) })
    const text = await callToolText(client, 'design_read', { id: DESIGN_ID })
    expect(text).toBe('<p>hi</p>')
  })

  it('design_write saves and confirms the reload', async () => {
    const { client, calls } = await connect({ 'designs.save': () => ({ updatedAt: 9 }) })
    const text = await callToolText(client, 'design_write', { id: DESIGN_ID, html: '<p>new</p>' })
    expect(text).toContain('Saved')
    expect(text).toContain('reloads')
    expect(calls).toEqual([
      { method: 'designs.save', params: { projectId: DESIGN_ID, html: '<p>new</p>', reason: 'external' } }
    ])
  })

  it('design_create creates and names the design', async () => {
    const { client, calls } = await connect({ 'designs.create': () => ({ project: DESIGN_PROJECT, task: { id: 't1' } }) })
    const text = await callToolText(client, 'design_create', { name: 'Landing page' })
    expect(text).toContain('Landing page')
    expect(text).toContain(DESIGN_ID)
    expect(calls[0].params).toEqual({ name: 'Landing page' })
  })

  it('a tool whose action throws returns isError true with the message', async () => {
    const { client } = await connect({
      'projects.list': () => {
        throw new Error('core is on fire')
      }
    })
    const result = await client.callTool({ name: 'design_list', arguments: {} })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('core is on fire')
  })

  it.each(['pc_list', 'pc_exec', 'pc_open', 'pc_screenshot'] as const)('%s returns the not-set-up error result', async (name) => {
    const { client } = await connect()
    const args =
      name === 'pc_exec' ? { pc: 'pc1', command: 'ls' } :
      name === 'pc_open' ? { pc: 'pc1', url: 'https://example.com' } :
      name === 'pc_screenshot' ? { pc: 'pc1' } :
      {}
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(PCS_NOT_SET_UP)
    expect(resultText(result)).toContain('Set up bot PCs')
  })
})
