/**
 * Where the user's Chrome listens for DevTools connections.
 *
 * 1. DESKMATES_CHROME_URL, when the user set one (ws://… or http://host:port).
 * 2. The DevToolsActivePort file Chrome writes into its profile folder once the user turns remote
 *    debugging on at chrome://inspect/#remote-debugging (Chrome 144 and later). This is the user's
 *    own signed-in Chrome; Chrome asks them to allow each new connection.
 * 3. A Chrome started with --remote-debugging-port=9222 (it needs its own --user-data-dir since
 *    Chrome 136, so it's a separate profile).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ChromeEndpoint {
  /** The browser's DevTools WebSocket. */
  url: string
  /** Where it came from, for messages and logs. */
  source: 'setting' | 'profile' | 'port'
  /** The profile folder, when found through DevToolsActivePort. */
  profile?: string
}

/** Chrome's profile folders on this OS: stable first, then Beta, Dev and Canary. */
export function chromeProfileDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'].map((name) => join(local, 'Google', name, 'User Data'))
  }
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support', 'Google')
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome Canary'].map((name) => join(base, name))
  }
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium'].map((name) => join(config, name))
}

/** The WebSocket address in a DevToolsActivePort file ("9222\n/devtools/browser/…"), or null. */
export function parseActivePort(text: string): string | null {
  const [portLine, pathLine] = text.replace(/^﻿/, '').split(/\r?\n/)
  const port = Number(portLine?.trim())
  const path = pathLine?.trim() ?? ''
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !path.startsWith('/devtools/browser/')) return null
  return `ws://127.0.0.1:${port}${path}`
}

/** Every place Chrome may be listening, best first. Files that don't exist are skipped. */
export function candidateEndpoints(options: { env?: NodeJS.ProcessEnv; dirs?: string[]; port?: number } = {}): Array<ChromeEndpoint | { http: string; source: 'setting' | 'port' }> {
  const env = options.env ?? process.env
  const out: Array<ChromeEndpoint | { http: string; source: 'setting' | 'port' }> = []
  const setting = env.DESKMATES_CHROME_URL?.trim()
  if (setting) out.push(/^wss?:/i.test(setting) ? { url: setting, source: 'setting' } : { http: setting.replace(/\/+$/, ''), source: 'setting' })
  for (const dir of options.dirs ?? chromeProfileDirs(env)) {
    const file = join(dir, 'DevToolsActivePort')
    if (!existsSync(file)) continue
    try {
      const url = parseActivePort(readFileSync(file, 'utf8'))
      if (url) out.push({ url, source: 'profile', profile: dir })
    } catch {
      // Unreadable: try the next one.
    }
  }
  out.push({ http: `http://127.0.0.1:${options.port ?? 9222}`, source: 'port' })
  return out
}

/** Asks a DevTools HTTP endpoint for its browser WebSocket; null when nothing answers there. */
export async function browserSocketAt(http: string, timeoutMs = 1500): Promise<string | null> {
  try {
    const response = await fetch(`${http}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const body = (await response.json()) as { webSocketDebuggerUrl?: string }
    return typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : null
  } catch {
    return null
  }
}

export const CHROME_SETUP_HELP =
  "Deskmates can't reach the user's Chrome. Ask the user to: 1) open Google Chrome (version 144 or later), 2) go to chrome://inspect/#remote-debugging and turn remote debugging on, 3) click Allow when Chrome asks whether to allow the connection. Then try again. (A Chrome started with --remote-debugging-port=9222 and its own --user-data-dir works too.)"
