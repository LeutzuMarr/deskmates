import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner, RunOptions } from '../../src/core/bots/command-runner'
import { LinuxDesktop, keysym } from '../../src/core/computer/linux-desktop'

interface RunCall {
  file: string
  args: string[]
}

/** Records every command and answers `xdotool getdisplaygeometry` and the capture tools. */
class FakeRunner implements CommandRunner {
  readonly calls: RunCall[] = []
  geometry = '1920 1080'
  missing = new Set<string>()

  async run(file: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ file, args })
    if (this.missing.has(file)) return { code: 127, stdout: '', stderr: `${file}: not found` }
    if (args[0] === 'getdisplaygeometry') return { code: 0, stdout: `${this.geometry}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

/** Answers with the same JPEG whatever path the capture tool was asked to write, and remembers the paths. */
function desktop(runner: FakeRunner, env: Record<string, string | undefined> = { DISPLAY: ':0' }): {
  desktop: LinuxDesktop
  read: string[]
  removed: string[]
} {
  const read: string[] = []
  const removed: string[] = []
  return {
    desktop: new LinuxDesktop({
      runner,
      env,
      readFile: (path) => {
        read.push(path)
        return Buffer.from('not-a-real-jpeg')
      },
      removeFile: (path) => removed.push(path),
      now: () => 0
    }),
    read,
    removed
  }
}

describe('keysym', () => {
  it('translates the Windows key names the model sends into X11 keysyms', () => {
    expect(keysym('enter')).toBe('Return')
    expect(keysym('esc')).toBe('Escape')
    expect(keysym('pageup')).toBe('Prior')
    expect(keysym('win')).toBe('super')
    expect(keysym('f12')).toBe('12')
    expect(keysym('a')).toBe('a')
  })

  it('rejects a key it does not know', () => {
    expect(() => keysym('meta-ish')).toThrow(/Unknown key/)
  })
})

describe('LinuxDesktop.check', () => {
  it('passes on an X11 session with xdotool', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await expect(linux.check()).resolves.toBeUndefined()
  })

  it('explains Wayland instead of silently failing', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' })
    await expect(linux.check()).rejects.toThrow(/Wayland/)
  })

  it('names the package to install when xdotool is missing', async () => {
    const runner = new FakeRunner()
    runner.missing.add('xdotool')
    const { desktop: linux } = desktop(runner)
    await expect(linux.check()).rejects.toThrow(/xdotool/)
  })
})

describe('LinuxDesktop.screenshot', () => {
  it('scales to the requested width and reports the real screen size', async () => {
    const runner = new FakeRunner()
    const { desktop: linux, read, removed } = desktop(runner)
    const shot = await linux.screenshot(1280)
    expect(shot.screenWidth).toBe(1920)
    expect(shot.screenHeight).toBe(1080)
    expect(shot.width).toBe(1280)
    expect(shot.height).toBe(720)
    expect(Buffer.from(shot.data, 'base64').toString()).toBe('not-a-real-jpeg')
    // The temporary file is removed once it has been read.
    expect(read).toHaveLength(1)
    expect(removed).toEqual(read)
  })

  it('keeps the full size when the screen is narrower than the request', async () => {
    const runner = new FakeRunner()
    runner.geometry = '1024 768'
    const { desktop: linux } = desktop(runner)
    const shot = await linux.screenshot(1280)
    expect(shot.width).toBe(1024)
    expect(shot.height).toBe(768)
  })

  it('falls back through the capture tools and explains when none is installed', async () => {
    const runner = new FakeRunner()
    runner.missing.add('import')
    runner.missing.add('scrot')
    runner.missing.add('gnome-screenshot')
    const { desktop: linux } = desktop(runner)
    await expect(linux.screenshot(1280)).rejects.toThrow(/imagemagick/)
    expect(runner.calls.map((call) => call.file)).toEqual(['xdotool', 'import', 'scrot', 'gnome-screenshot'])
  })

  it('asks xdotool for the geometry only once per session', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await linux.screenshot(1280)
    await linux.screenshot(1280)
    expect(runner.calls.filter((call) => call.args[0] === 'getdisplaygeometry')).toHaveLength(1)
  })
})

describe('LinuxDesktop input', () => {
  it('clicks with the button and repeat count for the action', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await linux.click(10, 20, 'right', 2)
    expect(runner.calls.at(-1)?.args).toEqual(['mousemove', '10', '20', 'click', '--repeat', '2', '--delay', '60', '3'])
  })

  it('presses and releases around a stepped drag so it is not read as a click', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await linux.drag(0, 0, 100, 50)
    const args = runner.calls.map((call) => call.args)
    expect(args[0]).toEqual(['mousemove', '0', '0', 'mousedown', '1'])
    expect(args.at(-2)).toEqual(['mousemove', '100', '50'])
    expect(args.at(-1)).toEqual(['mouseup', '1'])
    // Twelve intermediate positions, so the pointer moves instead of teleporting.
    expect(args.filter((command) => command.length === 3 && command[0] === 'mousemove')).toHaveLength(12)
  })

  it('scrolls down with button 5 and up with button 4, capped at 20 notches', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await linux.scroll(5, 5, 3)
    expect(runner.calls.at(-1)?.args).toContain('5')
    await linux.scroll(5, 5, -99)
    expect(runner.calls.at(-1)?.args).toContain('20')
    expect(runner.calls.at(-1)?.args).toContain('4')
  })

  it('turns a newline into Return and clears modifiers before typing', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await linux.type('first\nsecond')
    expect(runner.calls.at(-1)?.args).toEqual(['type', '--delay', '12', '--clearmodifiers', 'firstReturnsecond'])
  })

  it('maps a key combo to a keysym chain', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await linux.key('ctrl+shift+T')
    expect(runner.calls.at(-1)?.args).toEqual(['key', '--clearmodifiers', 'ctrl+shift+t'])
  })

  it('rejects an unknown key before running anything', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await expect(linux.key('nope+ctrl')).rejects.toThrow(/Unknown key/)
  })

  it('reports xdotool failures with its own message', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    runner.missing.add('xdotool')
    await expect(linux.move(1, 2)).rejects.toThrow(/not found/)
  })
})

describe('LinuxDesktop.openUrl', () => {
  it('refuses anything that is not a web address', async () => {
    const runner = new FakeRunner()
    const { desktop: linux } = desktop(runner)
    await expect(linux.openUrl('file:///etc/passwd')).rejects.toThrow(/Only web addresses/)
  })
})