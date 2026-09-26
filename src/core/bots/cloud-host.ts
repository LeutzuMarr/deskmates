import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { BotPc, PcState } from '../../shared/protocol'
import { type DockerApi, type DockerContainerSpec } from './docker-api'
import {
  BotHostError,
  type BotHost,
  type CreatePcOptions,
  type ExecOptions,
  type ExecResult,
  type PcEndpoints,
  type PcMode
} from './host'
import {
  AGENT_CONTAINER_PORT,
  CDP_CONTAINER_PORT,
  NOVNC_CONTAINER_PORT,
  SHARED_CONTAINER_NAME,
  networkNameFor,
  ownContainerName,
  pcStorageDir,
  portsFor
} from './host-paths'
import { PcRegistry, SHARED_PC_ID, type PcRecord } from './host-registry'
import { createTar, extractTar } from './tar'

const DEFAULT_IMAGE = 'ghcr.io/deskmates/bot-pc:latest'
const DEFAULT_SHARED_OPTIONS: CreatePcOptions = { memoryMb: 1024, cpuLimit: 2, idleStopMinutes: 20 }

/** Fixed name of the named volume every PC container mounts at /shared. */
const SHARED_VOLUME_NAME = 'deskmates-shared'

/** The named volume holding a PC's `/home/bot/data`: one fixed volume for the shared PC, one per bot. */
function storageVolumeName(storageId: string): string {
  return storageId === SHARED_PC_ID ? 'deskmates-shared-data' : `deskmates-data-${storageId}`
}

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

interface PcSnapshot {
  state: PcState
  containerId: string | null
  error: string | null
}

interface ContainerInfo extends PcSnapshot {
  /**
   * Set only when `state === 'error'` because the inspect call itself failed (server unreachable,
   * daemon down) — the fully classified error, so callers that need to throw can reuse its code
   * and cause instead of downgrading to a generic 'unknown'. Absent when the error instead came
   * from container-level state on a successful inspect (Dead / OOMKilled / State.Error).
   */
  hostError?: BotHostError
}

interface SharedWaiter {
  resolve: (pc: BotPc) => void
  reject: (error: unknown) => void
}

export interface CloudHostOptions {
  /** The Docker Engine HTTP client every container/network/exec call goes through. */
  api: DockerApi
  /** The app's data folder, e.g. `D:\DeskmatesData`. Owns `<dataDir>/pcs/` exactly like `LocalWslHost`. */
  dataDir: string
  /** Image to pull/run when a caller doesn't name one. Default 'ghcr.io/deskmates/bot-pc:latest'. */
  image?: string
  /** Initial PC mode, default 'own'. */
  mode?: PcMode
  /** Resource caps and idle policy for the shared PC, used the first time it's created. See `configureShared`. */
  sharedOptions?: CreatePcOptions
  /** Defaults to `Date.now`; tests inject a fake so idle-stop timing is deterministic. */
  clock?: () => number
  /**
   * Host (no scheme, no port) that published ports are reachable at — the Docker server itself,
   * passed by the controller from parseDockerEndpoint(). Endpoints are built `http://<this>:<port>`.
   */
  endpointsHost: string
}

/** `BotHost` over a remote Docker Engine's HTTP API — the counterpart to `LocalWslHost`'s WSL CLI, so `main.ts` can swap hosts behind one type. */
export class CloudHost implements BotHost {
  private readonly api: DockerApi
  private readonly dataDir: string
  private readonly image: string
  private readonly endpointsHost: string
  private readonly clock: () => number
  private readonly registry: PcRegistry

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

