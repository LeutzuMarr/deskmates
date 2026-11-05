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
})
