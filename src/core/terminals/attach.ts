import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { buildPrimer, isContextReset, OnboardingTracker } from '../agents/onboarding'
import type { AttachedTerminalSession, TerminalPermissionPrompt, TerminalTool } from '../../shared/protocol'
import { detectPermission, type TerminalKey } from './permission'

const POWERSHELL_EXE = 'powershell.exe'
const HELPER_FILE_NAME = 'deskmates-attach-helper.ps1'

/**
 * Attach mode (spec 5.14~5.16): the app types into a terminal the user already has open and reads
 * its screen back. One PowerShell helper process per attached terminal does the Windows console
 * work (`AttachConsole` + `WriteConsoleInputW`/`ReadConsoleOutputCharacterW`), so the runner here
 * talks to a line-delimited JSON protocol over the helper's stdio and never touches the console
 * itself. Everything goes through the `AttachHelperSpawner`, so unit tests run against a fake.
 *
 * The helper's own script is verified on the development PC: typing into another console window
 * and reading its screen back works via the console API in a classic console window, Windows
 * Terminal and even a full-screen raw-keyboard app — but NOT for elevated terminals or Git Bash
 * (mintty), which have no attachable console buffer. The helper must ignore Ctrl+C before
 * attaching, or the Ctrl+C keystroke it inherits from the shared console would kill it.
 */
export type AttachCommand = { cmd: 'type'; text: string } | { cmd: 'keys'; keys: TerminalKey[] } | { cmd: 'poll' } | { cmd: 'exit' }

export type AttachEvent =
  | { event: 'ready' }
  | { event: 'screen'; text: string }
  | { event: 'error'; message: string }

/** One attached-terminal helper process: the runner sends commands, the helper streams events. */
export interface AttachHelper {
  send(command: AttachCommand): void
  onEvent(listener: (event: AttachEvent) => void): void
  onExit(listener: (code: number | null) => void): void
  kill(): void
}

/** Creates helper processes for a target terminal's pid. Tests swap in a fake. */
export interface AttachHelperSpawner {
  spawnHelper(targetPid: number): AttachHelper
}

/**
 * The PowerShell helper script, embedded as a TS string so it ships inside the core bundle (the
 * refactor convention: no extra asset files to track). Written to the temp dir once at first use,
 * then spawned per attach. Kept as a named export so a test can assert the real script really uses
 * the console API (not just a fake that claims to).
 */
