/**
 * Connects command-line agents to the deskmates-prompt MCP server (the operating prompt's tools).
 *
 * Freebuff reads MCP servers from .agents/mcp.json in its folder, the folder above, and the home
 * folder; the home one needs no trust prompt. So the server goes into ~/.agents/mcp.json, under its
 * own key, next to whatever the user keeps there, and project folders are never written to. The
 * server starts whether or not Deskmates runs, so it never stops Freebuff from starting.
 *
 * OpenCode gets it through OPENCODE_CONFIG_CONTENT on the servers Deskmates starts, so the user's
 * own opencode.json is untouched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROMPT_MCP_KEY = 'deskmates-prompt'

let agentCommand: string | null = null

/** Records the agent kit's deskmates command, which runs the server (`deskmates prompt-mcp`). */
export function setPromptToolsCommand(command: string): void {
  agentCommand = command
}

function commandLine(command: string): { command: string; args: string[] } {
  return process.platform === 'win32' ? { command: 'cmd.exe', args: ['/d', '/c', command, 'prompt-mcp'] } : { command, args: ['prompt-mcp'] }
}

/**
 * Takes Deskmates' server back out of ~/.agents/mcp.json, which every Freebuff session on the PC
 * reads (the user's own ones too). Deskmates added it on Nov 21, 2026; Freebuff is left as it was
 * before. Only Deskmates' own entry goes; a file that held nothing else is removed, and anything
 * else the user keeps there stays. Returns what happened, for the log.
 */
export function removeFreebuffPromptTools(home = homedir()): 'removed' | 'absent' | 'skipped' {
  const file = join(home, '.agents', 'mcp.json')
  if (!existsSync(file)) return 'absent'
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown>
  try {
    const raw = readFileSync(file, 'utf8').replace(/^﻿/, '')
    config = raw.trim() ? JSON.parse(raw) : {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'skipped'
  } catch {
    return 'skipped'
  }
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? { ...config.mcpServers } : {}
  if (!(PROMPT_MCP_KEY in servers)) return 'absent'
  delete servers[PROMPT_MCP_KEY]
  const { mcpServers: _old, ...rest } = config
  if (Object.keys(servers).length === 0 && Object.keys(rest).length === 0) {
    rmSync(file, { force: true })
    return 'removed'
  }
  writeFileSync(file, `${JSON.stringify(Object.keys(servers).length ? { ...rest, mcpServers: servers } : rest, null, 2)}\n`, 'utf8')
  return 'removed'
}

/**
 * No longer used: Deskmates doesn't add itself to Freebuff's config any more (see
 * removeFreebuffPromptTools). Kept for the tests of the file handling.
 */
export function ensureFreebuffPromptTools(command: string, home = homedir()): 'written' | 'unchanged' | 'skipped' {
  const dir = join(home, '.agents')
  const file = join(dir, 'mcp.json')
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf8').replace(/^﻿/, '')
      config = raw.trim() ? JSON.parse(raw) : {}
      if (!config || typeof config !== 'object' || Array.isArray(config)) return 'skipped'
    } catch {
      return 'skipped'
    }
  }
  const { command: cmd, args } = commandLine(command)
  const entry = { command: cmd, args, env: { DESKMATES_AGENT: 'Freebuff' } }
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}
  if (JSON.stringify(servers[PROMPT_MCP_KEY]) === JSON.stringify(entry)) return 'unchanged'
  const next = { ...config, mcpServers: { ...servers, [PROMPT_MCP_KEY]: entry } }
  mkdirSync(dir, { recursive: true })
  // Plain UTF-8 without a byte-order mark: Freebuff ignores an mcp.json that has one.
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return 'written'
}

/** The OPENCODE_CONFIG_CONTENT for servers Deskmates starts, or null before the kit is written. */
export function openCodePromptToolsConfig(): string | null {
  if (!agentCommand) return null
  const { command, args } = commandLine(agentCommand)
  return JSON.stringify({
    mcp: { [PROMPT_MCP_KEY]: { type: 'local', command: [command, ...args], environment: { DESKMATES_AGENT: 'OpenCode' }, enabled: true } }
  })
}
