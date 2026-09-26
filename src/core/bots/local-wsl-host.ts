import { rmSync } from 'node:fs'
import type { BotPc, PcMode, PcState } from '../../shared/protocol'
import type { CommandRunner } from './command-runner'
import { ChildProcessBackgroundSpawner, EngineKeepAlive, type BackgroundSpawner } from './engine-keepalive'
import { BotHostError, type BotHost, type CreatePcOptions, type ExecOptions, type ExecResult, type PcEndpoints } from './host'
import { classifyDockerError, isKnownDockerFailure } from './host-errors'
import {
  AGENT_CONTAINER_PORT,
  CDP_CONTAINER_PORT,
  NOVNC_CONTAINER_PORT,
  SHARED_CONTAINER_NAME,
  WSL_EXE,
  dockerArgs,
  networkNameFor,
  ownContainerName,
  pcStorageDir,
  portsFor,
  sharedDir,
  startDockerArgs,
  toWslPath
} from './host-paths'
import { PcRegistry, SHARED_PC_ID, type PcRecord } from './host-registry'
import { probePcServices, waitForPcServices, type PcProbe } from './pc-health'

const DEFAULT_IMAGE = 'ghcr.io/deskmates/bot-pc:latest'
const DEFAULT_SHARED_OPTIONS: CreatePcOptions = { memoryMb: 1024, cpuLimit: 2, idleStopMinutes: 20 }
const DEFAULT_READY_TIMEOUT_MS = 60_000

function validateCreateOptions(options: CreatePcOptions): void {
  if (!Number.isFinite(options.memoryMb) || options.memoryMb <= 0) {
    throw new Error('memoryMb must be a positive number.')
  }
  if (!Number.isFinite(options.cpuLimit) || options.cpuLimit <= 0) {
    throw new Error('cpuLimit must be a positive number.')
  }
  if (!Number.isFinite(options.idleStopMinutes) || options.idleStopMinutes < 0) {
    throw new Error('idleStopMinutes must be zero or a positive number.')
  }
}

// Shape of `docker inspect <name>`'s JSON array output, trimmed to the fields this module reads.
interface DockerInspectResult {
  Id: string
  State: {
    Status: string
    OOMKilled?: boolean
    Dead?: boolean
    Error?: string
  }
}

interface PcSnapshot {
  state: PcState
  containerId: string | null
  error: string | null
}

interface ContainerInfo extends PcSnapshot {
  /**
   * Set only when `state === 'error'` because the `docker inspect` command itself failed (engine
   * down, distro missing, etc.) — the fully classified error, so callers that need to throw can
   * reuse its code and cause instead of downgrading to a generic 'unknown'. Absent when the error
   * instead came from container-level state on a successful inspect (Dead/OOMKilled/Error).
   */
  hostError?: BotHostError
}

interface SharedWaiter {
  resolve: (pc: BotPc) => void
  reject: (error: unknown) => void
}

export interface LocalWslHostOptions {
  runner: CommandRunner
  /** The app's data folder, e.g. `D:\DeskmatesData`. Owns `<dataDir>/pcs/` and reads `<dataDir>/shared/`. */
  dataDir: string
  /** Bot PC image reference `create`/`start` run, and the default for `pull`/`buildLocal`. */
  image?: string
  mode?: PcMode
  /** Resource caps and idle policy for the shared PC, used the first time it's created. See `configureShared`. */
  sharedOptions?: CreatePcOptions
  /** Defaults to `Date.now`; tests inject a fake so idle-stop timing is deterministic. */
  clock?: () => number
  /** Starts the process that keeps the engine distro up while a PC is in use. Defaults to real child processes; tests inject a fake. */
  spawner?: BackgroundSpawner
  /** Checks whether a PC's agent and browser answer. Defaults to real HTTP requests; tests inject a fake. */
  probe?: PcProbe
  /** How long `create`/`start` wait for a started PC's agent and browser to answer. Defaults to 60 seconds. */
  readyTimeoutMs?: number
}

