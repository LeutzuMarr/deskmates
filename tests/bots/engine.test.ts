import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner, RunOptions } from '../../src/core/bots/command-runner'
import { EngineManager } from '../../src/core/bots/engine'
import type { Downloader, RootfsSource } from '../../src/core/bots/engine-download'
import { startDockerArgs } from '../../src/core/bots/host-paths'
import type { EngineStatus } from '../../src/shared/protocol'

// ---- fakes ----

interface RecordedCall {
  file: string
  args: string[]
  options?: RunOptions
}

type QueuedResponse = CommandResult | { bytes: Buffer; code: number; stderr: string }

/**
 * A `CommandRunner` driven entirely by canned, exact `file`+`args` matches, queued in call order.
 * Once a key's queue is down to its last entry, that entry keeps being returned for any further
 * calls with the same key (most commands in this suite are only ever called once or twice with
 * the same arguments, so this avoids re-registering an identical response for every remaining call).
 * A call with no registered response throws, so a typo in a test's expected command line fails
 * loudly instead of silently returning `undefined`.
 */
class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCall[] = []
  private readonly queues = new Map<string, QueuedResponse[]>()

  private key(file: string, args: string[]): string {
    return [file, ...args].join('')
  }

  respond(file: string, args: string[], result: Partial<CommandResult> = {}): void {
    const key = this.key(file, args)
    const queue = this.queues.get(key) ?? []
    queue.push({ code: 0, stdout: '', stderr: '', ...result })
    this.queues.set(key, queue)
  }

  /** Queues raw bytes, decoded the same way `ExecCommandRunner` decodes real process output — UTF-16LE
   *  when the call passes `{ utf16: true }`, UTF-8 otherwise — so this exercises real byte decoding
   *  rather than a pre-decoded string that merely happens to parse correctly. */
  respondBytes(file: string, args: string[], bytes: Buffer, code = 0, stderr = ''): void {
    const key = this.key(file, args)
    const queue = this.queues.get(key) ?? []
    queue.push({ bytes, code, stderr })
    this.queues.set(key, queue)
  }

  async run(file: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ file, args, options })
    const key = this.key(file, args)
    const queue = this.queues.get(key)
    if (!queue || queue.length === 0) {
      throw new Error(`FakeCommandRunner: no response registered for "${file} ${args.join(' ')}"`)
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if ('bytes' in next) {
      const decode = (b: Buffer) => (options?.utf16 ? b.toString('utf16le') : b.toString('utf8'))
      return { code: next.code, stdout: decode(next.bytes), stderr: next.stderr }
    }
    return next
  }
}

class FakeDownloader implements Downloader {
  readonly calls: Array<{ url: string; destPath: string }> = []
  constructor(
    private readonly content: Buffer | null,
    private readonly error?: Error
  ) {}

  async download(url: string, destPath: string): Promise<void> {
    this.calls.push({ url, destPath })
    if (this.error) throw this.error
    writeFileSync(destPath, this.content ?? Buffer.alloc(0))
  }
}

/** No test can produce bytes matching the real, pinned `DEBIAN_ROOTFS.sha256` (that would need a SHA-256
 *  preimage), so setup()-path tests use their own tiny fixture with a hash computed the same way engine.ts
 *  computes it — a real `sha256File` call over real bytes, not a mocked one. */
const FIXTURE_ROOTFS_BYTES = Buffer.from('a small stand-in for the real debian rootfs tarball')
const FIXTURE_ROOTFS: RootfsSource = {
  url: 'https://example.invalid/fixture-rootfs.tar.xz',
  sha256: createHash('sha256').update(FIXTURE_ROOTFS_BYTES).digest('hex'),
  filename: 'fixture-rootfs.tar.xz'
}

function expectNeverElevated(fake: FakeCommandRunner): void {
  for (const call of fake.calls) {
    expect(call.args, `unexpected elevated command: ${call.file} ${call.args.join(' ')}`).not.toContain('--install')
  }
}

// ---- wsl.exe / systeminfo text fixtures ----

// The exact sentence given for this machine, encoded the way wsl.exe really writes it: UTF-16LE with a
// leading BOM. This is the byte sequence a real, WSL-not-installed Windows machine produces.
const WSL_NOT_INSTALLED_TEXT = "The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.\r\n"
const WSL_NOT_INSTALLED_BYTES = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(WSL_NOT_INSTALLED_TEXT, 'utf16le')])

