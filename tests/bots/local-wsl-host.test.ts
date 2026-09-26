import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner, RunOptions } from '../../src/core/bots/command-runner'
import type { BackgroundProcess, BackgroundSpawner } from '../../src/core/bots/engine-keepalive'
import { BotHostError, type CreatePcOptions, type PcEndpoints } from '../../src/core/bots/host'
import {
  AGENT_CONTAINER_PORT,
  CDP_CONTAINER_PORT,
  DISTRO,
  NOVNC_CONTAINER_PORT,
  SHARED_CONTAINER_NAME,
  WSL_EXE,
  dockerArgs,
  networkNameFor,
  ownContainerName,
  pcStorageDir,
  sharedDir,
  startDockerArgs,
  toWslPath
} from '../../src/core/bots/host-paths'
import { LocalWslHost } from '../../src/core/bots/local-wsl-host'
import type { PcProbe } from '../../src/core/bots/pc-health'
import type { PcService } from '../../src/core/bots/services'

// ---- a behaviorally-accurate fake of `wsl.exe -d deskmates-engine -- docker …` ----

interface RunCall {
  file: string
  args: string[]
  options?: RunOptions
}

interface FakeContainer {
  id: string
  status: 'running' | 'exited' | 'restarting'
  dead?: boolean
  oomKilled?: boolean
  containerError?: string
}

/**
 * Keeps its own container-name -> state map and answers `run`/`inspect`/`start`/`stop`/`rm`/
 * `exec`/`cp`/`pull`/`build` the way real Docker would, so `LocalWslHost` can be driven through
 * realistic multi-step sequences (create-then-inspect, stop-then-start, …) instead of one canned
 * response per test. Every call is recorded in `calls` for exact-command-line assertions.
 */
class FakeDocker implements CommandRunner {
  readonly calls: RunCall[] = []
  readonly containers = new Map<string, FakeContainer>()
  /** Networks created via `docker network create`, the way the real Docker daemon would track them. */
  readonly networks = new Set<string>()

  /** When true, every docker command fails as if the WSL engine itself were unreachable. */
  engineDown = false
  /** Container names whose next `run` should fail with "port is already allocated". */
  readonly portConflicts = new Set<string>()
  /** Image references whose `run`/`pull` should fail with "no such image". */
  readonly missingImages = new Set<string>()
  /** Container names that go straight back to `exited` right after their next `run` or `start` (simulates a crash-on-start). */
  readonly diesRightAway = new Set<string>()
  /** Canned exec responses, keyed by `[name, command, ...args].join('\u0000')`; default is a clean 0-exit no-op. */
  readonly execResponses = new Map<string, CommandResult>()
  /** Overrides the next `cp` result, then clears itself. */
  nextCpResult: CommandResult | null = null
  /** Network names whose next `network rm` should fail for a reason other than "doesn't exist" (e.g. simulates active endpoints). */
  readonly networkRmFails = new Set<string>()
  /** When true, every `docker run` that still has `--cpus` fails the way a real WSL2 distro with
   *  only the memory cgroup controller delegated does (see `runContainer`'s comment) — a retry
   *  without `--cpus` then succeeds, the way `LocalWslHost` is expected to retry. */
  cpuLimitUnsupported = false
  /** When true, dockerd isn't up yet (a distro WSL just booted again): docker commands fail until the start-docker script runs. */
  daemonStopped = false
  /** When true, the start-docker script can't get dockerd running. */
  dockerStartFails = false

  private nextId = 0

