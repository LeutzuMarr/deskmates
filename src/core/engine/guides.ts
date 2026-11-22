/**
 * Instructions agents load only when a task calls for them, so they cost nothing otherwise:
 * - the Claude in Chrome instructions (prompts/claude-in-chrome/claude-in-chrome.md), before driving
 *   the user's own Chrome: read_chrome_instructions, the "chrome-browser" skill, or handed over with
 *   the result of the first Chrome tool call of a run;
 * - the research instructions (prompts/research/research_instructions.md), before a piece of
 *   research: read_research_instructions;
 * - the Visualizer's design guide (prompts/visualize/visualize.md), split into modules, as the
 *   result of mcp__visualize__read_me.
 * The files are the user's and never changed; Deskmates adds a line on what differs here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { promptsDir } from './instructions'

export type GuideKind = 'chrome' | 'research' | 'visualize'

const GUIDE_FILES: Record<GuideKind, string> = {
  chrome: join('claude-in-chrome', 'claude-in-chrome.md'),
  research: join('research', 'research_instructions.md'),
  visualize: join('visualize', 'visualize.md')
}

/** File names a guide may also have when dropped straight into the prompts folder. */
const LOOSE_NAMES: Record<GuideKind, RegExp> = {
  chrome: /^claude-in-chrome\.md$/i,
  research: /^research[_-]instructions\.md$/i,
  visualize: /^visuali[sz]e\.md$/i
}

/** Where a guide is: its own folder, or loose in the prompts folder. Null when it isn't there. */
export function guidePath(kind: GuideKind, dir = promptsDir()): string | null {
  const own = join(dir, GUIDE_FILES[kind])
  if (existsSync(own)) return own
  try {
    const loose = readdirSync(dir).find((name) => LOOSE_NAMES[kind].test(name))
    return loose ? join(dir, loose) : null
  } catch {
    return null
  }
}

const cache = new Map<string, { mtimeMs: number; text: string }>()

function readGuide(kind: GuideKind, dir?: string): string | null {
  const path = guidePath(kind, dir)
  if (!path) return null
  try {
    const { mtimeMs } = statSync(path)
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return hit.text
    const text = readFileSync(path, 'utf8').replace(/\r/g, '')
    cache.set(path, { mtimeMs, text })
    return text
  } catch {
    return null
  }
}

interface Part {
  title: string
  level: number
  text: string
}

/** Splits Markdown into its `#` (level 1) or `##` (level 2) parts, ignoring headings in code fences. */
function splitParts(text: string, level: 1 | 2): { head: string; parts: Part[] } {
  const lines = text.split('\n')
  const parts: Part[] = []
  const head: string[] = []
  let current: Part | null = null
  let inFence = false
  const marker = level === 1 ? /^# (\S.*)$/ : /^## (\S.*)$/
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence
    const match = inFence ? null : marker.exec(line)
    if (match) {
      current = { title: match[1]!.trim(), level, text: line }
      parts.push(current)
    } else if (current) current.text += `\n${line}`
    else head.push(line)
  }
  return { head: head.join('\n').trim(), parts }
}

// ---- Claude in Chrome ----

const CHROME_NOTE = [
  "Deskmates note: these are the Claude in Chrome instructions, for driving the user's own Google Chrome (their real tabs and sign-ins). Follow them for every step in Chrome. What differs here:",
  "- The tools are Deskmates' Chrome tools under the same names (tabs_context, navigate, read_page, find, computer, form_input, get_page_text, browser_batch, upload_image, resize_window, gif_creator, read_console_messages, read_network_requests, javascript_tool, tabs_create, tabs_close). Their descriptions are in your tool list; these instructions replace any other browser guidance for Chrome work.",
  '- This computer runs Windows: use "ctrl" where the instructions say "cmd".',
  '- "Asking the user in the chat" also happens through Deskmates\' question cards: the first click or typing on a site, the user\'s own tabs, and anything that sends, posts, pays or deletes ask the user in the app, and the tool waits for the answer.',
  "- update_plan here is also the task list: send domains and approach (the Chrome form) or items; each site is still asked about once when you first act on it.",
  '- turn_answer_start exists and does nothing here; calling it once before your answer is fine.',
  "- Your own operating prompt still decides who you are, your knowledge cutoff and how you write; the product and date lines below are Chrome's own and don't apply."
].join('\n')