  constructor(options: CloudHostOptions) {
    this.api = options.api
    this.dataDir = options.dataDir
    this.image = options.image ?? DEFAULT_IMAGE
    this.endpointsHost = options.endpointsHost
    this.clock = options.clock ?? Date.now
    this.mode = options.mode ?? 'own'
    this.sharedOptions = options.sharedOptions ?? DEFAULT_SHARED_OPTIONS
    this.registry = new PcRegistry(options.dataDir)
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
        try {
          await this.api.stopContainer(SHARED_CONTAINER_NAME)
        } catch {
          // A failed idle stop leaves the shared PC's turn as-is; the next sweep tries again.
          continue
        }
        this.sharedHolder = null
        await this.promoteNextShared()
      } else {
        const name = ownContainerName(pcId)
        const info = await this.inspectContainer(name)
        if (info.state !== 'running') continue
        try {
          await this.api.stopContainer(name)
        } catch {
          // Same tolerance as the local host: a failed idle stop is skipped, not thrown.
        }
      }
    }
  }

  // ---- BotHost ----

  async create(botId: string, options: CreatePcOptions): Promise<BotPc> {
    validateCreateOptions(options)
    const name = ownContainerName(botId)
    const record = this.registry.ensure(botId, options)
    const existing = await this.inspectContainer(name)

    if (existing.state !== 'absent') {
      // Idempotent means the PC ends up running even when the container was already there —
      // whether that's because it's already running, or because it exists but is stopped.
      if (existing.state === 'running') {
        this.lastUsedAt.set(botId, this.clock())
        return this.buildBotPc(botId, botId, existing)
      }
      if (existing.state === 'error') {
        throw (
          existing.hostError ??
          new BotHostError('unknown', existing.error ?? "This bot's PC reported an error.", existing.error ?? undefined)
        )
      }
      const started = await this.startExisting(name, "This bot's PC stopped right after starting.")
      this.lastUsedAt.set(botId, this.clock())
      return this.buildBotPc(botId, botId, started)
    }

    const info = await this.runContainer(name, botId, record)
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
    // Only a container that actually exists could have a network created for it (`ensureNetwork`
    // only ever runs from `runContainer`) — skip both removal calls entirely for a bot that was
    // never created, so this stays a true no-op rather than two always-failed API calls.
    const info = await this.inspectContainer(name)
    if (info.state !== 'absent') {
      await this.api.removeContainer(name, true)
      await this.removeNetwork(name)
    }
    rmSync(pcStorageDir(this.dataDir, botId), { recursive: true, force: true })
    this.lastUsedAt.delete(botId)
    return this.buildBotPc(botId, botId, { state: 'absent', containerId: null, error: null })
  }

  async delete(botId: string): Promise<void> {
    const name = ownContainerName(botId)
    const info = await this.inspectContainer(name)
    if (info.state !== 'absent') {
      await this.api.removeContainer(name, true)
      await this.removeNetwork(name)
    }
    rmSync(pcStorageDir(this.dataDir, botId), { recursive: true, force: true })
    this.lastUsedAt.delete(botId)
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
    const p = portsFor(record.slot)
    return {
      agent: `http://${this.endpointsHost}:${p.agent}`,
      novnc: `http://${this.endpointsHost}:${p.novnc}`,
      cdp: `http://${this.endpointsHost}:${p.cdp}`,
      token: record.token
    }
  }

  async exec(botId: string, command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const { pcId, name } = this.targetFor(botId)
    // A non-zero exit here is the command's own exit code, which belongs to the caller; docker-level
    // failures (container missing/stopped) already come back as thrown BotHostErrors from the API layer.
    const result = await this.api.exec(name, {
      command: [command, ...args],
      input: options.input,
      timeoutMs: options.timeoutMs
    })
    this.lastUsedAt.set(pcId, this.clock())
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  async copyIn(botId: string, localPath: string, containerPath: string): Promise<void> {
    const { pcId, name } = this.targetFor(botId)
    await this.api.putArchive(name, containerPath, await createTar(localPath))
    this.lastUsedAt.set(pcId, this.clock())
  }

  async copyOut(botId: string, containerPath: string, localPath: string): Promise<void> {
    const { pcId, name } = this.targetFor(botId)
    const tar = Buffer.from(await this.api.getArchive(name, containerPath))
    // The tar's root entry is the basename of `containerPath`. An existing directory (or a path
    // with a trailing separator) means "put it inside here" — docker form 1; a bare file path
    // means the leaf is renamed exactly to it — docker form 2.
    if (/[\\/]$/.test(localPath) || (existsSync(localPath) && statSync(localPath).isDirectory())) {
      await extractTar(tar, localPath)
    } else {
      const tempDir = mkdtempSync(join(tmpdir(), 'deskmates-cp-'))
      try {
        const rootName = basename(containerPath)
        await extractTar(tar, tempDir)
        const extracted = join(tempDir, rootName)
        mkdirSync(dirname(localPath), { recursive: true })
        if (existsSync(localPath)) rmSync(localPath, { recursive: true, force: true })
        try {
          renameSync(extracted, localPath)
        } catch (error) {
          // Across filesystems a rename refuses (EXDEV); a copy is the same move from the caller's side.
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
          cpSync(extracted, localPath, { recursive: true })
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
    this.lastUsedAt.set(pcId, this.clock())
  }

  async pull(image?: string): Promise<void> {
    await this.api.pull(image ?? this.image)
  }

  async buildLocal(_contextDir: string, _image?: string): Promise<void> {
    throw new BotHostError(
      'unknown',
      "Building this bot's PC image locally works only for the local engine. Pull it on the Docker server instead."
    )
  }

  // ---- own-mode start/stop ----

  private async startOwn(botId: string): Promise<BotPc> {
    const record = this.registry.get(botId)
    const name = ownContainerName(botId)
    if (!record) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
    const info = await this.inspectContainer(name)
    if (info.state === 'absent') {
      throw new BotHostError('not-created', "This bot's PC is missing. Reset it to create a new one.")
    }
    if (info.state === 'running') {
      this.lastUsedAt.set(botId, this.clock())
      return this.buildBotPc(botId, botId, info)
    }
    if (info.state === 'error') {
      // `hostError` carries the real code (e.g. 'engine-not-running') when the inspect call itself
      // failed; falling back to 'unknown' only for a genuine container-level error (Dead/OOMKilled).
      throw info.hostError ?? new BotHostError('unknown', info.error ?? "This bot's PC reported an error.", info.error ?? undefined)
    }
    const after = await this.startExisting(name, "This bot's PC stopped right after starting.")
    this.lastUsedAt.set(botId, this.clock())
    return this.buildBotPc(botId, botId, after)
  }

  private async stopOwn(botId: string): Promise<BotPc> {
    const name = ownContainerName(botId)
    const info = await this.inspectContainer(name)
    if (info.state !== 'running' && info.state !== 'starting') {
      return this.buildBotPc(botId, botId, info)
    }
    await this.api.stopContainer(name)
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
          await this.api.stopContainer(SHARED_CONTAINER_NAME)
        }
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
  }

  // ---- shared plumbing ----

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
    await this.api.createContainer({
      image: this.image,
      name,
      env: { DESKMATES_TOKEN: record.token },
      memoryMb: record.memoryMb,
      cpus: record.cpuLimit,
      ports: [
        { hostIp: '0.0.0.0', hostPort: p.agent, containerPort: AGENT_CONTAINER_PORT },
        { hostIp: '0.0.0.0', hostPort: p.novnc, containerPort: NOVNC_CONTAINER_PORT },
        { hostIp: '0.0.0.0', hostPort: p.cdp, containerPort: CDP_CONTAINER_PORT }
      ],
      volumes: [`${storageVolumeName(storageId)}:/home/bot/data`, `${SHARED_VOLUME_NAME}:/shared`],
      network
    })
    await this.api.startContainer(name)
    const after = await this.inspectContainer(name)
    if (after.state !== 'running') {
      throw (
        after.hostError ??
        new BotHostError('container-died', "This bot's PC stopped right after starting.", after.error ?? '')
      )
    }
    return after
  }

  /**
   * Creates this container's isolated network if it doesn't already exist, so it starts on a
   * network with nothing else attached — no other bot's container can reach its agent/CDP/VNC
   * ports, regardless of what interface they bind inside the container. The API tolerates an
   * "already exists" 409 and reuses it rather than failing the whole start over it.
   */
  private async ensureNetwork(network: string): Promise<void> {
    await this.api.createNetwork(network)
  }

  /**
   * Removes this container's isolated network. Best-effort and never throws: by the time this
   * runs the container itself is already gone (called right after the container removal succeeds),
   * so a leftover network object has nothing attached to it and is inert — not a reachability
   * risk, just unused metadata `ensureNetwork` will happily reuse next time this same bot is
   * created. The API already tolerates an "already gone" 404, so nothing here needs swallowing.
   */
  private async removeNetwork(containerName: string): Promise<void> {
    await this.api.removeNetwork(networkNameFor(containerName))
  }

  private async startExisting(name: string, diedMessage: string): Promise<ContainerInfo> {
    await this.api.startContainer(name)
    const after = await this.inspectContainer(name)
    if (after.state !== 'running') {
      throw after.hostError ?? new BotHostError('container-died', diedMessage, after.error ?? '')
    }
    return after
  }

  private async inspectContainer(name: string): Promise<ContainerInfo> {
    const state = await this.api.inspectContainer(name)
    return {
      state: state.state,
      containerId: state.id,
      error: state.error,
      ...(state.hostError ? { hostError: state.hostError } : {})
    }
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