  async run(file: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ file, args, options })
    if (file !== WSL_EXE) return { code: 1, stdout: '', stderr: `fake docker: unexpected program ${file}` }
    if (this.engineDown) {
      return { code: 1, stdout: '', stderr: 'error during connect: this error may indicate that the docker daemon is not running.' }
    }
    if (isStartDockerCall(args)) {
      if (this.dockerStartFails) {
        return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon: it did not start within 30 seconds.' }
      }
      this.daemonStopped = false
      return { code: 0, stdout: '', stderr: '' }
    }
    if (this.daemonStopped) {
      return {
        code: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
      }
    }
    const [cmd, ...rest] = args.slice(4)
    switch (cmd) {
      case 'run':
        return this.handleRun(rest)
      case 'inspect':
        return this.handleInspect(rest)
      case 'start':
        return this.handleStart(rest)
      case 'stop':
        return this.handleStop(rest)
      case 'rm':
        return this.handleRm(rest)
      case 'exec':
        return this.handleExec(rest)
      case 'cp':
        return this.handleCp(rest)
      case 'pull':
        return this.handlePull(rest)
      case 'build':
        return { code: 0, stdout: '', stderr: '' }
      case 'network':
        return this.handleNetwork(rest)
      default:
        return { code: 1, stdout: '', stderr: `fake docker: unhandled subcommand ${cmd}` }
    }
  }

  private handleNetwork(rest: string[]): CommandResult {
    const [action, name] = rest
    if (action === 'create') {
      if (this.networks.has(name)) return { code: 1, stdout: '', stderr: `Error: network with name ${name} already exists` }
      this.networks.add(name)
      return { code: 0, stdout: name, stderr: '' }
    }
    if (action === 'rm') {
      if (!this.networks.has(name)) return { code: 1, stdout: '', stderr: `Error: No such network: ${name}` }
      if (this.networkRmFails.has(name)) {
        return {
          code: 1,
          stdout: '',
          stderr: `Error response from daemon: error while removing network: network ${name} has active endpoints`
        }
      }
      this.networks.delete(name)
      return { code: 0, stdout: name, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `fake docker: unhandled network action ${action}` }
  }

  private handleRun(rest: string[]): CommandResult {
    const name = rest[rest.indexOf('--name') + 1]
    const image = rest[rest.length - 1]
    if (this.cpuLimitUnsupported && rest.includes('--cpus')) {
      return {
        code: 1,
        stdout: '',
        stderr:
          'docker: Error response from daemon: NanoCPUs can not be set, as your kernel does not support CPU CFS scheduler or the cgroup is not mounted.'
      }
    }
    if (this.portConflicts.has(name)) {
      return {
        code: 1,
        stdout: '',
        stderr: `docker: Error response from daemon: driver failed programming external connectivity on endpoint ${name}: Bind for 127.0.0.1:8701 failed: port is already allocated.`
      }
    }
    if (this.missingImages.has(image)) {
      return {
        code: 1,
        stdout: '',
        stderr: `Unable to find image '${image}' locally\ndocker: Error response from daemon: pull access denied for ${image}, repository does not exist or may require 'docker login'.`
      }
    }
    const id = `container-${++this.nextId}`
    this.containers.set(name, { id, status: this.diesRightAway.has(name) ? 'exited' : 'running' })
    return { code: 0, stdout: id, stderr: '' }
  }

  private handleInspect(rest: string[]): CommandResult {
    const name = rest[0]
    const c = this.containers.get(name)
    if (!c) return { code: 1, stdout: '', stderr: `Error: No such object: ${name}` }
    const state: Record<string, unknown> = { Status: c.status }
    if (c.dead) state.Dead = true
    if (c.oomKilled) state.OOMKilled = true
    if (c.containerError) state.Error = c.containerError
    return { code: 0, stdout: JSON.stringify([{ Id: c.id, State: state }]), stderr: '' }
  }

  private handleStart(rest: string[]): CommandResult {
    const name = rest[0]
    const c = this.containers.get(name)
    if (!c) return { code: 1, stdout: '', stderr: `Error response from daemon: No such container: ${name}` }
    c.status = this.diesRightAway.has(name) ? 'exited' : 'running'
    return { code: 0, stdout: name, stderr: '' }
  }

  private handleStop(rest: string[]): CommandResult {
    const name = rest[0]
    const c = this.containers.get(name)
    if (!c) return { code: 1, stdout: '', stderr: `Error response from daemon: No such container: ${name}` }
    c.status = 'exited'
    return { code: 0, stdout: name, stderr: '' }
  }

  private handleRm(rest: string[]): CommandResult {
    const name = rest[rest.length - 1]
    if (!this.containers.has(name)) return { code: 1, stdout: '', stderr: `Error: No such container: ${name}` }
    this.containers.delete(name)
    return { code: 0, stdout: name, stderr: '' }
  }

  private handleExec(rest: string[]): CommandResult {
    let i = 0
    if (rest[i] === '-i') i++
    const name = rest[i++]
    const command = rest[i++]
    const cmdArgs = rest.slice(i)
    const c = this.containers.get(name)
    if (!c) return { code: 1, stdout: '', stderr: `Error response from daemon: No such container: ${name}` }
    if (c.status !== 'running') {
      return { code: 1, stdout: '', stderr: `Error response from daemon: Container ${c.id} is not running` }
    }
    const key = [name, command, ...cmdArgs].join('\u0000')
    return this.execResponses.get(key) ?? { code: 0, stdout: '', stderr: '' }
  }

  private handleCp(rest: string[]): CommandResult {
    if (this.nextCpResult) {
      const result = this.nextCpResult
      this.nextCpResult = null
      return result
    }
    const [src, dest] = rest
    const name = [...this.containers.keys()].find((n) => src.startsWith(`${n}:`) || dest.startsWith(`${n}:`))
    if (!name) return { code: 1, stdout: '', stderr: 'Error: No such container: unknown' }
    return { code: 0, stdout: '', stderr: '' }
  }

  private handlePull(rest: string[]): CommandResult {
    const image = rest[0]
    if (this.missingImages.has(image)) {
      return { code: 1, stdout: '', stderr: 'Error response from daemon: manifest unknown: manifest unknown' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function isStartDockerCall(args: string[]): boolean {
  return args.join('\u0000') === startDockerArgs().join('\u0000')
}

interface FakeProcess {
  file: string
  args: string[]
  alive: boolean
  /** Simulates the process exiting on its own (e.g. the user ran `wsl --shutdown`). */
  exit: () => void
}

/** Records every keep-alive process instead of spawning one. */
class FakeSpawner implements BackgroundSpawner {
  readonly spawned: FakeProcess[] = []

  spawn(file: string, args: string[]): BackgroundProcess {
    const listeners = new Set<() => void>()
    const proc: FakeProcess = {
      file,
      args,
      alive: true,
      exit: () => {
        if (!proc.alive) return
        proc.alive = false
        listeners.forEach((listener) => listener())
      }
    }
    this.spawned.push(proc)
    return { onExit: (listener) => listeners.add(listener), kill: () => proc.exit() }
  }

  alive(): FakeProcess[] {
    return this.spawned.filter((p) => p.alive)
  }
}

const answeringProbe: PcProbe = async () => true

function makeClock(start = 0) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms), set: (ms: number) => (now = ms) }
}

// ---- shared fixtures and helpers ----

const IMAGE = 'ghcr.io/deskmates/bot-pc:test'
const OPTS: CreatePcOptions = { memoryMb: 1024, cpuLimit: 2, idleStopMinutes: 30 }

function runCallsFor(fake: FakeDocker, name: string): RunCall[] {
  return fake.calls.filter((c) => {
    const sub = c.args.slice(4)
    return sub[0] === 'run' && sub[sub.indexOf('--name') + 1] === name
  })
}

function callsMatching(fake: FakeDocker, subcommand: string): RunCall[] {
  return fake.calls.filter((c) => c.args.slice(4)[0] === subcommand)
}

function lastCall(fake: FakeDocker): RunCall {
  const call = fake.calls[fake.calls.length - 1]
  if (!call) throw new Error('No commands were run yet.')
  return call
}

function allPortsFromRunCall(fake: FakeDocker, name: string, occurrence = 0): { agent: number; novnc: number; cdp: number } {
  const call = runCallsFor(fake, name)[occurrence]
  if (!call) throw new Error(`No run call #${occurrence} for ${name}`)
  const sub = call.args.slice(4)
  const mapped: number[] = []
  for (let i = 0; i < sub.length; i++) {
    if (sub[i] === '-p') mapped.push(Number(sub[i + 1].split(':')[1]))
  }
  const [agent, novnc, cdp] = mapped
  return { agent, novnc, cdp }
}

function tokenFromRunCall(fake: FakeDocker, name: string, occurrence = 0): string {
  const call = runCallsFor(fake, name)[occurrence]
  if (!call) throw new Error(`No run call #${occurrence} for ${name}`)
  const tokenArg = call.args.slice(4).find((a) => a.startsWith('DESKMATES_TOKEN='))
  if (!tokenArg) throw new Error('No DESKMATES_TOKEN argument found in that run call.')
  return tokenArg.slice('DESKMATES_TOKEN='.length)
}

const createdDataDirs: string[] = []

function makeHost(
  overrides: {
    dataDir?: string
    fake?: FakeDocker
    clock?: ReturnType<typeof makeClock>
    sharedOptions?: CreatePcOptions
    probe?: PcProbe
    readyTimeoutMs?: number
  } = {}
) {
  const dataDir = overrides.dataDir ?? realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-host-')))
  createdDataDirs.push(dataDir)
  const fake = overrides.fake ?? new FakeDocker()
  const clock = overrides.clock ?? makeClock(1_000_000)
  const spawner = new FakeSpawner()
  const host = new LocalWslHost({
    runner: fake,
    dataDir,
    image: IMAGE,
    clock: clock.now,
    spawner,
    probe: overrides.probe ?? answeringProbe,
    ...(overrides.readyTimeoutMs !== undefined ? { readyTimeoutMs: overrides.readyTimeoutMs } : {}),
    ...(overrides.sharedOptions ? { sharedOptions: overrides.sharedOptions } : {})
  })
  return { dataDir, fake, clock, host, spawner }
}

afterEach(() => {
  for (const dir of createdDataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---- PcService compatibility ----

describe('PcService compatibility', () => {
  it('LocalWslHost structurally satisfies PcService — fails to typecheck if the two drift apart', () => {
    const { host } = makeHost()
    const _check: PcService = host
    expect(_check).toBe(host)
  })
})

// ---- create ----

describe('create', () => {
  it('validates memoryMb, cpuLimit and idleStopMinutes before running anything', async () => {
    const { host, fake } = makeHost()
    await expect(host.create('bot-a', { memoryMb: 0, cpuLimit: 1, idleStopMinutes: 0 })).rejects.toThrow(
      'memoryMb must be a positive number.'
    )
    await expect(host.create('bot-a', { memoryMb: 512, cpuLimit: 0, idleStopMinutes: 0 })).rejects.toThrow(
      'cpuLimit must be a positive number.'
    )
    await expect(host.create('bot-a', { memoryMb: 512, cpuLimit: 1, idleStopMinutes: -1 })).rejects.toThrow(
      'idleStopMinutes must be zero or a positive number.'
    )
    expect(fake.calls).toHaveLength(0)
  })

  it('creates an isolated network for the bot before running its container, on that network, with --restart no, resource caps, three 127.0.0.1 port mappings, both volumes, and the token', async () => {
    const { host, fake, dataDir } = makeHost()
    const pc = await host.create('bot-a', OPTS)
    expect(pc.state).toBe('running')

    const name = ownContainerName('bot-a')
    const network = networkNameFor(name)
    const token = tokenFromRunCall(fake, name)
    const ports = allPortsFromRunCall(fake, name)

    // The network is created before the container that joins it, and nothing else uses it.
    expect(callsMatching(fake, 'network').map((c) => c.args.slice(4))).toEqual([['network', 'create', network]])
    expect(fake.networks.has(network)).toBe(true)

    expect(runCallsFor(fake, name)).toHaveLength(1)
    expect(runCallsFor(fake, name)[0].args).toEqual(
      dockerArgs([
        'run',
        '-d',
        '--name',
        name,
        '--network',
        network,
        '--restart',
        'no',
        '--memory',
        '1024m',
        '--cpus',
        '2',
        '-p',
        `127.0.0.1:${ports.agent}:${AGENT_CONTAINER_PORT}`,
        '-p',
        `127.0.0.1:${ports.novnc}:${NOVNC_CONTAINER_PORT}`,
        '-p',
        `127.0.0.1:${ports.cdp}:${CDP_CONTAINER_PORT}`,
        '-v',
        `${toWslPath(pcStorageDir(dataDir, 'bot-a'))}:/home/bot/data`,
        '-v',
        `${toWslPath(sharedDir(dataDir))}:/shared`,
        '-e',
        `DESKMATES_TOKEN=${token}`,
        IMAGE
      ])
    )
    // The network is created strictly before the container that references it.
    const networkCallIndex = fake.calls.findIndex((c) => c.args.slice(4).join(' ') === `network create ${network}`)
    const runCallIndex = fake.calls.findIndex((c) => c.args.slice(4)[0] === 'run')
    expect(networkCallIndex).toBeGreaterThanOrEqual(0)
    expect(networkCallIndex).toBeLessThan(runCallIndex)
    expect(fake.calls.some((c) => c.args.slice(4)[0] === 'inspect')).toBe(true)
  })

  it('gives each bot its own isolated network, distinct from every other bot and from the shared PC', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.create('bot-b', OPTS)

    const nameA = ownContainerName('bot-a')
    const nameB = ownContainerName('bot-b')
    const networkA = networkNameFor(nameA)
    const networkB = networkNameFor(nameB)
    expect(networkA).not.toBe(networkB)
    expect(fake.networks.has(networkA)).toBe(true)
    expect(fake.networks.has(networkB)).toBe(true)

    const argsA = runCallsFor(fake, nameA)[0].args.slice(4)
    const argsB = runCallsFor(fake, nameB)[0].args.slice(4)
    expect(argsA[argsA.indexOf('--network') + 1]).toBe(networkA)
    expect(argsB[argsB.indexOf('--network') + 1]).toBe(networkB)
    // Neither bot's --network value ever matches the other bot's container name or network.
    expect(argsA).not.toContain(networkB)
    expect(argsB).not.toContain(networkA)
  })

  it('reuses an already-existing network instead of failing, when one was left over from before (e.g. an older registry.json)', async () => {
    const { host, fake } = makeHost()
    const network = networkNameFor(ownContainerName('bot-a'))
    fake.networks.add(network) // simulates a leftover network from a prior, incomplete teardown

    const pc = await host.create('bot-a', OPTS)
    expect(pc.state).toBe('running')
    expect(callsMatching(fake, 'network').map((c) => c.args.slice(4))).toEqual([['network', 'create', network]])
  })

  it('is idempotent: calling it again on an already-running PC does not run a second container', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    const runsBefore = callsMatching(fake, 'run').length
    const pc = await host.create('bot-a', OPTS)
    expect(pc.state).toBe('running')
    expect(callsMatching(fake, 'run')).toHaveLength(runsBefore)
  })

  it('is idempotent even when the container already exists but is stopped: it starts it instead of returning it stopped (regression test)', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    expect(fake.containers.get(ownContainerName('bot-a'))?.status).toBe('exited')

    const pc = await host.create('bot-a', OPTS)
    expect(pc.state).toBe('running')
    expect(callsMatching(fake, 'start')).toHaveLength(1)
    expect(callsMatching(fake, 'run')).toHaveLength(1) // no second `docker run`
  })

  it('throws rather than silently reporting an error state when the existing container is unhealthy', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    fake.containers.get(ownContainerName('bot-a'))!.dead = true
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({ code: 'unknown', message: 'This PC died unexpectedly.' })
  })

  it('fails fast when the engine is down for a never-created bot, without attempting a docker run', async () => {
    const { host, fake } = makeHost()
    fake.engineDown = true
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({ code: 'engine-not-running' })
    expect(callsMatching(fake, 'run')).toHaveLength(0)
  })

  it('retries `docker run` without --cpus and still starts the PC when the WSL2 host cannot delegate the CPU cgroup controller (regression test, real error text)', async () => {
    const { host, fake } = makeHost()
    fake.cpuLimitUnsupported = true

    const pc = await host.create('bot-a', OPTS)

    expect(pc.state).toBe('running')
    const name = ownContainerName('bot-a')
    const runs = runCallsFor(fake, name)
    expect(runs).toHaveLength(2)
    expect(runs[0].args).toContain('--cpus')
    expect(runs[1].args).not.toContain('--cpus')
    // Everything else about the retried command is unchanged — same memory cap, ports, volumes and token.
    expect(runs[1].args).toContain('--memory')
    expect(runs[1].args).toContain('1024m')
  })

  it('still fails with the real docker error when --cpus is not the problem, without a pointless retry', async () => {
    const { host, fake } = makeHost()
    fake.portConflicts.add(ownContainerName('bot-a'))
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({ code: 'port-taken' })
    expect(runCallsFor(fake, ownContainerName('bot-a'))).toHaveLength(1)
  })
})

