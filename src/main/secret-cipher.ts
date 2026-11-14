import { spawn } from 'node:child_process'

/**
 * Encrypts and decrypts a batch of short strings with the platform's per-user secret store:
 * Windows DPAPI, or the OS keyring (libsecret/kwallet) through Electron's safeStorage.
 */
export interface SecretCipher {
  /**
   * Marker written in front of every blob this cipher produces, so a file written on one platform
   * is never handed to another platform's cipher. Entries without any marker are the older
   * `safeStorage`-only format.
   */
  readonly prefix: string
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

/** Binds each saved key to the current Windows user account through DPAPI. */
export const windowsDpapi: SecretCipher = {
  prefix: 'dpapi:',
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

/**
 * Electron's safeStorage, which is DPAPI on Windows and the desktop keyring (libsecret/kwallet) on
 * Linux and macOS. `electron` is imported lazily so this module stays loadable from plain Node tests.
 */
async function safeStorageModule(): Promise<typeof import('electron').safeStorage> {
  const { safeStorage } = await import('electron')
  return safeStorage
}

const NO_KEYRING =
  'Saving an API key needs an encrypted keyring, and this Linux system does not have one available. ' +
  'Install one and sign in to it — on Ubuntu, "sudo apt install gnome-keyring" (GNOME) or ' +
  '"libsecret-tools" (KDE) — then start Deskmates from inside your desktop session and try again.'

/** Binds each saved key to the desktop keyring's unlocked session. */
export const osKeyring: SecretCipher = {
  prefix: 'oskeyring:',
  async protect(items) {
    if (Object.keys(items).length === 0) return {}
    const safeStorage = await safeStorageModule()
    if (!safeStorage.isEncryptionAvailable()) throw new Error(NO_KEYRING)
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(items)) {
      try {
        out[key] = safeStorage.encryptString(value).toString('base64')
      } catch (error) {
        throw new Error(`${NO_KEYRING} (${(error as Error).message})`)
      }
    }
    return out
  },
  async unprotect(items) {
    const keys = Object.keys(items)
    if (keys.length === 0) return {}
    const safeStorage = await safeStorageModule()
    // A missing or locked keyring is not an error here: the contract says an unreadable entry comes
    // back null, and the store turns that into "this key has to be entered again".
    if (!safeStorage.isEncryptionAvailable()) return Object.fromEntries(keys.map((key) => [key, null]))
    return Object.fromEntries(
      keys.map((key) => {
        try {
          return [key, safeStorage.decryptString(Buffer.from(items[key], 'base64'))]
        } catch {
          return [key, null]
        }
      })
    )
  }
}

/** The cipher for the platform the app is running on. */
export function createSecretCipher(): SecretCipher {
  return process.platform === 'win32' ? windowsDpapi : osKeyring
}
