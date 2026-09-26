import type { ToolSet } from 'ai'
import { agentTools, subagentTools } from './agent-tools'
import type { ToolContext } from './context'
import { skillsTools } from '../extensions/skills-tool'
import { fileTools } from './files'
import { officeTools } from './office'
import { shellTools } from './shell'
import { coworkTools, type ToolListing } from './cowork'
import { designTools } from './design'
import { designComponentTools } from './design-components'
import { designVisualTools } from './design-visual'
import { extensionTools } from './extensions'

/** Merges every tool group into one ToolSet for a run. Built fresh per run via TaskRunner. */
export function buildTools(ctx: ToolContext): ToolSet {
  const all: ToolSet = {
    ...fileTools(ctx),
    ...officeTools(ctx),
    ...shellTools(ctx),
    ...agentTools(ctx),
    ...(ctx.skills ? skillsTools(ctx.skills) : {}),
    ...(ctx.connectors ? ctx.connectors.tools() : {}),
    ...extensionTools(ctx),
    ...(ctx.subagents ? subagentTools(ctx) : {})
  }
  const listTools = (): ToolListing[] =>
    Object.entries(all).map(([name, t]) => ({ name, description: String((t as { description?: string }).description ?? '') }))
  // The tool families the base prompts (prompts/claude-design, prompts/claude-cowork) are written for.
  Object.assign(
    all,
    ctx.projectKind === 'design'
      ? { ...designTools(ctx, listTools), ...designComponentTools(ctx), ...designVisualTools(ctx) }
      : coworkTools(ctx, listTools)
  )
  return all
}
