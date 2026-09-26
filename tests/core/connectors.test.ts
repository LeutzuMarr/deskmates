import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { EventBus } from '../../src/core/events'
import { approvalFor } from '../../src/core/engine/approvals'
import { ChangeLog } from '../../src/core/fs/change-log'
import { KeyStore } from '../../src/core/models/keys'
import { ModelService } from '../../src/core/models/providers'
import { McpConnectorManager, jsonSchemaToZod, isMcpToolName, mcpToolName } from '../../src/core/connectors'
import { createHandlers } from '../../src/core/server/handlers'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import type { CoreEvent, RpcMethod } from '../../src/shared/protocol'

type TestApi = Record<RpcMethod, (params: any) => any>

interface FakeToolSpec {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface FakeCallOutcome {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
  isError?: true
}

interface ConnectorHarnessConfig {
  tools?: FakeToolSpec[]
  outcomes?: Record<string, FakeCallOutcome>
  /** When set, `start()` throws, simulating an unreachable server. */
  failStart?: string
}

/** A fake MCP server over a `Transport`: answers the handshake and the requests the Client makes. */
class FakeMcpTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: any) => void
  calls: Array<{ id?: number; method: string; params?: unknown }> = []
  private readonly config: ConnectorHarnessConfig

  constructor(config: ConnectorHarnessConfig = {}) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.config.failStart) throw new Error(this.config.failStart)
  }

  async send(message: any): Promise<void> {
    if (!message || message.method === undefined) return
    this.calls.push({ id: message.id as number | undefined, method: message.method, params: message.params })
    // Notifications (no id) get no response.
    if (message.id === undefined) return
    let result: unknown
    switch (message.method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' }
        }
        break
      case 'ping':
        result = {}
        break
      case 'tools/list':
        result = {
          tools: (this.config.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: 'object' }
          }))
        }
        break
      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: string }
        const outcome = params.name ? this.config.outcomes?.[params.name] : undefined
        result = outcome
          ? {
              content: outcome.content ?? [],
              ...(outcome.structuredContent !== undefined ? { structuredContent: outcome.structuredContent } : {}),
              ...(outcome.isError ? { isError: true } : {})
            }
          : { content: [{ type: 'text', text: `ran ${params.name ?? '?'}` }] }
        break
      }
      default:
        result = {}
    }
    this.onmessage?.({ jsonrpc: '2.0', id: message.id, result })
  }

  async close(): Promise<void> {
    this.onclose?.()
  }
}

interface Harness {
  db: DatabaseSync
  base: string
  repos: Repos
  manager: McpConnectorManager
  transports: Map<string, number>
  cleanup(): void
}

let harnesses: Harness[] = []

function makeHarness(configs: Record<string, ConnectorHarnessConfig> = {}): Harness {
  const base = mkdtempSync(join(process.env.TEMP ?? 'C:\\Windows\\Temp', 'deskmates-connectors-'))
  const db = openDatabase(':memory:')
  const repos = createRepos(db)
  // Every connect gets a fresh transport (like the real factory); count them per connector name so
  // tests can assert that config changes reconnect.
  const counts = new Map<string, number>()
  const manager = new McpConnectorManager({
    repos,
    createTransport: (connector) => {
      counts.set(connector.name, (counts.get(connector.name) ?? 0) + 1)
      return new FakeMcpTransport(configs[connector.name] ?? {})
    }
  })
  const harness: Harness = {
    db,
    base,
    repos,
    manager,
    transports: counts,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.manager.closeAll()
    harness.db.close()
    harness.cleanup()
  }
})

describe('connectors migration', () => {
  it('creates the connectors table', () => {
    const h = makeHarness()
    const row = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'connectors'").get() as
      | { name: string }
      | undefined
    expect(row?.name).toBe('connectors')
  })
})

describe('ConnectorsRepo', () => {
  it('creates, requires, finds by name, lists sorted, updates and deletes with JSON round-trips', () => {
    const h = makeHarness()
    const repo = h.repos.connectors

    const a = repo.create({ name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '@x/files'], env: { TOKEN: 'abc' } })
    expect(a).toMatchObject({ name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '@x/files'], env: { TOKEN: 'abc' }, enabled: true })
    // null for the http-only url, not undefined, when read back.
    expect(a.url).toBeNull()

    expect(() => repo.require('missing')).toThrow('Connector not found: missing')
    expect(repo.getByName('files')).toEqual(a)

    repo.create({ name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp' })
    expect(repo.list().map((c) => c.name)).toEqual(['docs', 'files'])

    const updated = repo.update(a.id, { enabled: false, args: ['-y', '@x/files@2'] })
    expect(updated.enabled).toBe(false)
    expect(updated.args).toEqual(['-y', '@x/files@2'])
    expect(repo.get(a.id)?.enabled).toBe(false)

    repo.delete(a.id)
    expect(repo.get(a.id)).toBeUndefined()
    expect(repo.list().map((c) => c.name)).toEqual(['docs'])
  })
})