// ---- start/stop (own mode) ----

describe('start/stop (own mode)', () => {
  it('start throws not-created for a bot that was never created', async () => {
    const { host } = makeHost()
    await expect(host.start('never-created')).rejects.toMatchObject({
      code: 'not-created',
      message: "This bot's PC hasn't been created yet."
    })
  })

  it('start restarts a stopped container and updates lastUsedAt via the injected clock', async () => {
    const clock = makeClock(0)
    const { host, fake } = makeHost({ clock })
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    clock.set(5000)

    const pc = await host.start('bot-a')
    expect(pc.state).toBe('running')
    expect(pc.lastUsedAt).toBe(5000)
    expect(callsMatching(fake, 'start')).toHaveLength(1)
  })

  it('start on an already-running PC just confirms it, without calling docker start', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.start('bot-a')
    expect(callsMatching(fake, 'start')).toHaveLength(0)
  })

  it('start throws container-died when the container exits right after starting', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    fake.diesRightAway.add(ownContainerName('bot-a'))
    await expect(host.start('bot-a')).rejects.toMatchObject({ code: 'container-died' })
  })

  it('stop stops a running container and is a no-op (no docker stop call) when it is already stopped', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    expect(callsMatching(fake, 'stop')).toHaveLength(1)

    await host.stop('bot-a') // already stopped
    expect(callsMatching(fake, 'stop')).toHaveLength(1) // unchanged
  })

  it('own mode gives every bot a fully independent container', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.create('bot-b', OPTS)
    await host.stop('bot-a')
    expect(fake.containers.get(ownContainerName('bot-a'))?.status).toBe('exited')
    expect(fake.containers.get(ownContainerName('bot-b'))?.status).toBe('running')
  })
})

