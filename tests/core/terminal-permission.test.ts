import { describe, expect, it } from 'vitest'
import { AttachTerminalRunner } from '../../src/core/terminals/attach'
import type { AttachCommand, AttachEvent, AttachHelper, AttachHelperSpawner } from '../../src/core/terminals/attach'
import { detectPermission } from '../../src/core/terminals/permission'
import type { AttachedTerminalSession, TerminalPermissionPrompt } from '../../src/shared/protocol'

const OPENCODE_SCREEN = [
  '  How can I help?',
  '┃  △ Permission required',
  '┃    ← Access external directory C:\\Users\\David\\Documents',
  '┃',
  '┃    Patterns',
  '┃    - C:\\Users\\David\\Documents\\*',
  '┃',
  '┃   Allow once   Allow always   Reject          ⇆ select  enter confirm',
  '  Build  big-pickle'
].join('\n')

const OPENCODE_ALWAYS = [
  '┃  △ Permission required',
  '┃    Always allow',
  '┃    This will allow the following patterns until OpenCode is restarted.',
  '┃    - C:\\Users\\David\\Documents\\*',
  '┃   Confirm   Cancel'
].join('\n')

describe('detectPermission', () => {
  it("reads OpenCode's permission box and answers with its keys", () => {
    const found = detectPermission('opencode', OPENCODE_SCREEN)
    expect(found?.prompt.title).toBe('Access external directory C:\\Users\\David\\Documents')
    expect(found?.prompt.detail).toContain('C:\\Users\\David\\Documents\\*')
    expect(found?.prompt.options.map((o) => o.id)).toEqual(['once', 'always', 'reject'])
    expect(found?.keys).toEqual({ once: ['enter'], always: ['right', 'enter', 'enter'], reject: ['escape'] })
  })

  it("reads OpenCode's allow-always confirmation", () => {
    const found = detectPermission('opencode', OPENCODE_ALWAYS)
    expect(found?.prompt.options.map((o) => o.id)).toEqual(['confirm', 'cancel'])
    expect(found?.keys.confirm).toEqual(['enter'])
  })

  it('reads a numbered-choice prompt from other agents', () => {
    const screen = ['Run shell command: npm install', 'Allow execution of: npm?', '● 1. Yes, allow once', '  2. Yes, allow always', '  3. No, suggest changes (esc)'].join('\n')
    const found = detectPermission('agy', screen)
    expect(found?.prompt.title).toBe('Allow execution of: npm?')
    expect(found?.prompt.options.map((o) => o.label)).toEqual(['Yes, allow once', 'Yes, allow always', 'No, suggest changes'])
    expect(found?.prompt.options[2].danger).toBe(true)
    expect(found?.keys['2']).toEqual(['2'])
  })

  it('reads a y/n prompt at the bottom of the screen', () => {
    const found = detectPermission('agy', 'Some output\nDo you want to proceed? (y/n)')
    expect(found?.keys).toEqual({ yes: ['y', 'enter'], no: ['n', 'enter'] })
  })

  it('stays quiet on ordinary output', () => {
    expect(detectPermission('opencode', 'I read the file and fixed the bug.\n> ')).toBeNull()
    expect(detectPermission('agy', 'Allow me to explain how it works.\nIt starts here.')).toBeNull()
  })
})

class FakeHelper implements AttachHelper {
  readonly commands: AttachCommand[] = []
  private listeners: Array<(event: AttachEvent) => void> = []
  send(command: AttachCommand): void {
    this.commands.push(command)
  }
  onEvent(listener: (event: AttachEvent) => void): void {
    this.listeners.push(listener)
  }
  onExit(): void {}
  kill(): void {}
  emit(event: AttachEvent): void {
    this.listeners.forEach((listener) => listener(event))
  }
}

describe('attached terminal permissions', () => {
  it('shows the prompt, notifies once, and presses the keys for the chosen answer', () => {
    const helper = new FakeHelper()
    const spawner: AttachHelperSpawner = { spawnHelper: () => helper }
    const notified: TerminalPermissionPrompt[] = []
    let latest: AttachedTerminalSession | null = null
    const runner = new AttachTerminalRunner({
      spawner,
      guidePath: 'guide.md',
      guideVersion: 'v1',
      phrase: 'PHRASE',
      pollMs: 60_000,
      onSessionUpdated: (session) => {
        latest = { ...session }
      },
      onPermission: (_session, prompt) => notified.push(prompt)
    })
    const session = runner.attach(4242, 'opencode')
    helper.emit({ event: 'ready' })
    helper.emit({ event: 'screen', text: OPENCODE_SCREEN })
    helper.emit({ event: 'screen', text: OPENCODE_SCREEN + '\n' })
    expect(latest!.permission?.title).toContain('Access external directory')
    expect(notified).toHaveLength(1)

    runner.answer(session.id, latest!.permission!.key, 'always')
    expect(helper.commands).toContainEqual({ cmd: 'keys', keys: ['right', 'enter', 'enter'] })
    expect(latest!.permission).toBeNull()
    // The old box is still on screen for a moment: it must not come back as a new question.
    helper.emit({ event: 'screen', text: OPENCODE_SCREEN })
    expect(latest!.permission).toBeNull()
    expect(() => runner.answer(session.id, 'stale', 'once')).toThrow('no longer asking')
    runner.close()
  })
})
