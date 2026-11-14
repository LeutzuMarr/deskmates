import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../../src/core/bots/command-runner'
import type { Desktop } from '../../src/core/computer/desktop'
import { ScreenGuideService, toPhysical, validMark } from '../../src/core/screen/guide'
import type { ScreenMark } from '../../src/shared/protocol'

function fakeDesktop(screenWidth = 2560, width = 1280): Desktop {
  return {
    screenshot: async () => ({ data: 'QUJD', width, height: 720, screenWidth, screenHeight: 1440 }),
    move: async () => undefined,
    click: async () => undefined,
    drag: async () => undefined,
    scroll: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    openUrl: async () => undefined,
    close: () => undefined
  }
}

function setup(runner?: CommandRunner) {
  const shown: Array<{ marks: ScreenMark[]; seconds: number }> = []
  const runs: Array<{ file: string; args: string[]; env?: Record<string, string> }> = []
  const guide = new ScreenGuideService({
    createDesktop: () => fakeDesktop(),
    runner: runner ?? {
      run: async (file, args, options) => {
        runs.push({ file, args, env: options?.env })
        return { code: 0, stdout: '', stderr: '' }
      }
    },
    showOverlay: (marks, seconds) => shown.push({ marks, seconds }),
    platform: 'win32'
  })
  return { guide, shown, runs }
}

describe('ScreenGuideService', () => {
  it('scales marks from screenshot pixels to physical pixels after a look', async () => {
    const { guide, shown } = setup()
    const look = await guide.look()
    expect(look).toEqual({ data: 'QUJD', width: 1280, height: 720 })
    guide.point([{ kind: 'box', x: 100, y: 50, width: 40, height: 20, text: 'Save' }])
    expect(shown).toEqual([{ marks: [{ kind: 'box', x: 200, y: 100, width: 80, height: 40, text: 'Save' }], seconds: 8 }])
  })

  it('clamps the duration and clears with an empty list', () => {
    const { guide, shown } = setup()
    guide.point([{ kind: 'arrow', x: 1, y: 1 }], 999)
    guide.clear()
    expect(shown[0].seconds).toBe(60)
    expect(shown[1]).toEqual({ marks: [], seconds: 0 })
  })

  it('says text through the system voice, passing it in an environment variable', async () => {
    const { guide, runs } = setup()
    await guide.say('Click "Save" & done')
    expect(runs[0].file).toBe('powershell.exe')
    expect(runs[0].args.join(' ')).not.toContain('Save')
    expect(runs[0].env).toEqual({ DM_SAY_TEXT: 'Click "Save" & done' })
  })

  it('reports a failed speech run', async () => {
    const { guide } = setup({ run: async () => ({ code: 1, stdout: '', stderr: 'no voice' }) })
    await expect(guide.say('hi')).rejects.toThrow('no voice')
  })
})

describe('validMark', () => {
  it('rejects marks the overlay cannot draw', () => {
    expect(() => validMark({ kind: 'star' as ScreenMark['kind'], x: 1, y: 1 })).toThrow('kind')
    expect(() => validMark({ kind: 'circle', x: 1, y: 1 })).toThrow('width and height')
    expect(() => validMark({ kind: 'label', x: 1, y: 1 })).toThrow('text')
    expect(() => validMark({ kind: 'arrow', x: Number.NaN, y: 1 })).toThrow('numeric')
  })

  it('rounds when scaling', () => {
    expect(toPhysical({ kind: 'arrow', x: 10.4, y: 3 }, 1.5)).toEqual({ kind: 'arrow', x: 16, y: 5 })
  })
})
