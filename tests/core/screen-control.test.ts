import { beforeEach, describe, expect, it, vi } from 'vitest'

const elementsState = { list: [] as Array<{ type: string; name: string; x: number; y: number; w: number; h: number; password?: boolean }>, focusedPassword: false }
vi.mock('../../src/core/computer/elements', async (original) => {
  const real = await original<typeof import('../../src/core/computer/elements')>()
  return { ...real, listElements: async () => elementsState.list, focusedIsPassword: async () => elementsState.focusedPassword }
})

import { ScreenControl, screenControlTools } from '../../src/core/tools/screen-control'
import { approvalFor } from '../../src/core/engine/approvals'
import type { Desktop } from '../../src/core/computer/desktop'

function fakeDesktop() {
  const calls: string[] = []
  const desktop: Desktop = {
    // A 2560-wide screen shown as a 1280-wide screenshot: half scale.
    screenshot: async () => ({ data: 'AAAA', width: 1280, height: 720, screenWidth: 2560, screenHeight: 1440 }),
    move: async (x, y) => void calls.push(`move ${x},${y}`),
    click: async (x, y, button, count) => void calls.push(`click ${x},${y} ${button} x${count}`),
    drag: async () => void calls.push('drag'),
    scroll: async () => void calls.push('scroll'),
    type: async (text) => void calls.push(`type ${text}`),
    key: async (combo) => void calls.push(`key ${combo}`),
    openUrl: async (url) => void calls.push(`open ${url}`),
    close: () => undefined
  }
  return { desktop, calls }
}

function setup() {
  const { desktop, calls } = fakeDesktop()
  const active: boolean[] = []
  const control = new ScreenControl({ createDesktop: () => desktop, onActiveChange: (a) => active.push(a) })
  const tools = screenControlTools({ control, withImages: true, sleep: async () => undefined })
  const run = <T>(name: keyof typeof tools, input: T) =>
    (tools[name] as unknown as { execute: (i: T, o: unknown) => Promise<{ text: string; image?: string }> }).execute(input, { toolCallId: 'x', messages: [] })
  return { run, calls, active, control }
}

describe('screen control tools', () => {
  beforeEach(() => {
    elementsState.list = [{ type: 'Button', name: 'Save', x: 1000, y: 400, w: 200, h: 80 }]
    elementsState.focusedPassword = false
  })

  it('screen_act needs the user’s approval, screen_look does not', () => {
    expect(approvalFor('screen_act', [])).toBe('user-approval')
    expect(approvalFor('screen_act', ['screen_act'])).toBe('approved')
    expect(approvalFor('screen_look', [])).toBeUndefined()
  })

  it('look lists elements in screenshot pixels', async () => {
    const { run } = setup()
    const out = await run('screen_look', {})
    expect(out.text).toContain('[1] Button "Save" at (550, 220)')
    expect(out.image).toBe('AAAA')
  })

  it('clicking an element hits its centre on the real screen', async () => {
    const { run, calls, active } = setup()
    await run('screen_look', {})
    const out = await run('screen_act', { action: 'click', element: 1 })
    expect(calls).toContain('click 1100,440 left x1')
    expect(out.text).toContain('Did: click')
    expect(active).toEqual([true])
  })

  it('refuses to type into a password box', async () => {
    const { run, calls } = setup()
    elementsState.focusedPassword = true
    await expect(run('screen_act', { action: 'type', text: 'secret' })).rejects.toThrow(/password/)
    expect(calls.some((c) => c.startsWith('type'))).toBe(false)
  })

  it('after Stop nothing more happens', async () => {
    const { run, calls, control } = setup()
    control.stop()
    await expect(run('screen_act', { action: 'click', x: 10, y: 10 })).rejects.toThrow(/Stop/)
    expect(calls).toHaveLength(0)
  })

  it('an element that is not there is refused', async () => {
    const { run } = setup()
    await run('screen_look', {})
    await expect(run('screen_act', { action: 'click', element: 9 })).rejects.toThrow(/no element 9/)
  })
})
