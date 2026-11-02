import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentCommandFileName, agentKitDir } from '../core/agents/guide'

export interface InstallAgentCommandOptions {
  /** The app's data folder. */
  dataDir: string
  /** Absolute path of the bridge CLI's built entry point (src/bridge/cli.ts, via electron-vite's ?modulePath). */
  bridgeScript: string
  /** The executable to run the bridge script with; defaults to this running process's. */
  execPath?: string
}

/** Builds the `deskmates.cmd` content: runs the bridge CLI as plain Node, against this app's data folder. */
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
 * The POSIX twin of `buildAgentCommandScript`: an extensionless script with a shebang, because a
 * shell needs both to execute it. `ELECTRON_RUN_AS_NODE` makes Electron's own binary behave as plain
 * Node, so there is no dependency on a separate Node install. `"$@"` forwards the agent's arguments
 * one-for-one, and the paths are single-quoted so spaces in the data folder survive.
 */
export function buildAgentCommandShell(options: { dataDir: string; bridgeScript: string; execPath: string }): string {
  return (
    '#!/bin/sh\n' +
    'export ELECTRON_RUN_AS_NODE=1\n' +
    `export DESKMATES_DATA_DIR='${options.dataDir}'\n` +
    `exec '${options.execPath}' '${options.bridgeScript}' "$@"\n`
  )
}

/**
 * Writes <dataDir>/agent-kit/deskmates (or deskmates.cmd), the command connected coding agents run to
 * reach the app from their own shell. Only touches the file when its content changed. May throw on a
 * filesystem error; callers should treat that as non-fatal and just log it.
 */
export function installAgentCommand(options: InstallAgentCommandOptions): string {
  const dir = agentKitDir(options.dataDir)
  const isWindows = process.platform === 'win32'
  const path = join(dir, agentCommandFileName())
  const shared = {
    dataDir: options.dataDir,
    bridgeScript: options.bridgeScript,
    execPath: options.execPath ?? process.execPath
  }
  const content = isWindows ? buildAgentCommandScript(shared) : buildAgentCommandShell(shared)
  mkdirSync(dir, { recursive: true })
  let unchanged = false
  try {
    unchanged = readFileSync(path, 'utf8') === content
  } catch {
    unchanged = false
  }
  if (!unchanged) {
    writeFileSync(path, content, 'utf8')
    // A fresh script has to be executable; `writeFileSync`'s mode only applies when creating the
    // file, so an overwrite of an existing one would otherwise keep the old mode.
    if (!isWindows) chmodSync(path, 0o755)
  }
  return path
}
