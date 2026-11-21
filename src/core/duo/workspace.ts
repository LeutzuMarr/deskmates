import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DuoProfile } from '../../shared/duo'
import { myPromptBrief } from '../engine/my-prompt'
import { DUO_BRIEF, profileMarkdown } from './brief'

/** Writes `content` only when it changed, as plain UTF-8 without a byte-order mark (Freebuff ignores an mcp.json that has one). */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch {
    // Not there yet.
  }
  writeFileSync(path, content, 'utf8')
}

export interface DuoWorkspaceOptions {
  /** Duo's folder: <dataDir>/duo/workspace. */
  dir: string
  /** The agent kit's deskmates.cmd (or `deskmates` elsewhere), which runs the MCP server. */
  agentCommand: string
  profile: DuoProfile
  /** The user's own prompt; copied in so Freebuff can read its sections from this folder. */
  myPromptPath: string
  /** The outreach playbook to start from, if none is there yet. */
  defaultPlaybook?: string
}

/**
 * Prepares the folder Duo's Freebuff runs in: AGENTS.md (the user's prompt's first section and its
 * index, then Duo's brief), profile.md, playbook.md (kept once the user has one), the user's prompt
 * itself, and .agents/mcp.json pointing at Deskmates' MCP server as Duo.
 */
export function prepareDuoWorkspace(options: DuoWorkspaceOptions): void {
  const { dir } = options
  mkdirSync(join(dir, '.agents'), { recursive: true })

  const promptCopy = join(dir, 'my-prompt.md')
  if (existsSync(options.myPromptPath)) {
    const fresh = !existsSync(promptCopy) || statSync(promptCopy).mtimeMs < statSync(options.myPromptPath).mtimeMs
    if (fresh) copyFileSync(options.myPromptPath, promptCopy)
  }
  const operating = existsSync(promptCopy) ? myPromptBrief('file', promptCopy, { promptTools: 'mcp' }) : null
  writeIfChanged(join(dir, 'AGENTS.md'), [operating, operating ? '\n---\n' : '', DUO_BRIEF].filter(Boolean).join('\n'))
  writeIfChanged(join(dir, 'profile.md'), profileMarkdown(options.profile))
  const playbook = join(dir, 'playbook.md')
  if (!existsSync(playbook)) writeFileSync(playbook, options.defaultPlaybook ?? '# Outreach playbook\n\nNot written yet: ask the user how they pitch.\n', 'utf8')

  const isWindows = process.platform === 'win32'
  const config = {
    mcpServers: {
      deskmates: {
        command: isWindows ? 'cmd.exe' : options.agentCommand,
        args: isWindows ? ['/d', '/c', options.agentCommand, 'mcp'] : ['mcp'],
        env: { DESKMATES_AGENT: 'Duo' }
      }
    }
  }
  writeIfChanged(join(dir, '.agents', 'mcp.json'), JSON.stringify(config, null, 2))
}
