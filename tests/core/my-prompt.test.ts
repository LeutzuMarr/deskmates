import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMyPrompt, myPromptBrief, myPromptSection } from '../../src/core/engine/my-prompt'

function promptFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dm-prompt-'))
  mkdirSync(join(dir, 'my-prompt'))
  const path = join(dir, 'my-prompt', 'my-prompt.md')
  writeFileSync(path, text)
  return path
}

const SAMPLE = ['# behavior', 'Be kind.', '## tone', 'Short.', '# memory', 'Remember things.', '```', '# not a heading', '```', '# tools', 'Big list.'].join('\n')

describe("the user's own prompt", () => {
  it('splits sections, skipping headings inside code blocks', () => {
    const loaded = loadMyPrompt(promptFile(SAMPLE))!
    expect(loaded.sections.map((s) => s.title)).toEqual(['behavior', 'memory', 'tools'])
  })

  it('gives the first section in full and an index of the rest', () => {
    const path = promptFile(SAMPLE)
    const brief = myPromptBrief('tool', path)!
    expect(brief).toContain('Be kind.')
    expect(brief).toContain('## tone')
    expect(brief).not.toContain('Remember things.')
    expect(brief).toContain('- memory')
    expect(brief).toContain('read_prompt_section')
    expect(myPromptBrief('file', path)).toMatch(/- memory \(lines 5–9\)/)
  })

  it('reads one section by name', () => {
    const path = promptFile(SAMPLE)
    expect(myPromptSection('memory', path)).toContain('Remember things.')
    expect(myPromptSection('# Tools', path)).toBe('# tools\nBig list.')
    expect(myPromptSection('nothing', path)).toBeNull()
  })

  it('is missing gracefully', () => {
    expect(myPromptBrief('tool', join(tmpdir(), 'no-such-prompt.md'))).toBeNull()
  })
})
