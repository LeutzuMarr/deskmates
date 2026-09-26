import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentKitDir, buildAgentGuide, guidePhrase, guideVersion, writeAgentGuide, PHRASE_WORDS } from '../../src/core/agents/guide'

const DATA_DIR = 'D:\\DeskmatesData'
const COMMAND_PATH = join(DATA_DIR, 'agent-kit', 'deskmates.cmd')
const BASE_INPUT = { dataDir: DATA_DIR, commandPath: COMMAND_PATH, appVersion: '0.1.0', pcs: { installed: false } as const }

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deskmates-guide-'))
  tempDirs.push(dir)
  return dir
}

/** Removes the phrase line, as the version hash input is defined. */
function withoutPhraseLine(markdown: string): string {
  return markdown.replace(/^Check phrase: .*\n/m, '')
}

describe('buildAgentGuide', () => {
  const guide = buildAgentGuide(BASE_INPUT)

  it('has every section', () => {
    for (const heading of [
      '# Deskmates guide for coding agents',
      '## Check-in',
      '## The deskmates command',
      '## Designs (the Design tab)',
      '## Bot PCs',
      '## Good to know'
    ]) {
      expect(guide.markdown).toContain(heading)
    }
  })

  it('shows the version and the app version', () => {
    expect(guide.markdown).toContain(guide.version)
    expect(guide.markdown).toContain('Deskmates app version: 0.1.0')
  })

  it('shows the paths', () => {
    expect(guide.markdown).toContain(COMMAND_PATH)
    expect(guide.markdown).toContain(DATA_DIR)
    expect(guide.markdown).toContain(join(DATA_DIR, 'designs'))
  })

  it('lists the commands the guide promises', () => {
    for (const command of [
      'design list', 'design path', 'design read', 'design write', 'design create',
      'pc list', 'pc exec', 'pc open', 'pc screenshot', 'mcp', '--json'
    ]) {
      expect(guide.markdown).toContain(command)
    }
  })

  it('carries the design rules', () => {
    expect(guide.markdown).toContain('data-dm-id')
    expect(guide.markdown).toContain('1440')
    expect(guide.markdown).toContain('834')
    expect(guide.markdown).toContain('390')
  })

  it('tells the agent to read the whole guide', () => {
    expect(guide.markdown.toLowerCase()).toContain('read all of it')
  })

  it('adds the operating prompt section only when a path is given', () => {
    const withPrompt = buildAgentGuide({
      ...BASE_INPUT,
      operatingPromptPath: join(DATA_DIR, 'prompts', 'claude-code', 'claude-code-opus-5.5.md')
    })
    expect(withPrompt.markdown).toContain('## Your operating instructions')
    expect(withPrompt.markdown).toContain(join(DATA_DIR, 'prompts', 'claude-code', 'claude-code-opus-5.5.md'))
    expect(withPrompt.version).not.toBe(guide.version) // new section changes the hash
    expect(guide.markdown).not.toContain('## Your operating instructions')
  })
})

describe('the bot PC section', () => {
  it('says the PCs aren\u2019t set up when they aren\u2019t', () => {
    const guide = buildAgentGuide(BASE_INPUT)
    expect(guide.markdown).toContain("Bot PCs aren't set up on this computer yet")
    expect(guide.markdown).toContain('Set up bot PCs')
    expect(guide.markdown).toContain('WSL')
  })

  it('describes the shared PC and the shared folder when installed', () => {
    const guide = buildAgentGuide({ ...BASE_INPUT, pcs: { installed: true, mode: 'shared', sharedFolder: join(DATA_DIR, 'shared') } })
    expect(guide.markdown).toContain('All bots share one PC')
    expect(guide.markdown).toContain(join(DATA_DIR, 'shared'))
    expect(guide.markdown).toContain('/shared')
    expect(guide.markdown).toContain('Take over')
    expect(guide.markdown).not.toContain("aren't set up")
  })

  it('describes the own-PC mode differently', () => {
    const guide = buildAgentGuide({ ...BASE_INPUT, pcs: { installed: true, mode: 'own', sharedFolder: join(DATA_DIR, 'shared') } })
    expect(guide.markdown).toContain('its own PC')
    expect(guide.markdown).not.toContain('All bots share one PC')
  })
})

describe('the version and phrase', () => {
  const guide = buildAgentGuide(BASE_INPUT)

  it('is stable for the same input', () => {
    const again = buildAgentGuide(BASE_INPUT)
    expect(again.version).toBe(guide.version)
    expect(again.phrase).toBe(guide.phrase)
  })

  it('changes when the input changes', () => {
    const other = buildAgentGuide({ ...BASE_INPUT, appVersion: '0.2.0' })
    expect(other.version).not.toBe(guide.version)
    expect(other.phrase).not.toBe(guide.phrase)
    const otherPcMode = buildAgentGuide({ ...BASE_INPUT, pcs: { installed: true, mode: 'own', sharedFolder: 'x' } })
    expect(otherPcMode.version).not.toBe(guide.version)
  })

  it('is the first 8 hex characters of the SHA-256 over the text without its phrase line', () => {
    expect(guide.version).toMatch(/^[0-9a-f]{8}$/)
    expect(guideVersion(withoutPhraseLine(guide.markdown))).toBe(guide.version)
  })

  it('derives the phrase from the same hash', () => {
    expect(guidePhrase(guide.version)).toBe(guide.phrase)
  })

  it('has the phrase format: two listed words and a number from 10 to 99', () => {
    expect(guide.phrase).toMatch(/^[A-Z]+-[A-Z]+-(10|[1-9][0-9])$/)
    const [first, second] = guide.phrase.split('-')
    expect(PHRASE_WORDS).toContain(first)
    expect(PHRASE_WORDS).toContain(second)
  })

  it('marks the phrase line in the guide', () => {
    expect(guide.markdown).toContain(`Check phrase: ${guide.phrase}`)
  })

  it('never contains the full ready line', () => {
    const readyLine = `DESKMATES READY ${guide.phrase}`
    expect(guide.markdown).not.toContain(readyLine)
    expect(guide.markdown.toLowerCase()).not.toContain(readyLine.toLowerCase())
  })
})

describe('writeAgentGuide', () => {
  it('writes the guide and returns its path', () => {
    const dir = makeTempDir()
    const result = writeAgentGuide({ ...BASE_INPUT, dataDir: dir })
    expect(result.path).toBe(join(agentKitDir(dir), 'DESKMATES-AGENTS.md'))
    expect(readFileSync(result.path, 'utf8')).toBe(result.markdown)
  })

  it('creates the agent-kit folder when missing', () => {
    const dir = makeTempDir()
    const result = writeAgentGuide({ ...BASE_INPUT, dataDir: dir })
    expect(statSync(result.path).isFile()).toBe(true)
  })

  it('does not rewrite an unchanged file', () => {
    const dir = makeTempDir()
    const first = writeAgentGuide({ ...BASE_INPUT, dataDir: dir })
    // Push the mtime far into the past; a rewrite would bump it to now.
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(first.path, past, past)
    const second = writeAgentGuide({ ...BASE_INPUT, dataDir: dir })
    const mtime = statSync(second.path).mtimeMs
    expect(mtime).toBeLessThan(Date.now() - 3_000_000)
    expect(second.version).toBe(first.version)
  })

  it('rewrites when the content changes', () => {
    const dir = makeTempDir()
    writeAgentGuide({ ...BASE_INPUT, dataDir: dir })
    const changed = writeAgentGuide({ ...BASE_INPUT, dataDir: dir, appVersion: '9.9.9' })
    expect(statSync(changed.path).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })
})
