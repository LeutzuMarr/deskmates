import { spawn } from 'node:child_process'

/** Encrypts and decrypts with Windows DPAPI for the current Windows user. */
export interface Dpapi {
  /** Plain strings in, encrypted base64 blobs out (same keys). */
  protect(items: Record<string, string>): Promise<Record<string, string>>
  /** Encrypted base64 blobs in, plain strings out; an entry that won't decrypt comes back null. */
  unprotect(items: Record<string, string>): Promise<Record<string, string | null>>
}

/**
 * The script only ever sees base64 on stdin and writes base64 to stdout, so secrets never appear on a
 * command line (visible to other processes) and no character encoding can mangle them.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$out = @{}
foreach ($item in $request.items.PSObject.Properties) {
  $bytes = [Convert]::FromBase64String($item.Value)
  if ($request.mode -eq 'protect') {
    $out[$item.Name] = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope))
  } else {
    try { $out[$item.Name] = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)) }
    catch { $out[$item.Name] = $null }
  }
}
[Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress))
`

const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64')

function run(mode: 'protect' | 'unprotect', items: Record<string, string>): Promise<Record<string, string | null>> {
  if (Object.keys(items).length === 0) return Promise.resolve({})
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', (error) => reject(new Error(`Windows encryption failed to start: ${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Windows encryption failed. ${stderr.trim().slice(0, 300)}`))
      try {
        resolve(JSON.parse(stdout) as Record<string, string | null>)
      } catch {
        reject(new Error('Windows encryption returned an unreadable answer.'))
      }
    })
    child.stdin.end(JSON.stringify({ mode, items }))
  })
}

export const windowsDpapi: Dpapi = {
  async protect(items) {
    const encoded = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]))
    const result = await run('protect', encoded)
    const out: Record<string, string> = {}
    for (const key of Object.keys(items)) {
      const blob = result[key]
      if (!blob) throw new Error('Windows encryption returned nothing.')
      out[key] = blob
    }
    return out
  },
  async unprotect(items) {
    const result = await run('unprotect', items)
    return Object.fromEntries(
      Object.keys(items).map((key) => {
        const plain = result[key]
        return [key, plain ? Buffer.from(plain, 'base64').toString('utf8') : null]
      })
    )
  }
}
