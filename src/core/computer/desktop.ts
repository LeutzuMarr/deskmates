import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const HELPER_FILE_NAME = 'deskmates-desktop-helper.ps1'

export type MouseButton = 'left' | 'right' | 'middle'

/** A screenshot of the primary screen, scaled down to at most the requested width. */
export interface Screenshot {
  /** Base64 JPEG. */
  data: string
  width: number
  height: number
  /** The real screen size in physical pixels; model coordinates are scaled up to this. */
  screenWidth: number
  screenHeight: number
}

/** The user's own mouse, keyboard and screen. Coordinates are physical screen pixels. */
export interface Desktop {
  screenshot(maxWidth: number): Promise<Screenshot>
  move(x: number, y: number): Promise<void>
  click(x: number, y: number, button: MouseButton, count: number): Promise<void>
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>
  scroll(x: number, y: number, amount: number): Promise<void>
  type(text: string): Promise<void>
  key(combo: string): Promise<void>
  /** Opens an http(s) address in the default browser. */
  openUrl(url: string): Promise<void>
  close(): void
}

/**
 * The helper script, embedded so it ships inside the core bundle. ASCII only: it is written without a
 * BOM, which Windows PowerShell 5.1 reads as the ANSI code page. Text to type arrives as \\u escapes
 * in the JSON line (see `encodeCommand`), so the console input encoding never matters.
 */
export const DESKTOP_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class DmShot { public string Data; public int Width; public int Height; public int ScreenWidth; public int ScreenHeight; }

