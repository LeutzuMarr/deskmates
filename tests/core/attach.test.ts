import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ATTACH_HELPER_SCRIPT,
  AttachTerminalRunner,
  parseHelperEvent
} from '../../src/core/terminals/attach'
import type { AttachCommand, AttachEvent, AttachHelper, AttachHelperSpawner } from '../../src/core/terminals/attach'
import type { AttachedTerminalSession } from '../../src/shared/protocol'

// ---- fakes ----

/** A fake helper process: records every command, lets the test drive events by hand. Nothing here
 *  ever touches a real console (per the job's "fake the helper" requirement — the real PowerShell
 *  bridge is proven separately inside ATTACH_HELPER_SCRIPT's own tests). */
class FakeAttachHelper implements AttachHelper {
  readonly commands: AttachCommand[] = []
  killed = false
  private readonly eventListeners: Array<(event: AttachEvent) => void> = []
  private readonly exitListeners: Array<(code: number | null) => void> = []

  send(command: AttachCommand): void {
    this.commands.push(command)
  }
  onEvent(listener: (event: AttachEvent) => void): void {
    this.eventListeners.push(listener)
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener)
  }
  kill(): void {
    this.killed = true
  }
  emitEvent(event: AttachEvent): void {
    this.eventListeners.forEach((listener) => listener(event))
  }
  emitExit(code: number | null): void {
    this.exitListeners.forEach((listener) => listener(code))
  }
  /** The text of every `type` command, in order. */
  typedText(): string[] {
    return this.commands.filter((c) => c.cmd === 'type').map((c) => c.text)
  }
}

class FakeHelperSpawner implements AttachHelperSpawner {
  readonly helpers: FakeAttachHelper[] = []
  readonly targetedPids: number[] = []
  spawnHelper(targetPid: number): AttachHelper {
    this.targetedPids.push(targetPid)
    const helper = new FakeAttachHelper()
    this.helpers.push(helper)
    return helper
  }
}

const PHRASE = 'KETTLE-CEDAR-42'
const GUIDE = 'D:\\DeskmatesData\\agent-kit\\DESKMATES-AGENTS.md'

function makeRunner(spawner: FakeHelperSpawner, options: { pollMs?: number; onboardingTimeoutMs?: number } = {}) {
  const snapshots: AttachedTerminalSession[] = []
  let updateCount = 0
  const runner = new AttachTerminalRunner({
    spawner,
    guidePath: GUIDE,
    guideVersion: 'abc12345',
    phrase: PHRASE,
    pollMs: options.pollMs ?? 1000,
    onboardingTimeoutMs: options.onboardingTimeoutMs ?? 90_000,
    onSessionUpdated: (session) => {
      updateCount++
      snapshots.push({ ...session })
    }
  })
  return { runner, snapshots, updateCount: () => updateCount }
}

