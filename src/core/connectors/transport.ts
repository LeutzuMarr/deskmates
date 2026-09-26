/** Builds the transport a connector talks over: spawn-and-stdio, or HTTP streamable. */
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Connector } from '../../shared/protocol'

export function createMcpTransport(connector: Connector): Transport {
  if (connector.transport === 'http') {
    if (!connector.url) throw new Error(`The connector "${connector.name}" has no URL.`)
    return new StreamableHTTPClientTransport(new URL(connector.url))
  }
  if (!connector.command) throw new Error(`The connector "${connector.name}" has no command.`)
  // The SDK's env replaces the process env entirely, so start from its safe inherited set and layer
  // the connector's own variables on top — otherwise the spawned server would lose PATH.
  return new StdioClientTransport({
    command: connector.command,
    args: connector.args,
    env: { ...getDefaultEnvironment(), ...connector.env }
  })
}