// ---- reset / delete ----

describe('reset', () => {
  it("removes the container, its network and its storage, but keeps the bot's port slot for next time", async () => {
    const { host, fake, dataDir } = makeHost()
    await host.create('bot-a', OPTS)
    await host.create('bot-b', OPTS) // occupies the next slot, so bot-a's slot specifically is what we prove survives
    const beforePorts = allPortsFromRunCall(fake, ownContainerName('bot-a'))
    const network = networkNameFor(ownContainerName('bot-a'))
    expect(fake.networks.has(network)).toBe(true)
    mkdirSync(pcStorageDir(dataDir, 'bot-a'), { recursive: true })
    writeFileSync(join(pcStorageDir(dataDir, 'bot-a'), 'marker.txt'), 'x')

    const reset = await host.reset('bot-a')
    expect(reset.state).toBe('absent')
    expect(fake.containers.has(ownContainerName('bot-a'))).toBe(false)
    expect(fake.networks.has(network)).toBe(false)
    expect(existsSync(pcStorageDir(dataDir, 'bot-a'))).toBe(false)
    // bot-b's own network is untouched — resetting one bot never touches another bot's isolation.
    expect(fake.networks.has(networkNameFor(ownContainerName('bot-b')))).toBe(true)

    await host.create('bot-a', OPTS)
    expect(allPortsFromRunCall(fake, ownContainerName('bot-a'), 1)).toEqual(beforePorts)
    expect(fake.networks.has(network)).toBe(true) // recreated fresh for the new container
  })

  it('is a no-op, not an error, when the container was never created (and never attempts a network removal)', async () => {
    const { host, fake } = makeHost()
    const pc = await host.reset('never-created')
    expect(pc.state).toBe('absent')
    expect(callsMatching(fake, 'network')).toHaveLength(0)
  })

  it('still removes the container and storage even when removing its network fails for a reason other than "already gone" (best-effort cleanup)', async () => {
    const { host, fake, dataDir } = makeHost()
    await host.create('bot-a', OPTS)
    const network = networkNameFor(ownContainerName('bot-a'))
    fake.networkRmFails.add(network) // simulates e.g. "network has active endpoints"
    mkdirSync(pcStorageDir(dataDir, 'bot-a'), { recursive: true })

    const reset = await host.reset('bot-a')

    expect(reset.state).toBe('absent')
    expect(fake.containers.has(ownContainerName('bot-a'))).toBe(false)
    expect(existsSync(pcStorageDir(dataDir, 'bot-a'))).toBe(false) // storage cleanup wasn't blocked by the failed network rm
  })
})

