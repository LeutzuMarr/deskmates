import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner, RunOptions } from '../../src/core/bots/command-runner'
import { LinuxAttachHelper, LinuxAttachHelperSpawner, keySequence } from '../../src/core/terminals/attach-linux'
import type { AttachEvent } from '../../src/core/terminals/attach'

/** Records what was typed, and answers tmux the way a real tmux server would. */
class FakeRunner implements CommandRunner {
  readonly calls: { file: string; args: string[] }[] = []
  panes = '%1 /dev/pts/3\n%2 /dev/pts/9'
  paneText = 'opencode\n> ready'
  captureFails = false

  async run(file: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ file, args })
    if (file !== 'tmux') return { code: 127, stdout: '', stderr: 'tmux: not found' }
    if (args[0] === 'list-panes') return { code: 0, stdout: this.panes, stderr: '' }
    if (args[0] === 'capture-pane') {
      const pane = args[args.indexOf('-t') + 1]
      if (this.captureFails) return { code: 1, stdout: '', stderr: 'no server running' }
      if (!this.panes.includes(pane)) return { code: 1, stdout: '', stderr: `can't find pane: ${pane}` }
      return { code: 0, stdout: this.paneText, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
}

interface Harness {
  helper: LinuxAttachHelper
  runner: FakeRunner
  typed: string[]
  events: AttachEvent[]
  exited: (number | null)[]
}

function harness(options: { tty?: string; noTty?: boolean } = {}): Harness {
  const runner = new FakeRunner()
  const typed: string[] = []
  const events: AttachEvent[] = []
  const exited: (number | null)[] = []
  const helper = new LinuxAttachHelper(4242, {
    runner,
    ttyOf: () => {
      if (options.noTty) throw new Error('ENOENT')
      return options.tty ?? '/dev/pts/3'
    },
    write: (_tty, text) => typed.push(text)
  })
  helper.onEvent((event) => events.push(event))
  helper.onExit((code) => exited.push(code))
  return { helper, runner, typed, events, exited }
}

/** Lets the helper's async poll settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('keySequence', () => {
  it('sends VT sequences for the keys a TUI needs', () => {
    expect(keySequence('enter')).toBe('\r')
    expect(keySequence('escape')).toBe('\x1b')
    expect(keySequence('up')).toBe('\x1b[A')
    expect(keySequence('left')).toBe('\x1b[D')
    expect(keySequence(' ')).toBe(' ')
  })

  it('passes a single character through and rejects a name it does not know', () => {
    expect(keySequence('y')).toBe('y')
    expect(() => keySequence('f13')).toThrow(/Unknown key/)
  })
})

describe('LinuxAttachHelper', () => {
  it('types the prompt and submits it with one trailing Enter', () => {
    const { helper, typed } = harness()
    helper.send({ cmd: 'type', text: 'do the thing' })
    expect(typed).toEqual(['do the thing\r'])
  })

  it('flattens line breaks so a prompt is not submitted early', () => {
    const { helper, typed } = harness()
    helper.send({ cmd: 'type', text: 'first\nsecond\r\n' })
    expect(typed).toEqual(['first second  \r'])
  })

  it('sends each key of an answer as its own sequence', () => {
    const { helper, typed } = harness()
    helper.send({ cmd: 'keys', keys: ['right', 'enter'] })
    expect(typed).toEqual(['\x1b[C', '\r'])
  })

  it('reports a write failure as an error event instead of throwing', () => {
    const runner = new FakeRunner()
    const events: AttachEvent[] = []
    const helper = new LinuxAttachHelper(1, {
      runner,
      ttyOf: () => '/dev/pts/3',
      write: () => {
        throw new Error('EIO')
      }
    })
    helper.onEvent((event) => events.push(event))
    helper.send({ cmd: 'type', text: 'hi' })
    expect(events).toEqual([{ event: 'error', message: 'EIO' }])
  })

  it('mirrors the pane whose terminal is the target pid, once resolved', async () => {
    const { helper, runner, events } = harness()
    helper.send({ cmd: 'poll' })
    await settle()
    expect(events[0]).toEqual({ event: 'ready' })
    expect(events[1]).toEqual({ event: 'screen', text: 'opencode\n> ready' })
    expect(runner.calls.some((call) => call.args[0] === 'capture-pane' && call.args.includes('%1'))).toBe(true)
    expect(runner.calls.some((call) => call.args.includes('%2'))).toBe(false)
  })

  it('resolves the pane and tty once, not on every poll', async () => {
    const { helper, runner } = harness()
    helper.send({ cmd: 'poll' })
    await settle()
    const before = runner.calls.filter((call) => call.args[0] === 'list-panes').length
    helper.send({ cmd: 'poll' })
    await settle()
    expect(runner.calls.filter((call) => call.args[0] === 'list-panes')).toHaveLength(before)
  })

  it('says a terminal outside tmux cannot be mirrored, every poll, instead of showing a blank screen', async () => {
    const { helper, runner, events } = harness({ tty: '/dev/pts/9' })
    runner.panes = '%1 /dev/pts/3'
    helper.send({ cmd: 'poll' })
    await settle()
    helper.send({ cmd: 'poll' })
    await settle()
    const screens = events.filter((event) => event.event === 'screen')
    expect(screens).toHaveLength(2)
    expect(screens[0].event === 'screen' && screens[0].text).toMatch(/tmux/)
    expect(runner.calls.some((call) => call.args[0] === 'capture-pane')).toBe(false)
  })

  it('fails with the reason when the pid has no terminal', async () => {
    const { helper, events } = harness({ noTty: true })
    helper.send({ cmd: 'poll' })
    await settle()
    expect(events[0]).toEqual({ event: 'error', message: "Couldn't find that terminal's device: ENOENT" })
  })

  it('passes a tmux failure on instead of mirroring stale text', async () => {
    const runner = new FakeRunner()
    runner.captureFails = true
    const events: AttachEvent[] = []
    const helper = new LinuxAttachHelper(7, { runner, ttyOf: () => '/dev/pts/3', write: () => undefined })
    helper.onEvent((event) => events.push(event))
    helper.send({ cmd: 'poll' })
    await settle()
    expect(events.filter((event) => event.event === 'screen')).toHaveLength(0)
    expect(events.at(-1)?.event).toBe('error')
  })

  it('exits once on the exit command and again on kill, reporting a single exit', async () => {
    const { helper, exited, events } = harness()
    helper.send({ cmd: 'exit' })
    helper.kill()
    expect(exited).toEqual([0])
    // Nothing is emitted after the helper is gone.
    helper.send({ cmd: 'type', text: 'hi' })
    expect(events).toEqual([])
  })
})

describe('LinuxAttachHelperSpawner', () => {
  it('creates a helper for the target pid', () => {
    const spawner = new LinuxAttachHelperSpawner(new FakeRunner())
    expect(spawner.spawnHelper(555)).toBeInstanceOf(LinuxAttachHelper)
  })
})