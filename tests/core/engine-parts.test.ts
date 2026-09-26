import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import type { StoredMessage } from '../../src/core/store/repos'
import { DEFAULT_SETTINGS } from '../../src/shared/protocol'
import { approvalFor, RISKY_TOOLS } from '../../src/core/engine/approvals'
import { buildInstructions, basePromptPath, loadBasePrompt, readProjectInstructions } from '../../src/core/engine/instructions'
import { buildTimeline, pendingApprovals, danglingToolCalls } from '../../src/core/engine/timeline'
import { compactHistory } from '../../src/core/engine/history'

describe('approvalFor', () => {
  it('covers all three outcomes', () => {
    // Safe tool → undefined
    expect(approvalFor('write_file', [])).toBeUndefined()
    // Risky tool, not auto-approved → 'user-approval'
    expect(approvalFor('delete_path', [])).toBe('user-approval')
    // Risky tool, auto-approved → 'approved'
    expect(approvalFor('delete_path', ['delete_path'])).toBe('approved')
    expect(approvalFor('run_command', ['run_command'])).toBe('approved')
    // Confirm RISKY_TOOLS contains the right tools
    expect(RISKY_TOOLS.has('delete_path')).toBe(true)
    expect(RISKY_TOOLS.has('run_command')).toBe(true)
  })
})

describe('buildInstructions', () => {
  let emptyPromptsDir: string
  const originalEnv = process.env.DESKMATES_PROMPTS_DIR

  beforeEach(() => {
    // Hermetic: point the loader at an empty dir so a checkout with a real ./prompts on disk can't
    // bleed its contents into these overlay assertions.
    emptyPromptsDir = mkdtempSync(join(tmpdir(), 'deskmates-instr-empty-'))
    process.env.DESKMATES_PROMPTS_DIR = emptyPromptsDir
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DESKMATES_PROMPTS_DIR
    else process.env.DESKMATES_PROMPTS_DIR = originalEnv
    rmSync(emptyPromptsDir, { recursive: true, force: true })
  })

  it('includes project name, folder, how to write, identity, memories, global and project instructions; omits both instruction headings when both are empty', () => {
    const result = buildInstructions({
      project: { id: 'p1', name: 'MyApp', folder: 'C:\\Projects\\MyApp', kind: 'work', model: null, createdAt: 0 },
      settings: { ...DEFAULT_SETTINGS, globalInstructions: 'Always use TypeScript.', compatibleBaseUrl: '', maxSteps: 40 },
      memories: [
        { id: 'mem1', projectId: 'p1', content: 'User prefers tabs', createdAt: 0 },
        { id: 'mem2', projectId: 'p1', content: 'Use ESLint', createdAt: 1 }
      ],
      projectInstructions: 'Follow the style guide.',
      now: new Date('2025-06-15T10:30:00'),
      model: { provider: 'google', modelId: 'gemini-2.5-pro' }
    })

    // Project name and folder
    expect(result).toContain('Project: MyApp')
    expect(result).toContain('Folder: C:\\Projects\\MyApp')

    // How to write section
    expect(result).toContain('How to write:')
    expect(result).toContain('Lead with the result or answer')

    // Identity with model id
    expect(result).toContain('gemini-2.5-pro')
    expect(result).toContain('Google Gemini')

    // Memory lines with ids
    expect(result).toContain('[mem1] User prefers tabs')
    expect(result).toContain('[mem2] Use ESLint')

    // Global instructions
    expect(result).toContain('User instructions (all projects):')
    expect(result).toContain('Always use TypeScript.')

    // Project instructions
    expect(result).toContain('Project instructions (from DESKMATES.md):')
    expect(result).toContain('Follow the style guide.')

    // Omits both instruction headings when both are empty
    const result2 = buildInstructions({
      project: { id: 'p1', name: 'MyApp', folder: 'C:\\Projects\\MyApp', kind: 'work', model: null, createdAt: 0 },
      settings: { ...DEFAULT_SETTINGS, globalInstructions: '', compatibleBaseUrl: '', maxSteps: 40 },
      memories: [],
      projectInstructions: null,
      now: new Date('2025-06-15T10:30:00'),
      model: { provider: 'openai', modelId: 'gpt-4o' }
    })

    expect(result2).not.toContain('User instructions (all projects):')
    expect(result2).not.toContain('Project instructions (from DESKMATES.md):')
  })
})

