/** Merges every bot tool group into one ToolSet for a run, and the approval policy over them. */
import type { ToolSet } from 'ai'
import type { AgentClient } from './agent-client'
import { browserTools } from './browser'
import type { CdpClient } from './cdp-client'
import { handoffTools, type HandoffLookup } from './handoff'
import { pcFilesTools } from './pc-files'
import { screenTools } from './screen'
import { whatsappTools } from './whatsapp'
import { skillsTools } from '../../extensions/skills-tool'
import type { SkillsService } from '../../extensions/skills'
import type { McpConnectorManager } from '../../connectors'
import { isMcpToolName, SAFE_MCP_TOOLS } from '../../connectors/naming'
import type { SaveScreenshot } from './types'

export interface BotToolsDeps {
  agent: AgentClient
  cdp: CdpClient
  saveScreenshot: SaveScreenshot
  dataDir: string
  /** The running bot's own id — the `from` side of a handoff. */
  botId: string
  lookup: HandoffLookup
  now?: () => number
  /** The one number `whatsapp_send` may message. Empty means the user hasn't set one, so the tool isn't offered. */
  whatsappTo?: string
  /** The skills library, when skills are set up on this machine; absent otherwise. */
  skills?: SkillsService
  /** MCP connectors (spec 5.6); absent until that task is wired up, so bots get no connector tools then. */
  connectors?: McpConnectorManager
}

/** Built fresh per run via BotRunner. */
export function botTools(deps: BotToolsDeps): ToolSet {
  return {
    ...browserTools(deps.cdp, deps.saveScreenshot),
    ...screenTools(deps.agent, deps.saveScreenshot),
    ...pcFilesTools(deps.agent),
    ...handoffTools({ dataDir: deps.dataDir, fromBotId: deps.botId, lookup: deps.lookup, now: deps.now }),
    ...(deps.skills ? skillsTools(deps.skills) : {}),
    ...(deps.connectors ? deps.connectors.tools() : {}),
    ...(deps.whatsappTo
      ? whatsappTools({ cdp: deps.cdp, saveScreenshot: deps.saveScreenshot, allowedNumber: deps.whatsappTo })
      : {})
  }
}

/**
 * Tools that reach outside the page-scoped browser sandbox with raw, unscoped desktop input —
 * the bot equivalent of the Work tab's `run_command` (see `engine/approvals.ts`). Everything else
 * here (reading, browser click/type, pc files, handoff) stays inside a specific page or a fenced
 * folder, so it runs freely.
 */
export const RISKY_BOT_TOOLS: ReadonlySet<string> = new Set(['screen_click', 'screen_type', 'screen_key', 'screen_scroll', 'whatsapp_send'])

/** Determines the approval status for a bot tool call. `undefined` if the tool isn't risky. */
export function approvalForBotTool(toolName: string, autoApprove: readonly string[]): 'user-approval' | 'approved' | undefined {
  // Connector tools default to asking, same as the assistant's side (see engine/approvals.ts).
  if (isMcpToolName(toolName)) {
    if (SAFE_MCP_TOOLS.has(toolName)) return undefined
    return autoApprove.includes(toolName) ? 'approved' : 'user-approval'
  }
  if (!RISKY_BOT_TOOLS.has(toolName)) return undefined
  return autoApprove.includes(toolName) ? 'approved' : 'user-approval'
}