// A realistic mirror: an ANSI-colored prompt, then the ready line (which the matcher strips ansi
// and box-drawing noise from), then the prompt again.
function readyMirror(): string {
  return `\u001b[32muser@pc\u001b[0m C:\\proj>\r\nDESKMATES READY ${PHRASE}\r\n\u001b[32muser@pc\u001b[0m C:\\proj>`
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---- the embedded helper script is real, not a fake that claims to be ----

describe('ATTACH_HELPER_SCRIPT', () => {
  it('is a PowerShell file that drives the Windows console API (not a fake)', () => {
    expect(ATTACH_HELPER_SCRIPT).toContain('param([Parameter(Mandatory=$true)][int]$TargetPid)')
    expect(ATTACH_HELPER_SCRIPT).toContain('Add-Type -TypeDefinition')
    // The whole point of attach mode is these four calls; assert each to pin the real script.
    expect(ATTACH_HELPER_SCRIPT).toContain('FreeConsole()')
    expect(ATTACH_HELPER_SCRIPT).toContain('AttachConsole(')
    expect(ATTACH_HELPER_SCRIPT).toContain('SetConsoleCtrlHandler(')
    expect(ATTACH_HELPER_SCRIPT).toContain('WriteConsoleInputW(')
    expect(ATTACH_HELPER_SCRIPT).toContain('ReadConsoleOutputCharacterW(')
  })

  it('recognizes the CONIN$/CONOUT$ file names the console API needs', () => {
    expect(ATTACH_HELPER_SCRIPT).toContain('"CONIN$"')
    expect(ATTACH_HELPER_SCRIPT).toContain('"CONOUT$"')
  })

  it('emits real C# escapes, not literal newline characters, inside char literals', () => {
    // The script is a TS template literal, so `\r`/`\n` must be double-escaped: a stray CR/LF chip
    // inside a C# char literal becomes "Newline in constant" and the helper never compiles.
    expect(ATTACH_HELPER_SCRIPT).toContain(`flat.Append(ch == '\\r' || ch == '\\n' ? ' ' : ch);`)
    expect(ATTACH_HELPER_SCRIPT).not.toMatch(/ch == '[\r\n]/)
    expect(ATTACH_HELPER_SCRIPT).toContain(`UnicodeChar = '\\r' };`)
    expect(ATTACH_HELPER_SCRIPT).toContain(`sb.Append(buffer, 0, len).Append('\\n');`)
  })
})

// ---- the line parser for the helper protocol ----

describe('parseHelperEvent', () => {
  it('parses ready and screen events', () => {
    expect(parseHelperEvent('{"event":"ready"}')).toEqual({ event: 'ready' })
    expect(parseHelperEvent('{"event":"screen","text":"hello"}')).toEqual({ event: 'screen', text: 'hello' })
  })

  it('parses error events and ignores unrecognized lines without throwing', () => {
    expect(parseHelperEvent('{"event":"error","message":"boom"}')).toEqual({ event: 'error', message: 'boom' })
    expect(parseHelperEvent('')).toBeNull()
    expect(parseHelperEvent('   ')).toBeNull()
    expect(parseHelperEvent('not json')).toBeNull()
    expect(parseHelperEvent('{"event":"wiggle"}')).toBeNull()
  })
})

// ---- the runner: attach / primer / ready-line / send / retry / stop, all against a fake helper ----

describe('AttachTerminalRunner', () => {
  it('attach() makes an attaching session and spawns a helper for that pid', () => {
    const spawner = new FakeHelperSpawner()
    const { runner, snapshots } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    expect(session.state).toBe('attaching')
    expect(session.pid).toBe(4321)
    expect(session.tool).toBe('opencode')
    expect(session.onboarding).toBe('unknown')
    expect(spawner.targetedPids).toEqual([4321])
    expect(spawner.helpers).toHaveLength(1)
    expect(snapshots[0].id).toBe(session.id)
  })

  it('attach() is idempotent per pid while that session is still alive', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const first = runner.attach(4321, 'agy')
    const again = runner.attach(4321, 'agy')
    expect(again.id).toBe(first.id)
    expect(spawner.targetedPids).toEqual([4321])
    expect(spawner.helpers).toHaveLength(1)
  })

  it('re-attaches a fresh session (new helper) after the old one is closed', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const first = runner.attach(4321, 'opencode')
    runner.stop(first.id)
    const second = runner.attach(4321, 'opencode')
    expect(second.id).not.toBe(first.id)
    expect(spawner.targetedPids).toEqual([4321, 4321])
    expect(spawner.helpers).toHaveLength(2)
  })

  it('helper ready triggers the primer: types the guide prompt and moves to priming', () => {
    const spawner = new FakeHelperSpawner()
    const { runner, snapshots, updateCount } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })

    const helper = spawner.helpers[0]
    expect(helper.typedText()).toHaveLength(1)
    expect(helper.typedText()[0]).toContain('read the guide at')
    expect(helper.typedText()[0]).toContain(GUIDE)
    expect(session.state).toBe('priming')
    expect(session.onboarding).toBe('primed')
    expect(updateCount()).toBeGreaterThanOrEqual(2) // attaching, then priming
    expect(snapshots.at(-1)?.state).toBe('priming')
  })

  it('the ready line in the mirror confirms the check-in and connects the session', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })
    spawner.helpers[0].emitEvent({ event: 'screen', text: readyMirror() })

    expect(session.state).toBe('connected')
    expect(session.onboarding).toBe('confirmed')
    expect(session.screen).toContain('DESKMATES READY')
  })

  it('screen events mirror into the session, but an unchanged screen does not re-emit', () => {
    const spawner = new FakeHelperSpawner()
    const { runner, updateCount } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'screen', text: 'first frame' })
    const afterFirst = updateCount()
    expect(session.screen).toBe('first frame')

    spawner.helpers[0].emitEvent({ event: 'screen', text: 'first frame' })
    expect(updateCount()).toBe(afterFirst) // identical mirror, no change, no emit
  })

  it('a primed session that never shows the ready line fails onboarding after the timeout', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner, { pollMs: 5, onboardingTimeoutMs: 50 })

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })

    vi.advanceTimersByTime(60) // poll ticks keep the watchdog moving even with a static screen
    expect(session.state).toBe('connected')
    expect(session.onboarding).toBe('failed')
  })

  it('a timeout fires the poll watchdog without any screen events at all', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner, { pollMs: 5, onboardingTimeoutMs: 50 })

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })

    vi.advanceTimersByTime(60)
    expect(session.onboarding).toBe('failed')
  })

  it('send() after a failed check-in re-sends the primer before the user prompt', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner, { pollMs: 5, onboardingTimeoutMs: 50 })

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })
    vi.advanceTimersByTime(60)
    expect(session.onboarding).toBe('failed')

    runner.send(session.id, 'make me a design')
    const typed = spawner.helpers[0].typedText()
    expect(typed[typed.length - 2]).toContain('read the guide at') // primer again
    expect(typed[typed.length - 1]).toBe('make me a design')
  })

  it('send() after a confirmed check-in types only the user prompt', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })
    spawner.helpers[0].emitEvent({ event: 'screen', text: readyMirror() })

    runner.send(session.id, 'make me a design')
    const typed = spawner.helpers[0].typedText()
    expect(typed).toHaveLength(2) // primer, then the prompt — no re-primer
    expect(typed[1]).toBe('make me a design')
  })

  it('send() throws while attaching and on a detached terminal', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    expect(() => runner.send(session.id, 'hi')).toThrow(/still connecting/)

    runner.stop(session.id)
    expect(() => runner.send(session.id, 'hi')).toThrow(/detached/)
    expect(() => runner.send('no-such-id', 'hi')).toThrow(/doesn't exist/)
  })

  it('a context reset (/new) makes the next send re-prime', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })
    spawner.helpers[0].emitEvent({ event: 'screen', text: readyMirror() })
    expect(session.onboarding).toBe('confirmed')

    runner.send(session.id, '/new') // user restarted the agent conversation
    const typed = spawner.helpers[0].typedText()
    expect(typed[typed.length - 2]).toContain('read the guide at')
    expect(typed[typed.length - 1]).toBe('/new')
    expect(session.state).toBe('priming')
  })

  it('retry() re-sends the primer and returns the session to priming', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner, { pollMs: 5, onboardingTimeoutMs: 50 })

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })
    vi.advanceTimersByTime(60)
    expect(session.onboarding).toBe('failed')

    runner.retry(session.id)
    expect(session.state).toBe('priming')
    expect(session.onboarding).toBe('primed')
    expect(spawner.helpers[0].typedText().at(-1)).toContain('read the guide at')
  })

  it('retry() refuses on closed and errored sessions', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const detached = runner.attach(1, 'opencode')
    runner.stop(detached.id)
    expect(() => runner.retry(detached.id)).toThrow(/detached/)

    const broken = runner.attach(2, 'opencode')
    spawner.helpers[1].emitEvent({ event: 'ready' })
    spawner.helpers[1].emitEvent({ event: 'error', message: 'no console' })
    expect(() => runner.retry(broken.id)).toThrow(/error/)
  })

  it('stop() tells the helper to exit, kills it and marks the session closed', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    runner.stop(session.id)

    const helper = spawner.helpers[0]
    expect(helper.commands).toContainEqual({ cmd: 'exit' })
    expect(helper.killed).toBe(true)
    expect(session.state).toBe('closed')
    // No more polling after detach.
    for (const entry of [session]) expect(entry.state).toBe('closed')
    vi.advanceTimersByTime(10_000)
  })

  it('a helper error event marks the session errored and stops polling', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })
    spawner.helpers[0].emitEvent({ event: 'error', message: "Couldn't attach to that terminal window" })

    expect(session.state).toBe('error')
    expect(session.error).toBe("Couldn't attach to that terminal window")
  })

  it('an unexpected helper exit closes the session; while priming it fails the check-in', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    // Mid-check-in death: the ready line can never arrive, so onboarding fails instead of hanging.
    const priming = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'ready' })
    spawner.helpers[0].emitExit(3)
    expect(priming.state).toBe('closed')
    expect(priming.onboarding).toBe('failed')
    expect(priming.error).toContain('helper stopped (code 3)')

    // A clean manual detach does not clobber the closed state when the helper finally reports exit.
    const manual = runner.attach(5555, 'agy')
    runner.stop(manual.id)
    spawner.helpers[1].emitExit(0)
    expect(manual.state).toBe('closed')
  })

  it('list() only reports sessions spawned through this runner', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    runner.attach(111, 'opencode')
    runner.attach(222, 'agy')
    expect(runner.list().map((s) => s.pid)).toEqual([111, 222])
  })

  it('close() detaches every session', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const a = runner.attach(111, 'opencode')
    const b = runner.attach(222, 'agy')
    runner.close()
    expect(a.state).toBe('closed')
    expect(b.state).toBe('closed')
    expect(spawner.helpers.every((h) => h.killed)).toBe(true)
  })

  it('a screen frame that arrives before ready does not advance past attaching', () => {
    const spawner = new FakeHelperSpawner()
    const { runner } = makeRunner(spawner)

    const session = runner.attach(4321, 'opencode')
    spawner.helpers[0].emitEvent({ event: 'screen', text: 'just a prompt' })

    expect(session.state).toBe('attaching') // no ready event yet, so no primer, no priming
    expect(session.onboarding).toBe('unknown')
    expect(session.screen).toBe('just a prompt')
    expect(spawner.helpers[0].typedText()).toHaveLength(0)
  })
})