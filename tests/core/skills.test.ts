import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRunner } from '../../src/core/bots/command-runner'
import { EventBus } from '../../src/core/events'
import { ChangeLog } from '../../src/core/fs/change-log'
import { PluginsService, PLUGINS_DIR } from '../../src/core/extensions/plugins'
import { SKILLS_DIR, SkillsService, skillDescription } from '../../src/core/extensions/skills'
import { skillsTools } from '../../src/core/extensions/skills-tool'
import { KeyStore } from '../../src/core/models/keys'
import { ModelService } from '../../src/core/models/providers'
import { createHandlers } from '../../src/core/server/handlers'
import { openDatabase } from '../../src/core/store/db'
import { createRepos, type Repos } from '../../src/core/store/repos'
import type { CoreEvent, RpcMethod } from '../../src/shared/protocol'

type TestApi = Record<RpcMethod, (params: any) => any>

interface Fixture {
  db: DatabaseSync
  base: string
  repos: Repos
  skills: SkillsService
  cleanup(): void
}

/** A fake `git` that "clones" by copying a canned repo folder, without touching the network. */
class FakeGitRunner implements CommandRunner {
  calls: Array<{ file: string; args: string[] }> = []
  /** Where a fake clone should come from, keyed by the destination folder name. */
  source: Map<string, string> = new Map()

  async run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ file, args })
    if (file !== 'git') return { code: 0, stdout: '', stderr: '' }
    const dest = args[args.length - 1]!
    const name = basename(dest)
    const source = this.source.get(name)
    if (!source) return { code: 1, stdout: '', stderr: `Repository not found in fake git: ${name}` }
    cpSync(source, dest, { recursive: true })
    return { code: 0, stdout: `Cloning into '${name}'...`, stderr: '' }
  }
}

/** Writes a minimal SKILL.md plus a helper file into a fresh `<tmp>/dm-src-…/<name>` folder. */
function writeSkill(name: string): string {
  const folder = join(mkdtempSync(join(tmpdir(), 'dm-src-')), name)
  return writeSkillAt(folder, name)
}

/** Writes a minimal SKILL.md plus a helper file into an existing `folder`. */
function writeSkillAt(folder: string, name: string): string {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), `# ${name}\n\nInstructions for ${name}.\n`)
  writeFileSync(join(folder, 'helper.txt'), 'helper\n')
  return folder
}

let fixtures: Fixture[] = []

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'deskmates-skills-'))
  const db = openDatabase(':memory:')
  const repos = createRepos(db)
  const skills = new SkillsService({ repos, dataDir: base })
  const fixture: Fixture = {
    db,
    base,
    repos,
    skills,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    fixture.cleanup()
  }
})

describe('extensions migration', () => {
  it('creates the skills and plugins tables', () => {
    const f = makeFixture()
    const row = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('skills', 'plugins')").all() as Array<{ name: string }>
    expect(row.map((r) => r.name).sort()).toEqual(['plugins', 'skills'])
  })
})

describe('SkillsRepo', () => {
  it('creates, requires, finds by name, lists sorted, updates and deletes', () => {
    const f = makeFixture()
    const a = f.repos.skills.create('code-review', '/x/code-review', '/x')
    expect(a).toMatchObject({ name: 'code-review', folder: '/x/code-review', source: '/x', enabled: true })

    expect(() => f.repos.skills.require('missing')).toThrow('Skill not found: missing')
    expect(f.repos.skills.getByName('code-review')).toEqual(a)

    const b = f.repos.skills.create('triage', '/y/triage', '/y')
    expect(f.repos.skills.list().map((s) => s.name)).toEqual(['code-review', 'triage'])

    const disabled = f.repos.skills.update(a.id, { enabled: false })
    expect(disabled.enabled).toBe(false)
    expect(f.repos.skills.get(a.id)?.enabled).toBe(false)

    // Re-import by name refreshes folder, keeps the id and enabled flag.
    const reintroduced = f.repos.skills.updateFolder('code-review', '/z/code-review', '/z')
    expect(reintroduced.id).toBe(a.id)
    expect(reintroduced.folder).toBe('/z/code-review')
    expect(reintroduced.enabled).toBe(false)

    f.repos.skills.delete(a.id)
    expect(f.repos.skills.get(a.id)).toBeUndefined()
    expect(f.repos.skills.list().map((s) => s.name)).toEqual(['triage'])
  })
})