describe('delete', () => {
  it('removes the container, its network and storage, and frees the port slot for reuse', async () => {
    const { host, fake, dataDir } = makeHost()
    await host.create('bot-a', OPTS) // slot 1
    await host.create('bot-b', OPTS) // slot 2
    const networkA = networkNameFor(ownContainerName('bot-a'))
    const networkB = networkNameFor(ownContainerName('bot-b'))
    mkdirSync(pcStorageDir(dataDir, 'bot-a'), { recursive: true })

    await host.delete('bot-a')
    expect(fake.containers.has(ownContainerName('bot-a'))).toBe(false)
    expect(fake.networks.has(networkA)).toBe(false)
    expect(existsSync(pcStorageDir(dataDir, 'bot-a'))).toBe(false)
    expect(fake.networks.has(networkB)).toBe(true) // bot-b's isolation is untouched by deleting bot-a
    expect(callsMatching(fake, 'network').map((c) => c.args.slice(4))).toEqual([
      ['network', 'create', networkA],
      ['network', 'create', networkB],
      ['network', 'rm', networkA]
    ])

    await host.create('bot-c', OPTS) // should reclaim bot-a's freed slot 1
    expect(allPortsFromRunCall(fake, ownContainerName('bot-c'))).toEqual(allPortsFromRunCall(fake, ownContainerName('bot-a')))
  })

  it('clears a deleted bot that currently holds the shared PC turn, promoting the next queued bot', async () => {
    const { host } = makeHost()
    host.setMode('shared')
    await host.start('bot-a')
    const bPending = host.start('bot-b')
    await host.delete('bot-a')
    await expect(bPending).resolves.toMatchObject({ state: 'running', botId: 'bot-b' })
  })

  it("rejects a deleted bot's pending wait for the shared PC, without disturbing the rest of the queue", async () => {
    const { host } = makeHost()
    host.setMode('shared')
    await host.start('bot-a')
    const bPending = host.start('bot-b')
    const cPending = host.start('bot-c')
    bPending.catch(() => {})

    await host.delete('bot-b')
    await expect(bPending).rejects.toThrow('This bot was deleted while waiting for the shared PC.')

    await host.stop('bot-a')
    await expect(cPending).resolves.toMatchObject({ botId: 'bot-c' })
  })
})

// ---- status ----

describe('status', () => {
  it('reports absent for a bot that was never created', async () => {
    const { host } = makeHost()
    expect((await host.status('never-created')).state).toBe('absent')
  })

  it('reports running, stopped and starting straight from docker inspect', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    expect((await host.status('bot-a')).state).toBe('running')
    await host.stop('bot-a')
    expect((await host.status('bot-a')).state).toBe('stopped')
    fake.containers.get(ownContainerName('bot-a'))!.status = 'restarting'
    expect((await host.status('bot-a')).state).toBe('starting')
  })

  it('never throws, even when the engine is unreachable', async () => {
    const { host, fake } = makeHost()
    fake.engineDown = true
    await expect(host.status('bot-a')).resolves.toMatchObject({
      state: 'error',
      error: "The Deskmates engine isn't running. Open the setup wizard to start it."
    })
  })
})

// ---- endpoints ----

describe('endpoints', () => {
  it('is null before the PC has ever started, and populated with matching URLs and the run-time token after start', async () => {
    const { host, fake } = makeHost()
    expect(await host.endpoints('bot-a')).toBeNull()

    await host.create('bot-a', OPTS)
    const name = ownContainerName('bot-a')
    const token = tokenFromRunCall(fake, name)
    const ports = allPortsFromRunCall(fake, name)
    expect(await host.endpoints('bot-a')).toEqual({
      agent: `http://127.0.0.1:${ports.agent}`,
      novnc: `http://127.0.0.1:${ports.novnc}`,
      cdp: `http://127.0.0.1:${ports.cdp}`,
      token
    })
  })

  it('goes back to null once the PC stops', async () => {
    const { host } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    expect(await host.endpoints('bot-a')).toBeNull()
  })
})

// ---- exec ----

describe('exec', () => {
  it('runs the command as a plain argument list — never a shell string — and returns the in-container exit code as-is', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    const name = ownContainerName('bot-a')
    fake.execResponses.set([name, 'sh', '-c', 'exit 3'].join('\u0000'), { code: 3, stdout: 'partial output', stderr: 'oops' })

    const result = await host.exec('bot-a', 'sh', ['-c', 'exit 3'])
    expect(result).toEqual({ code: 3, stdout: 'partial output', stderr: 'oops' })
    expect(lastCall(fake).args).toEqual(dockerArgs(['exec', name, 'sh', '-c', 'exit 3']))
  })

  it('adds -i and forwards stdin/timeout when input is given', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    const name = ownContainerName('bot-a')
    await host.exec('bot-a', 'cat', [], { input: 'hello', timeoutMs: 5000 })
    expect(lastCall(fake).args).toEqual(dockerArgs(['exec', '-i', name, 'cat']))
    expect(lastCall(fake).options).toMatchObject({ input: 'hello', timeoutMs: 5000 })
  })

  it('throws a classified BotHostError for a docker-level failure, distinct from a non-zero command exit', async () => {
    const { host } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    await expect(host.exec('bot-a', 'ls', [])).rejects.toMatchObject({ code: 'not-running' })
  })

  it('updates lastUsedAt', async () => {
    const clock = makeClock(0)
    const { host } = makeHost({ clock })
    await host.create('bot-a', OPTS)
    clock.advance(5000)
    await host.exec('bot-a', 'true', [])
    expect((await host.status('bot-a')).lastUsedAt).toBe(5000)
  })
})

// ---- copyIn / copyOut ----

describe('copyIn / copyOut', () => {
  it('copyIn passes the WSL-mapped local path and container:path as separate array elements', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    const name = ownContainerName('bot-a')
    await host.copyIn('bot-a', 'C:\\Users\\david\\file.txt', '/home/bot/data/file.txt')
    expect(lastCall(fake).args).toEqual(dockerArgs(['cp', toWslPath('C:\\Users\\david\\file.txt'), `${name}:/home/bot/data/file.txt`]))
  })

  it('copyOut passes container:path and the WSL-mapped local path as separate array elements', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    const name = ownContainerName('bot-a')
    await host.copyOut('bot-a', '/home/bot/data/out.png', 'C:\\Users\\david\\out.png')
    expect(lastCall(fake).args).toEqual(dockerArgs(['cp', `${name}:/home/bot/data/out.png`, toWslPath('C:\\Users\\david\\out.png')]))
  })

  it('maps a failed copy to a classified BotHostError', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    fake.nextCpResult = { code: 1, stdout: '', stderr: 'Error: No such container:path' }
    await expect(host.copyOut('bot-a', '/nope', 'C:\\x')).rejects.toBeInstanceOf(BotHostError)
  })
})

