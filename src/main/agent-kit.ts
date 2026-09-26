import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentKitDir } from '../core/agents/guide'

export interface InstallAgentCommandOptions {
  /** The app's data folder. */
  dataDir: string
  /** Absolute path of the bridge CLI's built entry point (src/bridge/cli.ts, via electron-vite's ?modulePath). */
  bridgeScript: string
  /** The executable to run the bridge script with; defaults to this running process's. */
  execPath?: string
}

/** Builds the deskmates.cmd content: runs the bridge CLI as plain Node, against this app's data folder. */
export function buildAgentCommandScript(options: { dataDir: string; bridgeScript: string; execPath: string }): string {
  return (
    '@echo off\r\n' +
    'setlocal\r\n' +
    'set "ELECTRON_RUN_AS_NODE=1"\r\n' +
    `set "DESKMATES_DATA_DIR=${options.dataDir}"\r\n` +
    `"${options.execPath}" "${options.bridgeScript}" %*\r\n`
  )
}

/**
 * Writes <dataDir>\agent-kit\deskmates.cmd, the command connected coding agents run to reach the
 * app from their own shell. Only touches the file when its content changed. May throw on a
 * filesystem error; callers should treat that as non-fatal and just log it.
 */
export function installAgentCommand(options: InstallAgentCommandOptions): string {
  const dir = agentKitDir(options.dataDir)
  const path = join(dir, 'deskmates.cmd')
  const content = buildAgentCommandScript({
    dataDir: options.dataDir,
    bridgeScript: options.bridgeScript,
    execPath: options.execPath ?? process.execPath
  })
  mkdirSync(dir, { recursive: true })
  let unchanged = false
  try {
    unchanged = readFileSync(path, 'utf8') === content
  } catch {
    unchanged = false
  }
  if (!unchanged) writeFileSync(path, content, 'utf8')
  return path
}
