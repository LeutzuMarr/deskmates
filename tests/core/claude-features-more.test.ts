import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import { buildTimeline } from '../../src/core/engine/timeline'
import { documentPart, textWithSavedDocuments, userMessageWithImages } from '../../src/core/engine/attachments'
import { knowledgeInstructions, knowledgeTools, searchKnowledge, INLINE_KNOWLEDGE_CHARS } from '../../src/core/tools/knowledge'
import { guideGate, guideInstructions, guideReminder, guidesForMessage, markGuideGiven, resetGuides, visualizeModulesFor } from '../../src/core/engine/guides'
import { effortProviderOptions, thinkingPlainLine, thinkingTagValue } from '../../src/core/engine/effort'
import { dictationMode, transcribeAudio } from '../../src/core/engine/dictation'
import { buildInstructions } from '../../src/core/engine/instructions'
import { DEFAULT_SETTINGS } from '../../src/shared/protocol'
import { withMath } from '../../src/renderer/src/lib/math'

function setup(): { repos: Repos; taskId: string; projectId: string } {
  const repos = createRepos(openDatabase(':memory:'))
  const project = repos.projects.create('P', tmpdir())
  const task = repos.tasks.create(project.id)
  return { repos, taskId: task.id, projectId: project.id }
}

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const reply = (text: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const texts = (repos: Repos, id: string): string[] =>
  repos.tasks.messages(id).map((m) => (typeof m.message.content === 'string' ? m.message.content : (m.message.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('')))

describe('edit branches (versions)', () => {
  it('keeps the old message and reply as a version and flips between them', () => {
    const { repos, taskId } = setup()
    repos.tasks.appendMessages(taskId, [user('Hi'), reply('Hello'), user('Write a poem'), reply('Roses…')])
    expect(repos.tasks.forkAt(taskId, 2)).toMatchObject({ text: 'Write a poem' })
    expect(texts(repos, taskId)).toEqual(['Hi', 'Hello'])
    repos.tasks.appendMessages(taskId, [user('Write a haiku'), reply('Old pond…')])
    expect(repos.tasks.forks(taskId).get(2)).toEqual({ index: 1, count: 2 })

    const timeline = buildTimeline(repos.tasks.messages(taskId), repos.tasks.forks(taskId))
    expect(timeline.find((i) => i.kind === 'user' && i.text === 'Write a haiku')).toMatchObject({ position: 2, versions: { index: 1, count: 2 } })

    repos.tasks.switchVersion(taskId, 2, 0)
    expect(texts(repos, taskId)).toEqual(['Hi', 'Hello', 'Write a poem', 'Roses…'])
    expect(repos.tasks.forks(taskId).get(2)).toEqual({ index: 0, count: 2 })
    repos.tasks.switchVersion(taskId, 2, 1)
    expect(texts(repos, taskId)).toEqual(['Hi', 'Hello', 'Write a haiku', 'Old pond…'])
  })

  it('keeps versions made further down inside their own branch', () => {
    const { repos, taskId } = setup()
    repos.tasks.appendMessages(taskId, [user('A'), reply('a')])
    repos.tasks.forkAt(taskId, 0)
    repos.tasks.appendMessages(taskId, [user('B'), reply('b'), user('C'), reply('c')])
    // Edit the second message of version 2 at the top.
    repos.tasks.forkAt(taskId, 2)
    repos.tasks.appendMessages(taskId, [user('D'), reply('d')])
    expect([...repos.tasks.forks(taskId)]).toEqual([
      [0, { index: 1, count: 2 }],
      [2, { index: 1, count: 2 }]
    ])
    // Back to the first version at the top: the nested versions go with branch 2.
    repos.tasks.switchVersion(taskId, 0, 0)
    expect(texts(repos, taskId)).toEqual(['A', 'a'])
    expect([...repos.tasks.forks(taskId).keys()]).toEqual([0])
    // And they come back with it.
    repos.tasks.switchVersion(taskId, 0, 1)
    expect(texts(repos, taskId)).toEqual(['B', 'b', 'D', 'd'])
    repos.tasks.switchVersion(taskId, 2, 0)
    expect(texts(repos, taskId)).toEqual(['B', 'b', 'C', 'c'])
  })

  it('only forks at the user’s own messages', () => {
    const { repos, taskId } = setup()
    repos.tasks.appendMessages(taskId, [user('Hi'), reply('Hello')])
    expect(repos.tasks.forkAt(taskId, 1)).toBeNull()
    expect(repos.tasks.lastUserPosition(taskId)).toBe(0)
    expect(() => repos.tasks.switchVersion(taskId, 0, 3)).toThrow(/no version 4/)
  })
})

describe('feedback on replies', () => {
  it('stores thumbs up and down and gives the reasons to the next run', () => {
    const { repos, taskId, projectId } = setup()
    repos.tasks.setFeedback(taskId, 'm1p0', 'up')
    repos.tasks.setFeedback(taskId, 'm3p0', 'down', 'Made up the price', 'The ticket costs 40 euros…')
    expect(repos.tasks.feedback(taskId)).toMatchObject({ m1p0: { rating: 'up' }, m3p0: { rating: 'down', comment: 'Made up the price' } })
    repos.tasks.setFeedback(taskId, 'm1p0', null)
    expect(Object.keys(repos.tasks.feedback(taskId))).toEqual(['m3p0'])
    const criticism = repos.tasks.recentCriticism(projectId)
    expect(criticism).toEqual([{ comment: 'Made up the price', text: 'The ticket costs 40 euros…' }])
    const project = repos.projects.require(projectId)
    const instructions = buildInstructions({ project, settings: DEFAULT_SETTINGS, memories: [], criticism, projectInstructions: null, now: new Date(), model: { provider: 'google', modelId: 'gemini-2.5-flash' } })
    expect(instructions).toContain('"Made up the price"')
  })
})

describe('project knowledge', () => {
  it('stores files, puts small ones in the instructions whole, and searches large ones', async () => {
    const { repos, projectId } = setup()
    repos.knowledge.add(projectId, 'menu.md', 'Our pizza Margherita costs 9 euros.\n\nThe Diavola is spicy and costs 11 euros.', 80)
    expect(repos.knowledge.list(projectId)).toMatchObject([{ name: 'menu.md', size: 80 }])
    const small = knowledgeInstructions(repos.knowledge.texts(projectId))
    expect(small).toContain('<document name="menu.md">')
    expect(small).toContain('Diavola')

    const big = [{ name: 'manual.txt', text: `${'Filler about nothing. '.repeat(3000)}\n\nThe reset button is behind the left panel.\n\n${'More filler. '.repeat(3000)}` }]
    expect(big[0]!.text.length).toBeGreaterThan(INLINE_KNOWLEDGE_CHARS)
    expect(knowledgeInstructions(big)).toContain('project_knowledge_search')
    expect(knowledgeInstructions(big)).not.toContain('reset button')
    expect(searchKnowledge(big, 'where is the reset button')[0]!.text).toContain('behind the left panel')
    const search = knowledgeTools(() => big).project_knowledge_search as unknown as { execute: (input: unknown) => Promise<string> }
    expect(await search.execute({ query: 'reset button' })).toContain('[manual.txt]')
    expect(await search.execute({ query: 'zebra' })).toContain('Nothing in the project')
  })
})

describe('sources under a reply', () => {
  it('lists the pages read and the search results the reply names', () => {
    const stored = [
      user('What is the tallest building?'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 's1', toolName: 'WebSearch', input: { query: 'tallest building' } },
          { type: 'tool-call', toolCallId: 'f1', toolName: 'WebFetch', input: { url: 'https://en.wikipedia.org/wiki/Burj_Khalifa' } }
        ]
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 's1', toolName: 'WebSearch', output: { type: 'json', value: [{ title: 'Burj Khalifa', url: 'https://www.burjkhalifa.ae/en/' }, { title: 'Unrelated', url: 'https://example.org/x' }] } },
          { type: 'tool-result', toolCallId: 'f1', toolName: 'WebFetch', output: { type: 'json', value: { title: 'Burj Khalifa - Wikipedia', text: '…' } } }
        ]
      },
      reply('The Burj Khalifa (828 m), per burjkhalifa.ae.')
    ] as ModelMessage[]
    const timeline = buildTimeline(stored.map((message, i) => ({ message, at: i })))
    const answer = timeline.find((i) => i.kind === 'assistant')
    expect(answer && answer.kind === 'assistant' && answer.sources).toEqual([
      { url: 'https://en.wikipedia.org/wiki/Burj_Khalifa', title: 'Burj Khalifa - Wikipedia' },
      { url: 'https://www.burjkhalifa.ae/en/', title: 'Burj Khalifa' }
    ])
  })
})