// ---- pull / buildLocal ----

describe('pull / buildLocal', () => {
  it('pull runs docker pull with the default image, or a given override', async () => {
    const { host, fake } = makeHost()
    await host.pull()
    expect(lastCall(fake).args).toEqual(dockerArgs(['pull', IMAGE]))
    await host.pull('other/image:tag')
    expect(lastCall(fake).args).toEqual(dockerArgs(['pull', 'other/image:tag']))
  })

  it('pull throws image-missing when the registry does not have the image', async () => {
    const { host, fake } = makeHost()
    fake.missingImages.add(IMAGE)
    await expect(host.pull()).rejects.toMatchObject({ code: 'image-missing' })
  })

  it('buildLocal runs docker build with -t <image> and the WSL-mapped context dir', async () => {
    const { host, fake } = makeHost()
    await host.buildLocal('C:\\Projects\\Deskmates\\bot-image', 'my-custom:tag')
    expect(lastCall(fake).args).toEqual(dockerArgs(['build', '-t', 'my-custom:tag', toWslPath('C:\\Projects\\Deskmates\\bot-image')]))
  })
})

// ---- port allocation across restarts ----

describe('port allocation', () => {
  it('gives sequential bots sequential port slots, all bound to 127.0.0.1', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.create('bot-b', OPTS)
    const a = allPortsFromRunCall(fake, ownContainerName('bot-a'))
    const b = allPortsFromRunCall(fake, ownContainerName('bot-b'))
    expect(b.agent).toBe(a.agent + 1)
    expect(b.novnc).toBe(a.novnc + 1)
    expect(b.cdp).toBe(a.cdp + 1)
    // Every `-p` port mapping (as opposed to the `-v` volume args, which also contain a `:`) is host-bound to 127.0.0.1.
    for (const call of [...runCallsFor(fake, ownContainerName('bot-a')), ...runCallsFor(fake, ownContainerName('bot-b'))]) {
      const sub = call.args.slice(4)
      const mappings = sub.filter((_arg, i) => sub[i - 1] === '-p')
      expect(mappings).toHaveLength(3)
      for (const mapping of mappings) expect(mapping.startsWith('127.0.0.1:')).toBe(true)
    }
  })

  it("reuses a bot's port slot across an app restart, because it is persisted to registry.json on disk", async () => {
    const dataDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-host-')))
    createdDataDirs.push(dataDir)
    const fake = new FakeDocker()

    const host1 = new LocalWslHost({ runner: fake, dataDir, image: IMAGE, clock: makeClock().now, spawner: new FakeSpawner(), probe: answeringProbe })
    await host1.create('bot-a', OPTS)
    const originalPorts = allPortsFromRunCall(fake, ownContainerName('bot-a'))

    // A fresh LocalWslHost over the same dataDir simulates the app restarting: its PcRegistry
    // reloads from registry.json, while `fake` keeps standing in for the containers Docker itself
    // would still have running.
    const host2 = new LocalWslHost({ runner: fake, dataDir, image: IMAGE, clock: makeClock().now, spawner: new FakeSpawner(), probe: answeringProbe })
    await host2.reset('bot-a') // removes the container but keeps the registry's slot
    await host2.create('bot-a', OPTS)
    expect(allPortsFromRunCall(fake, ownContainerName('bot-a'), 1)).toEqual(originalPorts)
  })
})

// ---- shared mode and its queue ----

describe('shared mode and the queue', () => {
  it('the first start() becomes holder immediately; later ones wait and are promoted in order', async () => {
    const { host, fake } = makeHost()
    host.setMode('shared')

    const a = await host.start('bot-a')
    expect(a).toMatchObject({ state: 'running', botId: 'bot-a' })
    expect(callsMatching(fake, 'run')).toHaveLength(1)

    const bPending = host.start('bot-b')
    const cPending = host.start('bot-c')
    // Queued bots cause no docker activity of their own yet.
    expect(callsMatching(fake, 'run')).toHaveLength(1)
    expect(callsMatching(fake, 'start')).toHaveLength(0)

    await host.stop('bot-a')
    await expect(bPending).resolves.toMatchObject({ state: 'running', botId: 'bot-b' })

    await host.stop('bot-b')
    await expect(cPending).resolves.toMatchObject({ state: 'running', botId: 'bot-c' })

    await host.stop('bot-c')
    expect(fake.containers.get(SHARED_CONTAINER_NAME)?.status).toBe('exited') // queue empty, PC actually stopped
  })

  it('reports a queued bot as not running via status() and endpoints(), even though the shared PC is genuinely running for its holder (regression test)', async () => {
    const { host } = makeHost()
    host.setMode('shared')
    await host.start('bot-a')
    const bPending = host.start('bot-b')

    expect((await host.status('bot-b')).state).toBe('starting')
    expect(await host.endpoints('bot-b')).toBeNull()

    expect((await host.status('bot-a')).state).toBe('running')
    expect(await host.endpoints('bot-a')).not.toBeNull()

    await host.stop('bot-a')
    await bPending
  })

  it('a queued bot that calls stop() cancels its wait, rejecting its pending start() without disturbing the rest of the queue', async () => {
    const { host } = makeHost()
    host.setMode('shared')
    await host.start('bot-a')
    const bPending = host.start('bot-b')
    const cPending = host.start('bot-c')
    bPending.catch(() => {})

    await host.stop('bot-b')
    await expect(bPending).rejects.toThrow('The wait for the shared PC was cancelled.')

    await host.stop('bot-a')
    await expect(cPending).resolves.toMatchObject({ botId: 'bot-c' })
  })

  it('a bot that calls start() again while still queued gets a promise chained to the same pending turn, instead of orphaning the first call (regression test)', async () => {
    // `start()` is an `async` method, so even when both calls internally share the one pending
    // promise in `sharedPending`, each call's own wrapper promise is a distinct object — `toBe`
    // would never pass here. The real, observable guarantee is that BOTH calls settle once the
    // turn comes up, rather than the first one being silently dropped and hanging forever (which
    // is what happened before this was fixed: a second `start()` while queued overwrote the
    // waiter map entry, so only the second call's promise ever got resolved).
    const { host } = makeHost()
    host.setMode('shared')
    await host.start('bot-a')
    const first = host.start('bot-b')
    const second = host.start('bot-b')

    await host.stop('bot-a')
    await expect(first).resolves.toMatchObject({ state: 'running' })
    await expect(second).resolves.toMatchObject({ state: 'running' })
  })

  it('each bot keeps its own dedicated (stopped) container in either mode: switching to shared mode does not delete or touch it', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    host.setMode('shared')
    await host.start('bot-a')
    // bot-a's own container from create() is untouched — only the separate shared container ran.
    expect(fake.containers.get(ownContainerName('bot-a'))?.status).toBe('running')
    expect(fake.containers.get(SHARED_CONTAINER_NAME)?.status).toBe('running')
    expect(runCallsFor(fake, ownContainerName('bot-a'))).toHaveLength(1)
  })

  it('configureShared live-updates an already-provisioned shared PC (idle policy takes effect without recreating it)', async () => {
    const clock = makeClock(0)
    const { host, fake } = makeHost({ clock, sharedOptions: { memoryMb: 512, cpuLimit: 1, idleStopMinutes: 30 } })
    host.setMode('shared')
    await host.start('bot-a')

    host.configureShared({ memoryMb: 512, cpuLimit: 1, idleStopMinutes: 5 })
    clock.advance(6 * 60_000) // past the new 5-minute policy, well under the original 30
    await host.checkIdle()
    expect(fake.containers.get(SHARED_CONTAINER_NAME)?.status).toBe('exited')
  })
})

