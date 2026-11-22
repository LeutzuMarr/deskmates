import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseLooseJson } from '../../src/core/engine/loose-json'
import { loadMyPrompt, myPromptBrief, myPromptPath, myPromptSection, promptToolSpecs } from '../../src/core/engine/my-prompt'
import { builtinSkill, chromeInstructions, chromeInstructionsDue, guideTools, markChromeInstructionsGiven, researchInstructions, resetChromeInstructions, visualizeGuide } from '../../src/core/engine/guides'
import { effortProviderOptions, effortTable } from '../../src/core/engine/effort'
import { decodePng, encodeGif, lzwEncode } from '../../src/core/chrome/gif'
import { cronToWhen, parseWhen, reportSources } from '../../src/core/tools/fable-tools'
import { promptTools } from '../../src/core/tools/prompt-tools'
import { promptToolInfos } from '../../src/core/tools/shared-prompt-tools'
import { runPlan } from '../../src/core/tools/agent-tools'
import { visualPage } from '../../src/core/tools/widgets'
import { WIDGET_TOOL_NAMES } from '../../src/shared/widgets'
import type { ToolContext } from '../../src/core/tools/context'

const REAL_PROMPTS = join(process.cwd(), 'prompts')
const REAL_FABLE = join(REAL_PROMPTS, 'fable', 'claude-fable-5.2.md')
const hasReal = existsSync(REAL_FABLE)

/** A small prompt shaped like Fable 5.2: an effort preamble, a first section, parts, two Tools sections. */
const FABLE = [
  '| Effort setting | `<reasoning_effort>` value |',
  '|---|---|',
  '| low | 8 |',
  '| medium | 10 |',
  '| high | 30 |',
  '| extra | 80 |',
  '| max | `max` |',
  '',
  '`<x:reasoning_effort>10</x:reasoning_effort>`',
  '',
  '# Claude behavior',
  'Be kind.',
  '## Tone and formatting',
  'Short.',
  '# Agentic behavior',
  '## Situation',
  'A workspace.',
  '## How a task runs',
  'Start, then finish.',
  '# Tools',
  '## WebSearch',
  '',
  'Search the web.',
  '',
  '```yaml',
  '{',
  '  "name": "WebSearch",',
  '  "parameters": {',
  '    "properties": {',
  '      "mode": {',
  '        "description": ""standard": the normal search. Use "extended" for',
  'hard questions.",',
  '        "enum": ["standard", "extended"],',
  '        "type": "string"',
  '      }',
  '    },',
  '    "type": "object"',
  '  }',
  '}',
  '```',
  '## mcp__memory__memory_read',
  '',
  'Read memory.',
  '',
  '```json',
  '{"name": "mcp__memory__memory_read", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}',
  '```',
  '## mcp__widgets__chart_display_v0',
  '',
  'Show a chart.',
  '',
  'An example first:',
  '```json',
  '{"style": "bar"}',
  '```',
  '```json',
  '{"name": "mcp__widgets__chart_display_v0", "parameters": {"type": "object", "properties": {"style": {"type": "string"}}}}',
  '```',
  '## mcp__claude_ai__current_time',
  '',
  'The time.',
  '',
  '```json',
  '{"name": "mcp__claude_ai__current_time", "parameters": {"type": "object", "properties": {}}}',
  '```',
  '## TaskCreate',
  '',
  'Make a task.',
  '',
  '```json',
  '{"name": "TaskCreate", "parameters": {"type": "object", "properties": {"subject": {"type": "string"}, "description": {"type": "string"}}}}',
  '```',
  '## TaskUpdate',
  '',
  'Change a task.',
  '',
  '```json',
  '{"name": "TaskUpdate", "parameters": {"type": "object", "properties": {"taskId": {"type": "string"}, "status": {"type": "string"}}}}',
  '```',
  '## mcp__claude_ai__end_conversation',
  '',
  'End it.',
  '',
  '```json',
  '{"name": "mcp__claude_ai__end_conversation", "parameters": {"properties": {}, "type": "object"}}',
  '```',
  '## mcp__claude_ai__us_election_info',
  '',
  'Election results.',
  '',
  '```json',
  '{"name": "mcp__claude_ai__us_election_info", "parameters": {"type": "object", "properties": {}}}',
  '```',
  '## mcp__claude-code-remote__send_later',
  '',
  'Come back later.',
  '',
  '```json',
  '{"name": "mcp__claude-code-remote__send_later", "parameters": {"type": "object", "properties": {"message": {"type": "string"}, "delay_minutes": {"type": "integer"}}}}',
  '```',
  '## mcp__claude-code-remote__create_trigger',
  '',
  'A scheduled task.',
  '',
  '```json',
  '{"name": "mcp__claude-code-remote__create_trigger", "parameters": {"type": "object", "properties": {"name": {"type": "string"}}}}',
  '```',
  '## mcp__claude_ai__launch_extended_search_task',
  '',
  'Research.',
  '',
  '```json',
  '{"name": "mcp__claude_ai__launch_extended_search_task", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}',
  '```',
  '## mcp__claude_ai__read_research_report',
  '',
  'A report.',
  '',
  '```json',
  '{"name": "mcp__claude_ai__read_research_report", "parameters": {"type": "object", "properties": {"task_id": {"type": "string"}}}}',
  '```',
  '## propose_skills',
  '',
  'Skill cards.',
  '',
  '```json',
  '{"name": "propose_skills", "parameters": {"type": "object", "properties": {"proposals": {"type": "array"}}}}',
  '```',
  '## SearchMcpRegistry',
  '',
  'Search the registry.',
  '',
  '```json',
  '{"name": "SearchMcpRegistry", "parameters": {"type": "object", "properties": {"keywords": {"type": "array", "items": {"type": "string"}}}}}',
  '```',
  '## enable__mcp__remote-devices__computer',
  '',
  'Computer use.',
  '',
  '```json',
  '{"name": "enable__mcp__remote-devices__computer", "parameters": {"type": "object", "properties": {}}}',
  '```',
  '# Search instructions',
  '## Core search behaviors',
  'Search when things change.',
  '# Tools',
  '## mcp__visualize__read_me',
  '',
  'Design guide.',
  '',
  '```json',
  '{"name": "mcp__visualize__read_me", "parameters": {"type": "object", "properties": {"modules": {"type": "array", "items": {"type": "string"}}}}}',
  '```',
  '# Available skills',
  'docx, pdf.'
].join('\n')

