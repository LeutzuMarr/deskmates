/**
 * The user's own operating prompt, used by every agent that has no tab prompt of its own: the Work
 * tab, Duo, the bots, computer use and the connected command-line agents. It is the Fable 5.2 prompt
 * (prompts/fable/claude-fable-5.2.md); an older prompts/my-prompt/my-prompt.md is used only when that
 * file isn't there. The Design tab keeps the Design prompt.
 *
 * The file is never changed. It is far more than a small model can take in at once (about 450 KB),
 * so agents get its first section (Claude behavior: how to behave, refuse, format and care for the
 * user) in full, plus an index of the other sections and their parts, which they read when a task
 * touches them. Its "Tools" sections are not in the index: each tool's description is in the agent's
 * own tool list, and Deskmates builds those tools from the schemas there (see promptToolSpecs).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { promptsDir } from './instructions'
import { GROUNDING_RULES } from './grounding'
import { parseLooseJson } from './loose-json'
import { currentEffort, effortLines, effortPlainLine, effortTable } from './effort'
import type { EffortLevel } from '../../shared/effort'

/** The operating prompt, newest first: the first one present is used. */
export const OPERATING_PROMPT_FILES = [join('fable', 'claude-fable-5.2.md'), join('my-prompt', 'my-prompt.md')] as const
export const MY_PROMPT_FILE = OPERATING_PROMPT_FILES[0]

/** A section longer than this comes back as its list of parts, so one read can't flood the context. */
const MAX_SECTION_CHARS = 40_000

export interface PromptSection {
  /** The heading as written; a repeated title gets " (2)", " (3)"… so each one can be asked for. */
  title: string
  /** 1-based line numbers, inclusive. */
  from: number
  to: number
  /** The section's "## " parts, in order. */
  parts: PromptSection[]
}

interface Loaded {
  path: string
  lines: string[]
  sections: PromptSection[]
}

let cache: { path: string; mtimeMs: number; loaded: Loaded } | null = null

export function myPromptPath(dir = promptsDir()): string {
  for (const file of OPERATING_PROMPT_FILES) {
    const path = join(dir, file)
    if (existsSync(path)) return path
  }
  return join(dir, MY_PROMPT_FILE)
}

const isTools = (title: string): boolean => /^tools( \(\d+\))?$/i.test(title)

