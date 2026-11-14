import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineStatus, EngineStep, EngineStepState } from '../../shared/protocol'
import type { CommandRunner } from './command-runner'
import { DEBIAN_ROOTFS, FetchDownloader, sha256File, type Downloader, type RootfsSource } from './engine-download'
import { DISTRO, DOCKER_PROGRAM, USES_WSL, WSL_EXE, startDockerArgs } from './host-paths'
import type { EngineService } from './services'

/** The distro name this module creates and checks by default. `LocalDockerHost` reads the same
 *  constant so the wizard and the host can't drift onto different distro names. */
const DEFAULT_DISTRO = DISTRO

/** The bot PC image the `image` step checks for. Matches `LocalDockerHost`'s own default. */
const DEFAULT_IMAGE = 'ghcr.io/deskmates/bot-pc:latest'

type StepResult = { state: EngineStepState; detail: string }

/** Shown for a step that hasn't been reached yet because an earlier one isn't ready. */
const WAITING: Record<Exclude<EngineStep, 'wsl'>, StepResult> = {
  distro: { state: 'missing', detail: 'Waiting for WSL to be ready first.' },
  docker: { state: 'missing', detail: 'Waiting for the deskmates-engine distro first.' },
  image: { state: 'missing', detail: 'Waiting for Docker to be ready first.' }
}

function genericFailure(what: string): string {
  return `Something went wrong ${what}. Try again.`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strips a UTF-16 BOM some Windows tools leave at the start of decoded text, and normalizes line endings. */
function normalizeWslText(text: string): string {
  return text.replace(/^\uFEFF/, '').trim()
}

/**
 * Finds `name`'s row in `wsl --list --verbose` output. Each row is `[*] NAME  STATE  VERSION`, with
 * a leading `*` marking the default distro and columns separated by runs of spaces.
 */
function findDistroRow(text: string, name: string): { stateText: string; version: string } | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const withoutMarker = trimmed.startsWith('*') ? trimmed.slice(1).trim() : trimmed
    const cols = withoutMarker.split(/\s+/)
    if (cols.length < 3 || cols[0].toUpperCase() === 'NAME') continue
    if (cols[0] === name) return { stateText: cols[1], version: cols[2] }
  }
  return null
}

export interface EngineManagerOptions {
  runner: CommandRunner
  /** The app's data folder, e.g. `D:\DeskmatesData`. Owns `<dataDir>/engine/`. */
  dataDir: string
  /** Defaults to `deskmates-engine`. Tests pass another name so canned responses stay short. */
  distro?: string
  /** Defaults to `FetchDownloader`. Tests inject a fake so they never touch the network. */
  download?: Downloader
  /** Defaults to `DEBIAN_ROOTFS`. Tests pass a small fixture with its own real hash — a SHA-256 preimage
   *  of the pinned production hash isn't something a test can manufacture, so this is what makes the
   *  "hash matches, import proceeds" and "cache is reused" paths reachable without real network access. */
  rootfs?: RootfsSource
  /** Overrides the WSL-vs-native branch. Defaults to the real platform. Exists so both branches are
   *  testable from one machine: they issue completely different command lines, and only one of them
   *  can be exercised natively on any given host. */
  usesWsl?: boolean
}

/**
 * Detects and sets up the `deskmates-engine` WSL2 distro and the Docker Engine inside it, over an
 * injected `CommandRunner` — never a real child process in tests. Every check re-reads the actual
 * state each time (nothing is cached in memory), so `status()` and `setup()` behave the same
 * whether this is the first call or a resumed one after the app was closed mid-setup.
 *
 * Never runs an elevated command: when enabling WSL itself is the next step, `setup()` reports
 * `needs-admin` and stops, leaving the actual `wsl.exe --install` to the Electron main process's
 * own UAC-elevated launch.
 */
export class EngineManager implements EngineService {
  private readonly runner: CommandRunner
  private readonly dataDir: string
  private readonly distro: string
  private readonly downloader: Downloader
  private readonly rootfs: RootfsSource
  private readonly usesWsl: boolean

