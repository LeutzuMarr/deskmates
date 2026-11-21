/**
 * Approval policy for risky tools.
 */
import { isMcpToolName, SAFE_MCP_TOOLS } from '../connectors/naming'
import { GOOGLE_RISKY_TOOLS } from '../tools/google-tools'

/** Deskmates' own Gmail, Calendar and Drive tools (named as the operating prompt names them; a
 *  connector's tools are always lower-case, so they can't collide): only the ones that send,
 *  delete, share or change the calendar ask first. */
const BUILT_IN_GOOGLE = /^mcp__(Gmail|Google_Calendar|Google_Drive)__/
const GOOGLE_RISKY: ReadonlySet<string> = new Set(GOOGLE_RISKY_TOOLS)

/** Tools that always need explicit user approval. */
export const RISKY_TOOLS: ReadonlySet<string> = new Set(['delete_path', 'run_command', 'Bash', 'Workflow', 'delete_file', 'run_script', 'add_mcp_server', 'install_skill', 'install_plugin', 'screen_act', 'bash_tool', 'memory_delete'])

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
  if (BUILT_IN_GOOGLE.test(toolName)) {
    if (!GOOGLE_RISKY.has(toolName)) return undefined
    return autoApprove.includes(toolName) ? 'approved' : 'user-approval'
  }
  if (isMcpToolName(toolName)) {
    if (SAFE_MCP_TOOLS.has(toolName)) return undefined
    return autoApprove.includes(toolName) ? 'approved' : 'user-approval'
  }
  if (!RISKY_TOOLS.has(toolName)) return undefined
  if (autoApprove.includes(toolName)) return 'approved'
  return 'user-approval'
}