describe('PluginsRepo', () => {
  it('creates, requires, finds by name, lists sorted and deletes', () => {
    const f = makeFixture()
    const repo = f.repos.plugins.create('digest', '/p/digest', 'folder', '/src/digest')
    expect(repo).toMatchObject({ name: 'digest', folder: '/p/digest', sourceKind: 'folder', source: '/src/digest' })

    expect(() => f.repos.plugins.require('missing')).toThrow('Plugin not found: missing')
    expect(f.repos.plugins.getByName('digest')).toEqual(repo)

    f.repos.plugins.create('news', '/p/news', 'repo', 'https://github.com/owner/news')
    expect(f.repos.plugins.list().map((p) => p.name)).toEqual(['digest', 'news'])

    const updated = f.repos.plugins.update(repo.id, { source: '/src/digest-v2', sourceKind: 'folder', folder: '/p/digest-v2' })
    expect(updated).toMatchObject({ name: 'digest', folder: '/p/digest-v2', source: '/src/digest-v2' })

    f.repos.plugins.delete(repo.id)
    expect(f.repos.plugins.get(repo.id)).toBeUndefined()
  })
})

describe('SkillsService', () => {
  it('imports a folder with a SKILL.md into <dataDir>/skills/<name> and records it', () => {
    const f = makeFixture()
    const src = writeSkill('polish')

    const list = f.skills.import(src)
    expect(list).toHaveLength(1)
    const skill = list[0]!
    expect(skill.name).toBe(basename(src))
    expect(skill.source).toBe(src)
    expect(existsSync(skill.folder)).toBe(true)
    expect(readFileSync(join(skill.folder, 'SKILL.md'), 'utf8')).toContain('# polish')

    // Re-import with a changed folder keeps the same skill entry.
    const src2 = writeSkill('polish')
    const list2 = f.skills.import(src2)
    expect(list2).toHaveLength(1)
    expect(list2[0]!.id).toBe(skill.id)
  })

  it('imports every skill inside a folder of skills', () => {
    const f = makeFixture()
    const parent = join(f.base, 'my-skills')
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(parent, name), { recursive: true })
      writeFileSync(join(parent, name, 'SKILL.md'), `# ${name}
`)
    }
    mkdirSync(join(parent, 'not-a-skill'))
    const list = f.skills.import(parent)
    expect(list.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta'])
  })

  it('imports skill folders that are junctions by copying the real files', () => {
    const f = makeFixture()
    const real = join(f.base, 'elsewhere', 'linked')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'SKILL.md'), '# linked\n')
    const parent = join(f.base, 'agents-skills')
    mkdirSync(parent)
    symlinkSync(real, join(parent, 'linked'), 'junction')
    const list = f.skills.import(parent)
    expect(list.map((skill) => skill.name)).toEqual(['linked'])
    const copy = list[0]!.folder
    expect(lstatSync(copy).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toBe('# linked\n')
  })

  it('rejects folders without a SKILL.md', () => {
    const f = makeFixture()
    const src = join(f.base, 'not-a-skill')
    mkdirSync(src)
    expect(() => f.skills.import(src)).toThrow(`No SKILL.md found in ${src}.`)
  })

  it('rejects missing folders', () => {
    const f = makeFixture()
    expect(() => f.skills.import(join(f.base, 'nope'))).toThrow('does not exist')
  })

  it('setEnabled and remove update the list and delete the folder', () => {
    const f = makeFixture()
    const src = writeSkill('polish')
    const [skill] = f.skills.import(src)

    const disabled = f.skills.setEnabled(skill.id, false)
    expect(disabled[0]!.enabled).toBe(false)

    const removed = f.skills.remove(skill.id)
    expect(removed).toEqual([])
    expect(existsSync(skill.folder)).toBe(false)
    expect(f.repos.skills.get(skill.id)).toBeUndefined()
  })

  it('load() returns the SKILL.md, its files and folder', () => {
    const f = makeFixture()
    const src = writeSkill('polish')
    const [skill] = f.skills.import(src)

    const loaded = f.skills.load('polish')
    expect(loaded).not.toBeNull()
    expect(loaded!.folder).toBe(skill.folder)
    expect(loaded!.instructions).toContain('# polish')
    expect(loaded!.files.sort()).toEqual(['SKILL.md', 'helper.txt'])

    // Disabled or unknown skills don't load.
    f.skills.setEnabled(skill.id, false)
    expect(f.skills.load('polish')).toBeNull()
    expect(f.skills.load('nope')).toBeNull()
  })

  it('importAs names the skill explicitly (used by plugin-bundled skills)', () => {
    const f = makeFixture()
    const src = writeSkill('polish')

    const list = f.skills.importAs('polish-extra', src, 'plugin:digest')
    expect(list[0]).toMatchObject({ name: 'polish-extra', source: 'plugin:digest' })
    expect(existsSync(join(f.base, SKILLS_DIR, 'polish-extra', 'SKILL.md'))).toBe(true)
  })
})