  constructor(options: EngineManagerOptions) {
    this.runner = options.runner
    this.dataDir = options.dataDir
    this.distro = options.distro ?? DEFAULT_DISTRO
    this.downloader = options.download ?? new FetchDownloader()
    this.rootfs = options.rootfs ?? DEBIAN_ROOTFS
    this.usesWsl = options.usesWsl ?? USES_WSL
  }

  async status(): Promise<EngineStatus> {
    if (!this.usesWsl) return this.nativeStatus()

    const { result: wsl, virtualization } = await this.checkWsl()
    if (wsl.state !== 'ok') return this.buildStatus(virtualization, wsl)

    const distro = await this.checkDistro()
    if (distro.state !== 'ok') return this.buildStatus(virtualization, wsl, distro)

    const docker = await this.checkDocker()
    const image = docker.state === 'ok' ? await this.checkImage() : undefined
    return this.buildStatus(virtualization, wsl, distro, docker, image)
  }

  async setup(onProgress: (status: EngineStatus) => void): Promise<EngineStatus> {
    if (!this.usesWsl) return this.nativeSetup(onProgress)

    const { result: wsl, virtualization } = await this.checkWsl()
    if (wsl.state !== 'ok') {
      const status = this.buildStatus(virtualization, wsl)
      onProgress(status)
      return status
    }

    let distro = await this.checkDistro()
    if (distro.state !== 'ok') {
      try {
        await this.importDistro(onProgress, virtualization, wsl)
        distro = await this.checkDistro()
      } catch (error) {
        const status = this.buildStatus(virtualization, wsl, { state: 'error', detail: describeError(error) })
        onProgress(status)
        return status
      }
      if (distro.state !== 'ok') {
        // The import command exited 0 but the distro still doesn't check out — report rather than loop.
        const status = this.buildStatus(virtualization, wsl, distro)
        onProgress(status)
        return status
      }
    }
    onProgress(this.buildStatus(virtualization, wsl, distro))

    let docker = await this.checkDocker()
    if (docker.state !== 'ok') {
      try {
        await this.installDocker(onProgress, virtualization, wsl, distro)
        docker = await this.checkDocker()
      } catch (error) {
        const status = this.buildStatus(virtualization, wsl, distro, { state: 'error', detail: describeError(error) })
        onProgress(status)
        return status
      }
    }

    const image = docker.state === 'ok' ? await this.checkImage() : undefined
    const final = this.buildStatus(virtualization, wsl, distro, docker, image)
    onProgress(final)
    return final
  }

  // ---- native (Linux/macOS) ----
  //
  // There's no distro to create here, so the `wsl` and `distro` steps are reported `ok` with a
  // "doesn't apply" note rather than dropped from `steps`. That keeps the wizard's step list and
  // `EngineStatus.ready` identical across platforms — nothing downstream has to know that on Linux
  // two of the four steps are vestigial. The only setup work left is the image, which needs no
  // privileges: `docker pull` runs as the user.

  /** The `wsl`/`distro` steps off Windows: satisfied by construction, and says so. */
  private static readonly NOT_APPLICABLE: StepResult = {
    state: 'ok',
    detail: "Not needed — Docker runs natively on this system."
  }

  private async nativeStatus(): Promise<EngineStatus> {
    const docker = await this.checkNativeDocker()
    const image = docker.state === 'ok' ? await this.checkImage() : undefined
    return this.buildStatus(false, EngineManager.NOT_APPLICABLE, EngineManager.NOT_APPLICABLE, docker, image)
  }

  /** Only remaining setup off Windows: fetch the bot PC image, which needs no elevation. */
  private async nativeSetup(onProgress: (status: EngineStatus) => void): Promise<EngineStatus> {
    const notApplicable = EngineManager.NOT_APPLICABLE
    const docker = await this.checkNativeDocker()
    if (docker.state !== 'ok') return this.buildStatus(false, notApplicable, notApplicable, docker)

    onProgress(this.buildStatus(false, notApplicable, notApplicable, docker, { state: 'working', detail: 'Downloading the bot PC image…' }))
    const image = await this.pullImage(notApplicable, notApplicable, docker)
    const status = this.buildStatus(false, notApplicable, notApplicable, docker, image)
    onProgress(status)
    return status
  }

