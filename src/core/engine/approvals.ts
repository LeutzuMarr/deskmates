/**
 * Approval policy for risky tools.
 */
import { isMcpToolName, SAFE_MCP_TOOLS } from '../connectors/naming'

/** Tools that always need explicit user approval. */
export const RISKY_TOOLS: ReadonlySet<string> = new Set(['delete_path', 'run_command', 'Bash', 'Workflow', 'delete_file', 'run_script', 'add_mcp_server', 'install_skill', 'install_plugin'])

/**
 * Determines the approval status for a tool call.
 * @returns `undefined` if the tool isn't risky, `'approved'` if auto-approved, `'user-approval'` otherwise.
 */
export function approvalFor(
  toolName: string,
  autoApprove: readonly string[]
): 'user-approval' | 'approved' | undefined {
  // Connector tools run code the app didn't write, so they default to asking — unless the user
  // has opted this tool in (autoApprove) or it's on the conservative safe list.
  if (isMcpToolName(toolName)) {
    if (SAFE_MCP_TOOLS.has(toolName)) return undefined
    return autoApprove.includes(toolName) ? 'approved' : 'user-approval'
  }
  if (!RISKY_TOOLS.has(toolName)) return undefined
  if (autoApprove.includes(toolName)) return 'approved'
  return 'user-approval'
}