/** The Chrome sections Deskmates leaves out by default: who the model is (the agent's own prompt
 *  decides) and the tool list (already in the agent's tool list). Both can be read by name. */
const CHROME_SKIPPED = /^(behavior instructions|tools)$/i

/**
 * The Claude in Chrome instructions, with Deskmates' note on top. Without `section`: every part
 * except "Behavior instructions" and "Tools". With it: that part, or one tool's entry by name.
 */
export function chromeInstructions(section?: string, dir?: string): string | null {
  const text = readGuide('chrome', dir)
  if (!text) return null
  const { head, parts } = splitParts(text, 1)
  if (section?.trim()) {
    const wanted = section.trim().replace(/^#+\s*/, '').toLowerCase()
    const part = parts.find((p) => p.title.toLowerCase() === wanted) ?? parts.find((p) => p.title.toLowerCase().includes(wanted))
    if (part) return part.text.trim()
    for (const p of parts) {
      const sub = splitParts(p.text, 2).parts.find((s) => s.title.toLowerCase() === wanted)
      if (sub) return sub.text.trim()
    }
    return `There is no part called "${section}". Parts: ${parts.map((p) => p.title).join('; ')}.`
  }
  const kept = parts.filter((p) => !CHROME_SKIPPED.test(p.title)).map((p) => p.text.trim())
  const skipped = parts.filter((p) => CHROME_SKIPPED.test(p.title)).map((p) => p.title)
  return [
    CHROME_NOTE,
    '',
    head,
    '',
    ...kept,
    '',
    skipped.length ? `(Left out here: ${skipped.join(', ')}. read_chrome_instructions with section gives one of them, or one tool's entry by its name.)` : ''
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .trim()
}

/** Which guides each run has been given (by run key and kind), so each is handed over once. */
const given = new Map<string, number>()
const GIVEN_FOR_MS = 6 * 60 * 60_000

/** Notes that `runKey` has had guide `kind` (read it, or got it with a tool result or its instructions). */
export function markGuideGiven(runKey: string, kind: GuideKind): void {
  given.set(`${kind}:${runKey}`, Date.now())
  if (given.size > 1500) given.delete(given.keys().next().value as string)
}

/** Whether this run still needs guide `kind` (and the file exists to give). */
export function guideDue(runKey: string, kind: GuideKind, dir?: string): boolean {
  const at = given.get(`${kind}:${runKey}`)
  if (at !== undefined && Date.now() - at < GIVEN_FOR_MS) return false
  return guidePath(kind, dir) !== null
}

export function markChromeInstructionsGiven(runKey: string): void {
  markGuideGiven(runKey, 'chrome')
}

/** Whether this run still needs the Chrome instructions (and the file exists to give). */
export function chromeInstructionsDue(runKey: string, dir?: string): boolean {
  return guideDue(runKey, 'chrome', dir)
}

/** Forgets which runs had which guides (tests). */
export function resetChromeInstructions(): void {
  given.clear()
}
export const resetGuides = resetChromeInstructions

// ---- Research ----

const RESEARCH_NOTE = [
  'Deskmates note: Advanced Research is now on for this task. In Deskmates:',
  '- `launch_extended_search_task` is mcp__claude_ai__launch_extended_search_task. It runs a research agent here (web search and page reading) and returns its report when it is done; read it again later with mcp__claude_ai__read_research_report.',
  '- `web_search` is WebSearch (and WebFetch reads a page).',
  '- The research agent cannot ask the user anything, so ask your clarifying questions (if any) before launching it, as below.'
].join('\n')

/** The research instructions (the <research_instructions> part; the tool itself is in the tool list). */
export function researchInstructions(dir?: string): string | null {
  const text = readGuide('research', dir)
  if (!text) return null
  const end = text.indexOf('</research_instructions>')
  const body = end === -1 ? text : text.slice(0, end + '</research_instructions>'.length + 1)
  return `${RESEARCH_NOTE}\n\n${body.trim()}`
}

// ---- Visualizer ----

export const VISUALIZE_MODULES = ['diagram', 'mockup', 'interactive', 'data_viz', 'art', 'chart', 'elicitation'] as const

/** Which of visualize.md's "## " parts each module needs, besides the parts every module gets. */
const MODULE_PARTS: Record<(typeof VISUALIZE_MODULES)[number], RegExp[]> = {
  diagram: [/^color palette/i, /^svg setup/i, /^diagram types/i],
  mockup: [/^color palette/i, /^ui components/i],
  interactive: [/^color palette/i, /^svg setup/i, /^diagram types/i, /^ui components/i, /^charts/i],
  data_viz: [/^color palette/i, /^ui components/i, /^charts/i],
  chart: [/^color palette/i, /^ui components/i, /^charts/i],
  art: [/^color palette/i, /^svg setup/i, /^art/i],
  elicitation: [/^ui components/i]
}
const ALWAYS = [/^modules/i, /^core design system/i, /^when nothing fits/i]

const VISUALIZE_NOTE = [
  "Deskmates note: in this app the widget host provides everything this guide relies on: the CSS variables, the SVG classes (t, ts, th, box, node, arr, leader, c-{ramp}), pre-styled form elements, sendPrompt(text) (sends the text to this chat as the user's next message) and openLink(url).",
  '`imagine_svg` and `imagine_html` below both mean mcp__visualize__show_widget: code starting with <svg is drawn as SVG, anything else as HTML.'
].join('\n')

/** The Visualizer's guide for the given modules (none: the core rules and the module list). */
export function visualizeGuide(modules: string[] = [], dir?: string): string | null {
  const text = readGuide('visualize', dir)
  if (!text) return null
  const { head, parts } = splitParts(text, 2)
  const wanted = modules.map((m) => m.toLowerCase()).filter((m): m is (typeof VISUALIZE_MODULES)[number] => (VISUALIZE_MODULES as readonly string[]).includes(m))
  const patterns = [...ALWAYS, ...wanted.flatMap((m) => MODULE_PARTS[m])]
  const kept = parts.filter((p) => patterns.some((re) => re.test(p.title)))
  const unknown = modules.filter((m) => !(VISUALIZE_MODULES as readonly string[]).includes(m.toLowerCase()))
  return [
    VISUALIZE_NOTE,
    '',
    head,
    ...kept.map((p) => p.text.trim()),
    unknown.length ? `\n(No module called ${unknown.join(', ')}. Modules: ${VISUALIZE_MODULES.join(', ')}.)` : ''
  ]
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---- Built-in skills ----

/**
 * Skills the operating prompt lists that Deskmates provides itself, for when the user has no
 * installed skill of that name. Null for a name Deskmates doesn't know.
 */
export function builtinSkill(name: string, dir?: string): { name: string; instructions: string } | null {
  const key = name.replace(/^.*:/, '').trim().toLowerCase()
  const note = (instructions: string) => ({ name: key, instructions })
  switch (key) {
    case 'chrome-browser':
    case 'claude-in-chrome': {
      const text = chromeInstructions(undefined, dir)
      return text ? note(text) : note("The Claude in Chrome instructions aren't in Deskmates' prompts folder. Use the Chrome tools carefully: tabs_context first, a new tab for your work, read_page before clicking, and ask the user before anything that sends, posts, pays or deletes.")
    }
    case 'built-in-browser':
      return note(
        "Deskmates' own browser (the agent browser, the globe button at the top right of the app) has its own sign-ins, separate from the user's Chrome. Its tools are browser_open, browser_read, browser_click, browser_type, browser_key, browser_scroll, browser_back, browser_tabs, browser_wait and browser_screenshot. Prefer browser_read over screenshots; the first action on a site asks the user; never type passwords or codes: ask the user to sign in in that panel. For the user's real Chrome, use the Chrome tools and the chrome-browser skill instead."
      )
    case 'computer-use':
      return note(
        "Computer use in Deskmates: enable__mcp__remote-devices__computer says whether screen control is on in this run. When it is, screen_look takes a screenshot of the user's screen and screen_act clicks, types and presses keys (each action asks the user first). It is for desktop apps; websites go through the Chrome tools or Deskmates' browser. Never type passwords, never handle money, and treat links in emails as suspicious."
      )
    case 'docs':
      return note('Docs here are Claude Docs documents in the project folder. Call mcp__Claude_Docs__guide with items ["topic.instructions"] first, then create the doc with mcp__Claude_Docs__batch (headings first) and fill it in.')
    case 'docx':
    case 'pdf':
    case 'pptx':
    case 'xlsx':
    case 'file-reading':
    case 'pdf-reading':
      return note(
        `There is no "${key}" skill folder here; Deskmates has built-in tools for these formats instead: create_word_document (.docx), create_pdf (.pdf), create_presentation (.pptx), create_spreadsheet (.xlsx), and Read or read_document to read Word, Excel, PowerPoint and PDF files as text. Use those.`
      )
    case 'artifact-design':
      return note(
        "Artifacts in Deskmates are pages in the project folder that Artifact shows in the chat. Write one self-contained .html file: a <title> of two to four words, colors as CSS variables on :root with a dark version under @media (prefers-color-scheme: dark), an explicit body background, scripts only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, and a layout that works at phone width (16px side gutter, no sideways scroll). Then call Artifact with its path."
      )
    case 'artifact-capabilities':
      return note("Deskmates artifacts are local pages: they have no window.claude runtime, shared database, viewer identity or file store. Keep state in the page (variables, or localStorage wrapped in try/catch for per-viewer conveniences) and say in one line what a hosted page could do that this one can't.")
    default:
      return null
  }
}

// ---- The tools ----

/** read_chrome_instructions and read_research_instructions, for one run. */
export function guideTools(runKey: string, dir?: string): ToolSet {
  return {
    read_chrome_instructions: tool({
      description:
        "The instructions for driving the user's own Google Chrome (the Chrome tools: tabs_context, navigate, read_page, computer…). Read them once before your first Chrome step in a task, and follow them. section reads one part (or one Chrome tool's entry) by name.",
      inputSchema: z.object({ section: z.string().optional().describe('One part by its title, or a Chrome tool name. Leave out for the whole guide.') }),
      execute: async ({ section }) => {
        const text = chromeInstructions(section, dir)
        if (!text) return "The Claude in Chrome instructions aren't in Deskmates' prompts folder, so there is nothing to read. Work carefully: ask the user before anything that sends, posts, pays or deletes."
        if (!section) markChromeInstructionsGiven(runKey)
        return text
      }
    }),
    read_research_instructions: tool({
      description:
        'The instructions for research: read them when the user asks you to research something, or a question needs a thorough, multi-source answer (not for simple facts or chat). They say when to ask clarifying questions and how to launch the research agent (mcp__claude_ai__launch_extended_search_task).',
      inputSchema: z.object({}),
      execute: async () => {
        const text = researchInstructions(dir)
        if (!text) return "The research instructions aren't in Deskmates' prompts folder. Research with WebSearch and WebFetch yourself: several searches, read the best sources, and end with a short Sources list."
        markGuideGiven(runKey, 'research')
        return text
      }
    })
  }
}

/** The guide tools as the deskmates-prompt MCP server lists them. */
export const GUIDE_TOOL_NAMES = ['read_chrome_instructions', 'read_research_instructions'] as const

export function guideToolInfos(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const tools = guideTools('list')
  return GUIDE_TOOL_NAMES.map((name) => {
    const t = tools[name] as unknown as { description: string; inputSchema: z.ZodType }
    const { $schema: _drop, ...schema } = z.toJSONSchema(t.inputSchema, { io: 'input' }) as Record<string, unknown>
    return { name, description: t.description, inputSchema: schema }
  })
}

// ---- When a task needs a guide ----

const RESEARCH_ASK = /\b(research|investigate|look into|deep[- ]dive|find out everything|comprehensive (?:overview|review|report|analysis)|literature review|market (?:research|analysis)|competitive analysis|state of the art|cite (?:your )?sources|with sources|report on|write (?:me )?a report)\b/i
const CHROME_ASK = /\b(chrome|my browser|my tabs?|in (?:the|my) browser|open (?:the )?(?:website|site|page|tab)|go to (?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|org|net|io|ro|dev|app|ai|co)\b)|log ?in to|sign ?in to|on (?:linkedin|gmail|facebook|instagram|x\.com|twitter|youtube|amazon|github)|fill (?:in|out) (?:the |this |a )?form)\b/i
const VISUALIZE_ASK = /\b(diagram|flow ?chart|chart|graph|plot|visuali[sz]e|visuali[sz]ation|illustrate|illustration|draw (?:me )?|sketch|mock-?up|wireframe|infographic|interactive (?:demo|widget|explainer)|calculator)\b/i

/** The guides a user's message calls for, judged from its words. */
export function guidesForMessage(text: string): GuideKind[] {
  const out: GuideKind[] = []
  if (RESEARCH_ASK.test(text)) out.push('research')
  if (CHROME_ASK.test(text)) out.push('chrome')
  if (VISUALIZE_ASK.test(text)) out.push('visualize')
  return out
}

/** The Visualizer modules a message most likely needs. */
export function visualizeModulesFor(text: string): string[] {
  const modules = new Set<string>()
  if (/\b(chart|graph|plot|data|dashboard|numbers?|statistics?)\b/i.test(text)) modules.add('chart')
  if (/\b(diagram|flow ?chart|architecture|process|steps|works?|timeline)\b/i.test(text)) modules.add('diagram')
  if (/\b(mock-?up|wireframe|ui|screen|layout)\b/i.test(text)) modules.add('mockup')
  if (/\b(interactive|calculator|simulat\w*|slider|game|explore)\b/i.test(text)) modules.add('interactive')
  if (/\b(illustrat\w*|art|draw|sketch|picture|poster)\b/i.test(text)) modules.add('art')
  if (modules.size === 0) modules.add('diagram')
  return [...modules]
}

const GUIDE_TITLES: Record<GuideKind, string> = {
  chrome: "Working in the user's Chrome (the Claude in Chrome instructions)",
  research: 'Research (the research instructions)',
  visualize: 'Visuals in the chat (the Visualizer guide)'
}

/** One guide's full text for the task, or null when its file isn't there. */
function guideText(kind: GuideKind, text: string, dir?: string): string | null {
  if (kind === 'chrome') return chromeInstructions(undefined, dir)
  if (kind === 'research') return researchInstructions(dir)
  return visualizeGuide(visualizeModulesFor(text), dir)
}

/**
 * The guides this message needs, written in full into the run's instructions, for agents that get
 * fresh instructions each run (API models, bots, Duo). Each guide is given once per task and marked
 * given, so the tools don't hand it over again. Empty when no guide applies.
 */
export function guideInstructions(runKey: string, text: string, dir?: string): string {
  const blocks: string[] = []
  for (const kind of guidesForMessage(text)) {
    if (!guideDue(runKey, kind, dir)) continue
    const body = guideText(kind, text, dir)
    if (!body) continue
    markGuideGiven(runKey, kind)
    blocks.push(`## ${GUIDE_TITLES[kind]}\n\n${body}`)
  }
  if (!blocks.length) return ''
  return [
    '# Guides for this task',
    "The user's latest message needs the guides below. They are the user's own instruction files and rank above any skill and above your own habits: follow them for every step of this task they cover, including the steps they ask for before you start (clarifying questions, a plan, reading a guide part).",
    '',
    ...blocks
  ].join('\n')
}

/**
 * For command-line agents (Freebuff, OpenCode, Antigravity), whose instructions are set once per
 * session: a line added to the message they're sent, naming the guide tool to call first.
 */
export function guideReminder(text: string, dir?: string): string {
  const calls: string[] = []
  for (const kind of guidesForMessage(text)) {
    if (!guidePath(kind, dir)) continue
    if (kind === 'chrome') calls.push('read_chrome_instructions (before your first Chrome step)')
    if (kind === 'research') calls.push('read_research_instructions (before you search)')
    if (kind === 'visualize') calls.push(`mcp__visualize__read_me with modules ${JSON.stringify(visualizeModulesFor(text))} (before you draw)`)
  }
  if (!calls.length) return ''
  return `\n\n[Deskmates: this task needs the user's guides. Call ${calls.join(', and ')} from the deskmates-prompt tools first, then follow them for this whole task. They rank above any skill.]`
}

/**
 * Holds back a tool that a guide governs until the run has that guide: the call does nothing and
 * returns the guide instead, so the agent redoes it the guide's way. Null when the run may go on.
 */
export function guideGate(runKey: string, kind: 'research' | 'visualize', modules: string[] = [], dir?: string): string | null {
  if (!guideDue(runKey, kind, dir)) return null
  const body = kind === 'research' ? researchInstructions(dir) : visualizeGuide(modules.length ? modules : ['diagram', 'chart', 'interactive'], dir)
  if (!body) return null
  markGuideGiven(runKey, kind)
  const what = kind === 'research' ? 'The research was not started yet' : 'Nothing was drawn yet'
  return `${what}: first read and follow the user's guide for this, below (it ranks above any skill). Then make the call again the way it says.\n\n${body}`
}
