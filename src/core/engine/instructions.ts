/**
 * System-instructions builder for the Deskmates assistant.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Memory, Project, ProviderId, Settings } from '../../shared/protocol'
import { PROVIDER_LABELS } from '../../shared/protocol'

/** Returns the path to the project instructions file. */
export function projectInstructionsPath(folder: string): string {
  return join(folder, 'DESKMATES.md')
}

/** The folder holding the mounted system-prompt directories (_claude-code_, _claude-design_,
 *  _claude-cowork_), overridable for tests and the packaged app via DESKMATES_PROMPTS_DIR. */
export function promptsDir(): string {
  const dir = process.env.DESKMATES_PROMPTS_DIR?.trim()
  return dir || join(process.cwd(), 'prompts')
}

/** The base-prompt file per project kind (see prompts/README.md). */
const BASE_PROMPT_FILES: Record<'work' | 'design', string> = {
  work: join('claude-cowork', 'claude-cowork.md'),
  design: join('claude-design', 'claude-design.md')
}

/** Absolute path of the base prompt for a project kind. */
export function basePromptPath(kind: Project['kind']): string {
  return join(promptsDir(), BASE_PROMPT_FILES[kind === 'design' ? 'design' : 'work'])
}

/**
 * Reads the base prompt for a project kind, or null when the file is missing or empty. Base-prompt
 * files are loaded once per mtime, since they only change between app launches.
 */
const basePromptCache = new Map<string, { mtimeMs: number; content: string | null }>()

export function loadBasePrompt(kind: Project['kind']): string | null {
  const path = basePromptPath(kind)
  try {
    const stats = statSync(path)
    const cached = basePromptCache.get(path)
    if (cached && cached.mtimeMs === stats.mtimeMs) return cached.content
    const content = existsSync(path) ? readFileSync(path, 'utf8').trim() : null
    basePromptCache.set(path, { mtimeMs: stats.mtimeMs, content: content || null })
    return content || null
  } catch {
    return null
  }
}

/** Reads project instructions from DESKMATES.md, falling back to AGENTS.md. Returns null when neither exists or content is empty. */
export function readProjectInstructions(folder: string): string | null {
  for (const name of ['DESKMATES.md', 'AGENTS.md']) {
    const p = join(folder, name)
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8').trim()
      if (content) return content
    }
  }
  return null
}

const INSTALL_NOTE =
  'When the user asks you to install an MCP server, skill or plugin, do it: fetch or install it with the shell if needed (git clone, pip, npm, uv), then register it with add_mcp_server, install_skill or install_plugin so every Deskmates agent can use it. list_extensions shows what is installed.'

export interface BuildInstructionsInput {
  project: Project
  settings: Settings
  memories: Memory[]
  projectInstructions: string | null
  now: Date
  model: { provider: ProviderId; modelId: string }
  /** Installed skill names, so the assistant knows what it can load. */
  skills?: string[]
}

