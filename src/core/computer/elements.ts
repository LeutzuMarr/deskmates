import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 8000

/** Something on screen the user can click or type into, in physical screen pixels. */
export interface ScreenElement {
  type: string
  name: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Lists the clickable things in the focused window and the taskbar through Windows UI Automation (the
 * accessibility API screen readers use), so an agent can click a button by number instead of guessing
 * from a screenshot, and models that can't see images can still work. ASCII only: the file is written
 * without a BOM, which Windows PowerShell 5.1 reads as the ANSI code page.
 */
export const ELEMENTS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DmFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string name);
}
'@
[void][DmFg]::SetProcessDPIAware()
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.ControlType]
$types = @($T::Button, $T::Hyperlink, $T::MenuItem, $T::ListItem, $T::TabItem, $T::CheckBox, $T::RadioButton, $T::Edit, $T::ComboBox, $T::TreeItem, $T::SplitButton)
$conditions = [System.Windows.Automation.Condition[]]@($types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $_) })
$any = New-Object System.Windows.Automation.OrCondition($conditions)
$found = New-Object System.Collections.ArrayList
$windows = @([DmFg]::GetForegroundWindow(), [DmFg]::FindWindow('Shell_TrayWnd', $null)) | Select-Object -Unique
foreach ($hwnd in $windows) {
  if ($hwnd -eq [IntPtr]::Zero) { continue }
  try { $root = $A::FromHandle($hwnd) } catch { continue }
  foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $any)) {
    if ($found.Count -ge 150) { break }
    $c = $e.Current
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 4 -or $r.Height -lt 4) { continue }
    $name = ($c.Name -replace '\\s+', ' ').Trim()
    if (-not $name) { $name = ($c.HelpText -replace '\\s+', ' ').Trim() }
    $type = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
    if (-not $name -and $type -ne 'Edit') { continue }
    if ($name.Length -gt 80) { $name = $name.Substring(0, 80) }
    [void]$found.Add([ordered]@{ type = $type; name = $name; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; password = [bool]$c.IsPassword })
  }
}
ConvertTo-Json -InputObject @($found) -Compress -Depth 3
`

/** Whether the focused control is a password box, as Windows reports it. */
export const FOCUSED_PASSWORD_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
try { $f = [System.Windows.Automation.AutomationElement]::FocusedElement; if ($f -and $f.Current.IsPassword) { 'yes' } else { 'no' } } catch { 'no' }
`

function runScript(name: string, script: string): Promise<string> {
  const scriptPath = join(tmpdir(), name)
  const existing = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : null
  if (existing !== script) writeFileSync(scriptPath, script, 'utf8')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (_error, stdout) => resolve(String(stdout ?? '').trim())
    )
  })
}

/** The clickable things on screen now (focused window and taskbar). Empty if Windows doesn't answer in time. */
export async function listElements(): Promise<Array<ScreenElement & { password?: boolean }>> {
  if (process.platform !== 'win32') return []
  try {
    const parsed = JSON.parse((await runScript('deskmates-elements.ps1', ELEMENTS_SCRIPT)) || '[]') as unknown
    return Array.isArray(parsed) ? (parsed as Array<ScreenElement & { password?: boolean }>) : []
  } catch {
    return []
  }
}

export async function focusedIsPassword(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return (await runScript('deskmates-focused-password.ps1', FOCUSED_PASSWORD_SCRIPT)) === 'yes'
}

/** The numbered list an agent sees under the screenshot, in screenshot pixels (centre of each element). */
export function describeElements(elements: Array<ScreenElement & { password?: boolean }>, scale: number): string {
  if (elements.length === 0) return 'No clickable elements were reported for this screen; use x/y from the screenshot.'
  const rows = elements.map((e, i) => {
    const cx = Math.round((e.x + e.w / 2) / scale)
    const cy = Math.round((e.y + e.h / 2) / scale)
    return `[${i + 1}] ${e.type} "${e.name}" at (${cx}, ${cy})${e.password ? ' (password: only the user types here)' : ''}`
  })
  return `Clickable things on screen (pass element: N to click one exactly):\n${rows.join('\n')}`
}