describe('documents attached to a message', () => {
  it('travels as text the model reads and shows as a file chip', () => {
    const message = userMessageWithImages('Summarise this', [], [documentPart('report.pdf', 'Sales rose 4%.')])
    const [item] = buildTimeline([{ message, at: 1 }])
    expect(item).toMatchObject({ kind: 'user', text: 'Summarise this', files: ['report.pdf'] })
    const { repos, taskId } = setup()
    repos.tasks.appendMessages(taskId, [message, reply('Sales rose.')])
    // Edit keeps the document with the message.
    expect(repos.tasks.forkAt(taskId, 0)).toMatchObject({ text: 'Summarise this', documents: [expect.stringContaining('Sales rose 4%.')] })
  })

  it('is saved in the project for a command-line agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-docs-'))
    try {
      const text = textWithSavedDocuments('Read it', [{ dataUrl: 'data:text/plain;base64,aGVsbG8=', name: 'notes.txt' }], dir)
      const path = /- (.+notes\.txt)/.exec(text)?.[1]
      expect(path && existsSync(path)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the user’s guides, loaded when a task needs them', () => {
  let dir: string
  const original = process.env.DESKMATES_PROMPTS_DIR
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dm-guides-'))
    for (const [folder, file, body] of [
      ['research', 'research_instructions.md', '<research_instructions>\nAsk one clarifying question first.\n</research_instructions>'],
      ['claude-in-chrome', 'claude-in-chrome.md', '# Safety\nNever buy anything.\n\n# Tools\nlist'],
      ['visualize', 'visualize.md', '## Modules\nlist\n\n## Core design system\nUse the palette.\n\n## Diagram types\nFlowcharts.']
    ] as const) {
      mkdirSync(join(dir, folder), { recursive: true })
      writeFileSync(join(dir, folder, file), body)
    }
    process.env.DESKMATES_PROMPTS_DIR = dir
    resetGuides()
  })
  afterEach(() => {
    if (original === undefined) delete process.env.DESKMATES_PROMPTS_DIR
    else process.env.DESKMATES_PROMPTS_DIR = original
    rmSync(dir, { recursive: true, force: true })
  })

  it('tells which guides a message needs', () => {
    expect(guidesForMessage('Research the best e-bikes under 2000 euros')).toEqual(['research'])
    expect(guidesForMessage('Open my Chrome and go to linkedin.com')).toEqual(['chrome'])
    expect(guidesForMessage('Draw me a diagram of how DNS works')).toEqual(['visualize'])
    expect(guidesForMessage('Rename the file to notes.md')).toEqual([])
    expect(visualizeModulesFor('a chart of sales')).toContain('chart')
  })

  it('puts the guide in the run’s instructions once per task', () => {
    const first = guideInstructions('t1', 'Please research solar panel prices')
    expect(first).toContain('# Guides for this task')
    expect(first).toContain('Ask one clarifying question first.')
    expect(first).toContain('rank above any skill')
    expect(guideInstructions('t1', 'research more')).toBe('')
    expect(guideReminder('Research the market')).toContain('read_research_instructions')
  })

  it('holds back research and widgets until the guide is read', () => {
    const gate = guideGate('t2', 'research')
    expect(gate).toContain('The research was not started yet')
    expect(gate).toContain('Ask one clarifying question first.')
    expect(guideGate('t2', 'research')).toBeNull()
    markGuideGiven('t3', 'visualize')
    expect(guideGate('t3', 'visualize')).toBeNull()
    expect(guideGate('t4', 'visualize', ['diagram'])).toContain('Flowcharts.')
  })
})

