import type { CommandRunner } from '../bots/command-runner'
import type { DetectedTerminalAgent, TerminalTool } from '../../shared/protocol'

/** The real executable name Windows reports for each tool. Chocolatey's `opencode.exe` is a thin
 *  shim that spawns a child process with the same name (verified on the development PC: a
 *  `serve` run showed a shim at `...\chocolatey\bin\opencode.exe` with a child at
 *  `...\chocolatey\lib\opencode\tools\opencode.exe`), so filtering by name alone catches both. */
const EXE_NAMES: Record<TerminalTool, string> = { opencode: 'opencode.exe', agy: 'agy.exe' }

const POWERSHELL_EXE = 'powershell.exe'

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

/** Best-effort working folder read straight off the command line (a `--dir <path>` or `--dir=<path>`
 *  flag), never a filesystem or process-handle lookup — the app has no cheap way to read another
 *  process's real current directory on Windows, so a session started without `--dir` (attach mode's
 *  territory, or an interactively-launched `opencode`/`agy`) just reports `null`. */
export function folderFromCommandLine(commandLine: string): string | null {
  const match = /--dir[= ]"([^"]+)"|--dir[= ]([^\s"]+)/.exec(commandLine)
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

/** Lists running OpenCode and agy processes through the command runner (never a direct child-process
 *  call), so tests can swap in a fake. Returns an empty list rather than throwing when PowerShell
 *  itself fails or prints nothing — a machine with neither tool running is the common case. */
export async function detectTerminalAgents(runner: CommandRunner): Promise<DetectedTerminalAgent[]> {
  const result = await runner.run(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', psScript()], {
    timeoutMs: 15_000
  })
  if (result.code !== 0) return []
  return parseProcessListing(result.stdout)
}
