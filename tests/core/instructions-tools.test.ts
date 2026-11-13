import { describe, expect, it } from 'vitest'
import { deskmatesToolsGuide } from '../../src/core/engine/instructions'

describe('what agents are told about the app tools', () => {
  it('mentions cards, browser, screen control and schedules sections', () => {
    const work = deskmatesToolsGuide('work', false)
    expect(work).toContain('call AskUserQuestion')
    expect(work).toContain('browser_open')
    expect(work).toContain('Never type passwords')
    expect(work).toContain('screen_act')
    expect(work).toContain('schedule_create')
    expect(deskmatesToolsGuide('design', false)).toContain('call ask_user')
  })

  it('tells command-line agents to ask with a numbered list instead', () => {
    const cli = deskmatesToolsGuide('work', true)
    expect(cli).toContain('numbered list')
    expect(cli).not.toContain('browser_open')
  })

  it("tells command-line agents they are on the user's PC and how to reach the browser from the shell", () => {
    const cli = deskmatesToolsGuide('work', true, false, { command: 'C:\\kit\\deskmates.cmd', agentName: 'Daily Outreach' })
    expect(cli).toMatch(/not in a cloud workspace/)
    expect(cli).toContain('"C:\\kit\\deskmates.cmd" browser open <url> --as "Daily Outreach"')
    expect(cli).toMatch(/Never give up on a browser task by writing a report file/)
  })
})

describe('after a tab prompt', () => {
  it('adds only the tool names the prompt does not know, not a second set of asking rules', () => {
    const note = deskmatesToolsGuide('work', false, true)
    expect(note).toContain('not create_trigger')
    expect(note).toContain('not Claude in Chrome')
    expect(note).not.toContain('Asking the user')
  })
})
