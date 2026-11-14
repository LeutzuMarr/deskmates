import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryFiles, memoryVersion } from '../../src/core/tools/memory-files'
import { promptTools } from '../../src/core/tools/prompt-tools'
import { displayBody, saveWidget } from '../../src/core/tools/widgets'
import { promptToolSpecs } from '../../src/core/engine/my-prompt'
import { stepDiff } from '../../src/renderer/src/lib/steps'
import type { ToolContext } from '../../src/core/tools/context'

const PROMPT = `# claude_behavior

Be helpful.

# Tools
## create_file

Create a new file with content.

\`\`\`json
{"name": "create_file", "parameters": {"type": "object", "properties": {"description": {"type": "string"}, "path": {"type": "string"}, "file_text": {"type": "string"}}, "required": ["description", "path", "file_text"]}}
\`\`\`
## memory_write

Create or update a memory document.

\`\`\`json
{"name": "memory_write", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}, "if_version": {"type": "string"}}, "required": ["path", "content", "if_version"]}}
\`\`\`
## chart_display_v0

Display a chart.

\`\`\`yaml
{"name": "chart_display_v0", "parameters": {"description": "has "bad" quotes"}}
\`\`\`
## mcp__Gmail__send_message

Send an email.

\`\`\`json
{"name": "mcp__Gmail__send_message", "parameters": {"type": "object", "properties": {}}}
\`\`\`
`

let dir: string
const originalEnv = process.env.DESKMATES_PROMPTS_DIR

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deskmates-prompt-tools-'))
  mkdirSync(join(dir, 'prompts', 'my-prompt'), { recursive: true })
  writeFileSync(join(dir, 'prompts', 'my-prompt', 'my-prompt.md'), PROMPT, 'utf8')
  process.env.DESKMATES_PROMPTS_DIR = join(dir, 'prompts')
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env.DESKMATES_PROMPTS_DIR
  else process.env.DESKMATES_PROMPTS_DIR = originalEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('memory documents', () => {
  it('creates, reads, appends, edits and deletes with version checks', () => {
    const memory = new MemoryFiles(join(dir, 'memory'))
    expect(memory.write('/topics/a.md', 'one', 'new')).toContain(memoryVersion('one'))
    expect(() => memory.write('/topics/a.md', 'two', 'new')).toThrow(/already exists/)
    expect(() => memory.write('/topics/a.md', 'two', 'wrongversion')).toThrow(/changed since you read it/)
    memory.append('/topics/a.md', 'two', memoryVersion('one'))
    expect(memory.read('/topics/a.md')).toContain('one\ntwo')
    memory.replace('/topics/a.md', 'two', 'three', memoryVersion('one\ntwo'))
    expect(memory.list('/topics/').entries.map((e) => e.path)).toEqual(['/topics/a.md'])
    expect(() => memory.read('/../escape.md')).toThrow()
    memory.delete('/topics/a.md', memoryVersion('one\nthree'))
    expect(memory.read('/topics/a.md')).toContain('no such document')
  })
})

describe("the operating prompt's tools", () => {
  it('reads every tool heading, keeping schemas that parse and marking the rest', () => {
    const specs = promptToolSpecs(join(dir, 'prompts', 'my-prompt', 'my-prompt.md'))
    expect([...specs.keys()]).toEqual(['create_file', 'memory_write', 'chart_display_v0', 'mcp__Gmail__send_message'])
    expect(specs.get('create_file')?.description).toBe('Create a new file with content.')
    expect(specs.get('chart_display_v0')?.schema).toBeNull()
  })

  it('builds the tools the prompt names on top of the run’s own tools, and only those', async () => {
    const written: Array<{ file_path: string; content: string }> = []
    const base: ToolSet = {
      Write: tool({
        description: 'write',
        inputSchema: z.object({ file_path: z.string(), content: z.string() }),
        execute: async (input) => {
          written.push(input)
          return 'ok'
        }
      })
    }
    const ctx = { taskId: 't', projectId: 'p', root: dir, dataDir: dir } as unknown as ToolContext
    const tools = promptTools(ctx, base)
    expect(Object.keys(tools).sort()).toEqual(['chart_display_v0', 'create_file', 'memory_write'])
    const run = (name: string, input: unknown) => (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {})
    await run('create_file', { description: 'notes', path: 'notes.md', file_text: 'hi' })
    expect(written).toEqual([{ file_path: 'notes.md', content: 'hi' }])
    expect(await run('memory_write', { path: '/a.md', content: 'x', if_version: 'new' })).toContain('Saved /a.md')
    const chart = (await run('chart_display_v0', { style: 'bar', title: 'Sales', series: [{ name: 'A', values: [1, 2, 3] }], x_axis: { data: ['Jan', 'Feb', 'Mar'] } })) as { widget: string }
    expect(chart.widget).toMatch(/^deskmates-preview:\/\/widget\/[0-9a-f-]{36}\.html$/)
    const page = readFileSync(join(dir, 'widgets', chart.widget.split('/').pop()!), 'utf8')
    expect(page).toContain('<svg')
    expect(page).toContain('deskmates-widget-height')
  })
})

describe('widgets', () => {
  it('escapes what the agent sends and keeps only http links', () => {
    const body = displayBody('product_carousel_display_v0', { summary: 'Picks', products: [{ name: '<b>x</b>', url: 'javascript:alert(1)', price: '$5' }] })
    expect(body).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(body).not.toContain('javascript:')
    expect(body).toContain('$5')
  })

  it('adds the height reporter to a full page too', () => {
    const result = saveWidget(dir, 'Page', '<html><body><p>hi</p></body></html>')
    const page = readFileSync(join(dir, 'widgets', result.widget.split('/').pop()!), 'utf8')
    expect(page).toMatch(/deskmates-widget-height[\s\S]*<\/body>/)
  })
})

describe('line counts on file steps', () => {
  it('counts added and removed lines for edits and new files', () => {
    expect(stepDiff({ toolName: 'edit_file', input: { old_text: 'a\nb', new_text: 'a\nb\nc' }, state: 'done' })).toEqual({ added: 3, removed: 2 })
    expect(stepDiff({ toolName: 'create_file', input: { file_text: 'x\ny\n' }, state: 'done' })).toEqual({ added: 2, removed: 0 })
    expect(stepDiff({ toolName: 'Edit', input: { old_string: 'a', new_string: 'b' }, state: 'error' })).toBeNull()
    expect(stepDiff({ toolName: 'read_file', input: { path: 'a' }, state: 'done' })).toBeNull()
  })
})