describe('extended thinking switch', () => {
  it('sets the prompt tag and the model’s own reasoning setting', () => {
    expect(thinkingTagValue('auto')).toBeNull()
    expect(thinkingTagValue('on')).toBe('interleaved')
    expect(thinkingTagValue('off')).toBe('disabled')
    expect(thinkingPlainLine('off')).toContain('off')
    expect(effortProviderOptions('openai', 'gpt-5.1', 'high', 'off')).toEqual({ openai: { reasoningEffort: 'minimal' } })
    expect(effortProviderOptions('google', 'gemini-2.5-flash', 'max', 'off')).toEqual({ google: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } })
    expect(effortProviderOptions('google', 'gemini-2.5-pro', 'low', 'off')).toEqual({ google: { thinkingConfig: { includeThoughts: false, thinkingBudget: 128 } } })
    expect(effortProviderOptions('openai', 'gpt-5.1', 'low', 'on')).toEqual({ openai: { reasoningEffort: 'high' } })
    expect(effortProviderOptions('openai', 'gpt-5.1', 'low', 'auto')).toEqual({ openai: { reasoningEffort: 'low' } })
  })
})

describe('dictation', () => {
  it('records with a model key, else uses Windows speech', () => {
    expect(dictationMode({ get: (p) => (p === 'google' ? 'k' : undefined) })).toBe('record')
    expect(dictationMode({ get: () => undefined }, 'win32')).toBe('system')
    expect(dictationMode({ get: () => undefined }, 'linux')).toBe('none')
  })

  it('sends the recording to OpenAI when that is the key it has', async () => {
    let seen: { url: string; auth: string } | null = null
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: String((init.headers as Record<string, string>).Authorization) }
      return new Response(JSON.stringify({ text: ' Hello there. ' }), { status: 200 })
    }) as unknown as typeof fetch
    const text = await transcribeAudio({ get: (p) => (p === 'openai' ? 'sk-test' : undefined) }, Buffer.from('audio').toString('base64'), 'audio/webm;codecs=opus', fakeFetch)
    expect(text).toBe('Hello there.')
    expect(seen).toEqual({ url: 'https://api.openai.com/v1/audio/transcriptions', auth: 'Bearer sk-test' })
  })
})

describe('math in replies', () => {
  it('turns \\( \\) and \\[ \\] into math and leaves prices and code alone', () => {
    expect(withMath('Area is \\(\\pi r^2\\).')).toBe('Area is $$\\pi r^2$$.')
    expect(withMath('\\[E = mc^2\\]')).toContain('$$\nE = mc^2\n$$')
    expect(withMath('It costs $5 and $10.')).toBe('It costs $5 and $10.')
    expect(withMath('`\\(x\\)` and \\(y\\)')).toBe('`\\(x\\)` and $$y$$')
  })
})
