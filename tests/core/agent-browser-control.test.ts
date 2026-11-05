import { describe, expect, it } from 'vitest'
import { ControlState } from '../../src/main/browser-control'

describe('agent browser control', () => {
  it('user input hands control to the user', () => {
    const control = new ControlState()
    expect(control.controller).toBe('agent')
    expect(control.canAgentAct()).toBe(true)
    expect(control.userInput()).toBe(true)
    expect(control.canAgentAct()).toBe(false)
    // A second touch changes nothing.
    expect(control.userInput()).toBe(false)
    expect(control.handBack()).toBe(true)
    expect(control.canAgentAct()).toBe(true)
    expect(control.handBack()).toBe(false)
  })
})
