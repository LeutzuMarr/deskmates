/**
 * The user's own operating prompt (prompts/my-prompt/my-prompt.md), used by the agents that have no
 * tab prompt of their own: Duo, the bots, computer use in the Agents tab, and (through its own copy)
 * Buddy. The Work tab keeps the Cowork prompt, the Design tab the Design prompt, and connected coding
 * agents the Claude Code prompt.
 *
 * The file is never changed. It is about 470 KB, far more than a small model can take in at once,
 * so agents get its first section (claude_behavior: how to behave, refuse, format and care for the
 * user) in full, plus an index of the other sections, which they read when a task touches them.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { promptsDir } from './instructions'

export const MY_PROMPT_FILE = join('my-prompt', 'my-prompt.md')

export interface PromptSection {
  title: string
  /** 1-based line numbers, inclusive. */
  from: number
  to: number
}

interface Loaded {
  path: string
  lines: string[]
  sections: PromptSection[]
}

let cache: { mtimeMs: number; loaded: Loaded } | null = null

export function myPromptPath(dir = promptsDir()): string {
  return join(dir, MY_PROMPT_FILE)
}

/** The prompt split into its top-level `# ` sections, or null when the file isn't there. */
export function loadMyPrompt(path = myPromptPath()): Loaded | null {
  try {
    if (!existsSync(path)) return null
    const { mtimeMs } = statSync(path)
    if (cache && cache.loaded.path === path && cache.mtimeMs === mtimeMs) return cache.loaded
    const lines = readFileSync(path, 'utf8').replace(/\r/g, '').split('\n')
    const sections: PromptSection[] = []
    let inFence = false
    lines.forEach((line, i) => {
      if (/^```/.test(line)) inFence = !inFence
      if (!inFence && /^# \S/.test(line)) {
        if (sections.length) sections[sections.length - 1]!.to = i
        sections.push({ title: line.slice(2).trim(), from: i + 1, to: lines.length })
      }
    })
    const loaded = { path, lines, sections }
    cache = { mtimeMs, loaded }
    return loaded
  } catch {
    return null
  }
}

/** One section's text by its title (case-insensitive), or null. */
export function myPromptSection(title: string, path = myPromptPath()): string | null {
  const loaded = loadMyPrompt(path)
  if (!loaded) return null
  const wanted = title.trim().replace(/^#\s*/, '').toLowerCase()
  const section = loaded.sections.find((s) => s.title.toLowerCase() === wanted) ?? loaded.sections.find((s) => s.title.toLowerCase().includes(wanted))
  return section ? loaded.lines.slice(section.from - 1, section.to).join('\n').trim() : null
}

/**
 * What an agent is given: the first section in full and how to read the rest. `readHow` says how
 * this agent reads a section (a tool name, or the file path and line numbers for a command-line agent).
 */
export function myPromptBrief(readHow: 'tool' | 'file' | 'none', path = myPromptPath()): string | null {
  const loaded = loadMyPrompt(path)
  if (!loaded || loaded.sections.length === 0) return null
  const [first, ...rest] = loaded.sections
  const core = loaded.lines.slice(first!.from - 1, first!.to).join('\n').trim()
  if (readHow === 'none') {
    return ["Your operating prompt is the user's own prompt. Its first section follows; follow it in everything you do.", '', core].join('\n')
  }
  const index = rest
    .map((s) => (readHow === 'file' ? `- ${s.title} (lines ${s.from}–${s.to})` : `- ${s.title}`))
    .join('\n')
  const how =
    readHow === 'tool'
      ? 'Read one with read_prompt_section when the task touches it.'
      : `Read one from ${loaded.path} (the line numbers are given) when the task touches it; never read the whole file at once.`
  return [
    "Your operating prompt is the user's own prompt. Its first section follows in full; follow it in everything you do.",
    '',
    core,
    '',
    `Its other sections, for when they apply. ${how} Where they name tools or products this app doesn't have (the "Tools" section describes another app's tools), use this app's own tools for the same job, and keep to this app's safety rules.`,
    index
  ].join('\n')
}

export interface PromptToolSpec {
  /** The first paragraph of the tool's description in the prompt. */
  description: string
  /** Its JSON Schema as the prompt gives it, or null when the prompt's block isn't valid JSON. */
  schema: unknown | null
}

let toolsCache: { path: string; mtimeMs: number; specs: Map<string, PromptToolSpec> } | null = null

/**
 * The tools the prompt's "Tools" section describes, by name: each "## name" heading's first paragraph,
 * and the JSON block under it (fenced as json or yaml). Deskmates builds the matching tools from these,
 * so their inputs are exactly what the prompt teaches the agent to send.
 */
export function promptToolSpecs(path = myPromptPath()): Map<string, PromptToolSpec> {
  const loaded = loadMyPrompt(path)
  if (!loaded) return new Map()
  const { mtimeMs } = statSync(path)
  if (toolsCache && toolsCache.path === path && toolsCache.mtimeMs === mtimeMs) return toolsCache.specs
  const specs = new Map<string, PromptToolSpec>()
  const section = loaded.sections.find((s) => s.title === 'Tools')
  if (section) {
    const text = loaded.lines.slice(section.from, section.to).join('\n')
    // Each part starts at a "## name" heading; the text before the first heading (if any) is skipped.
    const parts = `\n${text}`.split(/\n## (?=\S)/)
    for (const part of parts.slice(1)) {
      const name = part.slice(0, part.indexOf('\n')).trim()
      const body = part.slice(part.indexOf('\n') + 1)
      const description = (body.trim().split(/\n\s*\n/)[0] ?? '').trim().slice(0, 600)
      const block = /```(?:json|yaml)\n([\s\S]*?)\n```/.exec(body)?.[1]
      let schema: unknown | null = null
      if (block) {
        try {
          const parsed = JSON.parse(block) as { name?: string; parameters?: unknown; input_schema?: unknown }
          if (parsed.name === name) schema = parsed.parameters ?? parsed.input_schema ?? null
        } catch {
          schema = null
        }
      }
      if (name) specs.set(name, { description, schema })
    }
  }
  toolsCache = { path, mtimeMs, specs }
  return specs
}

/** The tool agents read the other sections with. */
export function promptSectionTool(path = myPromptPath()) {
  return {
    read_prompt_section: tool({
      description: "Read one section of the user's operating prompt by its title (from the index in your instructions).",
      inputSchema: z.object({ title: z.string().min(1) }),
      execute: async ({ title }) => myPromptSection(title, path) ?? `There is no section called "${title}". Use a title from the index.`
    })
  }
}