export const ATTACH_HELPER_SCRIPT = `param([Parameter(Mandatory=$true)][int]$TargetPid)

# The helper: attaches to the target console, types commands, mirrors the screen. All of the heavy
# lifting is C# (the Windows console API); PowerShell is just the bootstrap that adds and drives it.
# Protocol (line-delimited JSON over stdio): stdin {cmd:'type'|'poll'|'exit'}, stdout {event:'*'}.
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DeskMates
{
    public static class AttachHelper
    {
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const ushort KEY_EVENT = 0x0001;
        private const ushort VK_RETURN = 0x0D;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(uint dwProcessId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteConsoleInputW(IntPtr console, InputRecord[] records, uint count, out uint written);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ReadConsoleOutputCharacterW(IntPtr console, char[] buffer, uint length, Coord coord, out uint read);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetConsoleScreenBufferInfo(IntPtr console, out ConsoleScreenBufferInfo info);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct Coord
        {
            public short X;
            public short Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SmallRect
        {
            public short Left;
            public short Top;
            public short Right;
            public short Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ConsoleScreenBufferInfo
        {
            public Coord dwSize;
            public Coord dwCursorPosition;
            public ushort wAttributes;
            public SmallRect srWindow;
            public Coord dwMaximumWindowSize;
        }

        // KEY_EVENT_RECORD layout (all three structs use C's natural packing, so the fields land on
        // the offsets Win32 expects): EventType at 0, the key record at 4 (after the ushort
        // padding), UnicodeChar at 10 within the key record, dwControlKeyState at 12. Total 20 bytes.
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct KeyEventRecord
        {
            public bool bKeyDown;
            public ushort wRepeatCount;
            public ushort wVirtualKeyCode;
            public ushort wVirtualScanCode;
            public char UnicodeChar;
            public uint dwControlKeyState;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct InputRecord
        {
            public ushort EventType;
            public ushort Reserved;
            public KeyEventRecord KeyEvent;
        }

        public static bool Attach(uint pid, out string error)
        {
            error = string.Empty;
            FreeConsole();
            // Ignore Ctrl+C for this process BEFORE attaching. Once attached, the shared console's
            // Ctrl+C keystroke would otherwise be delivered to the helper too, and that keystroke is
            // the user's own: it must keep going to the terminal they typed it into.
            SetConsoleCtrlHandler(IntPtr.Zero, true);
            if (AttachConsole(pid)) return true;
            error = "Couldn't attach to that terminal window (it may be Git Bash/mintty, elevated, or already closed): " + DescribeLastError(Marshal.GetLastWin32Error());
            return false;
        }

        public static bool TypeText(string text, out string error)
        {
            error = string.Empty;
            IntPtr conIn = CreateFile("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (conIn == (IntPtr)(-1))
            {
                error = "Couldn't open the terminal's input: " + DescribeLastError(Marshal.GetLastWin32Error());
                return false;
            }
            try
            {
                // Line breaks flatten to spaces: the terminal is a line-based prompt, and a literal
                // Enter mid-text would submit early. One trailing Enter submits the whole prompt.
                var flat = new StringBuilder(text.Length);
                foreach (char ch in text)
                {
                    flat.Append(ch == '\\r' || ch == '\\n' ? ' ' : ch);
                }
                var records = new InputRecord[2];
                foreach (char ch in flat.ToString())
                {
                    records[0].EventType = KEY_EVENT;
                    records[0].KeyEvent = new KeyEventRecord { bKeyDown = true, wRepeatCount = 1, UnicodeChar = ch, wVirtualKeyCode = ch == '\\r' ? VK_RETURN : (ushort)0 };
                    records[1].EventType = KEY_EVENT;
                    records[1].KeyEvent = new KeyEventRecord { bKeyDown = false, wRepeatCount = 1, UnicodeChar = ch, wVirtualKeyCode = ch == '\\r' ? VK_RETURN : (ushort)0 };
                    uint written;
                    if (!WriteConsoleInputW(conIn, records, 2, out written))
                    {
                        error = "Couldn't type into the terminal: " + DescribeLastError(Marshal.GetLastWin32Error());
                        return false;
                    }
                    Thread.Sleep(1);
                }
                uint done;
                records[0].KeyEvent = new KeyEventRecord { bKeyDown = true, wRepeatCount = 1, wVirtualKeyCode = VK_RETURN, UnicodeChar = '\\r' };
                records[1].KeyEvent = new KeyEventRecord { bKeyDown = false, wRepeatCount = 1, wVirtualKeyCode = VK_RETURN, UnicodeChar = '\\r' };
                if (!WriteConsoleInputW(conIn, records, 2, out done))
                {
                    error = "Couldn't finish typing into the terminal: " + DescribeLastError(Marshal.GetLastWin32Error());
                    return false;
                }
                return true;
            }
            finally
            {
                CloseHandle(conIn);
            }
        }

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint code, uint mapType);

        // Presses keys one by one (no text, no trailing Enter): named keys (enter, escape, tab, space,
        // left, up, right, down) or single characters. Arrow keys are "enhanced" keys; the console
        // turns these records into the VT sequences a full-screen TUI reads.
        public static bool PressKeys(string[] keys, out string error)
        {
            error = string.Empty;
            IntPtr conIn = CreateFile("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (conIn == (IntPtr)(-1))
            {
                error = "Couldn't open the terminal's input: " + DescribeLastError(Marshal.GetLastWin32Error());
                return false;
            }
            try
            {
                var records = new InputRecord[2];
                foreach (string key in keys)
                {
                    ushort vk = 0;
                    char ch = (char)0;
                    uint state = 0;
                    switch ((key ?? "").ToLowerInvariant())
                    {
                        case "enter": vk = 0x0D; ch = (char)13; break;
                        case "escape": vk = 0x1B; ch = (char)27; break;
                        case "tab": vk = 0x09; ch = (char)9; break;
                        case "space": vk = 0x20; ch = ' '; break;
                        case "left": vk = 0x25; state = 0x0100; break;
                        case "up": vk = 0x26; state = 0x0100; break;
                        case "right": vk = 0x27; state = 0x0100; break;
                        case "down": vk = 0x28; state = 0x0100; break;
                        default:
                            if (key == null || key.Length != 1)
                            {
                                error = "Unknown key: " + key;
                                return false;
                            }
                            ch = key[0];
                            char upper = char.ToUpperInvariant(ch);
                            if ((upper >= 'A' && upper <= 'Z') || (upper >= '0' && upper <= '9')) vk = (ushort)upper;
                            break;
                    }
                    ushort scan = vk == 0 ? (ushort)0 : (ushort)MapVirtualKey(vk, 0);
                    records[0].EventType = KEY_EVENT;
                    records[0].KeyEvent = new KeyEventRecord { bKeyDown = true, wRepeatCount = 1, wVirtualKeyCode = vk, wVirtualScanCode = scan, UnicodeChar = ch, dwControlKeyState = state };
                    records[1].EventType = KEY_EVENT;
                    records[1].KeyEvent = new KeyEventRecord { bKeyDown = false, wRepeatCount = 1, wVirtualKeyCode = vk, wVirtualScanCode = scan, UnicodeChar = ch, dwControlKeyState = state };
                    uint written;
                    if (!WriteConsoleInputW(conIn, records, 2, out written))
                    {
                        error = "Couldn't press a key in the terminal: " + DescribeLastError(Marshal.GetLastWin32Error());
                        return false;
                    }
                    Thread.Sleep(150);
                }
                return true;
            }
            finally
            {
                CloseHandle(conIn);
            }
        }

        public static string ReadScreen(out string error)
        {
            error = string.Empty;
            IntPtr conOut = CreateFile("CONOUT$", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (conOut == (IntPtr)(-1))
            {
                error = "Couldn't open the terminal's output: " + DescribeLastError(Marshal.GetLastWin32Error());
                return null;
            }
            try
            {
                ConsoleScreenBufferInfo info;
                if (!GetConsoleScreenBufferInfo(conOut, out info))
                {
                    error = "Couldn't read the terminal's size: " + DescribeLastError(Marshal.GetLastWin32Error());
                    return null;
                }
                short left = info.srWindow.Left;
                int width = info.srWindow.Right - left + 1;
                var buffer = new char[width];
                var sb = new StringBuilder();
                for (short y = info.srWindow.Top; y <= info.srWindow.Bottom; y++)
                {
                    uint read;
                    var coord = new Coord { X = left, Y = y };
                    if (!ReadConsoleOutputCharacterW(conOut, buffer, (uint)width, coord, out read))
                    {
                        error = "Couldn't read the terminal's screen: " + DescribeLastError(Marshal.GetLastWin32Error());
                        return null;
                    }
                    int len = (int)read;
                    while (len > 0 && buffer[len - 1] == ' ') len--; // don't mirror the full-width padding
                    sb.Append(buffer, 0, len).Append('\\n');
                }
                return sb.ToString().TrimEnd();
            }
            finally
            {
                CloseHandle(conOut);
            }
        }

        private static string DescribeLastError(int code)
        {
            return new Win32Exception(code).Message;
        }
    }
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop

function Write-JsonLine
{
    param([string]$Line)
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}

$attachError = $null
if (-not [DeskMates.AttachHelper]::Attach([uint32]$TargetPid, [ref]$attachError))
{
    Write-JsonLine ('{"event":"error","message":' + (ConvertTo-Json -InputObject $attachError) + '}')
    exit 1
}
Write-JsonLine '{"event":"ready"}'

try
{
    while ($true)
    {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $cmd = ConvertFrom-Json -InputObject $line
        if ($null -eq $cmd) { continue }
        if ($cmd.cmd -eq 'exit') { break }
        if ($cmd.cmd -eq 'type')
        {
            $err = $null
            if (-not [DeskMates.AttachHelper]::TypeText([string]$cmd.text, [ref]$err))
            {
                Write-JsonLine ('{"event":"error","message":' + (ConvertTo-Json -InputObject $err) + '}')
            }
            continue
        }
        if ($cmd.cmd -eq 'keys')
        {
            $err = $null
            if (-not [DeskMates.AttachHelper]::PressKeys([string[]]@($cmd.keys), [ref]$err))
            {
                Write-JsonLine ('{"event":"error","message":' + (ConvertTo-Json -InputObject $err) + '}')
            }
            continue
        }
        if ($cmd.cmd -eq 'poll')
        {
            $err = $null
            $text = [DeskMates.AttachHelper]::ReadScreen([ref]$err)
            if ($null -eq $text)
            {
                Write-JsonLine ('{"event":"error","message":' + (ConvertTo-Json -InputObject $err) + '}')
            }
            else
            {
                Write-JsonLine ('{"event":"screen","text":' + (ConvertTo-Json -InputObject $text) + '}')
            }
            continue
        }
    }
}
catch
{
    Write-JsonLine ('{"event":"error","message":' + (ConvertTo-Json -InputObject $_.Exception.Message) + '}')
}

exit 0
`