/** The prompt split into its top-level `# ` sections (and their `## ` parts), or null when the file isn't there. */
export function loadMyPrompt(path = myPromptPath()): Loaded | null {
  try {
    if (!existsSync(path)) return null
    const { mtimeMs } = statSync(path)
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.loaded
    const lines = readFileSync(path, 'utf8').replace(/\r/g, '').split('\n')
    const sections: PromptSection[] = []
    const seen = new Map<string, number>()
    let inFence = false
    lines.forEach((line, i) => {
      if (/^```/.test(line)) inFence = !inFence
      if (inFence) return
      const top = /^# (\S.*)$/.exec(line)
      if (top) {
        const last = sections[sections.length - 1]
        if (last) {
          last.to = i
          const part = last.parts[last.parts.length - 1]
          if (part) part.to = i
        }
        const base = top[1]!.trim()
        const count = (seen.get(base.toLowerCase()) ?? 0) + 1
        seen.set(base.toLowerCase(), count)
        sections.push({ title: count > 1 ? `${base} (${count})` : base, from: i + 1, to: lines.length, parts: [] })
        return
      }
      const sub = /^## (\S.*)$/.exec(line)
      const section = sections[sections.length - 1]
      if (sub && section) {
        const part = section.parts[section.parts.length - 1]
        if (part) part.to = i
        section.parts.push({ title: sub[1]!.trim(), from: i + 1, to: section.to, parts: [] })
      }
    })
    for (const section of sections) {
      const last = section.parts[section.parts.length - 1]
      if (last) last.to = section.to
    }
    const loaded = { path, lines, sections }
    cache = { path, mtimeMs, loaded }
    return loaded
  } catch {
    return null
  }
}

const textOf = (loaded: Loaded, range: { from: number; to: number }): string => loaded.lines.slice(range.from - 1, range.to).join('\n').trim()

const normalise = (title: string): string =>
  title
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/[`<>]/g, '')
    .toLowerCase()

/**
 * One section's text by its title (case-insensitive), or one of its "## " parts (a tool's whole
 * entry, for example), or null. A section too long to read at once comes back as its list of parts.
 */
export function myPromptSection(title: string, path = myPromptPath()): string | null {
  const loaded = loadMyPrompt(path)
  if (!loaded) return null
  const wanted = normalise(title)
  if (!wanted) return null
  const sections = loaded.sections
  const parts = sections.flatMap((s) => s.parts.map((p) => ({ part: p, section: s })))
  const section =
    sections.find((s) => normalise(s.title) === wanted) ??
    (parts.some((p) => normalise(p.part.title) === wanted) ? undefined : sections.find((s) => normalise(s.title).includes(wanted)))
  if (section) {
    const text = textOf(loaded, section)
    if (text.length <= MAX_SECTION_CHARS) return text
    return [
      `# ${section.title}`,
      '',
      `This section is long (${Math.round(text.length / 1000)} KB). Read the part you need by its title:`,
      ...section.parts.map((p) => `- ${p.title}`)
    ].join('\n')
  }
  const part = parts.find((p) => normalise(p.part.title) === wanted) ?? parts.find((p) => normalise(p.part.title).includes(wanted))
  return part ? textOf(loaded, part.part) : null
}

/** The index line for one section: its title, its parts, and (for a file reader) where it is. */
function indexLine(section: PromptSection, withLines: boolean): string {
  const parts = section.parts.map((p) => p.title.replace(/[`]/g, '')).filter(Boolean)
  const where = withLines ? ` (lines ${section.from}–${section.to})` : ''
  return `- ${section.title}${where}${parts.length ? ` — ${parts.join('; ')}` : ''}`
}

/**
 * What an agent is given: the first section in full and how to read the rest. `readHow` says how
 * this agent reads a section (a tool, or the file path and line numbers for a command-line agent).
 *
 * `promptTools`: the run really has the prompt's tools under their own names (the Work tab on an API
 * model, bots, Duo). 'mcp': a command-line agent that reaches them through the deskmates-prompt MCP
 * server (Freebuff, OpenCode). Otherwise the agent is told it can't call them.
 */
/**
 * The lines above the prompt's first heading (Fable's effort table, its <reasoning_effort> and
 * <thinking_mode> tags), with the effort the user picked in place of the file's own value, and a
 * plain line saying what that level means.
 */
function preamble(loaded: Loaded, effort: EffortLevel): string {
  const head = loaded.lines.slice(0, loaded.sections[0]!.from - 1).join('\n').trim()
  // The tag may carry a namespace (<x:reasoning_effort>); the file's own spelling is kept.
  const tag = /(<(?:[\w-]+:)?reasoning_effort>)[^<]*(<\/(?:[\w-]+:)?reasoning_effort>)/
  if (!tag.test(head)) return effortLines(effort, loaded.path)
  const value = effortTable(loaded.path)[effort]
  return `${head.replace(tag, (_all, open: string, close: string) => `${open}${value}${close}`)}\n\n${effortPlainLine(effort)}`
}

export function myPromptBrief(readHow: 'tool' | 'file' | 'none', path = myPromptPath(), options: { promptTools?: boolean | 'mcp'; effort?: EffortLevel } = {}): string | null {
  const loaded = loadMyPrompt(path)
  if (!loaded || loaded.sections.length === 0) return null
  const [first, ...rest] = loaded.sections
  const core = `${preamble(loaded, options.effort ?? currentEffort())}\n\n${textOf(loaded, first!)}`
  if (readHow === 'none') {
    return ["Your operating prompt is the user's own prompt. Its first section follows; follow it in everything you do.", '', core, '', GROUNDING_RULES].join('\n')
  }
  const index = rest.filter((s) => !isTools(s.title)).map((s) => indexLine(s, readHow === 'file'))
  const toolSections = rest.filter((s) => isTools(s.title))
  const how =
    readHow === 'tool'
      ? 'Read a section, or just one of its parts (the names after the dash), with read_prompt_section when the task touches it.'
      : `Read one from ${loaded.path} by its line numbers when the task touches it (a part starts at its "## " heading); never read the whole file at once.`
  const toolsNote =
    toolSections.length === 0
      ? ''
      : readHow === 'file'
        ? ` Its "Tools" sections (lines ${toolSections.map((s) => `${s.from}–${s.to}`).join(', ')}) describe the tools under "## name" headings.`
        : ' Its "Tools" sections are not listed: every tool they describe is in your tool list with its description; read_prompt_section with a tool\'s name gives its full entry.'
  return [
    "Your operating prompt is the user's own prompt. Its first section follows in full; follow it in everything you do.",
    '',
    core,
    '',
    options.promptTools === 'mcp'
      ? `Its other sections, for when they apply. ${how}${toolsNote} The tools its "Tools" sections name are real: the deskmates-prompt MCP server gives you each one under the same name (your agent may show it with a deskmates-prompt prefix). Call them rather than describing what they would do; the ones that send, delete, share or run commands ask the user in Deskmates first. Keep to this app's safety rules.`
      : readHow === 'tool' && options.promptTools
        ? `Its other sections, for when they apply. ${how}${toolsNote} The tools they name are real tools in this run, under the same names; call them rather than describing what they would do. Where a section names a product this app doesn't have (claude.ai links, install cards), the tool's result says what happens here instead. Keep to this app's safety rules.`
        : `Its other sections, for when they apply. ${how}${toolsNote} Its "Tools" sections describe tools of the Deskmates Work tab that you may not have here: only the tools you were actually given exist for you. Do the same job with those${readHow === 'file' ? ' and the deskmates command' : ''}, and never write a tool call or its result as if you had made it. Keep to this app's safety rules.`,
    ...index,
    ...(options.promptTools ? ['', GUIDES_NOTE] : []),
    '',
    GROUNDING_RULES
  ].join('\n')
}

/** The guides an agent loads only when a task calls for them (engine/guides.ts). */
const GUIDES_NOTE =
  "Guides to load only when the task calls for them, never otherwise: read_chrome_instructions before your first step in the user's own Chrome (the Chrome tools); read_research_instructions when the user asks for research or a question needs a thorough, multi-source answer; mcp__visualize__read_me (with the modules you need) before your first mcp__visualize__show_widget."

export interface PromptToolSpec {
  /** The opening of the tool's description in the prompt. */
  description: string
  /** Its JSON Schema as the prompt gives it, or null when no block for it could be read. */
  schema: unknown | null
}

let toolsCache: { path: string; mtimeMs: number; specs: Map<string, PromptToolSpec> } | null = null

/** The first paragraph of a tool's text (two when the first is a single short line), up to 600 characters. */
function toolDescription(body: string): string {
  const prose = body.split(/\n```/)[0] ?? ''
  const paragraphs = prose
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  let text = paragraphs[0] ?? ''
  if (text.length < 120 && paragraphs[1] && !/^#/.test(paragraphs[1])) text = `${text}\n\n${paragraphs[1]}`
  return text.replace(/[ \t]+\n/g, '\n').slice(0, 600)
}

/**
 * The tools the prompt's "Tools" sections describe, by name: each "## name" heading's description,
 * and its JSON block (fenced as json or yaml, read leniently; the block whose "name" is the tool's,
 * since a tool's text may show other examples first). Deskmates builds the matching tools from these,
 * so their inputs are exactly what the prompt teaches the agent to send.
 */
export function promptToolSpecs(path = myPromptPath()): Map<string, PromptToolSpec> {
  const loaded = loadMyPrompt(path)
  if (!loaded) return new Map()
  const { mtimeMs } = statSync(path)
  if (toolsCache && toolsCache.path === path && toolsCache.mtimeMs === mtimeMs) return toolsCache.specs
  const specs = new Map<string, PromptToolSpec>()
  for (const section of loaded.sections.filter((s) => isTools(s.title))) {
    for (const part of section.parts) {
      const name = part.title
      if (!name || /\s/.test(name)) continue
      const body = loaded.lines.slice(part.from, part.to).join('\n')
      let schema: unknown | null = null
      for (const match of body.matchAll(/```(?:json|yaml)\n([\s\S]*?)\n```/g)) {
        const parsed = parseLooseJson(match[1]!) as { name?: string; parameters?: unknown; input_schema?: unknown } | null
        if (parsed && typeof parsed === 'object' && parsed.name === name) {
          schema = parsed.parameters ?? parsed.input_schema ?? null
          break
        }
      }
      if (!specs.has(name)) specs.set(name, { description: toolDescription(body), schema })
    }
  }
  toolsCache = { path, mtimeMs, specs }
  return specs
}

/** The tool agents read the other sections with. */
export function promptSectionTool(path?: string) {
  return {
    read_prompt_section: tool({
      description: "Read one section of the user's operating prompt, or one part of a section, by its title (from the index in your instructions). A tool's name gives that tool's full entry.",
      inputSchema: z.object({ title: z.string().min(1) }),
      execute: async ({ title }) => myPromptSection(title, path ?? myPromptPath()) ?? `There is no section or part called "${title}". Use a title from the index.`
    })
  }
}