/** `BotHost` over `wsl -d deskmates-engine -- docker …`, run through an injected `CommandRunner`. */
export class LocalWslHost implements BotHost {
  private readonly runner: CommandRunner
  private readonly dataDir: string
  private readonly image: string
  private readonly clock: () => number
  private readonly registry: PcRegistry
  private readonly keepAlive: EngineKeepAlive
  private readonly probe: PcProbe
  private readonly readyTimeoutMs: number
  /** PCs (by botId, or `SHARED_PC_ID`) this process started and hasn't stopped; the keep-alive is held while this is non-empty. */
  private readonly activePcs = new Set<string>()

  private mode: PcMode
  private sharedOptions: CreatePcOptions

  /** botId currently holding the shared PC's turn, if any. */
  private sharedHolder: string | null = null
  /** botIds waiting their turn, in order. */
  private readonly sharedQueue: string[] = []
  private readonly sharedWaiters = new Map<string, SharedWaiter>()
  /** The promise already handed back to a queued bot, so a second `start()` call while still waiting returns the same promise instead of orphaning the first one. */
  private readonly sharedPending = new Map<string, Promise<BotPc>>()

  /** Last time each PC (by botId, or `SHARED_PC_ID`) was used — start/exec/copyIn/copyOut. Not persisted; idle-stop only needs it for as long as the process runs. */
  private readonly lastUsedAt = new Map<string, number>()

  constructor(options: LocalWslHostOptions) {
    this.runner = options.runner
    this.dataDir = options.dataDir
    this.image = options.image ?? DEFAULT_IMAGE
    this.clock = options.clock ?? Date.now
    this.mode = options.mode ?? 'own'
    this.sharedOptions = options.sharedOptions ?? DEFAULT_SHARED_OPTIONS
    this.registry = new PcRegistry(options.dataDir)
    this.keepAlive = new EngineKeepAlive(options.spawner ?? new ChildProcessBackgroundSpawner())
    this.probe = options.probe ?? ((endpoints) => probePcServices(endpoints))
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  }

  /** Stops holding the engine distro up, so WSL stops it (and every PC in it) once nothing else uses it. Call on shutdown. */
  dispose(): void {
    this.activePcs.clear()
    this.keepAlive.release()
  }

  // ---- PC mode (extra to the BotHost interface: see host.ts for why) ----

  setMode(mode: PcMode): void {
    this.mode = mode
  }

  getMode(): PcMode {
    return this.mode
  }

  /** Resource caps and idle policy applied the next time the shared PC needs creating; updates them live if it already exists. */
  configureShared(options: CreatePcOptions): void {
    validateCreateOptions(options)
    this.sharedOptions = options
    if (this.registry.get(SHARED_PC_ID)) this.registry.update(SHARED_PC_ID, options)
  }

  /** Changes a bot's stored memory/cpu/idle settings. Memory and cpu only take effect the next time its container is (re)created. */
  updatePcOptions(botId: string, patch: Partial<CreatePcOptions>): void {
    this.registry.update(botId, patch)
  }

  /** Stops any PC that's been idle past its `idleStopMinutes`. Call this periodically; timing comes entirely from the injected clock. */
  async checkIdle(): Promise<void> {
    const now = this.clock()
    for (const pcId of this.registry.knownIds()) {
      const record = this.registry.get(pcId)
      if (!record || record.idleStopMinutes <= 0) continue
      const last = this.lastUsedAt.get(pcId)
      if (last === undefined) continue
      if (now - last < record.idleStopMinutes * 60_000) continue

      if (pcId === SHARED_PC_ID) {
        const info = await this.inspectContainer(SHARED_CONTAINER_NAME)
        if (info.state !== 'running') continue
        const result = await this.runner.run(WSL_EXE, dockerArgs(['stop', SHARED_CONTAINER_NAME]))
        if (result.code === 0) {
          this.sharedHolder = null
          this.markStopped(SHARED_PC_ID)
          await this.promoteNextShared()
        }
      } else {
        const name = ownContainerName(pcId)
        const info = await this.inspectContainer(name)
        if (info.state !== 'running') continue
        const result = await this.runner.run(WSL_EXE, dockerArgs(['stop', name]))
        if (result.code === 0) this.markStopped(pcId)
      }
    }
  }