  /**
   * `docker info` against the host's own daemon.
   *
   * Deliberately does not try to start Docker if it isn't running: on Linux that means a `sudo`
   * password prompt (or a polkit dialog) triggered by a normal app action, which this app has no
   * business doing. It reports the problem with the fix in the message and lets the user act.
   */
  private async checkNativeDocker(): Promise<StepResult> {
    const result = await this.runner.run(DOCKER_PROGRAM, ['info'], { timeoutMs: 30_000 })
    if (result.code === 0) return { state: 'ok', detail: 'Docker is installed and running.' }

    const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
    if (/command not found|no such file or directory|is not recognized/.test(text)) {
      return {
        state: 'missing',
        detail: "Docker isn't installed. Install Docker Engine (for example, 'sudo apt install docker.io'), then try again."
      }
    }
    if (text.includes('cannot connect to the docker daemon') || text.includes('is the docker daemon running')) {
      return { state: 'missing', detail: 'Docker is installed but not running. Start it, then try again.' }
    }
    // A user in the `docker` group that doesn't exist yet hits "permission denied" on the socket,
    // which reads as a broken engine unless called out separately.
    if (text.includes('permission denied')) {
      return {
        state: 'missing',
        detail: "This account can't use Docker yet. Add yourself to the 'docker' group, then sign out and back in."
      }
    }
    return { state: 'error', detail: genericFailure('checking Docker') }
  }

  /** `docker pull`, reporting progress under the `image` step. Never throws; failure becomes a step state. */
  private async pullImage(wsl: StepResult, distro: StepResult, docker: StepResult): Promise<StepResult> {
    const result = await this.runner.run(DOCKER_PROGRAM, ['pull', DEFAULT_IMAGE], { timeoutMs: 600_000 })
    return result.code === 0 ? { state: 'ok', detail: "This bot PC's image is downloaded." } : { state: 'error', detail: "The bot PC image couldn't be downloaded. Check the internet connection and try again." }
  }

  // ---- WSL detection (Windows only) ----

  /** Runs `wsl.exe --status` and, only when it's needed to explain why WSL isn't ready, checks virtualization too. */
  private async checkWsl(): Promise<{ result: StepResult; virtualization: boolean }> {
    const raw = await this.runner.run(WSL_EXE, ['--status'], { utf16: true })
    const text = normalizeWslText(raw.stdout) || normalizeWslText(raw.stderr)

    if (!text) {
      return {
        virtualization: false,
        result: {
          state: 'error',
          detail: "This computer's Windows version doesn't seem to include wsl.exe. Update Windows, then try again."
        }
      }
    }
    if (/is not installed/i.test(text)) {
      const virtualization = await this.detectVirtualization()
      if (!virtualization) {
        return {
          virtualization,
          result: {
            state: 'error',
            detail:
              "Virtualization is turned off in your computer's firmware. Turn on Intel VT-x/AMD-V (sometimes called SVM Mode) in the BIOS, then try again."
          }
        }
      }
      return { virtualization, result: { state: 'needs-admin', detail: 'WSL needs to be installed. This needs an administrator prompt.' } }
    }
    if (/default version:\s*2\b/i.test(text)) {
      return { virtualization: true, result: { state: 'ok', detail: 'WSL 2 is installed and ready.' } }
    }
    if (/default version:\s*1\b/i.test(text)) {
      return {
        virtualization: true,
        result: {
          state: 'missing',
          detail: 'This computer has WSL 1, but Deskmates needs WSL 2. Run "wsl --update" from an administrator prompt, then try again.'
        }
      }
    }
    return { virtualization: await this.detectVirtualization(), result: { state: 'error', detail: genericFailure('checking WSL') } }
  }