/** Parses one line of the helper's JSON protocol; unknown shapes fall through to null. */
export function parseHelperEvent(line: string): AttachEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let event: unknown
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (event && typeof event === 'object') {
    const record = event as Record<string, unknown>
    if (record.event === 'ready') return { event: 'ready' }
    if (record.event === 'screen' && typeof record.text === 'string') return { event: 'screen', text: record.text }
    if (record.event === 'error' && typeof record.message === 'string') return { event: 'error', message: record.message }
  }
  return null
}

/** The real helper process: `powershell.exe`, its stdio piped, each stdout line parsed as an event. */
class PsAttachHelper implements AttachHelper {
  private readonly child: ChildProcess
  private readonly eventListeners = new Set<(event: AttachEvent) => void>()
  private readonly exitListeners = new Set<(code: number | null) => void>()
  private exited = false

  constructor(scriptPath: string, targetPid: number) {
    this.child = spawn(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TargetPid', String(targetPid)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout })
      rl.on('line', (line) => {
        const event = parseHelperEvent(line)
        if (event) this.eventListeners.forEach((listener) => listener(event))
      })
    }
    if (this.child.stderr) {
      const rl = createInterface({ input: this.child.stderr })
      rl.on('line', (line) => {
        if (line.trim()) this.eventListeners.forEach((listener) => listener({ event: 'error', message: line.trim() }))
      })
    }
    this.child.on('exit', (code) => this.fireExit(code))
    this.child.on('error', () => this.fireExit(null))
  }