// ---- idle stop ----

describe('checkIdle', () => {
  it('stops an own-mode PC once idle past idleStopMinutes, and not a moment before', async () => {
    const clock = makeClock(0)
    const { host, fake } = makeHost({ clock })
    await host.create('bot-a', { ...OPTS, idleStopMinutes: 10 })

    clock.advance(9 * 60_000)
    await host.checkIdle()
    expect(fake.containers.get(ownContainerName('bot-a'))?.status).toBe('running')

    clock.advance(2 * 60_000) // 11 minutes total
    await host.checkIdle()
    expect(fake.containers.get(ownContainerName('bot-a'))?.status).toBe('exited')
  })

  it('never stops a PC when idleStopMinutes is 0, no matter how long it sits idle', async () => {
    const clock = makeClock(0)
    const { host, fake } = makeHost({ clock })
    await host.create('bot-a', { ...OPTS, idleStopMinutes: 0 })
    clock.advance(10_000_000)
    await host.checkIdle()
    expect(fake.containers.get(ownContainerName('bot-a'))?.status).toBe('running')
  })

  it('idle-stopping the shared PC promotes the next queued bot automatically', async () => {
    const clock = makeClock(0)
    const { host, fake } = makeHost({ clock, sharedOptions: { ...OPTS, idleStopMinutes: 15 } })
    host.setMode('shared')
    await host.start('bot-a')
    const bPending = host.start('bot-b')

    clock.advance(16 * 60_000)
    await host.checkIdle()

    await expect(bPending).resolves.toMatchObject({ state: 'running', botId: 'bot-b' })
    expect(fake.containers.get(SHARED_CONTAINER_NAME)?.status).toBe('running')
  })

  it('a freshly restarted host has no in-memory usage history yet, so it idle-stops nothing until a PC is used again', async () => {
    const dataDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-host-')))
    createdDataDirs.push(dataDir)
    const fake = new FakeDocker()
    const host1 = new LocalWslHost({ runner: fake, dataDir, image: IMAGE, clock: makeClock(0).now, spawner: new FakeSpawner(), probe: answeringProbe })
    await host1.create('bot-a', { ...OPTS, idleStopMinutes: 5 })

    const clock2 = makeClock(10_000_000)
    const host2 = new LocalWslHost({ runner: fake, dataDir, image: IMAGE, clock: clock2.now, spawner: new FakeSpawner(), probe: answeringProbe })
    await host2.checkIdle()
    expect(fake.containers.get(ownContainerName('bot-a'))?.status).toBe('running')
  })
})

// ---- error mapping ----

describe('error mapping', () => {
  it('engine-not-running: an unreachable engine maps to a plain "open the setup wizard" sentence, with raw stderr kept as cause', async () => {
    const { host, fake } = makeHost()
    fake.engineDown = true
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({
      code: 'engine-not-running',
      message: "The Deskmates engine isn't running. Open the setup wizard to start it."
    })
    try {
      await host.create('bot-a', OPTS)
      throw new Error('expected create() to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(BotHostError)
      expect((error as BotHostError).cause).toContain('error during connect')
    }
  })

  it('image-missing: an unknown image maps to a plain "download or build it" sentence', async () => {
    const { host, fake } = makeHost()
    fake.missingImages.add(IMAGE)
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({
      code: 'image-missing',
      message: "This bot's PC image isn't installed yet. Download or build it from Settings."
    })
  })

  it('port-taken: a bound port maps to a plain "another program" sentence', async () => {
    const { host, fake } = makeHost()
    fake.portConflicts.add(ownContainerName('bot-a'))
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({
      code: 'port-taken',
      message: "Another program is already using this bot's PC ports. Close it and try again."
    })
  })

  it('container-died: a container that exits right after starting maps to a plain sentence, with the exit output as cause', async () => {
    const { host, fake } = makeHost()
    fake.diesRightAway.add(ownContainerName('bot-a'))
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({
      code: 'container-died',
      message: "This bot's PC stopped right after starting."
    })
  })

  it('not-created: starting a never-created bot says "hasn\'t been created"; starting one whose container vanished says "reset it"', async () => {
    const { host } = makeHost()
    await expect(host.start('never-created')).rejects.toMatchObject({
      code: 'not-created',
      message: "This bot's PC hasn't been created yet."
    })

    const { host: host2, fake: fake2 } = makeHost()
    await host2.create('bot-a', OPTS)
    fake2.containers.delete(ownContainerName('bot-a')) // e.g. removed outside the app
    await expect(host2.start('bot-a')).rejects.toMatchObject({
      code: 'not-created',
      message: "This bot's PC is missing. Reset it to create a new one."
    })
  })

  it('not-running: exec against a stopped PC maps to a plain sentence, distinct from the command\'s own exit code', async () => {
    const { host } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    await expect(host.exec('bot-a', 'ls', [])).rejects.toMatchObject({
      code: 'not-running',
      message: "This bot's PC isn't running right now."
    })
  })

  it('unknown: a container-level Dead/OOMKilled state maps to its own specific sentence under the unknown code', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    fake.containers.get(ownContainerName('bot-a'))!.dead = true
    await expect(host.start('bot-a')).rejects.toMatchObject({ code: 'unknown', message: 'This PC died unexpectedly.' })

    const { host: host2, fake: fake2 } = makeHost()
    await host2.create('bot-a', OPTS)
    fake2.containers.get(ownContainerName('bot-a'))!.oomKilled = true
    await expect(host2.start('bot-a')).rejects.toMatchObject({
      code: 'unknown',
      message: 'This PC ran out of memory and stopped. Increase its memory limit.'
    })
  })

  it('an engine outage discovered mid-session is reported as engine-not-running, never misdiagnosed as a missing PC (regression test)', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    fake.engineDown = true
    await expect(host.start('bot-a')).rejects.toMatchObject({
      code: 'engine-not-running',
      message: "The Deskmates engine isn't running. Open the setup wizard to start it."
    })
  })
})