  /** `Win32_Processor.VirtualizationFirmwareEnabled` reads `False` whenever a hypervisor already owns the
   *  hardware virtualization extensions (including WSL2's own), so that flag alone can't tell "off" from
   *  "already in use". `systeminfo`'s Hyper-V section says so explicitly when that's the case. */
  private async detectVirtualization(): Promise<boolean> {
    const result = await this.runner.run('systeminfo', [])
    const text = result.stdout.toLowerCase()
    if (text.includes('a hypervisor has been detected')) return true
    return /virtualization enabled in firmware:\s*yes/.test(text)
  }

  private async checkDistro(): Promise<StepResult> {
    const result = await this.runner.run(WSL_EXE, ['--list', '--verbose'], { utf16: true })
    if (result.code !== 0) return { state: 'missing', detail: `The ${this.distro} distro hasn't been created yet.` }

    const row = findDistroRow(normalizeWslText(result.stdout), this.distro)
    if (!row) return { state: 'missing', detail: `The ${this.distro} distro hasn't been created yet.` }
    if (row.version !== '2') {
      return {
        state: 'error',
        detail: `The ${this.distro} distro exists but is set to WSL 1, not WSL 2. Delete it and let setup recreate it.`
      }
    }
    return {
      state: 'ok',
      detail: /running/i.test(row.stateText) ? 'Created and running.' : 'Created (starts automatically when needed).'
    }
  }

  private async checkDocker(): Promise<StepResult> {
    const result = await this.runner.run(WSL_EXE, this.wslArgs('docker', 'info'))
    if (result.code === 0) return { state: 'ok', detail: 'Docker is installed and running.' }

    const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
    if (text.includes('docker') && /command not found|not recognized|no such file or directory/.test(text)) {
      return { state: 'missing', detail: "Docker isn't installed in the engine yet." }
    }
    if (text.includes('cannot connect to the docker daemon') || text.includes('is the docker daemon running')) {
      // Usually just a distro WSL stopped while idle and is booting again: its `[boot]` command is
      // still starting dockerd. Start it (or wait for it) rather than report the engine as broken.
      const started = await this.runner.run(WSL_EXE, startDockerArgs(this.distro), { timeoutMs: 60_000 })
      if (started.code === 0) return { state: 'ok', detail: 'Docker is installed and running.' }
      return { state: 'missing', detail: 'Docker is installed but not running.' }
    }
    return { state: 'error', detail: genericFailure('checking Docker') }
  }

  private async checkImage(): Promise<StepResult> {
    // Inside the distro on Windows (root, so the daemon socket is readable even for a
    // pre-existing distro that still has only the root user); a plain call everywhere else.
    const args = this.usesWsl ? this.wslArgs('docker', 'image', 'inspect', DEFAULT_IMAGE) : ['image', 'inspect', DEFAULT_IMAGE]
    const result = await this.runner.run(DOCKER_PROGRAM, args, { timeoutMs: 30_000 })
    return result.code === 0
      ? { state: 'ok', detail: "This bot PC's image is downloaded." }
      : { state: 'missing', detail: "This bot PC's image hasn't been downloaded yet." }
  }

  // ---- setup steps ----