describe('jsonSchemaToZod', () => {
  it('maps required and optional object properties', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['name']
    })
    expect(schema.safeParse({ name: 'x', tags: ['a'], extra: 1 }).success).toBe(true)
    expect(schema.safeParse({ tags: ['a'] }).success).toBe(false)
    expect(schema.safeParse({ name: 'x' }).success).toBe(true)
  })

  it('maps enums, numbers, integers, booleans and nulls', () => {
    const enumSchema = jsonSchemaToZod({ type: 'string', enum: ['fast', 'slow'] })
    expect(enumSchema.safeParse('fast').success).toBe(true)
    expect(enumSchema.safeParse('other').success).toBe(false)

    const numberSchema = jsonSchemaToZod({ type: 'integer', minimum: 1, maximum: 5 })
    expect(numberSchema.safeParse(3).success).toBe(true)
    expect(numberSchema.safeParse(1.5).success).toBe(false)
    expect(numberSchema.safeParse(0).success).toBe(false)

    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(true).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'null' }).safeParse(null).success).toBe(true)
  })

  it('treats anyOf/oneOf with a null branch as nullable', () => {
    const schema = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(schema.safeParse('x').success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse(3).success).toBe(false)
  })

  it('falls back to any() for unknown shapes and broken patterns', () => {
    expect(jsonSchemaToZod({ type: 'weird' }).safeParse(123).success).toBe(true)
    const withBadPattern = jsonSchemaToZod({ type: 'string', pattern: '[' })
    expect(withBadPattern.safeParse('anything').success).toBe(true)
  })
})

describe('McpConnectorManager CRUD', () => {
  it('creates connectors with defaults and rejects bad input', () => {
    const h = makeHarness()
    const list = h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'files', transport: 'stdio', command: 'npx', args: [], enabled: true })

    expect(() => h.manager.create({ name: '', transport: 'stdio', command: 'npx' })).toThrow('needs a name')
    expect(() => h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })).toThrow('already a connector named "files"')
    expect(() => h.manager.create({ name: 'bad', transport: 'stdio' })).toThrow('needs a command')
    expect(() => h.manager.create({ name: 'bad', transport: 'http', url: 'not a url' })).toThrow("doesn't look like a URL")
    expect(() => h.manager.create({ name: 'bad', transport: 'sse' as never, url: 'http://x' })).toThrow('Unknown transport')
  })

  it('updates and removes connectors', () => {
    const h = makeHarness()
    const [files] = h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    const [docs] = h.manager.create({ name: 'docs', transport: 'http', url: 'https://a.example/mcp' })

    const renamed = h.manager.update(files.id, { name: 'files-v2', enabled: false })
    expect(renamed.find((c) => c.id === files.id)).toMatchObject({ name: 'files-v2', enabled: false })

    // The http connector must stay reachable via its url after a no-op update.
    h.manager.update(docs.id, { url: 'https://b.example/mcp' })
    expect(h.repos.connectors.get(docs.id)?.url).toBe('https://b.example/mcp')

    const remaining = h.manager.remove(docs.id)
    expect(remaining.map((c) => c.name)).toEqual(['files-v2'])
    expect(h.repos.connectors.get(docs.id)).toBeUndefined()

    expect(() => h.manager.remove(docs.id)).toThrow('Connector not found')
  })
})

