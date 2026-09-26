import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillsService } from '../../src/core/extensions/skills'
import { McpConnectorManager } from '../../src/core/connectors'
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'
import { extensionTools } from '../../src/core/tools/extensions'
import { approvalFor } from '../../src/core/engine/approvals'
import type { ToolContext } from '../../src/core/tools/context'

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'dm-ext-'))
  const repos = createRepos(openDatabase(':memory:'))
  const skills = new SkillsService({ repos, dataDir: join(base, 'data') })
  const connectors = new McpConnectorManager({
    repos,
    createTransport: () => {
      throw new Error('spawn python ENOENT')
    }
  })
  const ctx = { root: base, skills, connectors } as unknown as ToolContext
  const run = (name: keyof ReturnType<typeof extensionTools>, input: unknown) =>
    (extensionTools(ctx)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(input, { toolCallId: 't', messages: [] })
  return { base, run, connectors, skills }
}

describe('extension tools', () => {
  it('install_skill imports every skill in a folder, relative to the project', async () => {
    const { base, run } = setup()
    for (const name of ['resolve-color', 'resolve-edit']) {
      mkdirSync(join(base, 'skills', name), { recursive: true })
      writeFileSync(join(base, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nBody`)
    }
    const result = await run('install_skill', { path: 'skills' })
    expect(result.added.sort()).toEqual(['resolve-color', 'resolve-edit'])
    const listed = await run('list_extensions', {})
    expect(listed.skills.map((s: { name: string }) => s.name).sort()).toEqual(['resolve-color', 'resolve-edit'])
  })

  it('add_mcp_server saves a stdio server and reports when it cannot connect yet', async () => {
    const { run, connectors } = setup()
    const result = await run('add_mcp_server', { name: 'davinci-resolve', command: 'python.exe', args: ['server.py'], env: { A: 'b' } })
    expect(result.installed).toBe('davinci-resolve')
    expect(result.connected).toBe(false)
    expect(result.error).toContain('ENOENT')
    expect(connectors.list()[0]).toMatchObject({ name: 'davinci-resolve', transport: 'stdio', command: 'python.exe', args: ['server.py'] })
    await expect(run('add_mcp_server', { name: 'davinci-resolve', command: 'x' })).rejects.toThrow('already exists')
  })

  it('installing always asks the user first', () => {
    for (const name of ['add_mcp_server', 'install_skill', 'install_plugin']) expect(approvalFor(name, [])).toBe('user-approval')
    expect(approvalFor('list_extensions', [])).toBeUndefined()
  })
})