const CHROME = [
  'You are a web automation assistant.',
  '',
  '# Critical injection defense',
  'Stop and ask.',
  '# Behavior instructions',
  'This iteration of Claude is Claude Sonnet 5.5.',
  '# Action types',
  '## Prohibited actions',
  'No banking.',
  '# Tools',
  '## read_page',
  'Get the tree.'
].join('\n')

const VISUALIZE = [
  '# Imagine — Visual Creation Suite',
  '',
  '## Modules',
  'Call read_me again with modules.',
  '## Core Design System',
  'Flat, compact.',
  '## When nothing fits',
  'Pick the closest.',
  '## Color palette',
  'Nine ramps.',
  '## SVG setup',
  'viewBox 680.',
  '## Diagram types',
  'Flowcharts.',
  '## UI components',
  'Cards.',
  '## Charts (Chart.js)',
  'Canvas.',
  '## Art and illustration',
  'Fill the canvas.'
].join('\n')

const RESEARCH = '`<research_instructions>`\nUse launch_extended_search_task.\n`</research_instructions>`\n\n`<function>`\n{"name": "launch_extended_search_task"}\n'

let dir: string
let prompts: string
const originalEnv = process.env.DESKMATES_PROMPTS_DIR

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deskmates-fable-'))
  prompts = join(dir, 'prompts')
  for (const [folder, file, text] of [
    ['fable', 'claude-fable-5.2.md', FABLE],
    ['claude-in-chrome', 'claude-in-chrome.md', CHROME],
    ['visualize', 'visualize.md', VISUALIZE],
    ['research', 'research_instructions.md', RESEARCH]
  ] as const) {
    mkdirSync(join(prompts, folder), { recursive: true })
    writeFileSync(join(prompts, folder, file), text, 'utf8')
  }
  process.env.DESKMATES_PROMPTS_DIR = prompts
  resetChromeInstructions()
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env.DESKMATES_PROMPTS_DIR
  else process.env.DESKMATES_PROMPTS_DIR = originalEnv
  rmSync(dir, { recursive: true, force: true })
})