public static class DmDesk {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }

  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1, WHEEL = 0x800;

  public static void Init() { SetProcessDPIAware(); }

  static void Send(INPUT input) { SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, uint data) { var i = new INPUT { type = 0 }; i.U.mi.dwFlags = flags; i.U.mi.mouseData = data; Send(i); }
  static void Key(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = 1 }; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; Send(i); }

  public static DmShot Shot(int maxWidth) {
    Rectangle b = Screen.PrimaryScreen.Bounds;
    var result = new DmShot { ScreenWidth = b.Width, ScreenHeight = b.Height };
    using (var full = new Bitmap(b.Width, b.Height)) {
      using (var g = Graphics.FromImage(full)) { g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size); }
      double s = b.Width > maxWidth ? (double)maxWidth / b.Width : 1.0;
      result.Width = (int)Math.Round(b.Width * s);
      result.Height = (int)Math.Round(b.Height * s);
      using (var small = new Bitmap(result.Width, result.Height)) {
        using (var g2 = Graphics.FromImage(small)) { g2.InterpolationMode = InterpolationMode.HighQualityBicubic; g2.DrawImage(full, 0, 0, result.Width, result.Height); }
        ImageCodecInfo jpeg = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        var ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 75L);
        using (var ms = new MemoryStream()) { small.Save(ms, jpeg, ps); result.Data = Convert.ToBase64String(ms.ToArray()); }
      }
    }
    return result;
  }

  public static void Move(int x, int y) { SetCursorPos(x, y); }

  static uint Down(string b) { return b == "right" ? 0x8u : b == "middle" ? 0x20u : 0x2u; }
  static uint Up(string b) { return b == "right" ? 0x10u : b == "middle" ? 0x40u : 0x4u; }

  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y); Thread.Sleep(40);
    for (int n = 0; n < count; n++) { Mouse(Down(button), 0); Thread.Sleep(30); Mouse(Up(button), 0); Thread.Sleep(60); }
  }

  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); Thread.Sleep(40); Mouse(0x2, 0); Thread.Sleep(80);
    for (int n = 1; n <= 12; n++) { SetCursorPos(x1 + (x2 - x1) * n / 12, y1 + (y2 - y1) * n / 12); Thread.Sleep(20); }
    Thread.Sleep(60); Mouse(0x4, 0);
  }

  public static void Scroll(int x, int y, int amount) {
    SetCursorPos(x, y); Thread.Sleep(30); Mouse(WHEEL, unchecked((uint)(amount * 120)));
  }

  public static void Type(string text) {
    foreach (char ch in text) {
      if (ch == '\\r') continue;
      if (ch == '\\n') { Key(0x0D, 0, 0); Key(0x0D, 0, KEYUP); }
      else { Key(0, ch, UNICODE); Key(0, ch, UNICODE | KEYUP); }
      Thread.Sleep(8);
    }
  }

  static ushort Vk(string name) {
    switch (name) {
      case "ctrl": case "control": return 0x11;
      case "alt": return 0x12;
      case "shift": return 0x10;
      case "win": case "super": case "meta": case "cmd": case "windows": return 0x5B;
      case "enter": case "return": return 0x0D;
      case "tab": return 0x09;
      case "esc": case "escape": return 0x1B;
      case "backspace": return 0x08;
      case "delete": case "del": return 0x2E;
      case "insert": return 0x2D;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": return 0x21;
      case "pagedown": return 0x22;
      case "up": return 0x26;
      case "down": return 0x28;
      case "left": return 0x25;
      case "right": return 0x27;
      case "space": return 0x20;
      case "capslock": return 0x14;
      case "printscreen": return 0x2C;
    }
    if (name.Length > 1 && name[0] == 'f') { int f; if (int.TryParse(name.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x6F + f); }
    if (name.Length == 1) {
      char c = char.ToUpperInvariant(name[0]);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
      short k = VkKeyScan(name[0]);
      if (k != -1) return (ushort)(k & 0xFF);
    }
    throw new ArgumentException("Unknown key: " + name);
  }

  static uint Ext(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B ? EXTENDED : 0u; }

  public static void Press(string combo) {
    string[] parts = combo.ToLowerInvariant().Replace(" ", "").Split('+');
    var vks = new ushort[parts.Length];
    for (int n = 0; n < parts.Length; n++) vks[n] = Vk(parts[n]);
    foreach (var vk in vks) { Key(vk, 0, Ext(vk)); Thread.Sleep(15); }
    for (int n = vks.Length - 1; n >= 0; n--) { Key(vks[n], 0, Ext(vks[n]) | KEYUP); Thread.Sleep(15); }
  }
}
'@
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition $source
[DmDesk]::Init()
[Console]::Out.WriteLine('{"event":"ready"}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $reply = @{ id = 0; ok = $true }
  try {
    $c = $line | ConvertFrom-Json
    $reply.id = $c.id
    switch ($c.cmd) {
      'screenshot' {
        $s = [DmDesk]::Shot([int]$c.maxWidth)
        $reply.data = $s.Data; $reply.width = $s.Width; $reply.height = $s.Height
        $reply.screenWidth = $s.ScreenWidth; $reply.screenHeight = $s.ScreenHeight
      }
      'move' { [DmDesk]::Move([int]$c.x, [int]$c.y) }
      'click' { [DmDesk]::Click([int]$c.x, [int]$c.y, [string]$c.button, [int]$c.count) }
      'drag' { [DmDesk]::Drag([int]$c.x, [int]$c.y, [int]$c.toX, [int]$c.toY) }
      'scroll' { [DmDesk]::Scroll([int]$c.x, [int]$c.y, [int]$c.amount) }
      'type' { [DmDesk]::Type([string]$c.text) }
      'key' { [DmDesk]::Press([string]$c.combo) }
      default { throw "Unknown command: $($c.cmd)" }
    }
  } catch {
    $reply.ok = $false
    $reply.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`

type HelperCommand =
  | { cmd: 'screenshot'; maxWidth: number }
  | { cmd: 'move'; x: number; y: number }
  | { cmd: 'click'; x: number; y: number; button: MouseButton; count: number }
  | { cmd: 'drag'; x: number; y: number; toX: number; toY: number }
  | { cmd: 'scroll'; x: number; y: number; amount: number }
  | { cmd: 'type'; text: string }
  | { cmd: 'key'; combo: string }

/** One JSON line, with every non-ASCII character as a \\u escape (see DESKTOP_HELPER_SCRIPT). */
export function encodeCommand(id: number, command: HelperCommand): string {
  return JSON.stringify({ id, ...command }).replace(
    /[\u007f-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

type Reply = { id: number; ok: boolean; error?: string } & Partial<Screenshot>

/** The real desktop: one long-lived PowerShell helper, so each action costs milliseconds, not a PowerShell startup. */
export class WindowsDesktop implements Desktop {
  private child: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>()

  constructor(private readonly scriptDir: string = tmpdir()) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const scriptPath = join(this.scriptDir, HELPER_FILE_NAME)
    const existing = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : null
    if (existing !== DESKTOP_HELPER_SCRIPT) writeFileSync(scriptPath, DESKTOP_HELPER_SCRIPT, 'utf8')

    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    const stderr: string[] = []
    this.ready = new Promise<void>((resolve, reject) => {
      const fail = (message: string): void => {
        const error = new Error(message)
        reject(error)
        for (const waiter of this.pending.values()) waiter.reject(error)
        this.pending.clear()
        this.child = null
        this.ready = null
      }
      createInterface({ input: child.stdout! }).on('line', (line) => {
        let message: Reply | { event: string }
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if ('event' in message) {
          if (message.event === 'ready') resolve()
          return
        }
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.ok) waiter.resolve(message)
        else waiter.reject(new Error(message.error ?? 'The desktop action failed.'))
      })
      createInterface({ input: child.stderr! }).on('line', (line) => {
        if (stderr.length < 20) stderr.push(line)
      })
      child.on('error', (error) => fail(`Couldn't start the desktop helper: ${error.message}`))
      child.on('close', () => fail(`The desktop helper stopped. ${stderr.join(' ').slice(0, 400)}`.trim()))
    })
    return this.ready
  }

  private async send(command: HelperCommand): Promise<Reply> {
    await this.start()
    const id = this.nextId++
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child?.stdin?.write(`${encodeCommand(id, command)}\n`)
    })
  }

  async screenshot(maxWidth: number): Promise<Screenshot> {
    const reply = await this.send({ cmd: 'screenshot', maxWidth })
    return {
      data: reply.data ?? '',
      width: reply.width ?? 0,
      height: reply.height ?? 0,
      screenWidth: reply.screenWidth ?? 0,
      screenHeight: reply.screenHeight ?? 0
    }
  }

  async move(x: number, y: number): Promise<void> {
    await this.send({ cmd: 'move', x, y })
  }

  async click(x: number, y: number, button: MouseButton, count: number): Promise<void> {
    await this.send({ cmd: 'click', x, y, button, count })
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.send({ cmd: 'drag', x: fromX, y: fromY, toX, toY })
  }

  async scroll(x: number, y: number, amount: number): Promise<void> {
    await this.send({ cmd: 'scroll', x, y, amount })
  }

  async type(text: string): Promise<void> {
    await this.send({ cmd: 'type', text })
  }

  async key(combo: string): Promise<void> {
    await this.send({ cmd: 'key', combo })
  }

  async openUrl(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only web addresses can be opened.')
    // explorer.exe hands the address to the default browser; no shell is involved, so nothing in it runs.
    const child = spawn('explorer.exe', [parsed.toString()], { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  }

  close(): void {
    const child = this.child
    this.child = null
    this.ready = null
    if (!child) return
    try {
      child.stdin?.end()
      child.kill()
    } catch {
      // Already gone.
    }
  }
}
