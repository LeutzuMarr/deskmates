/**
 * PluginsService — spec 5.5. A plugin is a folder or a GitHub repo bundling skills (and, later,
 * connector configs, bot templates and schedule templates). Installing copies/clones it into
 * `<dataDir>/plugins/<name>` and pulls its bundled skill folders (each holding a SKILL.md) into
 * the skills library, so the user keeps the skills even after the plugin is removed.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Plugin } from '../../shared/protocol'
import type { CommandRunner } from '../bots/command-runner'
import type { PluginsRepo } from '../store/repos'
import type { SkillsService } from './skills'

export const PLUGINS_DIR = 'plugins'

export interface PluginsServiceDeps {
  repos: { plugins: PluginsRepo }
  /** The app's data folder, e.g. `D:\DeskmatesData`. Owns `<dataDir>/plugins/`. */
  dataDir: string
  runner: CommandRunner
  skills: SkillsService
}

export class PluginsService {
  private readonly pluginsDir: string

  constructor(private readonly deps: PluginsServiceDeps) {
    this.pluginsDir = join(deps.dataDir, PLUGINS_DIR)
  }

  list(): Plugin[] {
    return this.deps.repos.plugins.list()
  }

  async install(source: string): Promise<Plugin[]> {
    const { folder, sourceKind, url } = planInstall(source, this.pluginsDir)
    const name = basename(folder)
    mkdirSync(this.pluginsDir, { recursive: true })
    if (sourceKind === 'repo') {
      if (!url) throw new Error('That does not look like a GitHub repo (owner/repo).')
      await this.cloneRepo(url, folder)
    } else {
      this.copyFolder(source, folder)
    }
    const existing = this.deps.repos.plugins.getByName(name)
    if (existing) {
      this.deps.repos.plugins.update(existing.id, { folder, source, sourceKind })
    } else {
      this.deps.repos.plugins.create(name, folder, sourceKind, source)
    }
    this.importBundledSkills(folder, name)
    return this.list()
  }

  remove(id: string): Plugin[] {
    const plugin = this.deps.repos.plugins.require(id)
    if (existsSync(plugin.folder)) rmSync(plugin.folder, { recursive: true, force: true })
    this.deps.repos.plugins.delete(id)
    return this.list()
  }

  private async cloneRepo(url: string, folder: string): Promise<void> {
    const result = await this.deps.runner.run('git', ['clone', '--depth', '1', url, folder])
    if (result.code !== 0) throw new Error(`git clone failed (${result.code}): ${(result.stderr || result.stdout).trim()}`)
    // Drop the clone's `.git` so the installed plugin is a plain folder the user can edit.
    const gitDir = join(folder, '.git')
    if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true })
  }

  private copyFolder(source: string, folder: string): void {
    if (!existsSync(source)) throw new Error(`The folder does not exist: ${source}`)
    if (resolve(source) === resolve(folder)) return
    cpSync(source, folder, { recursive: true })
  }

  /**
   * Every bundle's `skills` subfolders (each with a SKILL.md) become usable skills, stored under
   * the skills library as source `plugin:<name>`. Runs after install and after a reinstall.
   */
  private importBundledSkills(pluginFolder: string, pluginName: string): void {
    const skillsRoot = join(pluginFolder, 'skills')
    if (!existsSync(skillsRoot)) return
    for (const entry of readdirSync(skillsRoot)) {
      const p = join(skillsRoot, entry)
      if (!statSync(p).isDirectory()) continue
      if (!existsSync(join(p, 'SKILL.md'))) continue
      this.deps.skills.importAs(entry, p, `plugin:${pluginName}`)
    }
  }
}

/** Decides how to install `source` and returns the target folder, kind and (for repos) the clone URL. */
function planInstall(
  source: string,
  pluginsDir: string
): { folder: string; sourceKind: 'folder' | 'repo'; url: string | null } {
  const trimmed = source.trim()
  if (isRepoUrl(trimmed)) {
    const name = repoName(trimmed)
    if (!name) throw new Error('That does not look like a GitHub repo (owner/repo).')
    return { folder: join(pluginsDir, name), sourceKind: 'repo', url: normalizeRepoUrl(trimmed) }
  }
  if (existsSync(trimmed)) {
    return { folder: join(pluginsDir, basename(trimmed)), sourceKind: 'folder', url: null }
  }
  throw new Error(`That is neither a folder on this computer nor a GitHub repo: ${trimmed}`)
}

/** `owner/repo`, `https://github.com/owner/repo`, `git@github.com:owner/repo.git`. */
function isRepoUrl(source: string): boolean {
  return /^(https?:\/\/)?(www\.)?github\.com\/[^/]+\/[^/\s]+/.test(source) || /^[^/\s]+\/[^/\s]+$/.test(source)
}

function normalizeRepoUrl(source: string): string {
  if (/^https?:\/\//.test(source)) return source.replace(/\.git$/i, '')
  if (/^git@/.test(source)) return source
  return `https://github.com/${source}`
}

/** The repo name: the last path segment of a repo source, without a trailing `.git`. */
function repoName(source: string): string {
  const last = source.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? ''
  return last.replace(/\.git$/i, '')
}