describe('readProjectInstructions', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deskmates-instr-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('prefers DESKMATES.md over AGENTS.md, and returns null when neither exists', () => {
    // Neither exists → null
    expect(readProjectInstructions(tmpDir)).toBeNull()

    // Only AGENTS.md
    writeFileSync(join(tmpDir, 'AGENTS.md'), 'Agent instructions')
    expect(readProjectInstructions(tmpDir)).toBe('Agent instructions')

    // DESKMATES.md takes priority
    writeFileSync(join(tmpDir, 'DESKMATES.md'), 'Deskmates instructions')
    expect(readProjectInstructions(tmpDir)).toBe('Deskmates instructions')
  })
})

describe('the mounted base prompt', () => {
  let promptsDir: string
  const originalEnv = process.env.DESKMATES_PROMPTS_DIR

  beforeEach(() => {
    promptsDir = mkdtempSync(join(tmpdir(), 'deskmates-prompts-'))
    process.env.DESKMATES_PROMPTS_DIR = promptsDir
    mkdirSync(join(promptsDir, 'claude-cowork'), { recursive: true })
    mkdirSync(join(promptsDir, 'claude-design'), { recursive: true })
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DESKMATES_PROMPTS_DIR
    else process.env.DESKMATES_PROMPTS_DIR = originalEnv
    rmSync(promptsDir, { recursive: true, force: true })
  })

  const baseProject = {
    id: 'p1',
    name: 'MyApp',
    folder: 'C:\\Projects\\MyApp',
    kind: 'work' as const,
    model: null,
    createdAt: 0
  }
  const emptyOverlay = (kind: 'work' | 'design') => ({
    project: { ...baseProject, kind },
    settings: { ...DEFAULT_SETTINGS, globalInstructions: '', compatibleBaseUrl: '', maxSteps: 40 },
    memories: [],
    projectInstructions: null,
    now: new Date('2025-06-15T10:30:00'),
    model: { provider: 'google' as const, modelId: 'gemini-2.5-pro' }
  })

  it('resolves each kind to its file in the mounted prompt directories', () => {
    expect(basePromptPath('work')).toBe(join(promptsDir, 'claude-cowork', 'claude-cowork.md'))
    expect(basePromptPath('design')).toBe(join(promptsDir, 'claude-design', 'claude-design.md'))
    expect(loadBasePrompt('work')).toBeNull() // nothing written yet
  })

  it('prepends the loaded base prompt to the instructions before the Deskmates overlay', () => {
    writeFileSync(basePromptPath('work'), 'WORK BASE PROMPT', 'utf8')
    const result = buildInstructions(emptyOverlay('work'))
    expect(result.startsWith('WORK BASE PROMPT')).toBe(true)
    expect(result).toContain('Project: MyApp') // overlay still present after it
    expect(result.indexOf('WORK BASE PROMPT')).toBeLessThan(result.indexOf('Project: MyApp'))
  })

  it('loads the design base prompt for design projects', () => {
    writeFileSync(basePromptPath('design'), 'DESIGN BASE PROMPT', 'utf8')
    const result = buildInstructions(emptyOverlay('design'))
    expect(result.startsWith('DESIGN BASE PROMPT')).toBe(true)
    expect(result).toContain('.html and .dc.html pages')
  })

  it('drops the Deskmates rules that would contradict a loaded base prompt', () => {
    writeFileSync(basePromptPath('design'), 'DESIGN BASE PROMPT', 'utf8')
    const result = buildInstructions({ ...emptyOverlay('design'), memories: [{ id: 'm1', content: 'Likes teal', createdAt: 0 } as any] })
    expect(result).toContain('follow it exactly')
    expect(result).not.toContain('You are Deskmates')
    expect(result).not.toContain('How to design:')
    expect(result).not.toContain('How to write:')
    expect(result).not.toContain('Never claim to be a different assistant')
    expect(result).toContain('Likes teal')
  })

  it('leaves the instructions unchanged when the base prompt file is missing', () => {
    expect(loadBasePrompt('work')).toBeNull()
    const result = buildInstructions(emptyOverlay('work'))
    expect(result.startsWith('You are Deskmates, an AI assistant')).toBe(true)
    expect(result).not.toContain('WORK BASE PROMPT')
  })
})

