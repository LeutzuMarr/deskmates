import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from 'ai'
import { claudeDocsImplementations, markdownToHtml } from '../../src/core/tools/claude-docs'
import type { ToolContext } from '../../src/core/tools/context'
import { compactHistory, DROPPED_NOTE } from '../../src/core/engine/history'
import { contextTokens, historyBudgetChars } from '../../src/core/models/context'
import { myPromptBrief } from '../../src/core/engine/my-prompt'
import { writeFileSync, mkdirSync } from 'node:fs'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-docs-'))
  ctx = { taskId: 't', projectId: 'p', root: dir, changes: { record: () => undefined }, onChangesUpdated: () => undefined } as unknown as ToolContext
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const noTool = (name: string): Tool => {
  throw new Error(`no ${name}`)
}

describe('Claude Docs tools', () => {
  it('creates a doc with pending blocks, fills them, comments and exports', async () => {
    const docs = claudeDocsImplementations(ctx, noTool)
    const created = (await docs.mcp__Claude_Docs__batch!(
      {
        container: {
          kind: 'project',
          create: { name: 'Q3 Plan', doc: { markdown: '# Q3 Plan\n\n<?claude block asof?>\n\n<?claude block s1?>', blocks: { asof: { type: 'date', value: '2026-11-21' }, s1: { type: 'pending', intent: 'Goals' } } } }
        },
        batch: []
      },
      {}
    )) as { doc: { id: string }; tabs: Array<{ id: string; file: string }> }
    const { id } = created.doc
    const tab = created.tabs[0]!
    expect(readFileSync(join(dir, tab.file), 'utf8')).toContain('2026-11-21')
    expect(readFileSync(join(dir, tab.file), 'utf8')).toContain('<!-- pending s1')

    const filled = (await docs.mcp__Claude_Docs__update!({ container: { kind: 'project', id }, ref: { object: 'node', id: 's1' }, payload: { markdown: '## Goals\n\nShip it.' } }, {})) as { still_pending: string[] }
    expect(filled.still_pending).toEqual([])
    const text = readFileSync(join(dir, tab.file), 'utf8')
    expect(text).toContain('## Goals')
    expect(text).not.toContain('pending')

    await docs.mcp__Claude_Docs__create!({ container: { kind: 'project', id }, object: 'utterance', payload: { text: 'Looks good' } }, {})
    expect(await docs.mcp__Claude_Docs__query!({ container: { kind: 'project', id }, object: 'utterance' }, {})).toHaveLength(1)

    const exported = (await docs.mcp__Claude_Docs__export!({ container: { kind: 'project', id }, file: tab.id, format: 'html' }, {})) as { base64: string }
    expect(Buffer.from(exported.base64, 'base64').toString()).toContain('<h2>Goals</h2>')

    await expect(docs.mcp__Claude_Docs__delete!({ container: { kind: 'project', id }, ref: { object: 'file', id: tab.id } }, {})).rejects.toThrow(/last_tab/)
    expect(await docs.mcp__Claude_Docs__read!({ ref: { object: 'project', id: '*' } }, {})).toHaveLength(1)
  })

  it('refuses ids it never gave out, saying what to do instead', async () => {
    const docs = claudeDocsImplementations(ctx, noTool)
    await expect(docs.mcp__Claude_Docs__read!({ ref: { object: 'project', id: 'doc_made_up' } }, {})).rejects.toThrow(/no doc with id/)
    expect(existsSync(join(dir, 'Docs'))).toBe(false)
  })

  it('turns Markdown into simple HTML', () => {
    expect(markdownToHtml('# T\n\n- a\n- **b**\n\ntext')).toBe('<h1>T</h1>\n<ul>\n<li>a</li>\n<li><strong>b</strong></li>\n</ul>\n<p>text</p>')
  })
})

describe('context budget', () => {
  it('fits history to the model window after the prompt and tools', () => {
    expect(contextTokens('freebuff', 'Claude Haiku 5.5')).toBe(100_000)
    expect(contextTokens('google', 'gemini-3-flash')).toBe(1_000_000)
    const small = historyBudgetChars({ provider: 'ollama', modelId: 'custom-model', instructionsChars: 30_000, toolsChars: 40_000 })
    expect(small).toBe(24_000)
    expect(historyBudgetChars({ provider: 'google', modelId: 'gemini-3-flash', instructionsChars: 30_000, toolsChars: 40_000 })).toBe(400_000)
  })

  it('says when old turns were left out', () => {
    const big = 'x'.repeat(5000)
    const messages = [
      { role: 'user' as const, content: big },
      { role: 'assistant' as const, content: big },
      { role: 'user' as const, content: 'latest' }
    ]
    const out = compactHistory(messages, { maxTotalChars: 1000 })
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe(`${DROPPED_NOTE}\n\nlatest`)
    expect(compactHistory(messages)[0]!.content).toBe(big)
  })
})

describe('operating prompt brief', () => {
  it('tells only runs that have the prompt tools that they are real, and always adds the truthfulness rules', () => {
    const path = join(dir, 'my-prompt.md')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, '# claude_behavior\nBe kind.\n# Tools\n## create_file\nMake a file.\n')
    const work = myPromptBrief('tool', path, { promptTools: true })!
    const bot = myPromptBrief('tool', path)!
    expect(work).toContain('real tools in this run')
    expect(bot).not.toContain('real tools in this run')
    expect(bot).toContain('may not have here')
    for (const brief of [work, bot, myPromptBrief('none', path)!, myPromptBrief('file', path)!]) expect(brief).toContain('Staying truthful:')
  })
})