const WSL_STATUS_READY = 'Default Distribution: deskmates-engine\r\nDefault Version: 2\r\n'
const WSL_STATUS_V1 = 'Default Distribution: (none)\r\nDefault Version: 1\r\n'

// Captured verbatim (via node's execFile with { encoding: 'buffer' }, then .toString('utf16le'), the
// same decoding ExecCommandRunner does) from a real Windows 11 machine that has the WSL platform
// enabled but no distro installed yet: `wsl --status` volunteers an unprompted "WSL1 is not
// supported..." sentence alongside "Default Version: 2", and `wsl --list --verbose` exits non-zero
// with "no installed distributions" rather than a NAME/STATE/VERSION table. Regression coverage for
// exactly this machine's state — see EngineManager.status()'s "real machine, WSL enabled, no distro"
// test below.
const WSL_STATUS_READY_NO_DISTRO_REAL =
  'Default Version: 2\r\n' +
  'WSL1 is not supported with your current machine configuration.\r\n' +
  'Please enable the "Windows Subsystem for Linux" optional component to use WSL1.\r\n'
const WSL_LIST_NONE_INSTALLED_REAL =
  'Windows Subsystem for Linux has no installed distributions.\r\n' +
  'You can resolve this by installing a distribution with the instructions below:\r\n\r\n' +
  "Use 'wsl.exe --list --online' to list available distributions\r\n" +
  "and 'wsl.exe --install <Distro>' to install.\r\n"

const WSL_LIST_NO_ENGINE = '  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n'
const WSL_LIST_ENGINE_STOPPED =
  '  NAME                STATE           VERSION\r\n* Ubuntu              Running         2\r\n  deskmates-engine    Stopped         2\r\n'
const WSL_LIST_ENGINE_RUNNING = '  NAME                STATE           VERSION\r\n* deskmates-engine    Running         2\r\n'

const SYSTEMINFO_HYPERVISOR_DETECTED =
  'Hyper-V Requirements:     A hypervisor has been detected. Features required for Hyper-V will not be displayed.\r\n'
const SYSTEMINFO_VIRTUALIZATION_OFF =
  'Hyper-V Requirements:     VM Monitor Mode Extensions: Yes\r\n' +
  '                          Virtualization Enabled In Firmware: No\r\n' +
  '                          Second Level Address Translation: Yes\r\n'

const DOCKER_NOT_INSTALLED: Partial<CommandResult> = { code: 127, stderr: 'bash: docker: command not found\r\n' }
const DOCKER_NOT_RUNNING: Partial<CommandResult> = {
  code: 1,
  stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'
}
const DOCKER_INFO_OK: Partial<CommandResult> = { code: 0, stdout: 'Server Version: 24.0.7\nStorage Driver: overlay2\n' }

const DISTRO = 'deskmates-engine'
const WSL_EXE = 'wsl.exe'

function dockerCmd(...inner: string[]): string[] {
  return ['-d', DISTRO, '-u', 'root', '--', ...inner]
}

// ---- test setup ----

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'deskmates-engine-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function makeManager(fake: FakeCommandRunner, downloader?: Downloader): EngineManager {
  return new EngineManager({ runner: fake, dataDir, download: downloader, rootfs: FIXTURE_ROOTFS })
}

// ---- status(): detection matrix ----