  // ---- BotHost ----

  async create(botId: string, options: CreatePcOptions): Promise<BotPc> {
    validateCreateOptions(options)
    const name = ownContainerName(botId)
    const record = this.registry.ensure(botId, options)
    const info = await this.bringUp(botId, async () => {
      const existing = await this.inspectContainer(name)
      if (existing.state === 'absent') return this.runContainer(name, botId, record)
      // Idempotent means the PC ends up running even when the container was already there —
      // whether that's because it's already running, or because it exists but is stopped.
      if (existing.state === 'running') return existing
      if (existing.state === 'error') {
        throw (
          existing.hostError ??
          new BotHostError('unknown', existing.error ?? "This bot's PC reported an error.", existing.error ?? undefined)
        )
      }
      return this.startExisting(name, "This bot's PC stopped right after starting.")
    })
    this.lastUsedAt.set(botId, this.clock())
    return this.buildBotPc(botId, botId, info)
  }

  async start(botId: string): Promise<BotPc> {
    return this.mode === 'own' ? this.startOwn(botId) : this.startShared(botId)
  }

  async stop(botId: string): Promise<BotPc> {
    return this.mode === 'own' ? this.stopOwn(botId) : this.stopShared(botId)
  }

  async reset(botId: string): Promise<BotPc> {
    const name = ownContainerName(botId)
    const rm = await this.runner.run(WSL_EXE, dockerArgs(['rm', '-f', name]))
    if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) throw classifyDockerError(rm)
    // Only a container that actually existed could have had a network created for it (`ensureNetwork`
    // only ever runs from `runContainer`) — skip the removal attempt entirely for a bot that was
    // never created, so this stays a true no-op rather than one always-failing docker call.
    if (rm.code === 0) await this.removeNetwork(name)
    rmSync(pcStorageDir(this.dataDir, botId), { recursive: true, force: true })
    this.lastUsedAt.delete(botId)
    this.markStopped(botId)
    return this.buildBotPc(botId, botId, { state: 'absent', containerId: null, error: null })
  }

  async delete(botId: string): Promise<void> {
    const name = ownContainerName(botId)
    const rm = await this.runner.run(WSL_EXE, dockerArgs(['rm', '-f', name]))
    if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) throw classifyDockerError(rm)
    if (rm.code === 0) await this.removeNetwork(name)
    rmSync(pcStorageDir(this.dataDir, botId), { recursive: true, force: true })
    this.lastUsedAt.delete(botId)
    this.markStopped(botId)
    this.registry.delete(botId)

    // Never leave a deleted bot holding up (or waiting in) the shared queue.
    if (this.sharedHolder === botId) {
      this.sharedHolder = null
      await this.promoteNextShared()
    } else {
      this.dequeueShared(botId, 'This bot was deleted while waiting for the shared PC.')
    }
  }

  async status(botId: string): Promise<BotPc> {
    const { pcId, name } = this.targetFor(botId)
    const info = await this.inspectContainer(name)
    if (this.isQueuedInShared(botId)) {
      return this.buildBotPc(botId, pcId, { state: 'starting', containerId: info.containerId, error: info.error })
    }
    return this.buildBotPc(botId, pcId, info)
  }

  async endpoints(botId: string): Promise<PcEndpoints | null> {
    // A bot still waiting its turn hasn't "started" from its own point of view, even though the
    // shared container is genuinely running for whichever bot currently holds it. Reporting that
    // other bot's live URLs here would let a queued bot's "Take over" toggle hijack the wrong run.
    if (this.isQueuedInShared(botId)) return null
    const { pcId, name } = this.targetFor(botId)
    const info = await this.inspectContainer(name)
    if (info.state !== 'running') return null
    const record = this.registry.get(pcId)
    if (!record) return null
    return this.endpointsFor(record)
  }

  async exec(botId: string, command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const { pcId, name } = this.targetFor(botId)
    const flags = options.input !== undefined ? ['-i'] : []
    const result = await this.runner.run(WSL_EXE, dockerArgs(['exec', ...flags, name, command, ...args]), {
      timeoutMs: options.timeoutMs,
      input: options.input
    })
    // A non-zero exit here can just as easily be the command's own exit code as a docker-level
    // failure (container missing/stopped). Only the latter should become a BotHostError.
    if (result.code !== 0 && isKnownDockerFailure(result)) throw classifyDockerError(result)
    this.lastUsedAt.set(pcId, this.clock())
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }

  async copyIn(botId: string, localPath: string, containerPath: string): Promise<void> {
    const { pcId, name } = this.targetFor(botId)
    const result = await this.runner.run(WSL_EXE, dockerArgs(['cp', toWslPath(localPath), `${name}:${containerPath}`]))
    if (result.code !== 0) throw classifyDockerError(result)
    this.lastUsedAt.set(pcId, this.clock())
  }

  async copyOut(botId: string, containerPath: string, localPath: string): Promise<void> {
    const { pcId, name } = this.targetFor(botId)
    const result = await this.runner.run(WSL_EXE, dockerArgs(['cp', `${name}:${containerPath}`, toWslPath(localPath)]))
    if (result.code !== 0) throw classifyDockerError(result)
    this.lastUsedAt.set(pcId, this.clock())
  }

  async pull(image?: string): Promise<void> {
    const result = await this.runner.run(WSL_EXE, dockerArgs(['pull', image ?? this.image]))
    if (result.code !== 0) throw classifyDockerError(result)
  }

  async buildLocal(contextDir: string, image?: string): Promise<void> {
    const result = await this.runner.run(WSL_EXE, dockerArgs(['build', '-t', image ?? this.image, toWslPath(contextDir)]))
    if (result.code !== 0) throw classifyDockerError(result)
  }

  // ---- own-mode start/stop ----

  private async startOwn(botId: string): Promise<BotPc> {
    const record = this.registry.get(botId)
    const name = ownContainerName(botId)
    if (!record) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
    const after = await this.bringUp(botId, async () => {
      const info = await this.inspectContainer(name)
      if (info.state === 'absent') {
        throw new BotHostError('not-created', "This bot's PC is missing. Reset it to create a new one.")
      }
      if (info.state === 'running') return info
      if (info.state === 'error') {
        // `hostError` carries the real code (e.g. 'engine-not-running') when `docker inspect` itself
        // failed; falling back to 'unknown' only for a genuine container-level error (Dead/OOMKilled).
        throw info.hostError ?? new BotHostError('unknown', info.error ?? "This bot's PC reported an error.", info.error ?? undefined)
      }
      return this.startExisting(name, "This bot's PC stopped right after starting.")
    })
    this.lastUsedAt.set(botId, this.clock())
    return this.buildBotPc(botId, botId, after)
  }

  private async stopOwn(botId: string): Promise<BotPc> {
    const name = ownContainerName(botId)
    const info = await this.inspectContainer(name)
    if (info.state !== 'running' && info.state !== 'starting') {
      this.markStopped(botId)
      return this.buildBotPc(botId, botId, info)
    }
    const result = await this.runner.run(WSL_EXE, dockerArgs(['stop', name]))
    if (result.code !== 0) throw classifyDockerError(result)
    this.markStopped(botId)
    const after = await this.inspectContainer(name)
    return this.buildBotPc(botId, botId, after)
  }

  // ---- shared-mode start/stop and its queue ----

  private async startShared(botId: string): Promise<BotPc> {
    if (this.sharedHolder === botId) {
      const info = await this.ensureSharedRunning()
      this.lastUsedAt.set(SHARED_PC_ID, this.clock())
      return this.buildBotPc(botId, SHARED_PC_ID, info)
    }
    if (this.sharedHolder === null) {
      this.sharedHolder = botId
      try {
        const info = await this.ensureSharedRunning()
        this.lastUsedAt.set(SHARED_PC_ID, this.clock())
        return this.buildBotPc(botId, SHARED_PC_ID, info)
      } catch (error) {
        this.sharedHolder = null
        throw error
      }
    }
    const pending = this.sharedPending.get(botId)
    if (pending) return pending
    if (!this.sharedQueue.includes(botId)) this.sharedQueue.push(botId)
    const promise = new Promise<BotPc>((resolve, reject) => {
      this.sharedWaiters.set(botId, { resolve, reject })
    })
    this.sharedPending.set(botId, promise)
    return promise
  }

  private async stopShared(botId: string): Promise<BotPc> {
    if (this.sharedHolder === botId) {
      this.sharedHolder = null
      const promoted = await this.promoteNextShared()
      if (!promoted) {
        const info = await this.inspectContainer(SHARED_CONTAINER_NAME)
        if (info.state === 'running' || info.state === 'starting') {
          const result = await this.runner.run(WSL_EXE, dockerArgs(['stop', SHARED_CONTAINER_NAME]))
          if (result.code !== 0) throw classifyDockerError(result)
        }
        this.markStopped(SHARED_PC_ID)
      }
      const after = await this.inspectContainer(SHARED_CONTAINER_NAME)
      return this.buildBotPc(botId, SHARED_PC_ID, after)
    }
    this.dequeueShared(botId, 'The wait for the shared PC was cancelled.')
    const info = await this.inspectContainer(SHARED_CONTAINER_NAME)
    return this.buildBotPc(botId, SHARED_PC_ID, info)
  }

  /** Hands the turn to the next queued bot, if any, and resolves its pending `start()`. Returns whether anyone was promoted. */
  private async promoteNextShared(): Promise<boolean> {
    const next = this.sharedQueue.shift()
    if (next === undefined) return false
    this.sharedHolder = next
    const waiter = this.sharedWaiters.get(next)
    this.sharedWaiters.delete(next)
    this.sharedPending.delete(next)
    try {
      const info = await this.ensureSharedRunning()
      this.lastUsedAt.set(SHARED_PC_ID, this.clock())
      waiter?.resolve(this.buildBotPc(next, SHARED_PC_ID, info))
    } catch (error) {
      this.sharedHolder = null
      waiter?.reject(error)
    }
    return true
  }

  private dequeueShared(botId: string, reason: string): void {
    const index = this.sharedQueue.indexOf(botId)
    if (index === -1) return
    this.sharedQueue.splice(index, 1)
    const waiter = this.sharedWaiters.get(botId)
    this.sharedWaiters.delete(botId)
    this.sharedPending.delete(botId)
    waiter?.reject(new BotHostError('unknown', reason))
  }

  /** Creates the shared PC if needed (using `sharedOptions`) and makes sure it's running. */
  private async ensureSharedRunning(): Promise<ContainerInfo> {
    const record = this.registry.ensure(SHARED_PC_ID, this.sharedOptions)
    return this.bringUp(SHARED_PC_ID, async () => {
      const existing = await this.inspectContainer(SHARED_CONTAINER_NAME)
      if (existing.state === 'absent') return this.runContainer(SHARED_CONTAINER_NAME, SHARED_PC_ID, record)
      if (existing.state === 'running') return existing
      if (existing.state === 'error') {
        throw (
          existing.hostError ??
          new BotHostError('unknown', existing.error ?? 'The shared PC reported an error.', existing.error ?? undefined)
        )
      }
      return this.startExisting(SHARED_CONTAINER_NAME, 'The shared PC stopped right after starting.')
    })
  }

  // ---- engine keep-alive and readiness ----

  /**
   * Runs `startIt` with dockerd up and the engine distro held open, then waits until the PC's agent
   * and browser answer — a container reports "running" several seconds before either is listening.
   * The keep-alive stays held only while at least one PC is in use.
   */
  private async bringUp(pcId: string, startIt: () => Promise<ContainerInfo>): Promise<ContainerInfo> {
    this.keepAlive.hold()
    try {
      await this.ensureDocker()
      const info = await startIt()
      this.activePcs.add(pcId)
      // Set before the readiness wait so idle-stop still reaches a PC that never answers.
      this.lastUsedAt.set(pcId, this.clock())
      // Another PC's stop may have released the hold while this one was starting.
      this.keepAlive.hold()
      await this.waitUntilServing(pcId)
      return info
    } finally {
      if (this.activePcs.size === 0) this.keepAlive.release()
    }
  }

  private async ensureDocker(): Promise<void> {
    const result = await this.runner.run(WSL_EXE, startDockerArgs(), { timeoutMs: 60_000 })
    if (result.code === 0) return
    const error = classifyDockerError(result)
    if (error.code !== 'unknown') throw error
    throw new BotHostError('engine-not-running', "The Deskmates engine isn't running. Open the setup wizard to start it.", result.stderr)
  }

  private async waitUntilServing(pcId: string): Promise<void> {
    const record = this.registry.get(pcId)
    if (!record) return
    if (await waitForPcServices(this.endpointsFor(record), this.probe, this.readyTimeoutMs)) return
    throw new BotHostError(
      'not-responding',
      `This bot's PC is running, but its browser and agent didn't answer within ${Math.round(this.readyTimeoutMs / 1000)} seconds. Stop and start it again, or reset it.`
    )
  }

  private markStopped(pcId: string): void {
    this.activePcs.delete(pcId)
    if (this.activePcs.size === 0) this.keepAlive.release()
  }

  // ---- shared plumbing ----

  private endpointsFor(record: PcRecord): PcEndpoints {
    const p = portsFor(record.slot)
    return {
      agent: `http://127.0.0.1:${p.agent}`,
      novnc: `http://127.0.0.1:${p.novnc}`,
      cdp: `http://127.0.0.1:${p.cdp}`,
      token: record.token
    }
  }

  /** Resolves which PC a usage-facing call (start/stop/status/endpoints/exec/copyIn/copyOut) should act on for the current mode. */
  private targetFor(botId: string): { pcId: string; name: string } {
    if (this.mode === 'shared') return { pcId: SHARED_PC_ID, name: SHARED_CONTAINER_NAME }
    return { pcId: botId, name: ownContainerName(botId) }
  }

  /** True when `botId` is in shared mode and waiting in line for the shared PC — i.e. it isn't the bot the container is actually running for right now. */
  private isQueuedInShared(botId: string): boolean {
    return this.mode === 'shared' && this.sharedHolder !== botId && this.sharedQueue.includes(botId)
  }

  private async runContainer(name: string, storageId: string, record: PcRecord): Promise<ContainerInfo> {
    const network = networkNameFor(name)
    await this.ensureNetwork(network)

    const p = portsFor(record.slot)
    const runArgs = (withCpuLimit: boolean) => [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      network,
      '--restart',
      'no',
      '--memory',
      `${record.memoryMb}m`,
      ...(withCpuLimit ? ['--cpus', String(record.cpuLimit)] : []),
      '-p',
      `127.0.0.1:${p.agent}:${AGENT_CONTAINER_PORT}`,
      '-p',
      `127.0.0.1:${p.novnc}:${NOVNC_CONTAINER_PORT}`,
      '-p',
      `127.0.0.1:${p.cdp}:${CDP_CONTAINER_PORT}`,
      '-v',
      `${toWslPath(pcStorageDir(this.dataDir, storageId))}:/home/bot/data`,
      '-v',
      `${toWslPath(sharedDir(this.dataDir))}:/shared`,
      '-e',
      `DESKMATES_TOKEN=${record.token}`,
      this.image
    ]
    let result = await this.runner.run(WSL_EXE, dockerArgs(runArgs(true)))
    // Real WSL2 machines commonly boot with a hybrid cgroup setup where only the memory
    // controller is delegated to the unified (v2) hierarchy `docker.io`'s default cgroupfs
    // driver uses, and the CPU controller stays claimed by the legacy v1 mounts WSL2 also sets
    // up (confirmed against a real `deskmates-engine` distro, not just reasoned about: plain
    // `docker.io` there rejects every `--cpus` value with exactly this message, even though
    // `--memory` on the same `docker run` succeeds). CPU capping is a resource-fairness nicety,
    // not part of this app's isolation boundary (memory plus the per-bot network are what that
    // relies on — see host-paths.ts/README's Security section), so a host that can't delegate
    // the CPU controller still gets a working PC, just without the CPU cap, instead of never
    // being able to create one at all.
    if (result.code !== 0 && /nanocpus can not be set/i.test(`${result.stderr}\n${result.stdout}`)) {
      result = await this.runner.run(WSL_EXE, dockerArgs(runArgs(false)))
    }
    if (result.code !== 0) throw classifyDockerError(result)
    const after = await this.inspectContainer(name)
    if (after.state !== 'running') {
      throw (
        after.hostError ??
        new BotHostError('container-died', "This bot's PC stopped right after starting.", after.error ?? result.stdout)
      )
    }
    return after
  }

  /**
   * Creates this container's isolated network if it doesn't already exist, so it starts on a
   * network with nothing else attached — no other bot's container can reach its agent/CDP/VNC
   * ports, regardless of what interface they bind inside the container. Tolerates "already
   * exists" (e.g. a network left behind by a container removed outside `reset`/`delete`, or by a
   * pre-fix `registry.json`) and reuses it rather than failing the whole start over it.
   */
  private async ensureNetwork(network: string): Promise<void> {
    const result = await this.runner.run(WSL_EXE, dockerArgs(['network', 'create', network]))
    if (result.code !== 0 && !/already exists/i.test(result.stderr)) throw classifyDockerError(result)
  }

  /**
   * Removes this container's isolated network. Best-effort and never throws: by the time this
   * runs the container itself is already gone (called right after `docker rm -f` succeeds), so a
   * leftover network object has nothing attached to it and is inert — not a reachability risk,
   * just unused metadata `ensureNetwork` will happily reuse next time this same bot is created.
   * Failing `reset`/`delete` over that would leave storage and the registry entry undeleted for a
   * cosmetic cleanup step, which is worse than the leftover network itself.
   */
  private async removeNetwork(containerName: string): Promise<void> {
    await this.runner.run(WSL_EXE, dockerArgs(['network', 'rm', networkNameFor(containerName)]))
  }

  private async startExisting(name: string, diedMessage: string): Promise<ContainerInfo> {
    const result = await this.runner.run(WSL_EXE, dockerArgs(['start', name]))
    if (result.code !== 0) throw classifyDockerError(result)
    const after = await this.inspectContainer(name)
    if (after.state !== 'running') {
      throw after.hostError ?? new BotHostError('container-died', diedMessage, after.error ?? result.stdout)
    }
    return after
  }

  private async inspectContainer(name: string): Promise<ContainerInfo> {
    const result = await this.runner.run(WSL_EXE, dockerArgs(['inspect', name]))
    if (result.code !== 0) {
      if (/no such object/i.test(result.stderr) || /no such container/i.test(result.stderr)) {
        return { state: 'absent', containerId: null, error: null }
      }
      const hostError = classifyDockerError(result)
      return { state: 'error', containerId: null, error: hostError.message, hostError }
    }

    let parsed: DockerInspectResult[]
    try {
      parsed = JSON.parse(result.stdout) as DockerInspectResult[]
    } catch {
      return { state: 'error', containerId: null, error: "Couldn't read this bot's PC status." }
    }
    const info = parsed[0]
    if (!info) return { state: 'absent', containerId: null, error: null }

    if (info.State.Dead) return { state: 'error', containerId: info.Id, error: 'This PC died unexpectedly.' }
    if (info.State.OOMKilled) {
      return {
        state: 'error',
        containerId: info.Id,
        error: 'This PC ran out of memory and stopped. Increase its memory limit.'
      }
    }
    if (info.State.Error) return { state: 'error', containerId: info.Id, error: info.State.Error }
    if (info.State.Status === 'running') return { state: 'running', containerId: info.Id, error: null }
    if (info.State.Status === 'restarting') return { state: 'starting', containerId: info.Id, error: null }
    return { state: 'stopped', containerId: info.Id, error: null }
  }

  private buildBotPc(reportedBotId: string, pcId: string, info: PcSnapshot): BotPc {
    const record = this.registry.get(pcId)
    return {
      botId: reportedBotId,
      state: info.state,
      containerId: info.containerId,
      memoryMb: record?.memoryMb ?? 0,
      idleStopMinutes: record?.idleStopMinutes ?? 0,
      lastUsedAt: this.lastUsedAt.get(pcId) ?? null,
      error: info.error
    }
  }
}