describe('PluginsService', () => {
  it('installs a local folder by copying it under <dataDir>/plugins/<name>', async () => {
    const f = makeFixture()
    const runner = new FakeGitRunner()
    const plugins = new PluginsService({ repos: f.repos, dataDir: f.base, runner, skills: f.skills })

    const bundle = mkdtempSync(join(tmpdir(), 'dm-bundle-'))
    writeFileSync(join(bundle, 'plugin.json'), '{}')
    mkdirSync(join(bundle, 'skills'))
    writeSkillAt(join(bundle, 'skills', 'bundle-skill'), 'bundle-skill')
    // A non-skill folder inside skills/ is skipped.
    mkdirSync(join(bundle, 'skills', 'not-a-skill'))

    const list = await plugins.install(bundle)
    expect(list).toHaveLength(1)
    const plugin = list[0]!
    expect(plugin.sourceKind).toBe('folder')
    expect(plugin.source).toBe(bundle)
    expect(existsSync(join(plugin.folder, 'plugin.json'))).toBe(true)

    // Its bundled skill was imported, sourced to the plugin.
    const skill = f.repos.skills.getByName('bundle-skill')
    expect(skill?.source).toBe(`plugin:${plugin.name}`)
    expect(existsSync(join(f.base, SKILLS_DIR, 'bundle-skill', 'SKILL.md'))).toBe(true)

    // The non-skill folder was not imported.
    expect(f.repos.skills.getByName('not-a-skill')).toBeUndefined()

    // Reinstalling the same name replaces it, not duplicates.
    const list2 = await plugins.install(bundle)
    expect(list2).toHaveLength(1)
    expect(list2[0]!.id).toBe(plugin.id)
  })

  it('installs a GitHub repo by running git clone and strips .git', async () => {
    const f = makeFixture()
    const runner = new FakeGitRunner()
    const plugins = new PluginsService({ repos: f.repos, dataDir: f.base, runner, skills: f.skills })

    // A fake git that hands back a bundle folder.
    const fakeRepo = join(f.base, 'fake-repo-src')
    mkdirSync(join(fakeRepo, 'skills'), { recursive: true })
    writeFileSync(join(fakeRepo, 'readme.md'), '# repo')
    writeSkillAt(join(fakeRepo, 'skills', 'repo-skill'), 'repo-skill')
    mkdirSync(join(fakeRepo, '.git')) // the fake repo "has" a .git the clone strips
    runner.source.set('digest', fakeRepo)

    const list = await plugins.install('https://github.com/owner/digest')
    expect(list).toHaveLength(1)
    const plugin = list[0]!
    expect(plugin.sourceKind).toBe('repo')
    expect(plugin.source).toBe('https://github.com/owner/digest')

    // git was invoked exactly once, non-interactively, shallow.
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.file).toBe('git')
    expect(runner.calls[0]!.args.join(' ')).toBe(`clone --depth 1 https://github.com/owner/digest ${plugin.folder}`)
    expect(plugin.folder).toBe(join(f.base, PLUGINS_DIR, 'digest'))

    // The clone exists and its .git was removed.
    expect(existsSync(join(plugin.folder, 'readme.md'))).toBe(true)
    expect(existsSync(join(plugin.folder, '.git'))).toBe(false)

    // The bundled skill came along.
    expect(f.repos.skills.getByName('repo-skill')?.source).toBe(`plugin:${plugin.name}`)
  })

  it('maps owner/repo to a GitHub URL', async () => {
    const f = makeFixture()
    const runner = new FakeGitRunner()
    const plugins = new PluginsService({ repos: f.repos, dataDir: f.base, runner, skills: f.skills })

    const repo = mkdtempSync(join(tmpdir(), 'dm-repo-'))
    writeFileSync(join(repo, 'readme.md'), '# news')
    runner.source.set('news', repo)
    await plugins.install('owner/news')
    expect(runner.calls[0]!.args).toContain('https://github.com/owner/news')
  })

  it('fails clearly for something that is neither a folder nor a repo', async () => {
    const f = makeFixture()
    const runner = new FakeGitRunner()
    const plugins = new PluginsService({ repos: f.repos, dataDir: f.base, runner, skills: f.skills })
    await expect(plugins.install(join(f.base, 'does-not-exist'))).rejects.toThrow('neither a folder')
  })

  it('removes the plugin folder and its record', async () => {
    const f = makeFixture()
    const plugins = new PluginsService({
      repos: f.repos,
      dataDir: f.base,
      runner: new FakeGitRunner(),
      skills: f.skills
    })
    const bundle = mkdtempSync(join(tmpdir(), 'dm-bundle-'))
    writeFileSync(join(bundle, 'plugin.json'), '{}')
    const [plugin] = await plugins.install(bundle)

    const list = plugins.remove(plugin.id)
    expect(list).toEqual([])
    expect(existsSync(plugin.folder)).toBe(false)
  })
})