describe('buildTimeline', () => {
  it('converts user → assistant (text + tool-call) → tool (tool-result json) into three items', () => {
    const stored: StoredMessage[] = [
      {
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } as ModelMessage,
        at: 1000
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' } }
          ]
        } as ModelMessage,
        at: 2000
      },
      {
        message: {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'json', value: { content: 'hello' } } }
          ]
        } as ModelMessage,
        at: 3000
      }
    ]

    const timeline = buildTimeline(stored)
    expect(timeline.length).toBe(3)

    // User item
    expect(timeline[0].kind).toBe('user')
    expect(timeline[0].at).toBe(1000)

    // Assistant text item
    expect(timeline[1].kind).toBe('assistant')
    expect(timeline[1].at).toBe(2000)

    // Tool item - done
    expect(timeline[2].kind).toBe('tool')
    expect(timeline[2].at).toBe(2000)
    if (timeline[2].kind === 'tool') {
      expect(timeline[2].state).toBe('done')
    }
  })
})

describe('approval cycle', () => {
  it('tracks awaiting-approval → running → done', () => {
    // Assistant message with tool-call and non-automatic approval request
    const stored: StoredMessage[] = [
      {
        message: { role: 'user', content: [{ type: 'text', text: 'Delete file' }] } as ModelMessage,
        at: 1000
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'delete_path', input: { path: 'a.txt' } },
            { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1', isAutomatic: false }
          ]
        } as ModelMessage,
        at: 2000
      }
    ]

    let timeline = buildTimeline(stored)
    const toolItem = timeline.find(i => i.kind === 'tool')!
    expect(toolItem.kind === 'tool' && toolItem.state).toBe('awaiting-approval')
    expect(pendingApprovals(stored)).toHaveLength(1)

    // Add approval response (approved: true)
    stored.push({
      message: {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'a1', approved: true }
        ]
      } as ModelMessage,
      at: 3000
    })

    timeline = buildTimeline(stored)
    const toolItem2 = timeline.find(i => i.kind === 'tool')!
    expect(toolItem2.kind === 'tool' && toolItem2.state).toBe('running')
    expect(pendingApprovals(stored)).toHaveLength(0)

    // Add tool result
    stored.push({
      message: {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'delete_path', output: { type: 'json', value: { deleted: 'a.txt' } } }
        ]
      } as ModelMessage,
      at: 4000
    })

    timeline = buildTimeline(stored)
    const toolItem3 = timeline.find(i => i.kind === 'tool')!
    expect(toolItem3.kind === 'tool' && toolItem3.state).toBe('done')
  })

  it('denial (approved:false then execution-denied) gives denied', () => {
    const stored: StoredMessage[] = [
      {
        message: { role: 'user', content: [{ type: 'text', text: 'Delete file' }] } as ModelMessage,
        at: 1000
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'delete_path', input: { path: 'a.txt' } },
            { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1', isAutomatic: false }
          ]
        } as ModelMessage,
        at: 2000
      },
      {
        message: {
          role: 'tool',
          content: [
            { type: 'tool-approval-response', approvalId: 'a1', approved: false }
          ]
        } as ModelMessage,
        at: 3000
      },
      {
        message: {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'delete_path', output: { type: 'execution-denied', reason: 'User denied.' } }
          ]
        } as ModelMessage,
        at: 4000
      }
    ]

    const timeline = buildTimeline(stored)
    const toolItem = timeline.find(i => i.kind === 'tool')!
    expect(toolItem.kind === 'tool' && toolItem.state).toBe('denied')
  })

  it('automatic approval request (isAutomatic: true) is ignored by both functions', () => {
    const stored: StoredMessage[] = [
      {
        message: { role: 'user', content: [{ type: 'text', text: 'Write file' }] } as ModelMessage,
        at: 1000
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'write_file', input: { path: 'a.txt', content: 'hi' } },
            { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1', isAutomatic: true }
          ]
        } as ModelMessage,
        at: 2000
      }
    ]

    const timeline = buildTimeline(stored)
    const toolItem = timeline.find(i => i.kind === 'tool')!
    // Should still be running (not awaiting-approval) because isAutomatic is true
    expect(toolItem.kind === 'tool' && toolItem.state).toBe('running')
    // pendingApprovals should be empty
    expect(pendingApprovals(stored)).toHaveLength(0)
  })
})

