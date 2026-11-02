import type { CommandRunner } from '../bots/command-runner'
import type { DetectedTerminalAgent, TerminalTool } from '../../shared/protocol'

/** The real executable name Windows reports for each tool. Chocolatey's `opencode.exe` is a thin
 *  shim that spawns a child process with the same name (verified on the development PC: a
 *  `serve` run showed a shim at `...\chocolatey\bin\opencode.exe` with a child at
 *  `...\chocolatey\lib\opencode\tools\opencode.exe`), so filtering by name alone catches both. */
const EXE_NAMES: Record<TerminalTool, string> = { opencode: 'opencode.exe', agy: 'agy.exe', freebuff: 'freebuff.exe' }

/** The bare command name on Linux/macOS, which is what `ps` shows. */
const POSIX_NAMES: Record<TerminalTool, string> = { opencode: 'opencode', agy: 'agy', freebuff: 'freebuff' }

const POWERSHELL_EXE = 'powershell.exe'

const PS_BIN = 'ps'

/** One row of `Get-CimInstance Win32_Process`, as `ConvertTo-Json` renders it on this PowerShell
 *  version: `CreationDate` comes back as a legacy WMI `/Date(millis)/` string, not ISO text. */
interface RawProcessRow {
  ProcessId: number
  ParentProcessId: number
  Name: string
  CommandLine: string | null
  CreationDate: string | null
}

function psScript(): string {
  const filter = Object.values(EXE_NAMES)
    .map((name) => `Name='${name}'`)
    .join(' or ')
  return (
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    `Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Depth 3`
  )
}

/** Parses a WMI-style `/Date(millis)/` string (what `ConvertTo-Json` produces for a CIM `DateTime`
 *  on Windows PowerShell 5.1) into an epoch-millisecond timestamp. */
export function parseWmiDate(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /\/Date\((\d+)\)\//.exec(value)
  return match ? Number(match[1]) : null
}

function toolForExeName(name: string): TerminalTool | null {
  const lower = name.toLowerCase()
  for (const tool of Object.keys(EXE_NAMES) as TerminalTool[]) {
    if (EXE_NAMES[tool] === lower) return tool
  }
  return null
}

/**
 * Which tool a `ps` row is, if any. `comm` is the executable name, but an npm/bun install runs the
 * tool as an interpreter (`node /usr/lib/node_modules/opencode/bin/opencode.js`), so `comm` says
 * `node` and only the command line says what it really is. Both the interpreter and the script
 * argument are checked, and a `.js` suffix on the script is ignored.
 */
function toolForPosixName(comm: string, commandLine: string): TerminalTool | null {
  const bare = (value: string): string => value.split('/').pop()?.toLowerCase() ?? ''
  const names = new Map(Object.entries(POSIX_NAMES).map(([tool, name]) => [name, tool as TerminalTool]))
  const named = (value: string): TerminalTool | null => {
    const base = bare(value).replace(/\.(js|mjs|cjs)$/, '')
    return names.get(base) ?? null
  }
  return named(comm) ?? named(commandLine.split(/\s+/)[0] ?? '') ?? named(commandLine.split(/\s+/)[1] ?? '')
}

/** Best-effort working folder read straight off the command line (a `--dir <path>` or `--dir=<path>`
 *  flag, or Freebuff's `--cwd`), never a filesystem or process-handle lookup — the app has no cheap way to read another
 *  process's real current directory on Windows, so a session started without `--dir` (attach mode's
 *  territory, or an interactively-launched `opencode`/`agy`) just reports `null`. */
export function folderFromCommandLine(commandLine: string): string | null {
  const match = /--(?:dir|cwd)[= ]"([^"]+)"|--(?:dir|cwd)[= ]([^\s"]+)/.exec(commandLine)
  if (!match) return null
  return match[1] ?? match[2] ?? null
}

/** Parses `Get-CimInstance` output (either the JSON array `ConvertTo-Json` writes for several rows,
 *  or the single-object form it writes for exactly one) into detected agent processes, collapsing a
 *  launcher shim into its real child when both share the same tool and a parent/child relationship —
 *  see `EXE_NAMES` above for why that matters on this machine. */
export function parseProcessListing(json: string): DetectedTerminalAgent[] {
  const trimmed = json.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const rows: RawProcessRow[] = parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed as RawProcessRow]

  const results: DetectedTerminalAgent[] = []
  for (const row of rows) {
    const tool = toolForExeName(row.Name)
    if (!tool) continue
    const hasChildOfSameTool = rows.some((other) => other.ParentProcessId === row.ProcessId && toolForExeName(other.Name) === tool)
    if (hasChildOfSameTool) continue // a launcher shim; its child below is the real, longer-lived process
    const commandLine = row.CommandLine ?? ''
    results.push({
      tool,
      pid: row.ProcessId,
      startedAt: parseWmiDate(row.CreationDate),
      commandLine,
      folder: folderFromCommandLine(commandLine)
    })
  }
  return results
}

/** One line of `ps -eo pid=,ppid=,etimes=,comm=,args=` output, space separated. `etimes` is seconds
 *  of elapsed time, which `ps` gives on Linux and macOS alike. */
interface PsRow {
  pid: number
  ppid: number
  elapsedSeconds: number
  comm: string
  commandLine: string
}

/** Splits `ps` output into rows, skipping anything that doesn't start with a pid. */
export function parsePsListing(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(trimmed)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsedSeconds: Number(match[3]),
      comm: match[4],
      commandLine: match[5].trim()
    })
  }
  return rows
}

/** Parses `ps` output into detected agents, collapsing an interpreter wrapper into the tool it
 *  launched (the same reasoning as the Windows shim collapse), and turning `etimes` into the epoch
 *  milliseconds the protocol asks for. */
export function parsePosixProcessListing(output: string, now: number): DetectedTerminalAgent[] {
  const rows = parsePsListing(output)
  const results: DetectedTerminalAgent[] = []
  for (const row of rows) {
    const tool = toolForPosixName(row.comm, row.commandLine)
    if (!tool) continue
    const hasChildOfSameTool = rows.some((other) => other.ppid === row.pid && toolForPosixName(other.comm, other.commandLine) === tool)
    if (hasChildOfSameTool) continue // a wrapper; its child below is the real, longer-lived process
    results.push({
      tool,
      pid: row.pid,
      startedAt: row.elapsedSeconds > 0 ? now - row.elapsedSeconds * 1000 : null,
      commandLine: row.commandLine,
      folder: folderFromCommandLine(row.commandLine)
    })
  }
  return results
}

/** Lists running OpenCode and agy processes through the command runner (never a direct child-process
 *  call), so tests can swap in a fake. Returns an empty list rather than throwing when the listing
 *  tool itself fails or prints nothing — a machine with neither tool running is the common case. */
export async function detectTerminalAgents(runner: CommandRunner, platform: NodeJS.Platform = process.platform): Promise<DetectedTerminalAgent[]> {
  if (platform === 'win32') {
    const result = await runner.run(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', psScript()], {
      timeoutMs: 15_000
    })
    if (result.code !== 0) return []
    return parseProcessListing(result.stdout)
  }
  // `comm` for the executable name, `etimes` for a start time, `args` for the working folder: three
  // fields the Windows listing has no equivalent for.
  const result = await runner.run(PS_BIN, ['-eo', 'pid=,ppid=,etimes=,comm=,args='], { timeoutMs: 15_000 })
  if (result.code !== 0) return []
  return parsePosixProcessListing(result.stdout, Date.now())
}
