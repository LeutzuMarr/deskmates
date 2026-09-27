import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * A running managed-mode CLI call. `CommandRunner` (src/core/bots/command-runner.ts) only resolves
 * once a program exits, so it can't stream lines as they arrive or be stopped mid-run — both of
 * which managed mode needs (the app shows replies as they stream, and the user can stop a session).
 * This is that: the same "everything through one injectable interface" idea, sized for streaming.
 */
export interface SpawnedProcess {
  readonly pid: number | undefined
  onStdoutLine(listener: (line: string) => void): void
  onStderrLine(listener: (line: string) => void): void
  /** Fires exactly once, whether the process exited normally, was killed, or failed to start. */
  onExit(listener: (code: number | null) => void): void
  kill(): void
}

export interface SpawnOptions {
  cwd?: string
}

export interface ProcessSpawner {
  spawn(file: string, args: string[], options?: SpawnOptions): SpawnedProcess
}

/** The real spawner: one child process per managed-mode CLI call, run in the folder the user picked. */
export class ChildProcessSpawner implements ProcessSpawner {
  spawn(file: string, args: string[], options: SpawnOptions = {}): SpawnedProcess {
    const child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdoutListeners = new Set<(line: string) => void>()
    const stderrListeners = new Set<(line: string) => void>()
    const exitListeners = new Set<(code: number | null) => void>()
    let exited = false
    const fireExit = (code: number | null): void => {
      if (exited) return
      exited = true
      exitListeners.forEach((listener) => listener(code))
    }

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => stdoutListeners.forEach((listener) => listener(line)))
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr })
      rl.on('line', (line) => stderrListeners.forEach((listener) => listener(line)))
    }
    // 'close', not 'exit': 'exit' can fire before the last stdout lines are read, which dropped the
    // whole reply of a short CLI run (the task went idle with no answer).
    child.on('close', (code) => fireExit(code))
    child.on('error', () => fireExit(null))

    return {
      pid: child.pid,
      onStdoutLine: (listener) => stdoutListeners.add(listener),
      onStderrLine: (listener) => stderrListeners.add(listener),
      onExit: (listener) => exitListeners.add(listener),
      kill: () => {
        // Windows' TerminateProcess — what `child.kill()` uses there — only ever reaches the direct
        // child. A CLI agent spawns children of its own (ripgrep, git, shell tools), so killing just
        // the process Deskmates started leaves that work running after the app reports a stop, and
        // the tree keeps the folder's files locked. `taskkill /T` takes the whole tree down at once.
        if (process.platform === 'win32' && child.pid !== undefined) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            return
          } catch {
            // Fall through to the direct kill below.
          }
        }
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
    }
  }
}
