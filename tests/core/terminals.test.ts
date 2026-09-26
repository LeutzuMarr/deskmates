import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner, RunOptions } from '../../src/core/bots/command-runner'
import { detectTerminalAgents, folderFromCommandLine, parseProcessListing, parseWmiDate } from '../../src/core/terminals/detect'
import {
  ManagedTerminalRunner,
  buildAgyArgs,
  buildOpenCodeArgs,
  parseAgyLine,
  parseAgyStderrLine,
  parseOpenCodeLine,
  spillPrompt,
  MAX_INLINE_PROMPT
} from '../../src/core/terminals/managed'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessSpawner, SpawnedProcess, SpawnOptions } from '../../src/core/terminals/process'
import type { TimelineItem, TerminalSession } from '../../src/shared/protocol'

// ---- fakes ----

/** A fake CommandRunner (per rules.md's own pattern): scripted responses, no real process ever runs. */
function makeFakeCommandRunner(script: CommandResult | ((file: string, args: string[], options?: RunOptions) => CommandResult)): CommandRunner {
  return {
    async run(file, args, options) {
      return typeof script === 'function' ? script(file, args, options) : script
    }
  }
}

class FakeSpawnedProcess implements SpawnedProcess {
  readonly pid = 4242
  killed = false
  private readonly stdoutListeners: Array<(line: string) => void> = []
  private readonly stderrListeners: Array<(line: string) => void> = []
  private readonly exitListeners: Array<(code: number | null) => void> = []

  onStdoutLine(listener: (line: string) => void): void {
    this.stdoutListeners.push(listener)
  }
  onStderrLine(listener: (line: string) => void): void {
    this.stderrListeners.push(listener)
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener)
  }
  kill(): void {
    this.killed = true
  }
  emitStdout(line: string): void {
    this.stdoutListeners.forEach((listener) => listener(line))
  }
  emitStderr(line: string): void {
    this.stderrListeners.forEach((listener) => listener(line))
  }
  emitExit(code: number | null): void {
    this.exitListeners.forEach((listener) => listener(code))
  }
}

/** Records every spawn call and hands back a puppet process the test drives by hand — nothing here
 *  ever touches a real child process, matching the job's "fake command runner" requirement extended
 *  to the streaming spawner managed mode needs (see process.ts's own doc comment for why it's a
 *  separate interface from CommandRunner). */
class FakeSpawner implements ProcessSpawner {
  readonly calls: { file: string; args: string[]; cwd?: string }[] = []
  readonly processes: FakeSpawnedProcess[] = []
  spawn(file: string, args: string[], options: SpawnOptions = {}): SpawnedProcess {
    this.calls.push({ file, args, cwd: options.cwd })
    const proc = new FakeSpawnedProcess()
    this.processes.push(proc)
    return proc
  }
}

function makeRunner(spawner: FakeSpawner, phrase = 'KETTLE-CEDAR-42') {
  const sessions: TerminalSession[] = []
  const items: Record<string, TimelineItem[]> = {}
  const runner = new ManagedTerminalRunner({
    spawner,
    guidePath: 'D:\\DeskmatesData\\agent-kit\\DESKMATES-AGENTS.md',
    guideVersion: 'abc12345',
    phrase,
    onSessionUpdated: (session) => {
      const index = sessions.findIndex((s) => s.id === session.id)
      if (index >= 0) sessions[index] = { ...session }
      else sessions.push({ ...session })
    },
    onItem: (sessionId, item) => {
      items[sessionId] = [...(items[sessionId] ?? []), item]
    }
  })
  return { runner, sessions, items }
}

function readyLine(phrase: string): string {
  return JSON.stringify({
    type: 'text',
    timestamp: 1790002482444,
    sessionID: 'ses_f3b8a5869ffei9Fsnp0YDdtgpM',
    part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_f3b8a5869ffei9Fsnp0YDdtgpM', type: 'text', text: `DESKMATES READY ${phrase}` }
  })
}

// ---- detection: real `Win32_Process` output, captured on the development machine from a chocolatey
// install of OpenCode (`opencode serve --port 4999`) ----

