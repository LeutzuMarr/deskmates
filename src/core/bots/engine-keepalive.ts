import { spawn } from 'node:child_process'
import { DISTRO, WSL_EXE } from './host-paths'

/** A long-lived child process that runs until it's killed. */
export interface BackgroundProcess {
  /** Fires once, whether the process exited on its own, was killed, or failed to start. */
  onExit(listener: () => void): void
  kill(): void
}

/**
 * Starts long-lived child processes. `CommandRunner` only resolves once a program exits, which is
 * the opposite of what a keep-alive needs; tests inject a fake instead of spawning anything.
 */
export interface BackgroundSpawner {
  spawn(file: string, args: string[]): BackgroundProcess
}

/** The real spawner. */
export class ChildProcessBackgroundSpawner implements BackgroundSpawner {
  spawn(file: string, args: string[]): BackgroundProcess {
    // stdin is a pipe that's never written or closed: if this process dies without killing the child
    // (a crash, a hard kill), the pipe closes, the child reads EOF and exits by itself.
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin?.on('error', () => {})
    child.unref()
    ;(child.stdin as unknown as { unref?: () => void } | null)?.unref?.()

    const listeners = new Set<() => void>()
    let exited = false
    const fireExit = (): void => {
      if (exited) return
      exited = true
      listeners.forEach((listener) => listener())
    }
    child.on('exit', fireExit)
    child.on('error', fireExit)

    return {
      onExit: (listener) => listeners.add(listener),
      kill: () => {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
    }
  }
}

/**
 * WSL stops a distro about 15 seconds after the last `wsl.exe` attached to it exits, even while
 * dockerd and containers are running inside it — which kills every bot PC mid-run (the container
 * exits with 255 and the bot's tools fail with "fetch failed"). `.wslconfig`'s `vmIdleTimeout` doesn't
 * prevent it. Holding one idle `wsl.exe` open for as long as any PC is in use keeps the distro up.
 */
export class EngineKeepAlive {
  private child: BackgroundProcess | null = null

  constructor(
    private readonly spawner: BackgroundSpawner,
    private readonly distro: string = DISTRO
  ) {}

  get held(): boolean {
    return this.child !== null
  }

  /** Starts the keep-alive process if it isn't already running. Safe to call repeatedly. */
  hold(): void {
    if (this.child) return
    const child = this.spawner.spawn(WSL_EXE, ['-d', this.distro, '-u', 'root', '--', 'sh', '-c', 'cat >/dev/null'])
    this.child = child
    child.onExit(() => {
      if (this.child === child) this.child = null
    })
  }

  /** Stops the keep-alive process, letting WSL stop the distro once nothing else uses it. */
  release(): void {
    const child = this.child
    this.child = null
    child?.kill()
  }
}