describe('EngineManager.status()', () => {
  it('decodes wsl.exe\'s real UTF-16LE "not installed" bytes and reports needs-admin when a hypervisor is already running', async () => {
    const fake = new FakeCommandRunner()
    fake.respondBytes(WSL_EXE, ['--status'], WSL_NOT_INSTALLED_BYTES)
    fake.respond('systeminfo', [], { stdout: SYSTEMINFO_HYPERVISOR_DETECTED })

    const status = await makeManager(fake).status()

    expect(status.steps.wsl).toEqual({ state: 'needs-admin', detail: 'WSL needs to be installed. This needs an administrator prompt.' })
    expect(status.virtualization).toBe(true)
    expect(status.ready).toBe(false)
    expect(fake.calls).toEqual([
      { file: WSL_EXE, args: ['--status'], options: { utf16: true } },
      { file: 'systeminfo', args: [], options: undefined }
    ])
    expectNeverElevated(fake)
  })

  it('reports the firmware-virtualization error instead of needs-admin when no hypervisor is running and firmware virtualization is off', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_NOT_INSTALLED_TEXT })
    fake.respond('systeminfo', [], { stdout: SYSTEMINFO_VIRTUALIZATION_OFF })

    const status = await makeManager(fake).status()

    expect(status.steps.wsl.state).toBe('error')
    expect(status.steps.wsl.detail).toMatch(/virtualization is turned off/i)
    expect(status.virtualization).toBe(false)
    expect(status.ready).toBe(false)
  })

  it('reports WSL 1 as not enough, without needing a virtualization check', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_V1 })

    const status = await makeManager(fake).status()

    expect(status.steps.wsl.state).toBe('missing')
    expect(status.steps.wsl.detail).toMatch(/WSL 1.*WSL 2/i)
    expect(status.virtualization).toBe(true)
    // Already known true from a working WSL platform — systeminfo should never be called.
    expect(fake.calls.some((c) => c.file === 'systeminfo')).toBe(false)
  })

  it('reports the distro missing when WSL is ready but deskmates-engine was never created, without checking docker', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_NO_ENGINE })

    const status = await makeManager(fake).status()

    expect(status.steps.wsl.state).toBe('ok')
    expect(status.steps.distro).toEqual({ state: 'missing', detail: "The deskmates-engine distro hasn't been created yet." })
    expect(status.steps.docker.state).toBe('missing')
    expect(status.ready).toBe(false)
    expect(fake.calls.some((c) => c.args.includes('info'))).toBe(false)
  })

  it('treats a stopped-but-present distro as ok — WSL auto-starts it on demand — and ready does not require the image', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_STOPPED })
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_INFO_OK)
    fake.respond(WSL_EXE, dockerCmd('docker', 'image', 'inspect', 'ghcr.io/deskmates/bot-pc:latest'), { code: 1 })

    const status = await makeManager(fake).status()

    expect(status.steps.distro).toEqual({ state: 'ok', detail: 'Created (starts automatically when needed).' })
    expect(status.steps.image.state).toBe('missing')
    expect(status.ready).toBe(true)
  })

  it('reports docker missing when it is not installed in the distro', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_RUNNING })
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_NOT_INSTALLED)

    const status = await makeManager(fake).status()

    expect(status.steps.docker).toEqual({ state: 'missing', detail: "Docker isn't installed in the engine yet." })
    expect(status.ready).toBe(false)
    expect(fake.calls.some((c) => c.args.includes('inspect'))).toBe(false)
  })

  it('distinguishes docker installed-but-stopped from docker missing entirely, once starting it has failed', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_RUNNING })
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_NOT_RUNNING)
    fake.respond(WSL_EXE, startDockerArgs(DISTRO), {
      code: 1,
      stderr: 'Cannot connect to the Docker daemon: it did not start within 30 seconds.'
    })

    const status = await makeManager(fake).status()

    expect(status.steps.docker).toEqual({ state: 'missing', detail: 'Docker is installed but not running.' })
  })

  it('starts dockerd when the distro was stopped and is still booting, instead of reporting the engine as not ready', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_STOPPED })
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_NOT_RUNNING)
    fake.respond(WSL_EXE, startDockerArgs(DISTRO), { code: 0 })
    fake.respond(WSL_EXE, dockerCmd('docker', 'image', 'inspect', 'ghcr.io/deskmates/bot-pc:latest'), { code: 0 })

    const status = await makeManager(fake).status()

    expect(status.steps.docker).toEqual({ state: 'ok', detail: 'Docker is installed and running.' })
    expect(status.ready).toBe(true)
  })

  it('reports ready when wsl, distro, docker and the image are all in place', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_RUNNING })
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_INFO_OK)
    fake.respond(WSL_EXE, dockerCmd('docker', 'image', 'inspect', 'ghcr.io/deskmates/bot-pc:latest'), { code: 0 })

    const status = await makeManager(fake).status()

    expect(status).toEqual<EngineStatus>({
      ready: true,
      virtualization: true,
      steps: {
        wsl: { state: 'ok', detail: 'WSL 2 is installed and ready.' },
        distro: { state: 'ok', detail: 'Created and running.' },
        docker: { state: 'ok', detail: 'Docker is installed and running.' },
        image: { state: 'ok', detail: "This bot PC's image is downloaded." }
      }
    })
  })

  it('reports wsl ok and the distro missing on a real machine where WSL is enabled but no distro exists, undistracted by the unprompted "WSL1 is not supported" sentence', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY_NO_DISTRO_REAL })
    // The real `wsl --list --verbose` exits with Windows' unsigned -1 (4294967295), not a small
    // positive code — status() only needs "non-zero", but this pins the actual exit value observed.
    fake.respond(WSL_EXE, ['--list', '--verbose'], { code: 4294967295, stdout: WSL_LIST_NONE_INSTALLED_REAL })

    const status = await makeManager(fake).status()

    expect(status.steps.wsl).toEqual({ state: 'ok', detail: 'WSL 2 is installed and ready.' })
    expect(status.steps.distro).toEqual({ state: 'missing', detail: "The deskmates-engine distro hasn't been created yet." })
    expect(status.steps.docker.state).toBe('missing')
    expect(status.ready).toBe(false)
    expect(fake.calls.some((c) => c.args.includes('info'))).toBe(false)
    expectNeverElevated(fake)
  })

  it('reports wsl.exe itself missing (not just the WSL feature) as an error, distinct from "not installed"', async () => {
    const fake = new FakeCommandRunner()
    // Mirrors what ExecCommandRunner produces when execFile can't even find the binary: non-zero code, empty streams.
    fake.respond(WSL_EXE, ['--status'], { code: 1, stdout: '', stderr: '' })

    const status = await makeManager(fake).status()

    expect(status.steps.wsl.state).toBe('error')
    expect(status.steps.wsl.detail).toMatch(/doesn't seem to include wsl\.exe/i)
  })
})

