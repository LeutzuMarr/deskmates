import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOCK_SCRIPT, injectClock } from '../../src/main/video-clock'
import { SkillsService } from '../../src/core/extensions/skills'
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'

describe('injectClock', () => {
  it('runs before the page scripts but keeps the doctype first', () => {
    const html = injectClock('<!doctype html><html><head><script src="motion-stage.js"></script></head><body></body></html>')
    expect(html.startsWith('<!doctype html><html><head><script>')).toBe(true)
    expect(html.indexOf('__dmTime')).toBeLessThan(html.indexOf('motion-stage.js'))
    expect(injectClock('<p>bare</p>').startsWith('<script>')).toBe(true)
    expect(() => new Function(CLOCK_SCRIPT)).not.toThrow()
  })
})

describe('built-in skills', () => {
  it('serves animated-video by any of the names the design prompt uses, and lists it', () => {
    const repos = createRepos(openDatabase(':memory:'))
    const skills = new SkillsService({ repos, dataDir: mkdtempSync(join(tmpdir(), 'dm-skill-')) })
    for (const name of ['animated-video', 'Animated video', 'skills/animated-video/SKILL.md']) {
      expect(skills.load(name)?.instructions).toContain('<motion-stage')
    }
    expect(skills.catalog().some((line) => line.startsWith('animated-video: Timeline-based motion design'))).toBe(true)
    expect(skills.load('no-such-skill')).toBeNull()
  })
})