const REAL_WIN32_PROCESS_JSON = `[
    {
        "ProcessId":  24980,
        "ParentProcessId":  31704,
        "Name":  "opencode.exe",
        "CommandLine":  "C:\\\\ProgramData\\\\chocolatey\\\\bin\\\\opencode.exe serve --port 4999",
        "CreationDate":  "\\/Date(1790002811679)\\/"
    },
    {
        "ProcessId":  29428,
        "ParentProcessId":  24980,
        "Name":  "opencode.exe",
        "CommandLine":  "\\"C:\\\\ProgramData\\\\chocolatey\\\\lib\\\\opencode\\\\tools\\\\opencode.exe\\" serve --port 4999",
        "CreationDate":  "\\/Date(1790002811916)\\/"
    }
]`

describe('detect.ts', () => {
  it('parses a real Get-CimInstance Win32_Process capture and collapses the chocolatey shim into its child', () => {
    const result = parseProcessListing(REAL_WIN32_PROCESS_JSON)
    expect(result).toHaveLength(1)
    expect(result[0].tool).toBe('opencode')
    expect(result[0].pid).toBe(29428) // the real worker, not the 24980 launcher shim
    expect(result[0].commandLine).toContain('chocolatey\\lib\\opencode\\tools\\opencode.exe')
    expect(result[0].startedAt).toBe(1790002811916)
  })

  it('parses PowerShell ConvertTo-Json single-object output (no array) the same way', () => {
    const single = `{"ProcessId":111,"ParentProcessId":1,"Name":"agy.exe","CommandLine":"agy.exe","CreationDate":"/Date(1700000000000)/"}`
    const result = parseProcessListing(single)
    expect(result).toEqual([{ tool: 'agy', pid: 111, startedAt: 1700000000000, commandLine: 'agy.exe', folder: null }])
  })

  it('ignores unrelated process names and handles empty/garbage input without throwing', () => {
    expect(parseProcessListing('')).toEqual([])
    expect(parseProcessListing('not json')).toEqual([])
    expect(parseProcessListing('{"ProcessId":1,"ParentProcessId":0,"Name":"node.exe","CommandLine":"node x.js","CreationDate":null}')).toEqual([])
  })

  it('reads the working folder off a --dir flag, quoted or not', () => {
    expect(folderFromCommandLine('opencode.exe run --dir "D:\\My Project" "hi"')).toBe('D:\\My Project')
    expect(folderFromCommandLine('opencode.exe run --dir=D:\\Proj "hi"')).toBe('D:\\Proj')
    expect(folderFromCommandLine('opencode.exe serve --port 4999')).toBeNull()
  })

  it('parseWmiDate reads the legacy /Date(millis)/ format ConvertTo-Json emits for a CIM DateTime', () => {
    expect(parseWmiDate('/Date(1790002811916)/')).toBe(1790002811916)
    expect(parseWmiDate(null)).toBeNull()
    expect(parseWmiDate('garbage')).toBeNull()
  })

  it('detectTerminalAgents runs PowerShell through the injected CommandRunner and returns [] on failure', async () => {
    const seen: { file: string; args: string[] }[] = []
    const ok = makeFakeCommandRunner((file, args) => {
      seen.push({ file, args })
      return { code: 0, stdout: REAL_WIN32_PROCESS_JSON, stderr: '' }
    })
    const results = await detectTerminalAgents(ok)
    expect(results).toHaveLength(1)
    expect(seen[0].file).toBe('powershell.exe')
    expect(seen[0].args.join(' ')).toContain('Win32_Process')

    const failing = makeFakeCommandRunner({ code: 1, stdout: '', stderr: 'boom' })
    expect(await detectTerminalAgents(failing)).toEqual([])
  })
})

// ---- managed-mode stream parsing: real JSON lines captured from a trivial prompt on this machine ----