// ---- setup(): idempotent, resumable, never-elevated progression ----

describe('EngineManager.setup()', () => {
  it('stops at needs-admin without running or attempting anything else when WSL itself is missing', async () => {
    const fake = new FakeCommandRunner()
    fake.respondBytes(WSL_EXE, ['--status'], WSL_NOT_INSTALLED_BYTES)
    fake.respond('systeminfo', [], { stdout: SYSTEMINFO_HYPERVISOR_DETECTED })

    const progress: EngineStatus[] = []
    const final = await makeManager(fake).setup((status) => progress.push(status))

    expect(final.steps.wsl.state).toBe('needs-admin')
    expect(final.ready).toBe(false)
    expect(progress).toHaveLength(1)
    expect(progress[0]).toEqual(final)
    expectNeverElevated(fake)
  })

  it('downloads, verifies and imports the distro, then installs, enables and verifies Docker — the full resumed run', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    // Checked once before the import (missing) and once after (present) — setup() must re-check, not assume.
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_NO_ENGINE })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_RUNNING })
    const engineDir = join(dataDir, 'engine')
    const cachedPath = join(engineDir, 'downloads', FIXTURE_ROOTFS.filename)
    fake.respond(WSL_EXE, ['--import', DISTRO, engineDir, cachedPath, '--version', '2'], { code: 0 })
    // Docker: missing before install, ok after.
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_NOT_INSTALLED)
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_INFO_OK)
    fake.respond(WSL_EXE, dockerCmd('apt-get', 'update'), { code: 0 })
    fake.respond(WSL_EXE, dockerCmd('env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'docker.io'), { code: 0 })
    fake.respond(WSL_EXE, dockerCmd('sh', '-c', 'cat > /etc/wsl.conf'), { code: 0 })
    fake.respond(WSL_EXE, dockerCmd('service', 'docker', 'start'), { code: 0 })
    fake.respond(WSL_EXE, dockerCmd('docker', 'image', 'inspect', 'ghcr.io/deskmates/bot-pc:latest'), { code: 1 })

    const downloader = new FakeDownloader(FIXTURE_ROOTFS_BYTES)
    const progress: EngineStatus[] = []
    const final = await makeManager(fake, downloader).setup((status) => progress.push(status))

    expect(final.ready).toBe(true)
    expect(final.steps.distro.state).toBe('ok')
    expect(final.steps.docker.state).toBe('ok')

    // The rootfs landed at the cache path (not left as a .part file), with the fixture's own bytes.
    expect(existsSync(cachedPath)).toBe(true)
    expect(existsSync(`${cachedPath}.part`)).toBe(false)
    expect(downloader.calls).toEqual([{ url: FIXTURE_ROOTFS.url, destPath: `${cachedPath}.part` }])

    // The exact wsl --import command line.
    const importCall = fake.calls.find((c) => c.args[0] === '--import')
    expect(importCall?.args).toEqual(['--import', DISTRO, engineDir, cachedPath, '--version', '2'])

    // wsl.conf was written via stdin, not baked into a shell-escaped argument.
    const confCall = fake.calls.find((c) => c.args.join(' ') === dockerCmd('sh', '-c', 'cat > /etc/wsl.conf').join(' '))
    expect(confCall?.options?.input).toBe('[boot]\ncommand="service docker start"\n')

    // Progress narrated each real sub-step, in order.
    const details = progress.map((p) => `${p.steps.distro.state}/${p.steps.distro.detail}|${p.steps.docker.state}/${p.steps.docker.detail}`)
    expect(details.some((d) => d.includes('Downloading the Linux system image'))).toBe(true)
    expect(details.some((d) => d.includes('Verifying the download'))).toBe(true)
    expect(details.some((d) => d.includes('Setting up the deskmates-engine distro'))).toBe(true)
    expect(details.some((d) => d.includes('Updating package lists'))).toBe(true)
    expect(details.some((d) => d.includes('Installing Docker'))).toBe(true)
    expect(details.some((d) => d.includes('Enabling Docker'))).toBe(true)

    expectNeverElevated(fake)
  })

  it('reuses an already-downloaded, hash-verified rootfs instead of downloading again', async () => {
    const engineDir = join(dataDir, 'engine')
    const downloadsDir = join(engineDir, 'downloads')
    const cachedPath = join(downloadsDir, FIXTURE_ROOTFS.filename)
    // Pre-seed the cache exactly as a previous, interrupted setup() run would have left it.
    mkdirSync(downloadsDir, { recursive: true })
    writeFileSync(cachedPath, FIXTURE_ROOTFS_BYTES)

    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_NO_ENGINE })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_RUNNING })
    fake.respond(WSL_EXE, ['--import', DISTRO, engineDir, cachedPath, '--version', '2'], { code: 0 })
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_INFO_OK)
    fake.respond(WSL_EXE, dockerCmd('docker', 'image', 'inspect', 'ghcr.io/deskmates/bot-pc:latest'), { code: 1 })

    const downloader = new FakeDownloader(FIXTURE_ROOTFS_BYTES)
    const final = await makeManager(fake, downloader).setup(() => {})

    expect(downloader.calls).toHaveLength(0)
    expect(final.steps.distro.state).toBe('ok')
    expectNeverElevated(fake)
  })

  it('reports a plain error and cleans up the partial file when the downloaded rootfs fails its hash check', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_NO_ENGINE })

    const corrupted = Buffer.from('this is not the file that was promised')
    const downloader = new FakeDownloader(corrupted)
    const final = await makeManager(fake, downloader).setup(() => {})

    expect(final.steps.distro).toEqual({
      state: 'error',
      detail: "The downloaded Linux system image didn't match what was expected. Try again."
    })
    expect(final.ready).toBe(false)
    expect(fake.calls.some((c) => c.args[0] === '--import')).toBe(false)
    const partial = join(dataDir, 'engine', 'downloads', `${FIXTURE_ROOTFS.filename}.part`)
    expect(existsSync(partial)).toBe(false)
    expectNeverElevated(fake)
  })

  it('resolves with a plain error instead of hanging or throwing when the import command times out', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_NO_ENGINE })
    // What ExecCommandRunner returns when its timeout kills the process: non-zero code, empty streams —
    // indistinguishable at the CommandResult level from any other silent failure, so this is handled by
    // the same generic-failure path as any other non-zero exit here.
    fake.respond(WSL_EXE, ['--import', DISTRO, join(dataDir, 'engine'), join(dataDir, 'engine', 'downloads', FIXTURE_ROOTFS.filename), '--version', '2'], {
      code: 1,
      stdout: '',
      stderr: ''
    })

    const downloader = new FakeDownloader(FIXTURE_ROOTFS_BYTES)
    const final = await makeManager(fake, downloader).setup(() => {})

    expect(final.steps.distro).toEqual({
      state: 'error',
      detail: 'Something went wrong setting up the deskmates-engine distro. Try again.'
    })
    expect(final.ready).toBe(false)
    expectNeverElevated(fake)
  })

  it('does nothing further once everything is already ready', async () => {
    const fake = new FakeCommandRunner()
    fake.respond(WSL_EXE, ['--status'], { stdout: WSL_STATUS_READY })
    fake.respond(WSL_EXE, ['--list', '--verbose'], { stdout: WSL_LIST_ENGINE_RUNNING })
    fake.respond(WSL_EXE, dockerCmd('docker', 'info'), DOCKER_INFO_OK)
    fake.respond(WSL_EXE, dockerCmd('docker', 'image', 'inspect', 'ghcr.io/deskmates/bot-pc:latest'), { code: 0 })

    const final = await makeManager(fake).setup(() => {})

    expect(final.ready).toBe(true)
    // Only the four read-only checks — nothing from importDistro/installDocker.
    expect(fake.calls).toHaveLength(4)
    expectNeverElevated(fake)
  })
})
