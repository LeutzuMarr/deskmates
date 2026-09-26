import { describe, expect, it } from 'vitest'
import {
  buildPrimer,
  isContextReset,
  isReadyLine,
  OnboardingTracker
} from '../../src/core/agents/onboarding'

const PHRASE = 'KETTLE-CEDAR-42'
const READY_LINE = `DESKMATES READY ${PHRASE}`

describe('buildPrimer', () => {
  it('is exactly one line and names the guide path', () => {
    const primer = buildPrimer({ guidePath: 'D:\\DeskmatesData\\agent-kit\\DESKMATES-AGENTS.md' })
    expect(primer).not.toMatch(/\r|\n/)
    expect(primer).toContain('D:\\DeskmatesData\\agent-kit\\DESKMATES-AGENTS.md')
    expect(primer).toContain('check-in')
  })

  it('never contains the phrase or the ready line', () => {
    const primer = buildPrimer({ guidePath: 'D:\\guide.md' })
    expect(primer).not.toContain(PHRASE)
    expect(primer).not.toContain(READY_LINE)
  })

  it('with a prompt path, stays one line, names the prompt file and never leaks the phrase', () => {
    const primer = buildPrimer({
      guidePath: 'D:\\DeskmatesData\\agent-kit\\DESKMATES-AGENTS.md',
      promptPath: 'D:\\DeskmatesData\\prompts\\claude-code\\claude-code-opus-5.5.md'
    })
    expect(primer).not.toMatch(/\r|\n/)
    expect(primer).toContain('D:\\DeskmatesData\\prompts\\claude-code\\claude-code-opus-5.5.md')
    expect(primer).toContain('check-in')
    expect(primer).toContain('read the guide at')
    expect(primer).not.toContain(PHRASE)
    expect(primer).not.toContain(READY_LINE)
  })
})

describe('isReadyLine', () => {
  it('accepts the plain line', () => {
    expect(isReadyLine(READY_LINE, PHRASE)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isReadyLine(`deskmates ready ${PHRASE.toLowerCase()}`, PHRASE)).toBe(true)
  })

  it('accepts the line wrapped in ANSI escape codes', () => {
    expect(isReadyLine(`\u001b[1m\u001b[32mDESKMATES\u001b[0m READY ${PHRASE}\u001b[0m`, PHRASE)).toBe(true)
  })

  it('accepts the line framed with box-drawing characters', () => {
    expect(isReadyLine(`\u250c\u2500\u2500 DESKMATES \u2500 READY \u2500 ${PHRASE} \u2500\u2500\u2510`, PHRASE)).toBe(true)
  })

  it('accepts the line in markdown bold and backticks', () => {
    expect(isReadyLine(`\`**DESKMATES** READY ${PHRASE}\``, PHRASE)).toBe(true)
  })

  it('accepts surrounding screen text', () => {
    expect(isReadyLine(`> Thinking...\n${READY_LINE}\n> Ready for input`, PHRASE)).toBe(true)
  })

  it('rejects a wrong phrase', () => {
    expect(isReadyLine('DESKMATES READY RIVER-GOURD-11', PHRASE)).toBe(false)
  })

  it('rejects a partial line', () => {
    expect(isReadyLine('DESKMATES READY KETTLE-CEDAR', PHRASE)).toBe(false)
    expect(isReadyLine('DESKMATES READY', PHRASE)).toBe(false)
    expect(isReadyLine(READY_LINE.slice(0, READY_LINE.length - 3), PHRASE)).toBe(false)
  })

  it('rejects unrelated text', () => {
    expect(isReadyLine('The guide explains the Design tab.', PHRASE)).toBe(false)
  })
})

describe('isContextReset', () => {
  it('accepts /new, /clear and /reset, with or without arguments', () => {
    expect(isContextReset('/new')).toBe(true)
    expect(isContextReset('/clear')).toBe(true)
    expect(isContextReset('/reset all')).toBe(true)
    expect(isContextReset('  /new \n')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isContextReset('/newyear')).toBe(false)
    expect(isContextReset('please /new')).toBe(false)
    expect(isContextReset('/renew')).toBe(false)
    expect(isContextReset('fix the bug')).toBe(false)
  })
})
describe('OnboardingTracker', () => {
  it('starts unknown and needs a primer', () => {
    const tracker = new OnboardingTracker()
    expect(tracker.state('a')).toBe('unknown')
    expect(tracker.needsPrimer('a', 'v1')).toBe(true)
  })

  it('goes unknown -> primed -> confirmed on the ready line', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    expect(tracker.state('a')).toBe('primed')
    expect(tracker.needsPrimer('a', 'v1')).toBe(false)
    expect(tracker.observe('a', `noise\n${READY_LINE}`, PHRASE, 2000)).toBe('confirmed')
    expect(tracker.state('a')).toBe('confirmed')
    expect(tracker.needsPrimer('a', 'v1')).toBe(false)
  })

  it('stays primed on other text within the timeout', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    expect(tracker.observe('a', 'I read the guide.', PHRASE, 30_000)).toBe('primed')
    expect(tracker.state('a')).toBe('primed')
  })

  it('fails when the timeout passes without the line', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    expect(tracker.observe('a', 'Still thinking...', PHRASE, 1000 + 90_001)).toBe('failed')
    expect(tracker.state('a')).toBe('failed')
    expect(tracker.needsPrimer('a', 'v1')).toBe(true)
  })

  it('uses the configured timeout', () => {
    const tracker = new OnboardingTracker({ timeoutMs: 100 })
    tracker.markPrimed('a', 'v1', 1000)
    expect(tracker.observe('a', '...', PHRASE, 1099)).toBe('primed')
    expect(tracker.observe('a', '...', PHRASE, 1101)).toBe('failed')
  })

  it('asks for the primer again when the guide version changes', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    tracker.observe('a', READY_LINE, PHRASE, 2000)
    expect(tracker.needsPrimer('a', 'v2')).toBe(true)
  })

  it('returns to unknown on a context reset', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    tracker.noteUserInput('a', '/new')
    expect(tracker.state('a')).toBe('unknown')
    expect(tracker.needsPrimer('a', 'v1')).toBe(true)
  })

  it('ignores ordinary user input', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    tracker.noteUserInput('a', 'also add a footer')
    expect(tracker.state('a')).toBe('primed')
  })

  it('forgets a session on disconnect', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    tracker.disconnect('a')
    expect(tracker.state('a')).toBe('unknown')
    expect(tracker.needsPrimer('a', 'v1')).toBe(true)
  })

  it('keeps sessions apart', () => {
    const tracker = new OnboardingTracker()
    tracker.markPrimed('a', 'v1', 1000)
    tracker.markPrimed('b', 'v1', 1000)
    tracker.observe('a', READY_LINE, PHRASE, 2000)
    expect(tracker.state('a')).toBe('confirmed')
    expect(tracker.state('b')).toBe('primed')
  })
})