describe('load_skill tool', () => {
  it('returns the skill instructions and files', async () => {
    const f = makeFixture()
    const src = writeSkill('polish')
    f.skills.import(src)

    const tools = skillsTools(f.skills)
    const result = (await tools['load_skill']!.execute!({ name: 'polish' } as never, { signal: undefined } as never)) as {
      name: string
      instructions: string
      files: string[]
    }
    expect(result.name).toBe('polish')
    expect(result.instructions).toContain('# polish')
    expect(result.files.sort()).toEqual(['SKILL.md', 'helper.txt'])
  })

  it('throws for an unknown skill', async () => {
    const f = makeFixture()
    const tools = skillsTools(f.skills)
    await expect(tools['load_skill']!.execute!({ name: 'missing' } as never, { signal: undefined } as never)).rejects.toThrow('No skill named')
  })
})

describe('skills and plugins RPC handlers', () => {
  it('answer with SKILLS_NOT_SET_UP before the services are wired', () => {
    const base = mkdtempSync(join(tmpdir(), 'deskmates-handlers-'))
    const db = openDatabase(':memory:')
    const repos = createRepos(db)
    const bus = new EventBus()
    const keys = new KeyStore()
    const modelService = new ModelService(keys, () => repos.settings.get())
    const changes = new ChangeLog(repos.changes, join(base, 'snapshots'))
    // No runner needed for skills.* paths; handlers run without touching the model.
    const api = createHandlers({ repos, bus, runner: {} as never, changes, models: modelService, keys, version: '0.1.0', dataDir: base }) as unknown as TestApi
    expect(() => api['skills.list']({})).toThrow("Skills and plugins aren't set up on this computer yet.")
    expect(() => api['plugins.list']({})).toThrow("Skills and plugins aren't set up on this computer yet.")
    db.close()
    rmSync(base, { recursive: true, force: true })
  })

  it('wire up: import/setEnabled/remove emit skills.updated; install emits plugins.updated and skills.updated', async () => {
    const f = makeFixture()
    const runner = new FakeGitRunner()
    const plugins = new PluginsService({ repos: f.repos, dataDir: f.base, runner, skills: f.skills })
    const bus = new EventBus()
    const events: CoreEvent[] = []
    bus.on((event) => events.push(event))
    const keys = new KeyStore()
    const modelService = new ModelService(keys, () => f.repos.settings.get())
    const changes = new ChangeLog(f.repos.changes, join(f.base, 'snapshots'))
    const api = createHandlers({
      repos: f.repos,
      bus,
      runner: {} as never,
      changes,
      models: modelService,
      keys,
      version: '0.1.0',
      dataDir: f.base,
      skills: f.skills,
      plugins
    }) as unknown as TestApi

    const src = writeSkill('demo-skill')
    const imported = await api['skills.import']({ folder: src })
    expect(imported).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'skills.updated' })

    const bundle = mkdtempSync(join(tmpdir(), 'dm-bundle-'))
    writeFileSync(join(bundle, 'plugin.json'), '{}')
    mkdirSync(join(bundle, 'skills'))
    writeSkillAt(join(bundle, 'skills', 'bundled'), 'bundled')

    const installed = await api['plugins.install']({ source: bundle })
    expect(installed).toHaveLength(1)
    expect(events.some((e) => e.type === 'plugins.updated')).toBe(true)
    expect(events.some((e) => e.type === 'skills.updated')).toBe(true)

    const removed = await api['plugins.remove']({ id: installed[0].id })
    expect(removed).toEqual([])
  })
})
describe('skill descriptions', () => {
  it('reads plain, quoted and folded descriptions from the front matter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-desc-'))
    const write = (name: string, body: string): string => {
      const file = join(dir, `${name}.md`)
      writeFileSync(file, body)
      return file
    }
    expect(skillDescription(write('a', '---\nname: a\ndescription: Does A things.\n---\n# A'))).toBe('Does A things.')
    expect(skillDescription(write('b', '---\nname: b\ndescription: "Quoted: B"\n---\n'))).toBe('Quoted: B')
    expect(skillDescription(write('c', '---\nname: c\ndescription: >\n  Folded over\n  two lines\nother: x\n---\n'))).toBe('Folded over two lines')
    expect(skillDescription(write('d', '# no front matter'))).toBeNull()
    expect(skillDescription(write('e', `---\ndescription: ${'x'.repeat(300)}\n---`))?.length).toBe(160)
    rmSync(dir, { recursive: true, force: true })
  })
})
