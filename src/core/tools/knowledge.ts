/**
 * Project knowledge (Claude's "project knowledge"): files the user adds to a project in the Work
 * tab, read as text. Small sets go into every chat's instructions whole; a large set is listed by
 * name and searched with project_knowledge_search, which returns the passages that match.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

export interface KnowledgeText {
  name: string
  text: string
}

/** Up to this many characters of knowledge go into the instructions whole. */
export const INLINE_KNOWLEDGE_CHARS = 60_000

const CHUNK = 1_200

/** Splits a file into passages of about CHUNK characters, on paragraph breaks where it can. */
function passages(file: KnowledgeText): Array<{ name: string; text: string; at: number }> {
  const out: Array<{ name: string; text: string; at: number }> = []
  const paragraphs = file.text.split(/\n\s*\n/)
  let current = ''
  let at = 0
  let start = 0
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > CHUNK) {
      out.push({ name: file.name, text: current.trim(), at: start })
      start = at
      current = ''
    }
    current += `${paragraph}\n\n`
    at += paragraph.length + 2
    while (current.length > CHUNK * 2) {
      out.push({ name: file.name, text: current.slice(0, CHUNK).trim(), at: start })
      current = current.slice(CHUNK)
      start += CHUNK
    }
  }
  if (current.trim()) out.push({ name: file.name, text: current.trim(), at: start })
  return out
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []

/** The passages that best match `query`: every query word counts, rarer words more. */
export function searchKnowledge(files: KnowledgeText[], query: string, limit = 6): Array<{ name: string; text: string; score: number }> {
  const all = files.flatMap(passages)
  const terms = [...new Set(words(query))]
  if (!terms.length || !all.length) return []
  const docFreq = new Map(terms.map((t) => [t, all.filter((p) => p.text.toLowerCase().includes(t)).length]))
  const phrase = query.trim().toLowerCase()
  return all
    .map((p) => {
      const lower = p.text.toLowerCase()
      let score = 0
      for (const term of terms) {
        const df = docFreq.get(term) ?? 0
        if (!df) continue
        const hits = lower.split(term).length - 1
        if (hits) score += (1 + Math.log(hits)) * Math.log(1 + all.length / df)
      }
      if (phrase.length > 3 && lower.includes(phrase)) score *= 1.5
      if (p.name.toLowerCase().includes(phrase)) score += 1
      return { name: p.name, text: p.text, score }
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** The instructions' knowledge part: the files whole when they fit, otherwise their names. */
export function knowledgeInstructions(files: KnowledgeText[]): string {
  if (!files.length) return ''
  const total = files.reduce((n, f) => n + f.text.length, 0)
  if (total <= INLINE_KNOWLEDGE_CHARS) {
    return [
      "Project knowledge (files the user added to this project; use them whenever they bear on the request, and say which file an answer comes from):",
      ...files.map((f) => `<document name="${f.name.replace(/"/g, "'")}">\n${f.text.trim()}\n</document>`)
    ].join('\n\n')
  }
  return [
    `Project knowledge: the user added ${files.length} files to this project, too long to include whole (${Math.round(total / 1000)}K characters). Search them with project_knowledge_search before answering anything they may cover, and say which file an answer comes from:`,
    ...files.map((f) => `- ${f.name} (${Math.round(f.text.length / 1000) || 1}K characters)`)
  ].join('\n')
}

export function knowledgeTools(read: () => KnowledgeText[]): ToolSet {
  return {
    project_knowledge_search: tool({
      description:
        "Search the files the user added to this project's knowledge. Returns the passages that best match, with their file names. Use it before answering anything those files may cover; search again with other words if the first results miss.",
      inputSchema: z.object({
        query: z.string().describe('Words to look for: names, terms, a question.'),
        max_results: z.number().int().min(1).max(20).optional()
      }),
      execute: async ({ query, max_results }) => {
        const files = read()
        if (!files.length) return 'This project has no knowledge files. The user can add some from the project menu (Project knowledge).'
        const hits = searchKnowledge(files, query, max_results ?? 6)
        if (!hits.length) return `Nothing in the project's files matches "${query}". Files: ${files.map((f) => f.name).join(', ')}.`
        return hits.map((h) => `[${h.name}]\n${h.text}`).join('\n\n---\n\n')
      }
    })
  }
}