describe('danglingToolCalls', () => {
  it('returns a repair message for an unanswered tool call and null once a result exists', () => {
    const stored: StoredMessage[] = [
      {
        message: { role: 'user', content: [{ type: 'text', text: 'Do it' }] } as ModelMessage,
        at: 1000
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' } }
          ]
        } as ModelMessage,
        at: 2000
      }
    ]

    // Should return a repair message
    const repair = danglingToolCalls(stored)
    expect(repair).not.toBeNull()
    expect(repair!.role).toBe('tool')
    const content = (repair as any).content as any[]
    expect(content[0].toolCallId).toBe('c1')
    expect(content[0].output.type).toBe('error-text')
    expect(content[0].output.value).toContain('Interrupted')

    // Once a result exists, should return null
    stored.push({
      message: {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: 'contents' } }
        ]
      } as ModelMessage,
      at: 3000
    })

    expect(danglingToolCalls(stored)).toBeNull()
  })
})

describe('compactHistory', () => {
  it('shortens a 5000-character tool output two turns back, leaves latest turn untouched, and does not mutate input', () => {
    const bigOutput = 'x'.repeat(5000)
    const messages: ModelMessage[] = [
      // Turn 1 (old)
      { role: 'user', content: [{ type: 'text', text: 'first' }] } as ModelMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'big.txt' } }]
      } as ModelMessage,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: bigOutput } }]
      } as ModelMessage,
      // Turn 2 (recent)
      { role: 'user', content: [{ type: 'text', text: 'second' }] } as ModelMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'read_file', input: { path: 'small.txt' } }]
      } as ModelMessage,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'read_file', output: { type: 'text', value: bigOutput } }]
      } as ModelMessage,
      // Turn 3 (latest)
      { role: 'user', content: [{ type: 'text', text: 'third' }] } as ModelMessage,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }]
      } as ModelMessage
    ]

    // Keep a reference to the original to check no mutation
    const originalJson = JSON.stringify(messages)

    const compacted = compactHistory(messages, { keepRecentTurns: 2 })

    // Original should not be mutated
    expect(JSON.stringify(messages)).toBe(originalJson)

    // The old turn (turn 1) tool output should be shortened
    const oldToolMsg = compacted[2] as any
    expect(oldToolMsg.role).toBe('tool')
    const oldOutput = oldToolMsg.content[0].output
    expect(oldOutput.type).toBe('text')
    expect(oldOutput.value).toContain('[Shortened output from an earlier step]')
    expect(oldOutput.value.length).toBeLessThan(5000)

    // The latest turn's tool output should be untouched (turn 2 is within keepRecentTurns=2)
    const recentToolMsg = compacted[5] as any
    expect(recentToolMsg.content[0].output.value).toBe(bigOutput)
  })

  it('with a tiny maxTotalChars drops whole old turns, and every remaining tool-call still has its tool-result', () => {
    const messages: ModelMessage[] = [
      // Turn 1
      { role: 'user', content: [{ type: 'text', text: 'first' }] } as ModelMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' } }]
      } as ModelMessage,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: 'data1' } }]
      } as ModelMessage,
      // Turn 2
      { role: 'user', content: [{ type: 'text', text: 'second' }] } as ModelMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'read_file', input: { path: 'b.txt' } }]
      } as ModelMessage,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'read_file', output: { type: 'text', value: 'data2' } }]
      } as ModelMessage,
      // Turn 3
      { role: 'user', content: [{ type: 'text', text: 'third' }] } as ModelMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'write_file', input: { path: 'c.txt', content: 'hi' } }]
      } as ModelMessage,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c3', toolName: 'write_file', output: { type: 'text', value: 'ok' } }]
      } as ModelMessage
    ]

    const compacted = compactHistory(messages, { maxTotalChars: 100 })

    // Should have dropped at least one turn from the start
    expect(compacted.length).toBeLessThan(messages.length)

    // Every remaining tool-call must have a matching tool-result
    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const msg of compacted) {
      const m = msg as any
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'tool-call') callIds.add(p.toolCallId)
        }
      }
      if (m.role === 'tool' && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'tool-result') resultIds.add(p.toolCallId)
        }
      }
    }
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true)
    }
  })

  it('design projects get the designer preamble, design folder line and design guidance; work output is unchanged', () => {
    const savedDir = process.env.DESKMATES_PROMPTS_DIR
    process.env.DESKMATES_PROMPTS_DIR = mkdtempSync(join(tmpdir(), 'dm-noprompts-'))
    onTestFinished(() => {
      if (savedDir === undefined) delete process.env.DESKMATES_PROMPTS_DIR
      else process.env.DESKMATES_PROMPTS_DIR = savedDir
    })
    const design = buildInstructions({
      project: { id: 'p1', name: 'Poster', folder: 'C:\\Data\\designs\\abc', kind: 'design', model: null, createdAt: 0 },
      settings: { ...DEFAULT_SETTINGS, globalInstructions: '', compatibleBaseUrl: '', maxSteps: 40 },
      memories: [],
      projectInstructions: null,
      now: new Date('2025-06-15T10:30:00'),
      model: { provider: 'google', modelId: 'gemini-2.5-pro' }
    })

    expect(design).toContain('You are Deskmates, an AI designer. You build web pages in the Deskmates Design tab.')
    expect(design).toContain('Design folder: C:\\Data\\designs\\abc (the design is index.html in this folder)')
    expect(design).toContain('How to design:')
    expect(design).toContain('data-dm-id')

    const work = buildInstructions({
      project: { id: 'p2', name: 'MyApp', folder: 'C:\\Projects\\MyApp', kind: 'work', model: null, createdAt: 0 },
      settings: { ...DEFAULT_SETTINGS, globalInstructions: '', compatibleBaseUrl: '', maxSteps: 40 },
      memories: [],
      projectInstructions: null,
      now: new Date('2025-06-15T10:30:00'),
      model: { provider: 'google', modelId: 'gemini-2.5-pro' }
    })

    expect(work).not.toContain('You are Deskmates, an AI designer.')
    expect(work).not.toContain('Design folder:')
    expect(work).not.toContain('How to design:')
    expect(work).not.toContain('data-dm-id')
    expect(work).toContain('Project: MyApp')
    expect(work).toContain('How to write:')
  })
})

describe('buildTimeline with a CLI provider reply', () => {
  it('shows an assistant reply stored as a plain string', async () => {
    const { buildTimeline } = await import('../../src/core/engine/timeline')
    const items = buildTimeline([
      { message: { role: 'user', content: 'hello' }, at: 1 },
      { message: { role: 'assistant', content: 'Hi! How can I help?' }, at: 2 }
    ] as any)
    const reply = items.find((item) => item.kind === 'assistant')
    expect(reply && reply.kind === 'assistant' ? reply.text : null).toBe('Hi! How can I help?')
  })
})
