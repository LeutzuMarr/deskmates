/**
 * System-instructions builder for the Deskmates assistant.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Memory, Project, ProviderId, Settings } from '../../shared/protocol'
import { PROVIDER_LABELS, isCliProvider } from '../../shared/protocol'

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

/**
 * Stops the one habit the base prompts reliably provoke.
 *
 * The captured `claude-cowork.md` and `claude-design.md` system prompts each contain a worked example
 * in which a user turn reads roughly `"/…/claude-cowork.md this one is pretty outdated, please update
 * to current, don't overwrite just create new file"`. Models read that as an instruction, not as an
 * illustration — and so have been writing a fresh dated `claude-cowork-<date>.md` into the user's
 * project folder, unbidden, in response to questions as innocent as "what model are you". The
 * behaviour is annoying rather than dangerous, but it is also pure litter: the prompt being "updated"
 * is the one already sitting above the model in this very message.
 *
 * Stated here, in the same voice as the rest of the system prompt, because the base prompt's own
 * example is the pressure it has to answer.
 */
const NO_PROMPT_FILE_COPIES =
  'Never create, copy, save or rewrite a file whose name contains `claude-cowork` or `claude-design`. ' +
  'Those names belong to the system prompt above, which is already present in full in this message: it is not a file in the project folder, it is not out of date, and there is nothing to update. ' +
  'This holds whatever the examples above show, and whatever a question about the prompt seems to imply. ' +
  'If asked about the system prompt, answer from what you have already read; never go looking for a file to rewrite.'

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

/**
 * What every Deskmates agent is told about the app's own tools: asking with cards, the agent browser,
 * screen control and scheduled tasks. Command-line agents (Freebuff, OpenCode, Antigravity) can't draw
 * cards or call these tools from a Work task, so they get the parts that apply to them.
 */
export function deskmatesToolsGuide(kind: 'work' | 'design', cli: boolean): string {
  const ask = kind === 'design' ? 'ask_user' : 'AskUserQuestion'
  if (cli) {
    return [
      'Asking the user:',
      '- Whenever you need the user to decide or answer something, end your reply with the question on its own line followed by a numbered list of 2 to 5 short options (one line each). Deskmates turns them into buttons, and the user can still type something else. Ask one question at a time.'
    ].join('\n')
  }
  return [
    'Asking the user:',
    `- Whenever you need the user to decide or answer something, don't ask in plain text: call ${ask} with 2 to 4 short options, so they tap an answer instead of typing it (they can always type their own). Then end your turn and wait for the answer.`,
    '',
    'The agent browser (browser_open, browser_read, browser_click, browser_type, browser_key, browser_scroll, browser_back, browser_tabs, browser_screenshot, browser_wait):',
    "- A real browser the user can watch and use from the globe button at the top right of Deskmates. Use it for sites that need clicking, the user's sign-ins or JavaScript; for plain reading, web_search and web_fetch are cheaper.",
    '- Each page comes back as text plus numbered elements; click and type by number, and read again after the page changes.',
    "- Sign-ins are the user's. Never type passwords, one-time codes, card or ID numbers (the browser refuses anyway): when a page needs a sign-in, ask the user to sign in in the browser panel, then continue.",
    '- The first click or typing on a site asks the user for permission. Anything that sends, posts, pays, signs or deletes asks again; on LinkedIn only the user presses Send.',
    "- If the user is using the browser, your action waits until they hand it back. Don't fight them for it.",
    '',
    "Screen control (screen_look, screen_act):",
    "- screen_look shows the user's whole screen with a numbered list of what can be clicked. screen_act uses their mouse and keyboard; the user approves it the first time in a task, and can stop it at any moment.",
    "- Use them to check your own work like a tester: open the app, page or document you made or changed, click through it, look at the result, and fix what is wrong before you say it is done. Run the project's tests too when it has them.",
    "- Prefer element numbers to x/y. Never type passwords, never close or delete the user's things, and don't touch other apps' windows beyond what the task needs.",
    '',
    'Scheduled tasks (schedule_create, schedule_list, schedule_update, schedule_delete):',
    '- When the user wants something done at set times ("every weekday at 7:30", "remind me tomorrow at 19:35 to…"), create a scheduled task with a structured when. Confirm the name, the instruction and the time with the user first (a question card is ideal).',
    '- Write the instruction so it stands on its own: each run starts fresh, without this conversation, in this project.',
    "- On a command-line model (Freebuff, OpenCode, Antigravity) a scheduled run doesn't start by itself: it waits for the user to press Start. Say so when you create one."
  ].join('\n')
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
    parts.push(NO_PROMPT_FILE_COPIES)
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

  parts.push('')
  parts.push(deskmatesToolsGuide(isDesign ? 'design' : 'work', isCliProvider(model.provider)))

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
