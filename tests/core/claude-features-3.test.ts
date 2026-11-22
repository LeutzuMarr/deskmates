import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage, ToolSet } from 'ai'
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'
import { chatHistory, withoutSwitchedOffTools } from '../../src/core/engine/runner'
import { buildInstructions } from '../../src/core/engine/instructions'
import { guideInstructions, guideReminder, resetGuides } from '../../src/core/engine/guides'
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/protocol'
import { quoted } from '../../src/renderer/src/lib/quote'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const reply = (text: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })

function setup() {
  const repos = createRepos(openDatabase(':memory:'))
  const project = repos.projects.create('Home', tmpdir())
  return { repos, project }
}

describe('search inside chats', () => {
  it('finds chats by what was said in them, with the matching line', () => {
    const { repos, project } = setup()
    const a = repos.tasks.create(project.id)
    repos.tasks.update(a.id, { title: 'Holiday plans' })
    repos.tasks.appendMessages(a.id, [user('Where should we go in May?'), reply('Lisbon is lovely in May, with long sunny days and fewer crowds.')])
    const b = repos.tasks.create(project.id)
    repos.tasks.appendMessages(b.id, [user('Fix the login bug')])
    const hits = repos.tasks.search('sunny')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ taskId: a.id, title: 'Holiday plans' })
    expect(hits[0]!.snippet).toContain('long sunny days')
    expect(repos.tasks.search('LOGIN')).toMatchObject([{ taskId: b.id }])
    expect(repos.tasks.search('a')).toEqual([])
  })
})

describe('incognito chats', () => {
  it('stay out of search and chat history, and are deleted at start', () => {
    const { repos, project } = setup()
    const secret = repos.tasks.create(project.id, 'New task', true)
    expect(secret.incognito).toBe(true)
    repos.tasks.appendMessages(secret.id, [user('my secret pancake recipe')])
    expect(repos.tasks.search('pancake')).toEqual([])
    expect(chatHistory(repos).list().map((c) => c.id)).not.toContain(secret.id)
    const kept = repos.tasks.create(project.id)
    expect(repos.tasks.deleteIncognito()).toEqual([secret.id])
    expect(repos.tasks.get(secret.id)).toBeUndefined()
    expect(repos.tasks.get(kept.id)).toBeDefined()
  })

  it('get no memories or memory tools', () => {
    const { repos, project } = setup()
    const instructions = buildInstructions({ project, settings: DEFAULT_SETTINGS, memories: [{ id: 'm1', projectId: project.id, content: 'Likes tea', createdAt: 1 }], incognito: true, projectInstructions: null, now: new Date(), model: { provider: 'google', modelId: 'gemini-2.5-flash' } })
    expect(instructions).toContain('Incognito chat')
    expect(instructions).not.toContain('Likes tea')
    const tools = { memory_write: {}, conversation_search: {}, Read: {}, WebSearch: {} } as unknown as ToolSet
    expect(Object.keys(withoutSwitchedOffTools(tools, { webSearch: true, incognito: true }))).toEqual(['Read', 'WebSearch'])
  })
})

describe('web search and research switches', () => {
  it('takes the web tools away and says so when web search is off', () => {
    const tools = { WebSearch: {}, WebFetch: {}, web_search: {}, mcp__claude_ai__launch_extended_search_task: {}, Read: {} } as unknown as ToolSet
    expect(Object.keys(withoutSwitchedOffTools(tools, { webSearch: false, incognito: false }))).toEqual(['Read'])
    expect(withoutSwitchedOffTools(tools, { webSearch: true, incognito: false })).toBe(tools)
    const { project } = setup()
    const settings: Settings = { ...DEFAULT_SETTINGS, webSearch: false }
    const text = buildInstructions({ project, settings, memories: [], research: true, projectInstructions: null, now: new Date(), model: { provider: 'google', modelId: 'gemini-2.5-flash' } })
    expect(text).toContain('Web search is off')
    expect(text).toContain('Research is on for this message')
  })

  it('uses the user’s own style when they wrote one', () => {
    const { project } = setup()
    const settings: Settings = { ...DEFAULT_SETTINGS, responseStyle: 'custom', customStyle: 'Like a pirate, briefly.' }
    const text = buildInstructions({ project, settings, memories: [], projectInstructions: null, now: new Date(), model: { provider: 'google', modelId: 'gemini-2.5-flash' } })
    expect(text).toContain("Custom, in the user's own words: Like a pirate, briefly.")
  })
})

describe('Research forces the research guide', () => {
  let dir: string
  const original = process.env.DESKMATES_PROMPTS_DIR
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dm-research-'))
    mkdirSync(join(dir, 'research'), { recursive: true })
    writeFileSync(join(dir, 'research', 'research_instructions.md'), '<research_instructions>\nPlan first.\n</research_instructions>')
    process.env.DESKMATES_PROMPTS_DIR = dir
    resetGuides()
  })
  afterEach(() => {
    if (original === undefined) delete process.env.DESKMATES_PROMPTS_DIR
    else process.env.DESKMATES_PROMPTS_DIR = original
    rmSync(dir, { recursive: true, force: true })
  })

  it('even when the message doesn’t say "research"', () => {
    expect(guideInstructions('r1', 'Best e-bike under 2000 euros?')).toBe('')
    expect(guideInstructions('r2', 'Best e-bike under 2000 euros?', undefined, ['research'])).toContain('Plan first.')
    expect(guideReminder('Best e-bike?', undefined, ['research'])).toContain('read_research_instructions')
  })
})

describe('quoting part of a reply', () => {
  it('turns the selection into a Markdown quote above the reply', () => {
    expect(quoted('  Line one\nLine two  ')).toBe('> Line one\n> Line two\n\n')
  })
})
