import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT_OK, EXIT_USAGE, main, type CliDeps } from '../../src/bridge/cli'
import type { CoreClient } from '../../src/bridge/client'
import { PROMPT_MCP_KEY, removeFreebuffPromptTools } from '../../src/core/terminals/prompt-tools-config'
import { myPromptBrief } from '../../src/core/engine/my-prompt'
import { guideReminder } from '../../src/core/engine/guides'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(argv: string[]) {
  const calls: Array<{ method: string; params: unknown }> = []
  const out: string[] = []
  const err: string[] = []
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'promptTools.list') {
        return [
          { name: 'gmail_send_message', description: 'Send an email from the connected Gmail.', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
          { name: 'update_plan', description: 'The task list the user watches.', inputSchema: { type: 'object' } }
        ]
      }
      if (method === 'promptTools.call') return { text: 'Sent.' }
      throw new Error(`unexpected ${method}`)
    },
    close: () => undefined
  } as unknown as CoreClient
  const deps: CliDeps = { connectCore: async () => client, log: (t) => out.push(t), error: (t) => err.push(t) }
  return { promise: main([...argv, '--data-dir', tmpdir()], deps), calls, out, err }
}

describe('deskmates tool (the prompt tools as a command, for Freebuff)', () => {
  it('lists the tools, filtered by words', async () => {
    const r = run(['tool', 'list', 'gmail'])
    expect(await r.promise).toBe(EXIT_OK)
    expect(r.out[0]).toContain('gmail_send_message: Send an email')
    expect(r.out[0]).not.toContain('update_plan')
  })

  it("shows one tool's inputs", async () => {
    const r = run(['tool', 'help', 'gmail_send_message'])
    expect(await r.promise).toBe(EXIT_OK)
    expect(r.out[0]).toContain('"to"')
    const missing = run(['tool', 'help', 'nope'])
    expect(await missing.promise).toBe(EXIT_USAGE)
  })

  it('runs a tool with inline JSON or a JSON file, as the agent in its folder', async () => {
    const inline = run(['tool', 'gmail_send_message', '{"to":"a@b.c"}'])
    expect(await inline.promise).toBe(EXIT_OK)
    expect(inline.out).toEqual(['Sent.'])
    expect(inline.calls.at(-1)).toMatchObject({ method: 'promptTools.call', params: { name: 'gmail_send_message', input: { to: 'a@b.c' }, agent: 'Freebuff' } })

    const dir = mkdtempSync(join(tmpdir(), 'dm-tool-'))
    dirs.push(dir)
    const file = join(dir, 'input.json')
    writeFileSync(file, '\uFEFF{"to":"x@y.z"}')
    const fromFile = run(['tool', 'gmail_send_message', `@${file}`])
    expect(await fromFile.promise).toBe(EXIT_OK)
    expect(fromFile.calls.at(-1)).toMatchObject({ params: { input: { to: 'x@y.z' } } })

    const bad = run(['tool', 'gmail_send_message', '{to: oops'])
    expect(await bad.promise).toBe(EXIT_USAGE)
    expect(bad.err[0]).toContain('JSON object')
  })
})

describe("Freebuff's own setup is left as it was", () => {
  it("takes only Deskmates' entry out of ~/.agents/mcp.json", () => {
    const home = mkdtempSync(join(tmpdir(), 'dm-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.agents'))
    const file = join(home, '.agents', 'mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { [PROMPT_MCP_KEY]: { command: 'cmd.exe' }, mine: { command: 'x' } } }))
    expect(removeFreebuffPromptTools(home)).toBe('removed')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { mine: { command: 'x' } } })
    expect(removeFreebuffPromptTools(home)).toBe('absent')
    // A file that only held Deskmates' entry is removed.
    writeFileSync(file, JSON.stringify({ mcpServers: { [PROMPT_MCP_KEY]: { command: 'cmd.exe' } } }))
    expect(removeFreebuffPromptTools(home)).toBe('removed')
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, '{ not json')
    expect(removeFreebuffPromptTools(home)).toBe('skipped')
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  it("tells Freebuff to run the tools as a command, by the command's full path", () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-brief-'))
    dirs.push(dir)
    const prompt = join(dir, 'prompt.md')
    writeFileSync(prompt, '# Intro\nBe helpful.\n\n# Tools\n## gmail_send_message\nSend mail.\n')
    const brief = myPromptBrief('file', prompt, { promptTools: 'command', command: 'C:\\kit\\deskmates.cmd' })!
    expect(brief).toContain('C:\\kit\\deskmates.cmd tool <name> @input.json')
    expect(brief).not.toContain('deskmates-prompt MCP')
    expect(guideReminder('Research e-bikes', undefined, ['research'], 'command')).not.toContain('deskmates-prompt')
  })
})