  send(command: AttachCommand): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(command)}\n`)
    } catch {
      // Helper already gone; the exit event covers it.
    }
  }

  onEvent(listener: (event: AttachEvent) => void): void {
    this.eventListeners.add(listener)
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.add(listener)
  }

  kill(): void {
    try {
      this.child.kill()
    } catch {
      // Already gone.
    }
  }

  private fireExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitListeners.forEach((listener) => listener(code))
  }
}

/** The real spawner: materializes the embedded helper script into the temp dir once, then spawns it
 *  for each target pid. */
export class PsAttachHelperSpawner implements AttachHelperSpawner {
  private readonly scriptPath: string

  constructor(options: { tmpDir?: string } = {}) {
    this.scriptPath = join(options.tmpDir ?? tmpdir(), HELPER_FILE_NAME)
  }

  spawnHelper(targetPid: number): AttachHelper {
    const existing = existsSync(this.scriptPath) ? readFileSync(this.scriptPath, 'utf8') : null
    if (existing !== ATTACH_HELPER_SCRIPT) writeFileSync(this.scriptPath, ATTACH_HELPER_SCRIPT, 'utf8')
    return new PsAttachHelper(this.scriptPath, targetPid)
  }
}

interface Entry {
  session: AttachedTerminalSession
  helper: AttachHelper
  /** The last mirror the helper reported; fed to the onboarding tracker on every poll so the 90s
   *  ready-line timeout advances even when the terminal's screen isn't changing. */
  lastScreen: string
  pollTimer: ReturnType<typeof setInterval> | null
  /** The keys that answer each option of the permission prompt on screen now. */
  permissionKeys?: Record<string, TerminalKey[]>
  /** The last prompt the user was told about, so each one notifies once. */
  notifiedKey?: string
  /** The prompt just answered: hidden until the agent has had time to take it off the screen. */
  answered?: { key: string; at: number }
}

/** How long an answered prompt stays hidden while the agent redraws. */
const ANSWER_GRACE_MS = 2500

export interface AttachTerminalRunnerOptions {
  spawner: AttachHelperSpawner
  /** Path the primer tells the agent to read; passed to `buildPrimer`. */
  guidePath: string
  /** Absolute path of the mounted claude-code prompt, told to agents by the primer. */
  promptPath?: string
  /** The guide's current version and check phrase; used to prime and to recognize the ready line. */
  guideVersion: string
  phrase: string
  /** How often to ask the helper for a screen snapshot. Never emit-identical mirrors to the UI,
   *  but keep the onboarding timer ticking at this cadence. */
  pollMs?: number
  /** How long a primed attach has to confirm with the ready line before it counts as ``Didn't
   *  confirm`` (spec 5.14) — same default as the managed-mode tracker. */
  onboardingTimeoutMs?: number
  onSessionUpdated: (session: AttachedTerminalSession) => void
  /** The agent started asking a (new) permission question. */
  onPermission?: (session: AttachedTerminalSession, prompt: TerminalPermissionPrompt) => void
}

/**
 * Runs attached-terminal sessions (spec 5.14): spawns a helper per attach, types the primer and
 * the user's prompts into the target, and mirrors the target's screen back as the session's
 * `screen`. One poll per `pollMs` drives both the mirror and the onboarding watchdog. Outer
 * behavior only ever uses `AttachHelperSpawner` (never a real process), so tests fake the helper.
 */
export class AttachTerminalRunner {
  private readonly entries = new Map<string, Entry>()
  private readonly pidIndex = new Map<number, string>()
  private readonly onboarding: OnboardingTracker
  private readonly pollMs: number

  constructor(private readonly options: AttachTerminalRunnerOptions) {
    this.pollMs = options.pollMs ?? 1000
    this.onboarding = new OnboardingTracker({ timeoutMs: options.onboardingTimeoutMs ?? 90_000 })
  }

  list(): AttachedTerminalSession[] {
    return [...this.entries.values()].map((entry) => entry.session)
  }

  /** Attaches to a detected terminal the user already has open. Idempotent per pid: an already-
   *  attached (non-closed) session is returned as-is. The session starts in `attaching`; the first
   *  helper `ready` event kicks off the primer. */
  attach(pid: number, tool: TerminalTool): AttachedTerminalSession {
    const existingId = this.pidIndex.get(pid)
    if (existingId) {
      const existing = this.entries.get(existingId)
      if (existing && existing.session.state !== 'closed') return existing.session
    }

    const id = randomUUID()
    const now = Date.now()
    const session: AttachedTerminalSession = {
      id,
      tool,
      pid,
      state: 'attaching',
      onboarding: 'unknown',
      error: null,
      createdAt: now,
      updatedAt: now,
      screen: ''
    }
    const helper = this.options.spawner.spawnHelper(pid)
    const entry: Entry = { session, helper, lastScreen: '', pollTimer: null }
    this.entries.set(id, entry)
    this.pidIndex.set(pid, id)
    this.options.onSessionUpdated(session)

    helper.onEvent((event) => this.handleHelperEvent(entry, event))
    helper.onExit((code) => this.handleHelperExit(entry, code))
    entry.pollTimer = setInterval(() => this.poll(entry), this.pollMs)
    return session
  }

  /** Sends a user prompt to an attached terminal. If the check-in hasn't confirmed yet, the primer
   *  is re-sent first (the ready-line handshake), matching the managed-mode flow — the model can't
   *  be trusted to understand the user's text until it has read the guide. */
  send(id: string, text: string): void {
    const entry = this.requireAttached(id)
    if (entry.session.state === 'closed') throw new Error('That terminal was detached.')
    if (entry.session.state === 'error') throw new Error('That attached terminal has an error; detach and attach it again.')
    if (entry.session.state === 'attaching') throw new Error('That terminal is still connecting — try again in a moment.')
    const now = Date.now()
    if (isContextReset(text)) this.onboarding.noteUserInput(id, text)
    if (this.onboarding.needsPrimer(id, this.options.guideVersion)) this.prime(entry, now)
    entry.helper.send({ cmd: 'type', text })
    this.reflectState(entry)
  }

  /** Re-sends the primer (the ``Retry`` button) to an attached terminal whose check-in failed. */
  retry(id: string): void {
    const entry = this.requireAttached(id)
    if (entry.session.state === 'closed' || entry.session.state === 'error') {
      throw new Error(entry.session.state === 'closed' ? 'That terminal was detached.' : 'That attached terminal has an error.')
    }
    this.prime(entry, Date.now())
  }

  /** Answers the permission prompt on screen (identified by `key`) with one of its options. */
  answer(id: string, key: string, option: string): void {
    const entry = this.requireAttached(id)
    if (entry.session.state === 'closed' || entry.session.state === 'error') throw new Error('That terminal is no longer attached.')
    const prompt = entry.session.permission
    if (!prompt || prompt.key !== key || !entry.permissionKeys) throw new Error('The agent is no longer asking that question.')
    const keys = entry.permissionKeys[option]
    if (!keys) throw new Error('That is not one of the answers to this question.')
    entry.helper.send({ cmd: 'keys', keys })
    entry.answered = { key, at: Date.now() }
    entry.permissionKeys = undefined
    this.updateEntry(entry, { permission: null })
    entry.helper.send({ cmd: 'poll' })
  }

  /** Detaches: tells the helper to exit and stops polling. The user's terminal itself keeps running. */
  stop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.session.state === 'closed') return
    this.teardown(entry)
    this.updateEntry(entry, { state: 'closed' })
  }

  /** Stops every attached session; for app teardown. */
  close(): void {
    for (const id of [...this.entries.keys()]) this.stop(id)
  }

  private prime(entry: Entry, now: number): void {
    this.onboarding.markPrimed(entry.session.id, this.options.guideVersion, now)
    this.updateEntry(entry, { state: 'priming', onboarding: 'primed', error: null })
    entry.helper.send({ cmd: 'type', text: buildPrimer({ guidePath: this.options.guidePath, promptPath: this.options.promptPath }) })
  }

  private handleHelperEvent(entry: Entry, event: AttachEvent): void {
    const now = Date.now()
    if (event.event === 'ready') {
      // The helper has the target's console. First primer happens here; retry() re-primes later.
      if (entry.session.state === 'attaching') this.prime(entry, now)
      return
    }
    if (event.event === 'screen') {
      entry.lastScreen = event.text
      this.reflect(entry, now)
      return
    }
    if (event.event === 'error') {
      if (entry.session.state === 'closed') return
      clearIntervalSafe(entry)
      this.updateEntry(entry, { state: 'error', error: event.message })
      return
    }
  }

  private handleHelperExit(entry: Entry, code: number | null): void {
    clearIntervalSafe(entry)
    if (entry.session.state === 'closed') return
    // An unexpected helper death: if we were still waiting on the check-in, the ready line can never
    // arrive now — fail it rather than leave the badge hanging on ``Checking in…`` forever.
    if (this.onboarding.state(entry.session.id) === 'primed') entry.session.onboarding = 'failed'
    this.updateEntry(entry, {
      state: 'closed',
      error: entry.session.error ?? (code === null ? 'The attached terminal closed.' : `The terminal helper stopped (code ${code}).`)
    })
  }

  private poll(entry: Entry): void {
    if (entry.session.state === 'closed' || entry.session.state === 'error') return
    // Ask for a fresh mirror and let `reflect` also advance the onboarding watchdog.
    entry.helper.send({ cmd: 'poll' })
    this.reflect(entry, Date.now())
  }

  /** Mirrors the latest screen into the session and lets the onboarding tracker see it, emitting
   *  only when something actually changed (otherwise every poll would spam the UI). */
  private reflect(entry: Entry, now: number): void {
    const text = entry.lastScreen
    const observed = this.onboarding.observe(entry.session.id, text, this.options.phrase, now)
    const patch: Partial<AttachedTerminalSession> = {}
    if (observed === 'confirmed') {
      patch.onboarding = 'confirmed'
      patch.state = 'connected'
    } else if (observed === 'failed') {
      patch.onboarding = 'failed'
      patch.state = 'connected'
    } else if (observed === 'primed' && entry.session.state === 'attaching' && text) {
      patch.onboarding = 'primed'
      patch.state = 'priming'
    }
    const detected = text ? detectPermission(entry.session.tool, text) : null
    const recentlyAnswered = entry.answered && detected?.prompt.key === entry.answered.key && now - entry.answered.at < ANSWER_GRACE_MS
    const permission = detected && !recentlyAnswered ? detected.prompt : null
    entry.permissionKeys = permission ? detected!.keys : undefined
    if (permission && permission.key !== entry.notifiedKey) {
      entry.notifiedKey = permission.key
      this.options.onPermission?.(entry.session, permission)
    }
    if (!detected) entry.notifiedKey = undefined
    const permissionChanged = (permission?.key ?? null) !== (entry.session.permission?.key ?? null)
    const changed =
      text !== entry.session.screen ||
      permissionChanged ||
      (patch.onboarding != null && patch.onboarding !== entry.session.onboarding) ||
      (patch.state != null && patch.state !== entry.session.state)
    if (!changed) return
    this.updateEntry(entry, { ...patch, screen: text, permission })
  }

  /** Re-derives the session state from where the onboarding tracker got to (used after typing). */
  private reflectState(entry: Entry): void {
    const state = this.onboarding.state(entry.session.id)
    const patch: Partial<AttachedTerminalSession> =
      state === 'confirmed' ? { state: 'connected', onboarding: 'confirmed' } : state === 'failed' ? { state: 'connected', onboarding: 'failed' } : state === 'primed' ? { state: 'priming', onboarding: 'primed' } : { state: 'priming' }
    this.updateEntry(entry, patch)
  }

  private updateEntry(entry: Entry, patch: Partial<AttachedTerminalSession>): void {
    Object.assign(entry.session, patch, { updatedAt: Date.now() })
    this.options.onSessionUpdated(entry.session)
  }

  private teardown(entry: Entry): void {
    clearIntervalSafe(entry)
    entry.helper.send({ cmd: 'exit' })
    entry.helper.kill()
  }

  private requireAttached(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error("That attached terminal doesn't exist (it may have been detached).")
    return entry
  }
}

function clearIntervalSafe(entry: Entry): void {
  if (entry.pollTimer) {
    clearInterval(entry.pollTimer)
    entry.pollTimer = null
  }
}