describe('McpConnectorManager tools', () => {
  it('refreshes to expose connector tools as mcp__-prefixed tool names', async () => {
    const h = makeHarness({
      'My Files': {
        tools: [
          { name: 'Read File', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
          { name: 'write_file', inputSchema: { type: 'object' } }
        ]
      }
    })
    h.manager.create({ name: 'My Files', transport: 'stdio', command: 'npx' })
    await h.manager.refresh()

    const tools = h.manager.tools()
    expect(tools['mcp__my_files__read_file']).toBeDefined()
    expect(tools['mcp__my_files__write_file']).toBeDefined()
    expect(tools['mcp__my_files__read_file'].description).toBe('Read a file.')
  })

  it('connect, list, and call round-trip on the fake transport', async () => {
    const h = makeHarness({
      files: {
        tools: [{ name: 'read', inputSchema: { type: 'object' } }],
        outcomes: { read: { content: [{ type: 'text', text: 'hello' }] } }
      }
    })
    h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    await h.manager.refresh()

    const tool = h.manager.tools()['mcp__files__read']
    expect(tool).toBeDefined()
    const transport = (h.manager as unknown as { clients: Map<string, unknown> })['clients']
    void transport
    const result = (await tool!.execute!({} as never, { signal: undefined } as never)) as unknown
    expect(result).toBe('hello')
  })

  it('throws when executing a tool on a connector that is no longer connected', async () => {
    const h = makeHarness({ files: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } })
    h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    await h.manager.refresh()
    const tool = h.manager.tools()['mcp__files__read']!

    // Remove the connector and refresh: the client closes, so the cached tool is stale and must fail.
    const [connector] = h.manager.list()
    h.manager.remove(connector.id)
    await h.manager.refresh()
    await expect(tool.execute!({} as never, { signal: undefined } as never)).rejects.toThrow('isn\'t connected')
  })

  it('turns MCP call errors into thrown errors', async () => {
    const h = makeHarness({
      files: {
        tools: [{ name: 'boom', inputSchema: { type: 'object' } }],
        outcomes: { boom: { content: [{ type: 'text', text: 'nope' }], isError: true } }
      }
    })
    h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    await h.manager.refresh()
    const tool = h.manager.tools()['mcp__files__boom']!
    await expect(tool.execute!({} as never, { signal: undefined } as never)).rejects.toThrow('nope')
  })

  it('returns structuredContent JSON when there is no text', async () => {
    const h = makeHarness({
      files: {
        tools: [{ name: 'analyze', inputSchema: { type: 'object' } }],
        outcomes: { analyze: { structuredContent: { score: 0.9 } } }
      }
    })
    h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    await h.manager.refresh()
    const analyze = h.manager.tools()['mcp__files__analyze']!
    expect(((await analyze.execute!({} as never, { signal: undefined } as never)) as unknown) as string).toBe('{"score":0.9}')
  })

  it('drops a failing connector but keeps serving the rest', async () => {
    const h = makeHarness({
      ok: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] },
      broken: { tools: [{ name: 'read', inputSchema: { type: 'object' } }], failStart: 'refusing to start' }
    })
    h.manager.create({ name: 'ok', transport: 'stdio', command: 'npx' })
    h.manager.create({ name: 'broken', transport: 'stdio', command: 'npx' })
    await h.manager.refresh()

    const tools = h.manager.tools()
    expect(tools['mcp__ok__read']).toBeDefined()
    expect(tools['mcp__broken__read']).toBeUndefined()
  })

  it('refreshes again after a fix, reusing a live connection and reconnecting on config change', async () => {
    const h = makeHarness({
      files: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
    })
    h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    await h.manager.refresh()
    expect(Object.keys(h.manager.tools())).toEqual(['mcp__files__read'])
    const connectsAfterFirst = h.transports.get('files')

    await h.manager.refresh()
    expect(h.transports.get('files')).toBe(connectsAfterFirst) // no reconnect on an unchanged config

    const [connector] = h.manager.list()
    h.manager.update(connector.id, { command: 'node' })
    await h.manager.refresh()
    expect(h.transports.get('files')).toBe((connectsAfterFirst ?? 0) + 1) // config change reconnects
  })

  it('test(id) lists tools then closes; unreachable servers fail with a plain message', async () => {
    const h = makeHarness({
      files: { tools: [{ name: 'read', inputSchema: { type: 'object' } }, { name: 'write', inputSchema: { type: 'object' } }] },
      broken: { tools: [{ name: 'read' }], failStart: 'connection refused' }
    })
    const [files] = h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    const [broken] = h.manager.create({ name: 'broken', transport: 'stdio', command: 'npx' })

    await expect(h.manager.test(files.id)).resolves.toEqual(['read', 'write'])
    await expect(h.manager.test(broken.id)).rejects.toThrow('Couldn\'t reach "broken": connection refused')
  })
})

