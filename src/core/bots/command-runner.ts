import { execFile } from 'node:child_process'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Kill the command after this many milliseconds. Default 120 000. */
  timeoutMs?: number
  /** Text written to the command's stdin. */
  input?: string
  /** Extra environment variables, merged over the current ones. */
  env?: Record<string, string>
  /** Decode the output as UTF-16LE, which `wsl.exe` uses for its own messages. */
  utf16?: boolean
}

/**
 * Runs external programs (`wsl.exe`, `docker`, `schtasks`). Everything that touches the
 * system goes through this one interface, so tests can pass a fake instead.
 */
export interface CommandRunner {
  run(file: string, args: string[], options?: RunOptions): Promise<CommandResult>
}

/** The real runner. It never throws on a non-zero exit; callers read `code`. */
export class ExecCommandRunner implements CommandRunner {
  run(file: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const { timeoutMs = 120_000, input, env, utf16 = false } = options
    return new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          encoding: utf16 ? 'buffer' : 'utf8',
          env: env ? { ...process.env, ...env } : process.env
        },
        (error, stdout, stderr) => {
          const decode = (value: string | Buffer): string =>
            typeof value === 'string' ? value : value.toString(utf16 ? 'utf16le' : 'utf8')
          const code =
            error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code ?? 1) : error ? 1 : 0
          resolve({ code, stdout: decode(stdout), stderr: decode(stderr) })
        }
      )
      if (input !== undefined) {
        child.stdin?.end(input)
      }
    })
  }
}