describe('parseOpenCodeLine (real `opencode run --format json` capture)', () => {
  const STEP_START =
    '{"type":"step_start","timestamp":1790002481457,"sessionID":"ses_f3b8a5869ffei9Fsnp0YDdtgpM","part":{"id":"prt_0c476491e0015IrkSlIBtvkL9T","messageID":"msg_0c475b2b1001iNholbt1nZK3T7","sessionID":"ses_f3b8a5869ffei9Fsnp0YDdtgpM","snapshot":"170ee4a2a6957def72a1fe3057e8e9eda0201bd4","type":"step-start"}}'
  const TEXT =
    '{"type":"text","timestamp":1790002482444,"sessionID":"ses_f3b8a5869ffei9Fsnp0YDdtgpM","part":{"id":"prt_0c4764cf20012z3znRjVHUkDfb","messageID":"msg_0c475b2b1001iNholbt1nZK3T7","sessionID":"ses_f3b8a5869ffei9Fsnp0YDdtgpM","type":"text","text":"PONG","time":{"start":1790002482418,"end":1790002482427}}}'
  const STEP_FINISH =
    '{"type":"step_finish","timestamp":1790002483439,"sessionID":"ses_f3b8a5869ffei9Fsnp0YDdtgpM","part":{"id":"prt_0c47650bb001AlcOrWrKKhBZgv","reason":"stop","snapshot":"37e2c1c4f2ef374aa21bc6b9b2eb0e87b8dd8ad2","messageID":"msg_0c475b2b1001iNholbt1nZK3T7","sessionID":"ses_f3b8a5869ffei9Fsnp0YDdtgpM","type":"step-finish","tokens":{"total":37641,"input":35834,"output":15,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}'

  it('extracts the reply text from the text event', () => {
    const parsed = parseOpenCodeLine(TEXT)
    expect(parsed?.sessionId).toBe('ses_f3b8a5869ffei9Fsnp0YDdtgpM')
    expect(parsed?.item).toEqual({ kind: 'assistant', id: expect.any(String), at: 1790002482444, text: 'PONG' })
  })

  it('step_start and step_finish carry the session id but produce no visible item', () => {
    for (const line of [STEP_START, STEP_FINISH]) {
      const parsed = parseOpenCodeLine(line)
      expect(parsed?.sessionId).toBe('ses_f3b8a5869ffei9Fsnp0YDdtgpM')
      expect(parsed?.item).toBeUndefined()
    }
  })

  it('falls back to a generic tool item for an unrecognized shape instead of dropping it', () => {
    const parsed = parseOpenCodeLine('{"type":"tool_call","sessionID":"s1","part":{"type":"tool","tool":"read_file","input":{"path":"a.ts"}}}')
    expect(parsed?.item?.kind).toBe('tool')
  })

  it('returns null for unparsable / blank lines', () => {
    expect(parseOpenCodeLine('')).toBeNull()
    expect(parseOpenCodeLine('not json')).toBeNull()
  })
})

describe('parseAgyLine (real `agy --output-format stream-json` capture)', () => {
  // Captured from a real (incomplete — see the job's report) run of this machine's agy; the tools
  // array is trimmed for test brevity.
  const INIT =
    '{"event":"init","conversation_id":"e64f97a7-9143-4828-9ef7-5ab714972e41","init":{"cwd":"D:\\\\Projects\\\\Deskmates\\\\.scratch-terminal-test","tools":["run_command","view_file","write_to_file"],"permission_mode":"request-review"}}'
  const USER_INPUT =
    '{"event":"step_update","step_update":{"conversation_id":"e64f97a7-9143-4828-9ef7-5ab714972e41","step_index":0,"state":"DONE","step_type":"user_input"}}'
  const ERROR_MESSAGE =
    '{"event":"step_update","step_update":{"conversation_id":"e64f97a7-9143-4828-9ef7-5ab714972e41","step_index":1,"state":"DONE","step_type":"error_message","duration_seconds":0}}'

  it('turns init into a gray session-summary item and captures the conversation id', () => {
    const parsed = parseAgyLine(INIT)
    expect(parsed?.sessionId).toBe('e64f97a7-9143-4828-9ef7-5ab714972e41')
    expect(parsed?.item?.kind).toBe('tool')
    if (parsed?.item?.kind === 'tool') {
      expect(parsed.item.toolName).toBe('session')
      expect(parsed.item.state).toBe('done')
    }
  })

  it('a user_input step is just an echo of what we sent: no visible item', () => {
    const parsed = parseAgyLine(USER_INPUT)
    expect(parsed?.sessionId).toBe('e64f97a7-9143-4828-9ef7-5ab714972e41')
    expect(parsed?.item).toBeUndefined()
  })

  it('an error_message step becomes an error tool item', () => {
    const parsed = parseAgyLine(ERROR_MESSAGE)
    expect(parsed?.item?.kind).toBe('tool')
    if (parsed?.item?.kind === 'tool') {
      expect(parsed.item.state).toBe('error')
      expect(parsed.item.error).toBeTruthy()
    }
  })

  it('falls back to a generic gray line for any other step_type instead of dropping it', () => {
    const parsed = parseAgyLine(
      '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"RUNNING","step_type":"tool_call"}}'
    )
    expect(parsed?.item?.kind).toBe('tool')
    if (parsed?.item?.kind === 'tool') expect(parsed.item.state).toBe('running')
  })

  it('parseAgyStderrLine reads the AGY_ERROR: {...} line agy\'s own changelog documents for API failures', () => {
    const item = parseAgyStderrLine('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":false,"error":"Daily quota exceeded"}')
    expect(item?.state).toBe('error')
    expect(item?.error).toBe('Daily quota exceeded')
    expect(parseAgyStderrLine('just some other stderr noise')).toBeNull()
  })
})