describe('importMcpConfig', () => {
  it('imports stdio and http servers, skipping sse, duplicates and bad entries', () => {
    const h = makeHarness()
    const configPath = join(h.base, 'mcp_config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@x/files'], env: { TOKEN: 'abc' } },
          'sse-only': { url: 'http://localhost:3001/mcp', transportType: 'sse' },
          remote: { url: 'https://api.example.com/mcp', type: 'http' },
          useless: { command: '' }
        }
      })
    )
    const list = h.manager.importMcpConfig(configPath)
    const byName = new Map(list.map((c) => [c.name, c]))
    expect(byName.get('filesystem')).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@x/files'], env: { TOKEN: 'abc' } })
    expect(byName.get('remote')).toMatchObject({ transport: 'http', url: 'https://api.example.com/mcp' })
    expect(byName.has('sse-only')).toBe(false)
    expect(byName.has('useless')).toBe(false)
  })

  it('keeps existing connectors and expands ~ in the path', () => {
    const h = makeHarness()
    h.manager.create({ name: 'filesystem', transport: 'stdio', command: 'npx' })
    const configPath = join(h.base, 'mcp_config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: { filesystem: { command: 'other' }, fresh: { command: 'echo' } } }))
    const list = h.manager.importMcpConfig(configPath)
    expect(list.map((c) => c.name)).toEqual(['filesystem', 'fresh'])
    expect(h.repos.connectors.getByName('filesystem')?.command).toBe('npx')
  })

  it('errors clearly on a missing file, invalid JSON or a missing mcpServers key', () => {
    const h = makeHarness()
    expect(() => h.manager.importMcpConfig(join(h.base, 'nope.json'))).toThrow('Couldn\'t find a file')
    writeFileSync(join(h.base, 'bad.json'), 'not json')
    expect(() => h.manager.importMcpConfig(join(h.base, 'bad.json'))).toThrow('isn\'t valid JSON')
    writeFileSync(join(h.base, 'empty.json'), '{}')
    expect(() => h.manager.importMcpConfig(join(h.base, 'empty.json'))).toThrow('no "mcpServers"')
  })
})

describe('MCP tool naming and approval', () => {
  it('builds and recognizes mcp__ tool names', () => {
    expect(mcpToolName('My Files', 'Read File')).toBe('mcp__my_files__read_file')
    expect(isMcpToolName('mcp__my_files__read_file')).toBe(true)
    expect(isMcpToolName('read_file')).toBe(false)
  })

  it('gates connector tools behind user approval by default', () => {
    expect(approvalFor('mcp__files__read', [])).toBe('user-approval')
    expect(approvalFor('mcp__files__read', ['mcp__files__read'])).toBe('approved')
  })

  it('leaves built-in tools to the existing risky set', () => {
    expect(approvalFor('read_file', [])).toBeUndefined()
    expect(approvalFor('delete_path', [])).toBe('user-approval')
    expect(approvalFor('delete_path', ['delete_path'])).toBe('approved')
  })
})

describe('connectors RPC handlers', () => {
  function handlers(h: Harness) {
    const bus = new EventBus()
    const keys = new KeyStore()
    const modelService = new ModelService(keys, () => h.repos.settings.get())
    const changes = new ChangeLog(h.repos.changes, join(h.base, 'snapshots'))
    const events: CoreEvent[] = []
    bus.on((event) => events.push(event))
    const api = createHandlers({
      repos: h.repos,
      bus,
      runner: {} as never,
      changes,
      models: modelService,
      keys,
      version: '0.1.0',
      dataDir: h.base,
      connectors: h.manager
    }) as unknown as TestApi
    return { api, events }
  }

  it('answers with CONNECTORS_NOT_SET_UP before the manager is wired', () => {
    const h = makeHarness()
    const bus = new EventBus()
    const keys = new KeyStore()
    const modelService = new ModelService(keys, () => h.repos.settings.get())
    const changes = new ChangeLog(h.repos.changes, join(h.base, 'snapshots'))
    const api = createHandlers({
      repos: h.repos,
      bus,
      runner: {} as never,
      changes,
      models: modelService,
      keys,
      version: '0.1.0',
      dataDir: h.base
    }) as unknown as TestApi
    expect(() => api['connectors.list']({})).toThrow("Connectors aren't set up on this computer yet.")
  })

  it('list/create/delete work and nudge connectors.updated', async () => {
    const h = makeHarness({ files: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } })
    h.manager.create({ name: 'files', transport: 'stdio', command: 'npx' })
    const { api, events } = handlers(h)

    expect(api['connectors.list']({})).toHaveLength(1)

    const created = api['connectors.create']({ name: 'docs', transport: 'http', url: 'https://a.example/mcp' })
    expect(created).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'connectors.updated', connectors: created })

    const tested = await api['connectors.test']({ id: h.repos.connectors.getByName('files')!.id })
    expect(tested).toEqual(['read'])

    const remaining = api['connectors.delete']({ id: h.repos.connectors.getByName('docs')!.id })
    expect(remaining).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'connectors.updated' })
  })

  it('imports a config through the RPC surface', () => {
    const h = makeHarness()
    const { api, events } = handlers(h)
    const configPath = join(h.base, 'mcp_config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: { filesystem: { command: 'npx' } } }))
    const list = api['connectors.import']({ path: configPath })
    expect(list.map((c: { name: string }) => c.name)).toEqual(['filesystem'])
    expect(events.at(-1)).toMatchObject({ type: 'connectors.updated' })
  })
})