// ---- engine keep-alive and readiness ----

describe('engine keep-alive and readiness', () => {
  const KEEP_ALIVE_ARGS = ['-d', DISTRO, '-u', 'root', '--', 'sh', '-c', 'cat >/dev/null']

  it('makes sure dockerd is up before touching the container, so a distro WSL just stopped and rebooted still starts its PC', async () => {
    const { host, fake } = makeHost()
    await host.create('bot-a', OPTS)
    await host.stop('bot-a')
    fake.daemonStopped = true
    fake.calls.length = 0

    const pc = await host.start('bot-a')
    expect(pc.state).toBe('running')
    const startDockerIndex = fake.calls.findIndex((c) => isStartDockerCall(c.args))
    const inspectIndex = fake.calls.findIndex((c) => c.args.slice(4)[0] === 'inspect')
    expect(startDockerIndex).toBeGreaterThanOrEqual(0)
    expect(startDockerIndex).toBeLessThan(inspectIndex)
    expect(callsMatching(fake, 'start')).toHaveLength(1)
  })

  it('reports engine-not-running when dockerd will not start, and does not keep the engine held', async () => {
    const { host, fake, spawner } = makeHost()
    fake.dockerStartFails = true
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({ code: 'engine-not-running' })
    expect(callsMatching(fake, 'run')).toHaveLength(0)
    expect(spawner.alive()).toHaveLength(0)
  })

  it('holds one keep-alive wsl.exe while any PC is running and releases it when the last one stops', async () => {
    const { host, spawner } = makeHost()
    await host.create('bot-a', OPTS)
    await host.create('bot-b', OPTS)
    expect(spawner.spawned).toHaveLength(1)
    expect(spawner.spawned[0]).toMatchObject({ file: WSL_EXE, args: KEEP_ALIVE_ARGS, alive: true })

    await host.stop('bot-a')
    expect(spawner.alive()).toHaveLength(1)
    await host.stop('bot-b')
    expect(spawner.alive()).toHaveLength(0)

    await host.start('bot-a')
    expect(spawner.alive()).toHaveLength(1)
    await host.delete('bot-a')
    expect(spawner.alive()).toHaveLength(0)
  })

  it('releases the keep-alive when the last running PC is idle-stopped', async () => {
    const clock = makeClock(0)
    const { host, spawner } = makeHost({ clock })
    await host.create('bot-a', { ...OPTS, idleStopMinutes: 5 })
    expect(spawner.alive()).toHaveLength(1)

    clock.advance(6 * 60_000)
    await host.checkIdle()
    expect(spawner.alive()).toHaveLength(0)
  })

  it('holds the shared PC too, and releases it once the last bot gives up its turn', async () => {
    const { host, spawner } = makeHost()
    host.setMode('shared')
    await host.start('bot-a')
    expect(spawner.alive()).toHaveLength(1)
    await host.stop('bot-a')
    expect(spawner.alive()).toHaveLength(0)
  })

  it('starts a new keep-alive when the previous one exited on its own (e.g. wsl --shutdown)', async () => {
    const { host, spawner } = makeHost()
    await host.create('bot-a', OPTS)
    spawner.spawned[0].exit()

    await host.start('bot-a')
    expect(spawner.spawned).toHaveLength(2)
    expect(spawner.alive()).toHaveLength(1)
  })

  it('dispose releases the keep-alive', async () => {
    const { host, spawner } = makeHost()
    await host.create('bot-a', OPTS)
    host.dispose()
    expect(spawner.alive()).toHaveLength(0)
  })

  it("waits until the PC's agent and browser answer before start returns, probing the PC's own endpoints", async () => {
    let answersAfter = 3
    const probed: PcEndpoints[] = []
    const probe: PcProbe = async (endpoints) => {
      probed.push(endpoints)
      return --answersAfter <= 0
    }
    const { host, fake } = makeHost({ probe, readyTimeoutMs: 10_000 })
    await host.create('bot-a', OPTS)

    expect(probed).toHaveLength(3)
    const ports = allPortsFromRunCall(fake, ownContainerName('bot-a'))
    expect(probed[0]).toEqual({
      agent: `http://127.0.0.1:${ports.agent}`,
      novnc: `http://127.0.0.1:${ports.novnc}`,
      cdp: `http://127.0.0.1:${ports.cdp}`,
      token: tokenFromRunCall(fake, ownContainerName('bot-a'))
    })
  })

  it('throws not-responding when the PC runs but never answers in time, keeping the engine held for the running container', async () => {
    const { host, spawner } = makeHost({ probe: async () => false, readyTimeoutMs: 0 })
    await expect(host.create('bot-a', OPTS)).rejects.toMatchObject({ code: 'not-responding' })
    expect(spawner.alive()).toHaveLength(1)
  })
})