describe('CLI argument construction', () => {
  it('long prompts travel in a file instead of on the command line, which Windows caps', () => {
    const folder = mkdtempSync(join(tmpdir(), 'dm-spill-'))
    const short = spillPrompt('opencode', folder, 'hi')
    expect(short).toMatchObject({ prompt: 'hi', files: [] })

    const long = 'x'.repeat(MAX_INLINE_PROMPT + 1)
    const open = spillPrompt('opencode', folder, long)
    expect(open.prompt.length).toBeLessThan(300)
    expect(readFileSync(open.files[0], 'utf8')).toBe(long)
    const args = buildOpenCodeArgs({ folder, model: 'm', sessionId: null, prompt: open.prompt, files: open.files })
    expect(args.slice(-3)).toEqual([open.prompt, '-f', open.files[0]])
    open.cleanup()
    expect(existsSync(open.files[0])).toBe(false)

    const agy = spillPrompt('agy', folder, long)
    const file = /in the file (.+?\.md)\./.exec(agy.prompt)?.[1] ?? ''
    expect(file.startsWith(join(folder, '.deskmates'))).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(long)
    agy.cleanup()
    expect(existsSync(file)).toBe(false)
  })

  it('OpenCode: fresh call has no -s, continuation passes -s <id>', () => {
    expect(buildOpenCodeArgs({ folder: 'D:\\proj', model: 'opencode/big-pickle', sessionId: null, prompt: 'hi' })).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '-m',
      'opencode/big-pickle',
      '--dir',
      'D:\\proj',
      'hi'
    ])
    expect(buildOpenCodeArgs({ folder: 'D:\\proj', model: 'opencode/big-pickle', sessionId: 'ses_1', prompt: 'hi' })).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '-m',
      'opencode/big-pickle',
      '--dir',
      'D:\\proj',
      '-s',
      'ses_1',
      'hi'
    ])
  })

  it('agy: the prompt is always the last argument (verified live: -p swallows the next token as its own value)', () => {
    const args = buildAgyArgs({ model: null, sessionId: null, prompt: 'Reply with PONG' })
    expect(args.at(-2)).toBe('-p')
    expect(args.at(-1)).toBe('Reply with PONG')
    expect(args[0]).toBe('--output-format')
  })

  it('agy: continuation passes --conversation <id>', () => {
    const args = buildAgyArgs({ model: 'gemini-pro', sessionId: 'conv-1', prompt: 'hi' })
    expect(args).toContain('--conversation')
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-1')
    expect(args).toContain('--model')
  })
})

// ---- the primer / ready-line check-in flow, end to end through ManagedTerminalRunner ----