  /**
   * Downloads (or reuses a cached, hash-verified) Debian rootfs and imports it as `this.distro`.
   * Throws an already-plain-sentence `Error` on failure; never leaves a half-downloaded file
   * behind as if it were a good cache entry.
   */
  private async importDistro(onProgress: (status: EngineStatus) => void, virtualization: boolean, wsl: StepResult): Promise<void> {
    const emit = (distro: StepResult) => onProgress(this.buildStatus(virtualization, wsl, distro))

    const downloadsDir = join(this.dataDir, 'engine', 'downloads')
    mkdirSync(downloadsDir, { recursive: true })
    const destPath = join(downloadsDir, this.rootfs.filename)
    const tmpPath = `${destPath}.part`

    const cached = existsSync(destPath) && (await sha256File(destPath)) === this.rootfs.sha256
    if (!cached) {
      emit({ state: 'working', detail: 'Downloading the Linux system image…' })
      try {
        await this.downloader.download(this.rootfs.url, tmpPath)
      } catch (error) {
        throw new Error(`Downloading the Linux system image failed: ${describeError(error)}`)
      }

      emit({ state: 'working', detail: 'Verifying the download…' })
      const actual = await sha256File(tmpPath)
      if (actual !== this.rootfs.sha256) {
        rmSync(tmpPath, { force: true })
        throw new Error("The downloaded Linux system image didn't match what was expected. Try again.")
      }
      renameSync(tmpPath, destPath)
    }

    emit({ state: 'working', detail: `Setting up the ${this.distro} distro…` })
    const engineDir = join(this.dataDir, 'engine')
    mkdirSync(engineDir, { recursive: true })
    const result = await this.runner.run(WSL_EXE, ['--import', this.distro, engineDir, destPath, '--version', '2'], {
      timeoutMs: 300_000
    })
    if (result.code !== 0) throw new Error(genericFailure(`setting up the ${this.distro} distro`))
  }

  /** Installs Docker Engine inside `this.distro` via apt, then enables and starts it — no elevated Windows command needed, since everything runs as root inside the (unprivileged, from Windows' point of view) WSL distro. */
  private async installDocker(
    onProgress: (status: EngineStatus) => void,
    virtualization: boolean,
    wsl: StepResult,
    distro: StepResult
  ): Promise<void> {
    const emit = (docker: StepResult) => onProgress(this.buildStatus(virtualization, wsl, distro, docker))

    emit({ state: 'working', detail: 'Updating package lists…' })
    const update = await this.runner.run(WSL_EXE, this.wslArgs('apt-get', 'update'), { timeoutMs: 180_000 })
    if (update.code !== 0) throw new Error('Updating package lists failed. Check the internet connection and try again.')

    emit({ state: 'working', detail: 'Installing Docker…' })
    const install = await this.runner.run(
      WSL_EXE,
      this.wslArgs('env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'docker.io'),
      { timeoutMs: 300_000 }
    )
    if (install.code !== 0) throw new Error(genericFailure('installing Docker'))

    // WSL has no systemd by default, so a plain `apt install` won't start (or auto-start) the daemon.
    // `/etc/wsl.conf`'s `[boot] command` makes it start on every future boot of this distro; starting
    // it directly right after covers the current session too, so setup can verify immediately.
    emit({ state: 'working', detail: 'Enabling Docker…' })
    const conf = await this.runner.run(WSL_EXE, this.wslArgs('sh', '-c', 'cat > /etc/wsl.conf'), {
      input: '[boot]\ncommand="service docker start"\n'
    })
    if (conf.code !== 0) throw new Error(genericFailure('enabling Docker'))

    const start = await this.runner.run(WSL_EXE, this.wslArgs('service', 'docker', 'start'))
    if (start.code !== 0) throw new Error(genericFailure('starting Docker'))
  }

  // ---- plumbing ----

  /** Wraps a Linux command to run inside `this.distro` as root — root because a freshly-imported rootfs has no other user yet. */
  private wslArgs(...inner: string[]): string[] {
    return ['-d', this.distro, '-u', 'root', '--', ...inner]
  }

  private buildStatus(virtualization: boolean, wsl: StepResult, distro?: StepResult, docker?: StepResult, image?: StepResult): EngineStatus {
    const steps = {
      wsl,
      distro: distro ?? WAITING.distro,
      docker: docker ?? WAITING.docker,
      image: image ?? WAITING.image
    }
    return {
      // The image step is a specific bot PC's asset, tracked here for visibility but not required
      // for the *engine* itself to be ready — pulling it is a separate, later wizard step.
      ready: steps.wsl.state === 'ok' && steps.distro.state === 'ok' && steps.docker.state === 'ok',
      virtualization,
      steps
    }
  }
}
