import { spawn, type ChildProcess } from 'node:child_process'
import { tool } from 'ai'
import { z } from 'zod'
import { resolveInside } from '../fs/safe-path'
import type { ToolContext } from './context'

const MAX_OUTPUT_CHARS = 30_000

export interface ShellResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Accumulates decoded output up to a character cap, appending a cut marker once. */
function outputCollector(): { push(chunk: string): void; read(): string } {
  let text = ''
  let cut = false
  return {
    push(chunk: string): void {
      if (cut) return
      text += chunk
      if (text.length > MAX_OUTPUT_CHARS) {
        text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output cut]`
        cut = true
      }
    },
    read: () => text
  }
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    if (child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => {
        // The command is being stopped anyway; taskkill failing to start is fine.
      })
    }
  } else {
    child.kill('SIGKILL')
  }
}

/** Runs a command through PowerShell (or a POSIX shell off Windows) and collects its output. */
export function runPowerShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ShellResult> {
  return new Promise((settle) => {
    if (signal?.aborted) {
      settle({ exitCode: null, stdout: '', stderr: 'Stopped before the command started.', timedOut: false })
      return
    }

    const child =
      process.platform === 'win32'
        ? spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command
            ],
            { cwd, windowsHide: true }
          )
        : spawn('sh', ['-c', command], { cwd })

    const stdout = outputCollector()
    const stderr = outputCollector()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk))

    let timedOut = false
    let settled = false

    const onAbort = (): void => killTree(child)

    const finish = (result: ShellResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle(result)
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    child.on('close', (code) => {
      finish({ exitCode: code, stdout: stdout.read(), stderr: stderr.read(), timedOut })
    })

    child.on('error', (err) => {
      finish({ exitCode: null, stdout: stdout.read(), stderr: err.message, timedOut })
    })
  })
}

export function shellTools(ctx: ToolContext) {
  return {
    run_command: tool({
      description:
        'Run a PowerShell command on this Windows PC, starting in the project folder or a subfolder. The user must approve every command unless they allowed commands for this task.',
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().default('.'),
        timeout_seconds: z.number().int().min(1).max(600).default(120)
      }),
      execute: async ({ command, cwd = '.', timeout_seconds = 120 }, { abortSignal }) => {
        const resolvedCwd = resolveInside(ctx.root, cwd)
        return runPowerShell(command, resolvedCwd, timeout_seconds * 1000, abortSignal)
      }
    })
  }
}