/** Builds the full system instructions for the assistant. */
export function buildInstructions(input: BuildInstructionsInput): string {
  const { project, settings, memories, projectInstructions, now, model } = input
  const isDesign = project.kind === 'design'
  const parts: string[] = []

  // A base prompt (claude-design / claude-cowork .md) governs on its own: the Deskmates rules below
  // would contradict its workflow, file formats and style, so only facts about this setup follow it.
  const basePrompt = loadBasePrompt(project.kind)
  if (basePrompt) {
    parts.push(basePrompt)
    parts.push('')
    parts.push('---')
    parts.push('')
    parts.push(
      'Everything above is your system prompt: follow it exactly, including its workflow, the tools it tells you to use, its file formats and its response style. What follows only describes this particular setup, together with the user\'s saved memories and instructions.'
    )
    parts.push('')
    parts.push('Environment:')
    parts.push(`- Project: ${project.name}`)
    parts.push(`- Project folder: ${project.folder}. File tools take paths relative to it; /mnt/user-data/outputs, /mnt/user-data/uploads and /home/claude all mean this folder.`)
    if (isDesign) {
      parts.push("- The preview beside the chat shows the project's .html and .dc.html pages; the user can also edit a page there directly.")
    }
    parts.push(`- The computer is the user's Windows PC. Model: ${PROVIDER_LABELS[model.provider]} ${model.modelId}.`)
    parts.push(`- ${INSTALL_NOTE}`)
    const timeStr = now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })
    parts.push(`- Now: ${timeStr} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`)
    pushUserContext(parts, input)
    return parts.join('\n')
  }

  // 1. Identity preamble
  parts.push(
    isDesign
      ? 'You are Deskmates, an AI designer. You build web pages in the Deskmates Design tab. The user sees your page live in a preview next to this chat and can also edit it directly: select, move, resize, and change fonts, sizes and colors.'
      : 'You are Deskmates, an AI assistant that works in a project folder on the user\'s Windows PC.'
  )

  // 2. Project and folder
  parts.push(`Project: ${project.name}`)
  parts.push(
    isDesign
      ? `Design folder: ${project.folder} (the design is index.html in this folder)`
      : `Folder: ${project.folder} (all file paths are relative to this folder)`
  )

  // 3. Current date/time
  const timeStr = now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  parts.push(`Now: ${timeStr} (${timeZone})`)

  // 4. How to design (design projects only)
  if (isDesign) {
    parts.push('')
    parts.push('How to design:')
    parts.push('- Keep the design one self-contained index.html: inline <style>, no build step, no JavaScript frameworks unless the user asks. Web fonts may come from Google Fonts (<link> to https://fonts.googleapis.com/css2). Images may be https URLs or inline SVG.')
    parts.push('- Make it responsive: it must look right 1440, 834 and 390 pixels wide.')
    parts.push("- Elements carry data-dm-id attributes, which the preview editor uses to track the user's selection and edits. Keep them on elements you change, and don't invent new ones: the editor adds them.")
    parts.push("- Inline translate, width, height and font styles on elements are usually the user's direct edits. Keep them unless the user asks you to change that element.")
    parts.push("- When the message starts with a 'Selected element' block, it names one element by data-dm-id and shows its HTML. Change only that element unless the user asks for more.")
    parts.push('- Read index.html before changing it. Use edit_file for targeted changes and write_file for a first draft or a full redesign.')
    parts.push('- Never add scripts that send data anywhere, trackers or analytics.')
    parts.push('- Aim for polished, modern, well-spaced layouts with a clear type hierarchy, like a professional designer would.')
  }

  // 5. How to work
  parts.push('')
  parts.push('How to work:')
  parts.push('- For tasks with more than one step, call update_plan first and keep it current.')
  parts.push('- Look at files before changing them.')
  parts.push('- Prefer edit_file for small changes and write_file for new files or full rewrites.')
  parts.push('- Every file change is recorded and the user can undo it.')
  parts.push('- delete_path and run_command need the user\'s approval; if the user denies one, don\'t retry it, explain instead.')
  parts.push('- Use remember for lasting preferences and facts, never for passwords or secrets.')
  parts.push('- Finish with a short summary of what changed and where.')
  parts.push(`- ${INSTALL_NOTE}`)

  // 6. How to write
  parts.push('')
  parts.push('How to write:')
  parts.push('- Lead with the result or answer, then only the details that matter.')
  parts.push('- Write plain, warm, direct sentences, and use Markdown only where it helps (short lists, code, small tables).')
  parts.push('- Don\'t narrate every step, because the app already shows tool activity as a gray summary line; while working, add at most one short sentence when you change direction or find something important.')
  parts.push('- Keep the final message short: what you did, what changed, and anything the user needs to decide.')
  parts.push('- If the request is ambiguous and a wrong guess would waste work, ask one clear question first.')
  parts.push('- Never invent file contents or results you haven\'t seen.')

  // 7. Identity
  parts.push('')
  parts.push(`You are the Deskmates assistant, running on ${PROVIDER_LABELS[model.provider]} model ${model.modelId}. If someone asks which model or assistant you are, say that plainly. Never claim to be a different assistant or another company's product.`)

  pushUserContext(parts, input)
  return parts.join('\n')
}

/** Saved memories, installed skills, and the user's global and project instructions. */
function pushUserContext(parts: string[], input: BuildInstructionsInput): void {
  const { settings, memories, projectInstructions } = input

  // 8. Saved memories
  parts.push('')
  if (memories.length > 0) {
    parts.push('Saved memories:')
    for (const m of memories) {
      parts.push(`- [${m.id}] ${m.content}`)
    }
  } else {
    parts.push('Saved memories:')
    parts.push('No saved memories yet.')
  }

  // 8.5 Installed skills
  if (input.skills && input.skills.length > 0) {
    parts.push('')
    parts.push('Installed skills — when a task matches one, load it first (load_skill, Skill or read_skill_prompt with its name) and follow it:')
    parts.push(input.skills.map((name) => `- ${name}`).join('\n'))
  }

  // 9. User instructions (global) — only if not blank
  const globalInstr = settings.globalInstructions?.trim()
  if (globalInstr) {
    parts.push('')
    parts.push('User instructions (all projects):')
    parts.push(globalInstr)
  }

  // 10. Project instructions — only if present
  if (projectInstructions) {
    parts.push('')
    parts.push('Project instructions (from DESKMATES.md):')
    parts.push(projectInstructions)
  }
}