function context(extra: Partial<ToolContext> = {}): ToolContext & { plans: unknown[] } {
  const plans: unknown[] = []
  return {
    taskId: `t-${Math.random()}`,
    projectId: 'p',
    root: dir,
    dataDir: dir,
    modelRef: { provider: 'openai', modelId: 'gpt-5' },
    onPlan: (items: unknown) => plans.push(items),
    onNotify: () => undefined,
    onChangesUpdated: () => undefined,
    onMemoryUpdated: () => undefined,
    plans,
    ...extra
  } as unknown as ToolContext & { plans: unknown[] }
}

const call = (tools: Record<string, unknown>, name: string, input: unknown = {}) => (tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {})

describe('reading near-JSON schema blocks', () => {
  it('repairs unescaped quotes, line breaks, single quotes, backslashes and trailing commas', () => {
    expect(parseLooseJson('{"a": "Use "select:x" for it", "b": 1}')).toEqual({ a: 'Use "select:x" for it', b: 1 })
    expect(parseLooseJson('{"a": "two\nlines"}')).toEqual({ a: 'two\nlines' })
    expect(parseLooseJson(`{"pattern": '^\\d+\\.\\d$', "type": "string"}`)).toEqual({ pattern: '^\\d+\\.\\d$', type: 'string' })
    expect(parseLooseJson('{"a": [1, 2,], "b": "x",}')).toEqual({ a: [1, 2], b: 'x' })
    // A quoted list inside a description is text, not the end of the string.
    expect(parseLooseJson('{"d": "e.g. ["/Users/alex"]. More", "t": "s"}')).toEqual({ d: 'e.g. ["/Users/alex"]. More', t: 's' })
    expect(parseLooseJson('{"d": "Examples: "Auth", "Library".", "t": "s"}')).toEqual({ d: 'Examples: "Auth", "Library".', t: 's' })
    expect(parseLooseJson('not json at all')).toBeNull()
  })
})

describe('the Fable 5.2 operating prompt', () => {
  it('is the prompt every agent reads, ahead of the older my-prompt.md', () => {
    mkdirSync(join(prompts, 'my-prompt'), { recursive: true })
    writeFileSync(join(prompts, 'my-prompt', 'my-prompt.md'), '# old\nOld prompt.', 'utf8')
    expect(myPromptPath(prompts)).toBe(join(prompts, 'fable', 'claude-fable-5.2.md'))
    rmSync(join(prompts, 'fable'), { recursive: true })
    expect(myPromptPath(prompts)).toBe(join(prompts, 'my-prompt', 'my-prompt.md'))
  })

  it('numbers repeated sections, keeps parts, and leaves the Tools sections out of the index', () => {
    const path = myPromptPath(prompts)
    const loaded = loadMyPrompt(path)!
    expect(loaded.sections.map((s) => s.title)).toEqual(['Claude behavior', 'Agentic behavior', 'Tools', 'Search instructions', 'Tools (2)', 'Available skills'])
    const brief = myPromptBrief('tool', path, { promptTools: true, effort: 'high' })!
    expect(brief).toContain('Be kind.')
    expect(brief).toContain('- Agentic behavior — Situation; How a task runs')
    expect(brief).not.toMatch(/^- Tools/m)
    expect(brief).not.toContain('Search the web.')
    expect(brief).toContain('read_chrome_instructions')
    // The effort the user picked replaces the file's own value.
    expect(brief).toContain('`<x:reasoning_effort>30</x:reasoning_effort>`')
    expect(brief).not.toContain('reasoning_effort>10<')
    expect(brief).toContain('Effort level: High')
    expect(myPromptBrief('tool', path, { effort: 'max' })).toContain('<x:reasoning_effort>max</x:reasoning_effort>')
    expect(myPromptBrief('file', path)).toMatch(/Its "Tools" sections \(lines \d+–\d+, \d+–\d+\)/)
  })

  it('reads a section, one part of it, or one tool’s entry', () => {
    const path = myPromptPath(prompts)
    expect(myPromptSection('Agentic behavior', path)).toContain('Start, then finish.')
    expect(myPromptSection('How a task runs', path)).toBe('## How a task runs\nStart, then finish.')
    expect(myPromptSection('TaskCreate', path)).toContain('Make a task.')
    expect(myPromptSection('nothing like it', path)).toBeNull()
  })

  it('builds tool specs from both Tools sections, picking the block named for the tool', () => {
    const specs = promptToolSpecs(myPromptPath(prompts))
    expect(specs.has('mcp__visualize__read_me')).toBe(true)
    expect((specs.get('WebSearch')?.schema as { properties: { mode: { description: string } } }).properties.mode.description).toBe('"standard": the normal search. Use "extended" for\nhard questions.')
    expect(specs.get('mcp__widgets__chart_display_v0')?.schema).toEqual({ type: 'object', properties: { style: { type: 'string' } } })
  })

  it.skipIf(!hasReal)('parses every tool schema in the real Fable 5.2 file', () => {
    const specs = promptToolSpecs(REAL_FABLE)
    expect(specs.size).toBeGreaterThanOrEqual(60)
    const unread = [...specs].filter(([, spec]) => !spec.schema).map(([name]) => name)
    expect(unread).toEqual([])
    expect(myPromptSection('Action categories', REAL_FABLE)).toContain('Prohibited')
    expect(myPromptSection('Tools', REAL_FABLE)).toMatch(/This section is long/)
  })
})

