/**
 * SkillsService — spec 5.5. Skills use the open Agent Skills format: a folder holding a `SKILL.md`
 * plus whatever files it needs. Importing copies the folder into `<dataDir>/skills/<name>` and
 * records it; the assistant reads it through the `load_skill` tool.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Skill } from '../../shared/protocol'
import type { SkillsRepo } from '../store/repos'
import animatedVideo from './builtin/animated-video.md?raw'

export const SKILLS_DIR = 'skills'

/** Skills that ship with Deskmates, used when the library has none of that name. */
const BUILTIN_SKILLS: Record<string, string> = { 'animated-video': animatedVideo }

/** "Animated video", "animated_video" or "skills/animated-video/SKILL.md" → "animated-video". */
const builtinKey = (name: string): string =>
  name
    .trim()
    .replace(/\/?SKILL\.md$/i, '')
    .split('/')
    .pop()!
    .replace(/^.*:/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const frontMatterDescription = (text: string): string | null => /^---\r?\n[\s\S]*?^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null

/** The file that marks a folder as a skill (open Agent Skills format). */
const SKILL_MD = 'SKILL.md'

export interface SkillsServiceDeps {
  repos: { skills: SkillsRepo }
  /** The app's data folder, e.g. `D:\DeskmatesData`. Owns `<dataDir>/skills/`. */
  dataDir: string
}

export interface LoadedSkill {
  name: string
  /** The skill's folder (its `SKILL.md` plus any helper files). */
  folder: string
  /** Contents of the skill's `SKILL.md`. */
  instructions: string
  /** Paths of the skill's other files, relative to its folder. */
  files: string[]
}

export class SkillsService {
  private readonly skillsDir: string

  constructor(private readonly deps: SkillsServiceDeps) {
    this.skillsDir = join(deps.dataDir, SKILLS_DIR)
  }

  list(): Skill[] {
    return this.deps.repos.skills.list()
  }

  /** Imports one skill folder, or every skill folder inside a folder of skills (e.g. `~/.claude/skills`). */
  import(folder: string): Skill[] {
    if (existsSync(folder) && !existsSync(join(folder, SKILL_MD))) {
      const children = readdirSync(folder)
        .map((entry) => join(folder, entry))
        .filter((child) => statSync(child).isDirectory() && existsSync(join(child, SKILL_MD)))
      if (children.length > 0) {
        for (const child of children) this.importAs(basename(child), child, child)
        return this.list()
      }
    }
    return this.importAs(basename(folder), folder, folder)
  }

  /** Registers a skill, copying its folder into `<dataDir>/skills/<name>`. `source` says where it came from. */
  importAs(name: string, target: string, source: string): Skill[] {
    const nameOk = name.trim()
    if (!nameOk) throw new Error('The skill needs a name.')
    if (!existsSync(target)) throw new Error(`The folder does not exist: ${target}`)
    if (!existsSync(join(target, SKILL_MD))) throw new Error(`No SKILL.md found in ${target}.`)
    mkdirSync(this.skillsDir, { recursive: true })
    const finalDir = join(this.skillsDir, nameOk)
    // Skill folders are often junctions or symlinks (e.g. ~/.agents/skills); copy what they point to,
    // since recreating the link needs rights Windows only gives administrators.
    const real = realpathSync.native(target)
    if (resolve(real) !== resolve(finalDir)) {
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true })
      cpSync(real, finalDir, { recursive: true, dereference: true })
    }
    this.deps.repos.skills.updateFolder(nameOk, finalDir, source)
    return this.list()
  }

  setEnabled(id: string, enabled: boolean): Skill[] {
    this.deps.repos.skills.update(id, { enabled })
    return this.list()
  }

  remove(id: string): Skill[] {
    const skill = this.deps.repos.skills.require(id)
    if (existsSync(skill.folder)) rmSync(skill.folder, { recursive: true, force: true })
    this.deps.repos.skills.delete(id)
    return this.list()
  }

  /** Each enabled skill as "name: what it's for", for the assistant's instructions. */
  catalog(): string[] {
    const installed = this.list()
    const own = installed
      .filter((s) => s.enabled)
      .map((s) => {
        const about = skillDescription(join(s.folder, SKILL_MD))
        return about ? `${s.name}: ${about}` : s.name
      })
    const builtin = Object.entries(BUILTIN_SKILLS)
      .filter(([name]) => !installed.some((s) => s.name === name))
      .map(([name, text]) => {
        const about = frontMatterDescription(text)
        return about ? `${name}: ${about}` : name
      })
    return [...own, ...builtin].sort()
  }

  /** Reads a skill for the `load_skill` tool. Returns null when disabled or the folder is missing. */
  load(name: string): LoadedSkill | null {
    const skill = this.deps.repos.skills.getByName(name)
    if (!skill || !skill.enabled || !existsSync(skill.folder) || !existsSync(join(skill.folder, SKILL_MD))) {
      const key = builtinKey(name)
      const text = skill ? undefined : BUILTIN_SKILLS[key]
      return text ? { name: key, folder: '', instructions: text, files: [] } : null
    }
    return {
      name: skill.name,
      folder: skill.folder,
      instructions: readFileSync(join(skill.folder, SKILL_MD), 'utf8'),
      files: listFiles(skill.folder)
    }
  }
}

/** Recursively lists a folder's files (not directories), relative paths with forward slashes. */
function listFiles(folder: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const stat = statSync(p)
      const rel = prefix ? `${prefix}/${entry}` : entry
      if (stat.isDirectory()) walk(p, rel)
      else out.push(rel)
    }
  }
  walk(folder, '')
  return out
}

const MAX_DESCRIPTION_CHARS = 160

/** The `description` from a SKILL.md front matter (plain, quoted or folded), shortened to one line. */
export function skillDescription(file: string): string | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!front) return null
  const lines = front[1].split(/\r?\n/)
  const index = lines.findIndex((line) => /^description:/.test(line))
  if (index === -1) return null
  let value = lines[index].replace(/^description:\s*/, '')
  if (/^[|>][-+]?$/.test(value) || value === '') {
    const folded: string[] = []
    for (const line of lines.slice(index + 1)) {
      if (!/^\s/.test(line)) break
      folded.push(line.trim())
    }
    value = folded.join(' ')
  }
  value = value.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim()
  if (!value) return null
  return value.length > MAX_DESCRIPTION_CHARS ? `${value.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : value
}