describe('ManagedTerminalRunner: the check-in flow', () => {
  it('starts by sending the primer (not the real prompt) and confirms onboarding when the ready line arrives', () => {
    const spawner = new FakeSpawner()
    const { runner, sessions, items } = makeRunner(spawner)

    const session = runner.start('opencode', 'D:\\proj')
    // start() runs its primer call synchronously (spawning is fire-and-forget, not awaited), so by
    // the time it returns the session has already moved past 'starting' into 'busy' — a live UI
    // subscriber still sees the 'starting' event first, since onSessionUpdated fires before run().
    expect(session.state).toBe('busy')
    expect(spawner.calls).toHaveLength(1)
    // The primer text, not a user-visible bubble, is what got sent as the prompt.
    expect(spawner.calls[0].args.at(-1)).toContain('DESKMATES-AGENTS.md')
    expect(items[session.id] ?? []).toHaveLength(0) // primer isn't echoed into the visible timeline

    spawner.processes[0].emitStdout(readyLine('KETTLE-CEDAR-42'))
    spawner.processes[0].emitExit(0)

    const updated = sessions.find((s) => s.id === session.id)
    expect(updated?.onboarding).toBe('confirmed')
    expect(updated?.state).toBe('idle')
    expect(updated?.cliSessionId).toBe('ses_f3b8a5869ffei9Fsnp0YDdtgpM')
    expect(items[session.id] ?? []).toHaveLength(0) // the "DESKMATES READY ..." line itself never shows up as a bubble
  })

  it('reports "didn\'t confirm" when the primer run finishes with no ready line', () => {
    const spawner = new FakeSpawner()
    const { runner, sessions } = makeRunner(spawner)

    const session = runner.start('agy', 'D:\\proj')
    spawner.processes[0].emitStdout(
      '{"event":"init","conversation_id":"conv-1","init":{"cwd":"D:\\\\proj","tools":[],"permission_mode":"request-review"}}'
    )
    spawner.processes[0].emitExit(0)

    const updated = sessions.find((s) => s.id === session.id)
    expect(updated?.onboarding).toBe('failed')
    expect(updated?.state).toBe('idle') // the run itself didn't fail, the agent just never confirmed
  })

  it('a later send() continues the same CLI session and shows the prompt as a visible user bubble', () => {
    const spawner = new FakeSpawner()
    const { runner, items } = makeRunner(spawner)

    const session = runner.start('opencode', 'D:\\proj')
    spawner.processes[0].emitStdout(readyLine('KETTLE-CEDAR-42'))
    spawner.processes[0].emitExit(0)

    runner.send(session.id, 'What time is it?')
    expect(spawner.calls[1].args).toContain('-s')
    expect(spawner.calls[1].args.at(-1)).toBe('What time is it?')
    expect(items[session.id]?.some((item) => item.kind === 'user' && item.text === 'What time is it?')).toBe(true)

    spawner.processes[1].emitStdout(
      '{"type":"text","timestamp":1,"sessionID":"ses_f3b8a5869ffei9Fsnp0YDdtgpM","part":{"id":"p2","type":"text","text":"5pm"}}'
    )
    spawner.processes[1].emitExit(0)
    expect(items[session.id]?.some((item) => item.kind === 'assistant' && item.text === '5pm')).toBe(true)
  })

  it('an AGY_ERROR stderr line marks the run as failed, surfacing it honestly instead of hiding it', () => {
    const spawner = new FakeSpawner()
    const { runner, sessions, items } = makeRunner(spawner)

    const session = runner.start('agy', 'D:\\proj')
    // agy's own event shape (see parseAgyLine's doc comment): the ready line arrives as a
    // step_update whose step_type isn't user_input/error_message, carried in a text-ish field.
    spawner.processes[0].emitStdout(
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":1,"state":"DONE","step_type":"assistant_message","message":"DESKMATES READY KETTLE-CEDAR-42"}}'
    )
    spawner.processes[0].emitExit(0)

    runner.send(session.id, 'do a thing')
    spawner.processes[1].emitStderr('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":false,"error":"Daily quota exceeded"}')
    spawner.processes[1].emitExit(3)

    const updated = sessions.find((s) => s.id === session.id)
    expect(updated?.state).toBe('error')
    expect(items[session.id]?.some((item) => item.kind === 'tool' && item.state === 'error' && item.error === 'Daily quota exceeded')).toBe(
      true
    )
  })

  it('stop() kills the in-flight process', () => {
    const spawner = new FakeSpawner()
    const { runner } = makeRunner(spawner)
    const session = runner.start('opencode', 'D:\\proj')
    runner.stop(session.id)
    expect(spawner.processes[0].killed).toBe(true)
  })
})