describe('the prompt’s tools under its own names', () => {
  it('maps mcp__memory__, mcp__widgets__ and mcp__claude_ai__ names onto Deskmates’ tools', async () => {
    const ctx = context()
    const tools = promptTools(ctx, {})
    const chart = (await call(tools, 'mcp__widgets__chart_display_v0', { style: 'bar', series: [{ values: [1, 2] }] })) as { widget: string }
    expect(chart.widget).toMatch(/^deskmates-preview:\/\/widget\//)
    expect(WIDGET_TOOL_NAMES).toContain('mcp__widgets__chart_display_v0')
    await expect(call(tools, 'mcp__memory__memory_read', { path: '/x.md' })).resolves.toContain('no such document')
    const now = (await call(tools, 'mcp__claude_ai__current_time')) as { now: string }
    expect(now.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(Object.keys(tools)).toContain('SearchMcpRegistry')
  })

  it('keeps a task list with TaskCreate and TaskUpdate', async () => {
    const ctx = context()
    const tools = promptTools(ctx, {})
    await call(tools, 'TaskCreate', { subject: 'Read the report', description: 'all of it' })
    await call(tools, 'TaskCreate', { subject: 'Write the summary', description: 'short' })
    await call(tools, 'TaskUpdate', { taskId: '1', status: 'completed' })
    await call(tools, 'TaskUpdate', { taskId: '2', status: 'in_progress' })
    expect(ctx.plans.at(-1)).toEqual([
      { text: 'Read the report', status: 'done' },
      { text: 'Write the summary', status: 'in_progress' }
    ])
    await expect(call(tools, 'TaskUpdate', { taskId: '9', status: 'completed' })).rejects.toThrow(/no task #9/)
  })

  it('asks for confirmation before ending a conversation', async () => {
    const tools = promptTools(context(), {})
    expect(await call(tools, 'mcp__claude_ai__end_conversation')).toMatchObject({ ended: false })
    expect(await call(tools, 'mcp__claude_ai__end_conversation')).toMatchObject({ ended: true })
  })

  it('says why election results and computer use aren’t here, instead of being missing', async () => {
    const tools = promptTools(context(), {})
    expect(JSON.stringify(await call(tools, 'mcp__claude_ai__us_election_info', {}))).toContain('cannot look up election results right now')
    expect(await call(tools, 'enable__mcp__remote-devices__computer')).toMatchObject({ enabled: false })
  })

  it('schedules a message back into the conversation, and scheduled tasks from cron times', async () => {
    const wakeups: Array<{ ms: number; prompt: string }> = []
    const created: unknown[] = []
    const schedules = { create: (input: unknown) => (created.push(input), { id: 's1', name: 'Morning', nextRunAt: Date.now() + 1000 }) }
    const tools = promptTools(context({ scheduleWakeup: (ms, prompt) => wakeups.push({ ms, prompt }), schedules: schedules as never }), {})
    await call(tools, 'mcp__claude-code-remote__send_later', { message: 'Check the build', delay_minutes: 5 })
    expect(wakeups).toEqual([{ ms: 300_000, prompt: 'Check the build' }])
    await expect(call(tools, 'mcp__claude-code-remote__send_later', { message: 'x', delay_minutes: 600 })).rejects.toThrow(/at most 60 minutes/)
    await call(tools, 'mcp__claude-code-remote__create_trigger', { name: 'Morning', prompt: 'Read my inbox', initiation: 'human_request', cron_expression: '30 7 * * 1-5' })
    expect(created).toEqual([{ projectId: 'p', name: 'Morning', instruction: 'Read my inbox', when: { frequency: 'weekdays', time: '07:30' } }])
    await expect(call(tools, 'mcp__claude-code-remote__create_trigger', { name: 'x', prompt: 'y', cron_expression: '0 * * * *' })).rejects.toThrow(/at most once a day/)
  })

  it('reads cron expressions and zoned times', () => {
    expect(cronToWhen('0 9 * * *')).toEqual({ frequency: 'daily', time: '09:00' })
    expect(cronToWhen('15 18 * * 1,3')).toEqual({ frequency: 'weekly', time: '18:15', days: [1, 3] })
    expect(cronToWhen('0 8 1 * *')).toEqual({ frequency: 'monthly', time: '08:00', dayOfMonth: 1 })
    expect(typeof cronToWhen('*/5 * * * *')).toBe('string')
    expect(parseWhen('2026-04-20T09:00:00[UTC]')?.toISOString()).toBe('2026-04-20T09:00:00.000Z')
    expect(parseWhen('2026-07-01T12:00:00[Europe/Rome]')?.toISOString()).toBe('2026-07-01T10:00:00.000Z')
    expect(parseWhen('2026-04-20T17:00:00Z')?.toISOString()).toBe('2026-04-20T17:00:00.000Z')
  })

  it('runs research as a sub-agent, keeps the report and reads it back', async () => {
    const asked: Array<{ instructions?: string; maxSteps?: number; tools: Record<string, unknown> }> = []
    const subagents = {
      run: async (request: { instructions?: string; maxSteps?: number; tools: Record<string, unknown>; tasks: Array<{ id: string }> }) => {
        asked.push(request)
        return [{ id: request.tasks[0]!.id, text: '# Tea prices\n\nThey rose. [Market report](https://example.com/report)' }]
      }
    }
    const tools = promptTools(context({ subagents: subagents as never }), {})
    const result = (await call(tools, 'mcp__claude_ai__launch_extended_search_task', { command: 'How did tea prices move?' })) as { task_id: string; research_report: { title: string; sources: unknown[] } }
    expect(result.research_report.title).toBe('Tea prices')
    expect(result.research_report.sources).toEqual([{ title: 'Market report', url: 'https://example.com/report' }])
    expect(asked[0]!.maxSteps).toBe(40)
    expect(Object.keys(asked[0]!.tools)).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']))
    expect(asked[0]!.instructions).toContain('Search when things change.')
    const again = (await call(tools, 'mcp__claude_ai__read_research_report', { task_id: result.task_id })) as { research_report: { text: string } }
    expect(again.research_report.text).toContain('They rose.')
    await expect(promptTools(context(), {}).mcp__claude_ai__launch_extended_search_task!.execute!({ command: 'x' } as never, {} as never)).rejects.toThrow(/research agent can't run here/)
    expect(reportSources('[a](https://a.example) [a again](https://a.example)')).toHaveLength(1)
  })

  it('shows skill proposals and saves their drafts', async () => {
    const tools = promptTools(context(), {})
    const result = (await call(tools, 'propose_skills', { proposals: [{ name: 'Weekly Report', kind: 'new', description: 'Use for the weekly report.', skillMd: '---\nname: weekly-report\n---\nSteps.' }] })) as { widget: string; proposals: Array<{ folder: string }> }
    expect(result.widget).toMatch(/^deskmates-preview:\/\/widget\//)
    expect(readFileSync(join(result.proposals[0]!.folder, 'SKILL.md'), 'utf8')).toContain('Steps.')
    await expect(call(tools, 'propose_skills', { proposals: [{ name: 'claude-helper', skillMd: 'x' }] })).rejects.toThrow(/can't contain/)
  })

  it('loads the Visualizer’s guide module by module', async () => {
    const tools = promptTools(context(), {})
    const core = String(await call(tools, 'mcp__visualize__read_me', {}))
    expect(core).toContain('Flat, compact.')
    expect(core).not.toContain('Flowcharts.')
    const diagram = String(await call(tools, 'mcp__visualize__read_me', { modules: ['diagram'] }))
    expect(diagram).toContain('Flowcharts.')
    expect(diagram).toContain('viewBox 680.')
    expect(diagram).not.toContain('Canvas.')
    expect(visualizeGuide(['chart'])).toContain('Canvas.')
    expect(visualizeGuide(['nope'])).toContain('No module called nope')
  })

  it('draws Visualizer widgets on the guide’s design system, with sendPrompt', () => {
    const page = visualPage('flow', '<svg viewBox="0 0 680 100"><g class="c-blue"><rect/></g></svg>')
    expect(page).toContain('--color-text-primary')
    expect(page).toContain('.c-blue>rect')
    expect(page).toContain('window.sendPrompt')
    expect(page).toContain('class="vz-card"')
  })
})

describe('guides loaded on demand', () => {
  it('gives the Chrome instructions without the behaviour and tool parts, with Deskmates’ note', () => {
    const text = chromeInstructions()!
    expect(text).toContain('Deskmates note')
    expect(text).toContain('Stop and ask.')
    expect(text).toContain('No banking.')
    expect(text).not.toContain('Claude Sonnet 5.5')
    expect(text).not.toContain('Get the tree.')
    expect(chromeInstructions('read_page')).toBe('## read_page\nGet the tree.')
  })

  it('hands the Chrome instructions over once per run', async () => {
    expect(chromeInstructionsDue('run-1')).toBe(true)
    const tools = guideTools('run-1')
    expect(String(await call(tools, 'read_chrome_instructions'))).toContain('Stop and ask.')
    expect(chromeInstructionsDue('run-1')).toBe(false)
    markChromeInstructionsGiven('run-2')
    expect(chromeInstructionsDue('run-2')).toBe(false)
  })

  it('gives the research instructions only up to the end of their block', async () => {
    const text = researchInstructions()!
    expect(text).toContain('Advanced Research is now on')
    expect(text).toContain('Use launch_extended_search_task.')
    expect(text).not.toContain('<function>')
    expect(String(await call(guideTools('r'), 'read_research_instructions'))).toContain('Use launch_extended_search_task.')
  })

  it('answers the built-in skills the prompt lists', () => {
    expect(builtinSkill('chrome-browser')?.instructions).toContain('Stop and ask.')
    expect(builtinSkill('anthropic-skills:docx')?.instructions).toContain('create_word_document')
    expect(builtinSkill('no-such-skill')).toBeNull()
  })

  it('lists the guide tools and the section reader for command-line agents, once each', () => {
    const names = promptToolInfos().map((info) => info.name)
    expect(names).toEqual(expect.arrayContaining(['read_chrome_instructions', 'read_research_instructions', 'read_prompt_section', 'browser_batch', 'gif_creator', 'TaskCreate']))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('the effort level', () => {
  it('comes from the prompt’s own table', () => {
    expect(effortTable(myPromptPath(prompts))).toEqual({ low: '8', medium: '10', high: '30', extra: '80', max: 'max' })
  })

  it('sets the reasoning of models that have a setting for it', () => {
    expect(effortProviderOptions('openai', 'gpt-5-mini', 'low')).toEqual({ openai: { reasoningEffort: 'low' } })
    expect(effortProviderOptions('openai', 'gpt-4o', 'high')).toBeUndefined()
    expect(effortProviderOptions('google', 'gemini-2.5-flash', 'max')).toEqual({ google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24_576 } } })
    expect(effortProviderOptions('google', 'gemini-3-pro-preview', 'extra')).toEqual({ google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } })
    expect(effortProviderOptions('freebuff', 'x', 'max')).toBeUndefined()
  })
})

describe('approvals for the prompt’s prefixed tools', () => {
  it('treats them as built-in tools, not connectors', async () => {
    const { approvalFor } = await import('../../src/core/engine/approvals')
    expect(approvalFor('mcp__widgets__chart_display_v0', [])).toBeUndefined()
    expect(approvalFor('mcp__claude_ai__current_time', [])).toBeUndefined()
    expect(approvalFor('mcp__visualize__show_widget', [])).toBeUndefined()
    expect(approvalFor('mcp__memory__memory_delete', [])).toBe('user-approval')
    expect(approvalFor('mcp__Claude_Docs__delete', [])).toBe('user-approval')
    expect(approvalFor('mcp__files__read', [])).toBe('user-approval')
  })
})

describe('update_plan in Claude in Chrome’s form', () => {
  it('turns domains and approach into the task list', () => {
    const plans: unknown[] = []
    const result = runPlan({ onPlan: (items) => plans.push(items) }, undefined, ['mail.example'], ['Open the inbox', 'Read the newest email'])
    expect(plans[0]).toEqual([
      { text: 'Open the inbox', status: 'in_progress' },
      { text: 'Read the newest email', status: 'pending' }
    ])
    expect(result).toMatchObject({ ok: true, domains: ['mail.example'] })
    expect(() => runPlan({ onPlan: () => undefined }, undefined)).toThrow(/Send items/)
  })
})

/** A PNG of one colour, the way Chrome sends screenshots (8-bit RGBA, filter 0 rows). */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows: number[] = []
  for (let y = 0; y < height; y++) {
    rows.push(y % 2 ? 2 : 0) // alternate "none" and "up" filters
    for (let x = 0; x < width; x++) rows.push(...(y % 2 ? [0, 0, 0, 0] : rgba))
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))])
}

/** Decodes GIF LZW sub-blocks back to palette indices. */
function lzwDecode(blocks: Uint8Array, minCodeSize = 8): number[] {
  const bytes: number[] = []
  for (let i = 0; i < blocks.length && blocks[i]! > 0; i += blocks[i]! + 1) bytes.push(...blocks.subarray(i + 1, i + 1 + blocks[i]!))
  const clear = 1 << minCodeSize
  const end = clear + 1
  let size = minCodeSize + 1
  let dict: number[][] = []
  const reset = (): void => {
    dict = Array.from({ length: clear }, (_, k) => [k])
    dict.push([], [])
    size = minCodeSize + 1
  }
  reset()
  const out: number[] = []
  let bitPos = 0
  let prev: number[] | null = null
  const read = (): number => {
    let code = 0
    for (let b = 0; b < size; b++, bitPos++) code |= ((bytes[bitPos >> 3]! >> (bitPos & 7)) & 1) << b
    return code
  }
  while (bitPos + size <= bytes.length * 8) {
    const code = read()
    if (code === clear) {
      reset()
      prev = null
      continue
    }
    if (code === end) break
    const entry: number[] = code < dict.length ? dict[code]! : [...prev!, prev![0]!]
    out.push(...entry)
    if (prev) dict.push([...prev, entry[0]!])
    prev = entry
    if (dict.length === 1 << size && size < 12) size++
  }
  return out
}

describe('GIF recordings', () => {
  it('decodes Chrome’s PNG screenshots', () => {
    const image = decodePng(solidPng(3, 2, [200, 10, 20, 255]))
    expect(image.width).toBe(3)
    expect([...image.data.subarray(0, 4)]).toEqual([200, 10, 20, 255])
    // Row 1 used the "up" filter with zero deltas: the same colour again.
    expect([...image.data.subarray(12, 16)]).toEqual([200, 10, 20, 255])
  })

  it('LZW-encodes so a decoder gets the same pixels back, past the 4096-code reset', () => {
    const pixels = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7 + (i >> 5)) % 252)
    expect(lzwDecode(lzwEncode(pixels))).toEqual([...pixels])
  })

  it('writes a looping GIF89a', () => {
    const frame = decodePng(solidPng(4, 4, [0, 128, 255, 255]))
    const gif = Buffer.from(encodeGif([frame, frame], { delayCs: 50 }))
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a')
    expect(gif.includes(Buffer.from('NETSCAPE2.0', 'latin1'))).toBe(true)
    expect(gif[gif.length - 1]).toBe(0x3b)
  })
})

describe('chat titles', () => {
  it('start as the gist of the first message, not the message itself', async () => {
    const { gistTitle } = await import('../../src/core/engine/titles')
    expect(gistTitle('Hey! Can you please research the best laptops for students under 1000 euros and make a table')).toBe('Research the best laptops for students')
    expect(gistTitle('I want you to fix the login bug, it crashes when the password is empty')).toBe('Fix the login bug')
    expect(gistTitle('please summarise https://example.com/a/very/long/link for me')).toBe('Summarise')
    expect(gistTitle('   ')).toBe('New chat')
  })

  it('take a model’s summary, cleaned, or nothing usable', async () => {
    const { cleanTitle, summaryTitle } = await import('../../src/core/engine/titles')
    expect(cleanTitle('Title: "Laptop shortlist for students".')).toBe('Laptop shortlist for students')
    expect(cleanTitle('NONE')).toBeNull()
    expect(cleanTitle('This is a very long sentence that is clearly not a short title at all, really')).toBeNull()
    expect(await summaryTitle('hello', '', null)).toBeNull()
  })
})
