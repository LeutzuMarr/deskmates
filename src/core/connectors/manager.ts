/**
 * McpConnectorManager — spec 5.6. Owns the connector records, keeps one live MCP `Client` per
 * enabled connector, and exposes their tools as an AI SDK `ToolSet` the assistant and bots merge in.
 * Transports are injectable so tests never spawn a real process.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { tool, type Tool, type ToolSet } from 'ai'
import type { Connector, ConnectorTransport } from '../../shared/protocol'
import type { ConnectorPatch, ConnectorsRepo } from '../store/repos'
import { mcpToolName } from './naming'
import { jsonSchemaToZod } from './schema'

export interface ConnectorInput {
  name: string
  transport: ConnectorTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled?: boolean
}

export interface McpConnectorManagerDeps {
  repos: { connectors: ConnectorsRepo }
  /** Builds the transport for a connector. Injectable so tests use a fake transport instead of real processes. */
  createTransport: (connector: Connector) => Transport
}

/** The parts of a connector's config its connection depends on; change one and the next refresh reconnects. */
function signature(connector: Connector): string {
  return JSON.stringify([connector.transport, connector.command, connector.args, connector.url, connector.env])
}

/** What a `tools/call` result looks like on the wire (the SDK's return type is a wide union). */
interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class McpConnectorManager {
  private readonly clients = new Map<string, Client>()
  private readonly signatures = new Map<string, string>()
  private toolsCache: ToolSet = {}
  private refreshTail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: McpConnectorManagerDeps) {}

  list(): Connector[] {
    return this.deps.repos.connectors.list()
  }

  create(input: ConnectorInput): Connector[] {
    const name = input.name?.trim() ?? ''
    if (!name) throw new Error('The connector needs a name.')
    if (this.deps.repos.connectors.getByName(name)) throw new Error(`There's already a connector named "${name}".`)
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('A stdio connector needs a command to run.')
    } else if (input.transport === 'http') {
      if (!input.url?.trim()) throw new Error('An HTTP connector needs a URL.')
      try {
        new URL(input.url)
      } catch {
        throw new Error(`That doesn't look like a URL: ${input.url}`)
      }
    } else {
      throw new Error(`Unknown transport: ${String(input.transport)}`)
    }
    this.deps.repos.connectors.create({ ...input, name })
    this.triggerRefresh()
    return this.list()
  }

  update(id: string, patch: ConnectorPatch): Connector[] {
    const current = this.deps.repos.connectors.require(id)
    const name = patch.name !== undefined ? patch.name.trim() : current.name
    if (!name) throw new Error('The connector needs a name.')
    if (name !== current.name && this.deps.repos.connectors.getByName(name)) {
      throw new Error(`There's already a connector named "${name}".`)
    }
    const transport = patch.transport ?? current.transport
    const command = patch.command !== undefined ? patch.command : current.command
    const url = patch.url !== undefined ? patch.url : current.url
    if (transport === 'stdio' && !command?.trim()) throw new Error('A stdio connector needs a command to run.')
    if (transport === 'http') {
      if (!url?.trim()) throw new Error('An HTTP connector needs a URL.')
      try {
        new URL(url)
      } catch {
        throw new Error(`That doesn't look like a URL: ${url}`)
      }
    }
    const clean: ConnectorPatch = {}
    if (patch.name !== undefined) clean.name = name
    if (patch.transport !== undefined) clean.transport = transport
    if (patch.command !== undefined) clean.command = command
    if (patch.args !== undefined) clean.args = patch.args
    if (patch.url !== undefined) clean.url = url
    if (patch.env !== undefined) clean.env = patch.env
    if (patch.enabled !== undefined) clean.enabled = patch.enabled
    this.deps.repos.connectors.update(id, clean)
    this.triggerRefresh()
    return this.list()
  }

  remove(id: string): Connector[] {
    this.deps.repos.connectors.require(id)
    this.deps.repos.connectors.delete(id)
    void this.closeClient(id)
    this.triggerRefresh()
    return this.list()
  }

  /** Connects to the connector live, lists its tool names, then closes. Throws a plain-language error on failure. */
  async test(id: string): Promise<string[]> {
    const connector = this.deps.repos.connectors.require(id)
    const client = new Client({ name: 'deskmates-connectors', version: '1.0.0' })
    try {
      await client.connect(this.deps.createTransport(connector))
      const { tools } = await client.listTools()
      return tools.map((mcpTool) => mcpTool.name)
    } catch (error) {
      throw new Error(`Couldn't reach "${connector.name}": ${errorMessage(error)}`)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  /**
   * Imports MCP servers from an `mcp_config.json` file (the `{ mcpServers: {...} }` shape, e.g.
   * Antigravity's). Adds each stdio/http server whose name isn't already taken; skips other
   * transports (e.g. sse). `~` in the path expands to the home folder.
   */
  importMcpConfig(path: string): Connector[] {
    const file = path.startsWith('~') ? join(homedir(), path.slice(1)) : path
    if (!existsSync(file)) throw new Error(`Couldn't find a file at ${file}.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new Error(`${file} isn't valid JSON.`)
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers
    if (!servers || typeof servers !== 'object') throw new Error(`${file} has no "mcpServers" section.`)

    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      if (this.deps.repos.connectors.getByName(name)) continue
      const cfg = (raw ?? {}) as {
        command?: unknown
        args?: unknown
        url?: unknown
        env?: unknown
        type?: unknown
        transportType?: unknown
      }
      const transport = resolveTransport(cfg)
      if (!transport) continue
      const command = typeof cfg.command === 'string' ? cfg.command : undefined
      const url = typeof cfg.url === 'string' ? cfg.url : undefined
      if (transport === 'stdio' && !command) continue
      if (transport === 'http' && !url) continue
      const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : undefined
      const env =
        cfg.env && typeof cfg.env === 'object'
          ? Object.fromEntries(Object.entries(cfg.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as Array<[string, string]>)
          : undefined
      this.deps.repos.connectors.create({ name, transport, command, args, url, env })
    }
    this.triggerRefresh()
    return this.list()
  }

  /** The current tool set for enabled connectors — spread into a run's tools. Synchronous; stale until the next refresh lands. */
  tools(): ToolSet {
    return this.toolsCache
  }

  /** Reconciles live connections with the stored list and rebuilds the tool set. Refreshes run one at a time. */
  refresh(): Promise<void> {
    const next = this.refreshTail.then(
      () => this.doRefresh(),
      () => this.doRefresh()
    )
    this.refreshTail = next.catch(() => undefined)
    return next
  }

  /** Closes every live connection and empties the tool set; for app shutdown. */
  async closeAll(): Promise<void> {
    await this.refreshTail
    this.toolsCache = {}
    const clients = [...this.clients.keys()]
    await Promise.all(clients.map((id) => this.closeClient(id)))
  }

  private triggerRefresh(): void {
    void this.refresh().catch((error) => console.error('[core] connector refresh failed', error))
  }

  private async doRefresh(): Promise<void> {
    const connectors = this.list().filter((connector) => connector.enabled)
    const enabledIds = new Set(connectors.map((connector) => connector.id))
    for (const id of [...this.clients.keys()]) {
      if (!enabledIds.has(id)) await this.closeClient(id)
    }

    const next: ToolSet = {}
    for (const connector of connectors) {
      try {
        const client = await this.clientFor(connector)
        const { tools } = await client.listTools()
        for (const mcpTool of tools) next[mcpToolName(connector.name, mcpTool.name)] = this.toAiTool(connector, mcpTool)
      } catch (error) {
        // One unreachable server must not take the others down; it's retried on the next refresh.
        console.error(`[core] connector "${connector.name}" failed to load tools:`, errorMessage(error))
        await this.closeClient(connector.id)
      }
    }
    this.toolsCache = next
  }

  /** The connector's live client, opening or reopening it when its config changed since last time. */
  private async clientFor(connector: Connector): Promise<Client> {
    const sig = signature(connector)
    const existing = this.clients.get(connector.id)
    if (existing && this.signatures.get(connector.id) === sig) return existing
    if (existing) await this.closeClient(connector.id)
    const client = new Client({ name: 'deskmates-connectors', version: '1.0.0' })
    await client.connect(this.deps.createTransport(connector))
    this.clients.set(connector.id, client)
    this.signatures.set(connector.id, sig)
    return client
  }

  private async closeClient(id: string): Promise<void> {
    const client = this.clients.get(id)
    this.clients.delete(id)
    this.signatures.delete(id)
    if (client) await client.close().catch(() => undefined)
  }

  private toAiTool(connector: Connector, mcpTool: McpTool): Tool {
    return tool({
      description: mcpTool.description ?? `Run the "${mcpTool.name}" tool from the ${connector.name} connector.`,
      inputSchema: jsonSchemaToZod(mcpTool.inputSchema ?? { type: 'object' }),
      execute: async (args) => {
        // The client is resolved now, not when the tool was built: a connector deleted or disabled
        // mid-session must fail here rather than call into a closed connection.
        const client = this.clients.get(connector.id)
        if (!client) throw new Error(`Connector "${connector.name}" isn't connected.`)
        let result: McpCallResult
        try {
          result = (await client.callTool({
            name: mcpTool.name,
            arguments: (args ?? {}) as Record<string, unknown>
          })) as McpCallResult
        } catch (error) {
          throw new Error(`${connector.name} couldn't run ${mcpTool.name}: ${errorMessage(error)}`)
        }
        const text = resultText(result)
        if (result.isError) throw new Error(text || `${connector.name}'s ${mcpTool.name} reported an error.`)
        if (text) return text
        if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
        if (result.content?.length) return JSON.stringify(result.content)
        return 'Done.'
      }
    })
  }
}

/** The transport an `mcp_config.json` entry implies; null when the entry is unusable (e.g. `sse`). */
function resolveTransport(cfg: {
  command?: unknown
  url?: unknown
  type?: unknown
  transportType?: unknown
}): ConnectorTransport | null {
  // Both spellings appear in the wild: gemini CLIs (Antigravity) write `transportType`, other tools write `type`.
  const explicit = [cfg.type, cfg.transportType].find((v): v is string => typeof v === 'string')
  if (explicit) {
    if (explicit === 'stdio' || explicit === 'http') return explicit
    // Explicit transports we don't support (sse, and friends) are skipped even if they also carry a url.
    return null
  }
  if (typeof cfg.command === 'string' && cfg.command) return 'stdio'
  if (typeof cfg.url === 'string' && cfg.url) return 'http'
  return null
}

function resultText(result: McpCallResult): string {
  if (!Array.isArray(result.content)) return ''
  return result.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}
