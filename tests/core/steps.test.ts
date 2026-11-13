import { describe, expect, it } from 'vitest'
import { currentActivity, shortUrl, stepLabel, stepWords } from '../../src/renderer/src/lib/steps'
import { ActivitySteps } from '../../src/core/terminals/freebuff-pool'
import type { TimelineItem, ToolItem } from '../../src/shared/protocol'

const tool = (toolName: string, input: unknown, state: ToolItem['state'] = 'running'): ToolItem => ({ kind: 'tool', id: toolName, at: 0, toolName, input, state })

describe('step words', () => {
  it('says what a step does live, and what it did once done', () => {
    expect(stepWords('web_fetch', { url: 'https://www.example.com/pricing/' })).toEqual({ live: 'Analyzing example.com/pricing', done: 'Analyzed example.com/pricing' })
    expect(stepLabel(tool('read_file', { path: 'src/app.ts' }))).toBe('Reading src/app.ts')
    expect(stepLabel(tool('read_file', { path: 'src/app.ts' }, 'done'))).toBe('Read src/app.ts')
    expect(stepLabel(tool('web_search', { query: 'hotels in Rome' }))).toBe('Searching the web for "hotels in Rome"')
    expect(stepLabel(tool('bash', { command: 'npm test' }, 'done'))).toBe('Ran npm test')
  })

  it("covers the CLIs' own tool names and Freebuff's lines of work", () => {
    expect(stepLabel(tool('read', { filePath: 'README.md' }))).toBe('Reading README.md')
    expect(stepLabel(tool('webfetch', { url: 'https://docs.example.org' }))).toBe('Analyzing docs.example.org')
    expect(stepLabel(tool('freebuff', { activity: '• Read AGENTS.md' }))).toBe('Read AGENTS.md')
  })

  it('falls back to a readable name for tools it does not know', () => {
    expect(stepLabel(tool('some_new_tool', {}))).toBe('Some new tool')
    expect(shortUrl('not a url')).toBe('not a url')
  })
})

describe('current activity', () => {
  const user: TimelineItem = { kind: 'user', id: 'u', at: 0, text: 'go' }
  it('names the running step, thinking, or the reply being written', () => {
    expect(currentActivity([user, tool('browser_open', { url: 'https://mail.zoho.eu' })])).toBe('Opening mail.zoho.eu…')
    expect(currentActivity([user, { kind: 'thinking', id: 't', at: 0, text: '…' }])).toBe('Thinking…')
    expect(currentActivity([user, { kind: 'assistant', id: 'a', at: 0, text: 'Hi' }])).toBe('Writing the reply…')
    expect(currentActivity([user])).toBeNull()
  })
})

describe("Freebuff's steps", () => {
  it('opens a new step for each new line of work and updates one that only grows', () => {
    const items: ToolItem[] = []
    const steps = new ActivitySteps('first', (item) => items.push(item as ToolItem))
    steps.report('• Read AGENTS.md')
    steps.report('• Read AGENTS.md')
    steps.report('Ho letto')
    steps.report('Ho letto i compiti')
    steps.finish()
    const byId = new Map<string, ToolItem>()
    for (const item of items) byId.set(item.id, item)
    const final = [...byId.values()]
    expect(final.map((i) => [(i.input as { activity: string }).activity, i.state])).toEqual([
      ['• Read AGENTS.md', 'done'],
      ['Ho letto i compiti', 'done']
    ])
    expect(final[0]!.id).toBe('first')
  })
})
