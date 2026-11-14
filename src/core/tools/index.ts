import type { ToolSet } from 'ai'
import { agentTools, subagentTools } from './agent-tools'
import type { ToolContext } from './context'
import { skillsTools } from '../extensions/skills-tool'
import { fileTools } from './files'
import { officeTools } from './office'
import { shellTools } from './shell'
import { coworkTools, type ToolListing } from './cowork'
import { promptSectionTool } from '../engine/my-prompt'
import { promptTools } from './prompt-tools'
import { designTools } from './design'
import { designComponentTools } from './design-components'
import { designVisualTools } from './design-visual'
import { extensionTools } from './extensions'
import { agentBrowserTools } from './browser'
import { scheduleTools } from './schedules'
import { screenControlTools } from './screen-control'
import { join } from 'node:path'

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
    ...(ctx.subagents ? subagentTools(ctx) : {}),
    ...(ctx.browser
      ? agentBrowserTools({
          browser: ctx.browser,
          agent: ctx.agentName ?? (ctx.projectKind === 'design' ? 'Design' : 'Work'),
          runKey: ctx.taskId,
          screenshotDir: join(ctx.root, '.deskmates', 'screenshots'),
          signal: ctx.signal
        })
      : {}),
    ...(ctx.screen ? screenControlTools({ control: ctx.screen, withImages: ['google', 'openai'].includes(ctx.modelRef.provider) }) : {}),
    ...(ctx.schedules ? scheduleTools({ scheduler: ctx.schedules, projectId: ctx.projectId, waitsForStart: () => ctx.cliModel === true }) : {})
  }
  const listTools = (): ToolListing[] =>
    Object.entries(all).map(([name, t]) => ({ name, description: String((t as { description?: string }).description ?? '') }))
  // The tool families the base prompts (prompts/claude-design, prompts/claude-cowork) are written for.
  Object.assign(
    all,
    ctx.projectKind === 'design'
      ? { ...designTools(ctx, listTools), ...designComponentTools(ctx), ...designVisualTools(ctx) }
      : { ...coworkTools(ctx, listTools), ...promptSectionTool() }
  )
  // The Work tab's agent reads the user's own prompt: give it the tools that prompt names.
  if (ctx.projectKind !== 'design') Object.assign(all, promptTools(ctx, all))
  return all
}
