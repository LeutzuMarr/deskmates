/** Names for tools that come from MCP connectors (spec 5.6). */

/** Prefix every connector tool carries, so the approval layer can tell them apart from built-in tools. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** MCP tool names arrive from servers and may contain anything; tool keys need plain identifiers. */
export function sanitizeMcpSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
}

/** The tool name the model sees: `mcp__<connector>__<tool>`, each segment sanitized. */
export function mcpToolName(connectorName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeMcpSegment(connectorName) || 'connector'}__${sanitizeMcpSegment(toolName) || 'tool'}`
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

/** Connector tools that may run without approval, by their full prefixed name. Ships conservative: none. */
export const SAFE_MCP_TOOLS: ReadonlySet<string> = new Set<string>()
