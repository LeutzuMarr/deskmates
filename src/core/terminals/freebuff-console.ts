import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Types into and reads the screen of a console window, through the Windows console API
 * (`AttachConsole` + `WriteConsoleInputW`/`ReadConsoleOutputCharacterW`). The script is the same
 * one attach mode uses (attach.ts), plus a focus-in command and Backspace; it is pointed at the hidden console Freebuff runs in.
 */
export type ConsoleCommand = { cmd: 'type'; text: string } | { cmd: 'keys'; keys: string[] } | { cmd: 'focus' } | { cmd: 'poll' } | { cmd: 'exit' }

export type ConsoleEvent = { event: 'ready' } | { event: 'screen'; text: string } | { event: 'error'; message: string }

export const CONSOLE_HELPER_SCRIPT = `param([Parameter(Mandatory=$true)][int]$TargetPid)

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

        // Tells the program in the console that its window has focus, without giving the hidden
        // window real focus. Two ways, since apps listen for one or the other: a console focus
        // record, and the terminal "focus in" sequence (ESC [ I), sent quickly so it reads as one.
        public static bool SendFocus(out string error)
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
                uint written;
                // FOCUS_EVENT_RECORD is a single BOOL where the key record starts, so bKeyDown is bSetFocus.
                var focus = new InputRecord[1];
                focus[0].EventType = 0x0010;
                focus[0].KeyEvent = new KeyEventRecord { bKeyDown = true };
                WriteConsoleInputW(conIn, focus, 1, out written);
                string sequence = "\\u001b[I";
                var records = new InputRecord[sequence.Length * 2];
                for (int i = 0; i < sequence.Length; i++)
                {
                    records[i * 2].EventType = KEY_EVENT;
                    records[i * 2].KeyEvent = new KeyEventRecord { bKeyDown = true, wRepeatCount = 1, UnicodeChar = sequence[i] };
                    records[i * 2 + 1].EventType = KEY_EVENT;
                    records[i * 2 + 1].KeyEvent = new KeyEventRecord { bKeyDown = false, wRepeatCount = 1, UnicodeChar = sequence[i] };
                }
                if (!WriteConsoleInputW(conIn, records, (uint)records.Length, out written))
                {
                    error = "Couldn't send focus to the terminal: " + DescribeLastError(Marshal.GetLastWin32Error());
                    return false;
                }
                return true;
            }
            finally
            {
                CloseHandle(conIn);
            }
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
                        case "backspace": vk = 0x08; ch = (char)8; break;
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
                    // Backspaces come in runs to clear a leftover draft; other keys drive menus, which
                    // need time to redraw between presses.
                    Thread.Sleep(vk == 0x08 ? 15 : 150);
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
        if ($cmd.cmd -eq 'focus')
        {
            $err = $null
            if (-not [DeskMates.AttachHelper]::SendFocus([ref]$err))
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

const HELPER_FILE_NAME = 'deskmates-freebuff-console.ps1'

/** Parses one line of the helper's JSON protocol; anything else is null. */
export function parseConsoleEvent(line: string): ConsoleEvent | null {
  let event: unknown
  try {
    event = JSON.parse(line.trim())
  } catch {
    return null
  }
  if (!event || typeof event !== 'object') return null
  const record = event as Record<string, unknown>
  if (record.event === 'ready') return { event: 'ready' }
  if (record.event === 'screen' && typeof record.text === 'string') return { event: 'screen', text: record.text }
  if (record.event === 'error' && typeof record.message === 'string') return { event: 'error', message: record.message }
  return null
}

/** One helper process attached to one console. */
export class ConsoleHelper {
  private readonly child: ChildProcess
  private readonly listeners = new Set<(event: ConsoleEvent) => void>()

  constructor(targetPid: number, onExit: () => void) {
    const scriptPath = join(tmpdir(), HELPER_FILE_NAME)
    const existing = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : null
    if (existing !== CONSOLE_HELPER_SCRIPT) writeFileSync(scriptPath, CONSOLE_HELPER_SCRIPT, 'utf8')
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TargetPid', String(targetPid)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      const event = parseConsoleEvent(line)
      if (event) this.listeners.forEach((listener) => listener(event))
    })
    createInterface({ input: this.child.stderr! }).on('line', (line) => {
      if (line.trim()) this.listeners.forEach((listener) => listener({ event: 'error', message: line.trim() }))
    })
    this.child.on('exit', onExit)
    this.child.on('error', onExit)
  }

  onEvent(listener: (event: ConsoleEvent) => void): void {
    this.listeners.add(listener)
  }

  send(command: ConsoleCommand): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(command)}\n`)
    } catch {
      // Already gone; the exit handler covers it.
    }
  }

  kill(): void {
    try {
      this.child.kill()
    } catch {
      // Already gone.
    }
  }
}
