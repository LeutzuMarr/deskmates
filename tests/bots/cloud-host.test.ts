import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CloudHost, type CloudHostOptions } from '../../src/core/bots/cloud-host'
import {
  type DockerApi,
  type DockerContainerSpec,
  type DockerContainerState,
  type DockerExecResult,
  type DockerExecSpec
} from '../../src/core/bots/docker-api'
import { BotHostError, type CreatePcOptions } from '../../src/core/bots/host'
import {
  AGENT_CONTAINER_PORT,
  CDP_CONTAINER_PORT,
  NOVNC_CONTAINER_PORT,
  SHARED_CONTAINER_NAME,
  networkNameFor,
  ownContainerName,
  pcStorageDir,
  portsFor
} from '../../src/core/bots/host-paths'
import { createTar, extractTar } from '../../src/core/bots/tar'

type StoreState = 'running' | 'starting' | 'stopped' | 'error'

interface FakeContainer {
  id: string
  state: StoreState
  spec: DockerContainerSpec | null
  files: Map<string, Buffer>
  /** When true, `startContainer()` leaves the container stopped, to exercise post-start "died" guards. */
  diesOnStart: boolean
}

const ENGINE_ERROR = new BotHostError('engine-not-running', "Can't reach the Docker server at http://fake:2375.")

/**
 * An honest in-memory `DockerApi`: containers keyed by name with a state + spec + file map, a
 * calls recorder, and tolerance semantics matching the api layer (absent instead of 404, a
 * classified error state instead of a throw for a probe failure).
 */
class FakeDockerApi implements DockerApi {
  readonly containers = new Map<string, FakeContainer>()
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly pulled: string[] = []
  idCounter = 0
  engineDown = false
  nextExec: DockerExecResult = { exitCode: 0, stdout: '', stderr: '' }

  seed(name: string, state: StoreState, diesOnStart = false): void {
    this.containers.set(name, { id: `seed-${name}`, state, spec: null, files: new Map(), diesOnStart })
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args)
  }

  async ping(): Promise<void> {
    this.record('ping')
    if (this.engineDown) this.throwEngine()
  }

  async pull(image: string): Promise<void> {
    this.record('pull', image)
    if (this.engineDown) this.throwEngine()
    this.pulled.push(image)
  }

  async build(_tar: Uint8Array, _image: string): Promise<void> {
    this.record('build')
    if (this.engineDown) this.throwEngine()
  }

  async createNetwork(name: string): Promise<void> {
    this.record('createNetwork', name)
    if (this.engineDown) this.throwEngine()
  }

  async removeNetwork(name: string): Promise<void> {
    this.record('removeNetwork', name)
    if (this.engineDown) this.throwEngine()
  }

  async createContainer(spec: DockerContainerSpec): Promise<string> {
    this.record('createContainer', spec)
    if (this.engineDown) this.throwEngine()
    if (this.containers.has(spec.name)) {
      throw new BotHostError('port-taken', "Another program is already using this bot's PC ports. Close it and try again.")
    }
    const id = `id-${++this.idCounter}`
    this.containers.set(spec.name, { id, state: 'stopped', spec, files: new Map(), diesOnStart: false })
    return id
  }

  async startContainer(nameOrId: string): Promise<void> {
    this.record('startContainer', nameOrId)
    if (this.engineDown) this.throwEngine()
    const entry = this.entry(nameOrId)
    if (!entry) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
    entry.state = entry.diesOnStart ? 'stopped' : 'running'
  }

  async stopContainer(nameOrId: string, timeoutSeconds?: number): Promise<void> {
    this.record('stopContainer', nameOrId, timeoutSeconds)
    if (this.engineDown) this.throwEngine()
    const entry = this.entry(nameOrId)
    if (!entry) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
    entry.state = 'stopped'
  }

  async removeContainer(nameOrId: string, force?: boolean): Promise<void> {
    this.record('removeContainer', nameOrId, force)
    if (this.engineDown) this.throwEngine()
    const name = this.nameOf(nameOrId)
    if (name) this.containers.delete(name)
  }

  async inspectContainer(nameOrId: string): Promise<DockerContainerState> {
    this.record('inspectContainer', nameOrId)
    if (this.engineDown) {
      return { state: 'error', id: null, error: ENGINE_ERROR.message, hostError: ENGINE_ERROR }
    }
    const entry = this.entry(nameOrId)
    if (!entry) return { state: 'absent', id: null, error: null }
    return { id: entry.id, state: entry.state, error: null }
  }

  async exec(containerNameOrId: string, spec: DockerExecSpec): Promise<DockerExecResult> {
    this.record('exec', containerNameOrId, spec)
    if (this.engineDown) this.throwEngine()
    if (!this.entry(containerNameOrId)) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
    return this.nextExec
  }

  async putArchive(containerNameOrId: string, containerPath: string, tar: Uint8Array): Promise<void> {
    this.record('putArchive', containerNameOrId, containerPath)
    if (this.engineDown) this.throwEngine()
    const entry = this.entry(containerNameOrId)
    if (!entry) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
    entry.files.set(containerPath, Buffer.from(tar))
  }

  async getArchive(containerNameOrId: string, containerPath: string): Promise<Uint8Array> {
    this.record('getArchive', containerNameOrId, containerPath)
    if (this.engineDown) this.throwEngine()
    const entry = this.entry(containerNameOrId)
    if (!entry) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
    const tar = entry.files.get(containerPath)
    if (!tar) throw new BotHostError('unknown', "That folder or file doesn't exist in the bot's PC.")
    return tar
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  private entry(nameOrId: string): FakeContainer | undefined {
    const byName = this.containers.get(nameOrId)
    if (byName) return byName
    for (const entry of this.containers.values()) {
      if (entry.id === nameOrId) return entry
    }
    return undefined
  }

  private nameOf(nameOrId: string): string | undefined {
    if (this.containers.has(nameOrId)) return nameOrId
    for (const [name, entry] of this.containers) {
      if (entry.id === nameOrId) return name
    }
    return undefined
  }

  private throwEngine(): never {
    throw ENGINE_ERROR
  }
}

/** A create-options set used by most tests; the short idle time keeps idle-stop math tractable. */
function opts(patch: Partial<CreatePcOptions> = {}): CreatePcOptions {
  return { memoryMb: 1024, cpuLimit: 2, idleStopMinutes: 15, ...patch }
}

describe('CloudHost (remote Docker BotHost)', () => {
  let base: string
  let dataDir: string
  let api: FakeDockerApi

  function makeHost(overrides: Partial<CloudHostOptions> = {}): CloudHost {
    return new CloudHost({ api, dataDir, endpointsHost: '198.51.100.7', ...overrides })
  }

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-cloud-')))
    dataDir = join(base, 'data')
    api = new FakeDockerApi()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('1. create on an absent bot provisions network, container and start, and returns the running PC', async () => {
    const host = makeHost()
    const pc = await host.create('alice', opts())

    expect(pc.state).toBe('running')
    expect(pc.memoryMb).toBe(1024)
    expect(pc.idleStopMinutes).toBe(15)
    expect(pc.containerId).toBe('id-1')
    expect(pc.error).toBeNull()

    const name = ownContainerName('alice')
    const lifecycle = api.calls.map((c) => c.method).filter((m) => m !== 'inspectContainer')
    expect(lifecycle).toEqual(['createNetwork', 'createContainer', 'startContainer'])
    expect(api.callsOf('createNetwork').map(([n]) => n)).toEqual([networkNameFor(name)])

    const spec = api.callsOf('createContainer')[0][0] as DockerContainerSpec
    expect(spec.image).toBe('ghcr.io/deskmates/bot-pc:latest')
    expect(spec.name).toBe(name)
    const endpoints = await host.endpoints('alice')
    expect(endpoints).not.toBeNull()
    expect(spec.env).toEqual({ DESKMATES_TOKEN: (endpoints as NonNullable<typeof endpoints>).token })
    expect(spec.memoryMb).toBe(1024)
    expect(spec.cpus).toBe(2)
    const p = portsFor(1)
    expect(spec.ports).toEqual([
      { hostIp: '0.0.0.0', hostPort: p.agent, containerPort: AGENT_CONTAINER_PORT },
      { hostIp: '0.0.0.0', hostPort: p.novnc, containerPort: NOVNC_CONTAINER_PORT },
      { hostIp: '0.0.0.0', hostPort: p.cdp, containerPort: CDP_CONTAINER_PORT }
    ])
    expect(spec.volumes).toEqual([`deskmates-data-alice:/home/bot/data`, `deskmates-shared:/shared`])
    expect(spec.network).toBe(networkNameFor(name))
    expect(api.callsOf('startContainer')).toEqual([[name]])
  })

  it('2. create is idempotent: an already-running PC is returned without another createContainer', async () => {
    const host = makeHost()
    const first = await host.create('alice', opts())
    const again = await host.create('alice', { memoryMb: 2048, cpuLimit: 4, idleStopMinutes: 30 })
    expect(api.callsOf('createContainer')).toHaveLength(1)
    expect(api.callsOf('startContainer')).toHaveLength(1)
    expect(again.state).toBe('running')
    expect(again.memoryMb).toBe(1024)
    expect(again.containerId).toBe(first.containerId)
  })

  it('3. create on a stopped container starts it (no recreate), and a post-start failure surfaces as container-died', async () => {
    const name = ownContainerName('alice')
    api.seed(name, 'stopped', true)
    const first = makeHost()
    await expect(first.create('alice', opts())).rejects.toMatchObject({
      code: 'container-died',
      message: "This bot's PC stopped right after starting."
    })
    expect(api.callsOf('createContainer')).toHaveLength(0)
    expect(api.callsOf('startContainer')).toHaveLength(1)

    api.calls.length = 0
    api.containers.clear()
    api.idCounter = 0
    api.seed(name, 'stopped')
    const second = makeHost()
    const pc = await second.create('alice', opts())
    expect(pc.state).toBe('running')
    expect(api.callsOf('createContainer')).toHaveLength(0)
    expect(api.callsOf('startContainer')).toHaveLength(1)
  })

  it('4. create rethrows the classified engine error verbatim when inspect reports it', async () => {
    const host = makeHost()
    api.engineDown = true
    await expect(host.create('alice', opts())).rejects.toMatchObject({
      code: 'engine-not-running',
      message: "Can't reach the Docker server at http://fake:2375."
    })
  })

  it('5. reset clears the container, network and storage but keeps the record; a never-created bot triggers nothing', async () => {
    const host = makeHost()
    await host.create('alice', opts())
    const name = ownContainerName('alice')
    const storage = pcStorageDir(dataDir, 'alice')
    mkdirSync(storage, { recursive: true })

    const pc = await host.reset('alice')
    expect(api.callsOf('removeContainer')).toEqual([[name, true]])
    expect(api.callsOf('removeNetwork')).toEqual([[networkNameFor(name)]])
    expect(existsSync(storage)).toBe(false)
    expect(pc.state).toBe('absent')
    expect(pc.containerId).toBeNull()
    expect(pc.lastUsedAt).toBeNull()
    expect(pc.memoryMb).toBe(1024)

    api.calls.length = 0
    const never = await host.reset('nobody')
    expect(never.state).toBe('absent')
    expect(api.callsOf('removeContainer')).toHaveLength(0)
    expect(api.callsOf('removeNetwork')).toHaveLength(0)
  })

  it('6. delete tears down container, network, storage and registry, and a recreated bot reuses its slot', async () => {
    const host = makeHost()
    await host.create('alice', opts())
    const name = ownContainerName('alice')
    const storage = pcStorageDir(dataDir, 'alice')
    mkdirSync(storage, { recursive: true })

    await host.delete('alice')
    expect(api.callsOf('removeContainer')).toEqual([[name, true]])
    expect(api.callsOf('removeNetwork')).toEqual([[networkNameFor(name)]])
    expect(existsSync(storage)).toBe(false)

    const after = await host.status('alice')
    expect(after.state).toBe('absent')
    expect(after.memoryMb).toBe(0)

    await host.create('alice', opts())
    const recreateCalls = api.callsOf('createContainer')
    expect(recreateCalls).toHaveLength(2)
    const spec = recreateCalls[1][0] as DockerContainerSpec
    const p = portsFor(1)
    expect(spec.ports).toEqual([
      { hostIp: '0.0.0.0', hostPort: p.agent, containerPort: AGENT_CONTAINER_PORT },
      { hostIp: '0.0.0.0', hostPort: p.novnc, containerPort: NOVNC_CONTAINER_PORT },
      { hostIp: '0.0.0.0', hostPort: p.cdp, containerPort: CDP_CONTAINER_PORT }
    ])
  })

  it('7. status maps container states and reports a shared-queued bot as starting', async () => {
    const host = makeHost()
    await host.create('alice', opts())
    expect((await host.status('alice')).state).toBe('running')

    api.seed(ownContainerName('bob'), 'stopped')
    expect((await host.status('bob')).state).toBe('stopped')
    expect((await host.status('carol')).state).toBe('absent')

    host.setMode('shared')
    await host.start('dave')
    const erinWait = host.start('erin')
    expect((await host.status('erin')).state).toBe('starting')
    expect((await host.status('dave')).state).toBe('running')
    await host.stop('dave')
    await erinWait
    await host.stop('erin')
  })

  it('8. endpoints expose the remote server host for a running PC and null when stopped or queued', async () => {
    const endpointsHost = '192.0.2.33'
    const host = makeHost({ endpointsHost })
    await host.create('alice', opts())
    const p = portsFor(1)
    await expect(host.endpoints('alice')).resolves.toEqual({
      agent: `http://${endpointsHost}:${p.agent}`,
      novnc: `http://${endpointsHost}:${p.novnc}`,
      cdp: `http://${endpointsHost}:${p.cdp}`,
      token: expect.any(String) as string
    })

    await host.stop('alice')
    await expect(host.endpoints('alice')).resolves.toBeNull()

    host.setMode('shared')
    await host.start('carol')
    const daveWait = host.start('dave')
    await expect(host.endpoints('dave')).resolves.toBeNull()
    await expect(host.endpoints('carol')).resolves.not.toBeNull()
    await host.stop('carol')
    await daveWait
    await host.stop('dave')
  })

  it('9. a shared-mode stop hands the PC to the next queued bot, and an empty queue stops the container', async () => {
    const host = makeHost()
    host.setMode('shared')
    await host.start('alice')
    const bobWait = host.start('bob')

    let settled = false
    void bobWait.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    expect(settled).toBe(false)
    expect(api.callsOf('startContainer').map(([n]) => n as string)).toContain(SHARED_CONTAINER_NAME)

    const aliceStop = await host.stop('alice')
    expect(aliceStop.state).toBe('running')
    const bobPc = await bobWait
    expect(bobPc.state).toBe('running')
    expect((await host.status('bob')).state).toBe('running')

    await host.stop('bob')
    expect(api.callsOf('stopContainer').map(([n]) => n as string)).toContain(SHARED_CONTAINER_NAME)
  })

  it('10. deleting a queued bot rejects its pending start with the deleted-bot message', async () => {
    const host = makeHost()
    host.setMode('shared')
    await host.start('alice')
    const bobWait = host.start('bob')

    await host.delete('bob')

    await expect(bobWait).rejects.toThrow('This bot was deleted while waiting for the shared PC.')
    await host.stop('alice')
  })

  it('11. exec passes a plain argv through and maps the exit result', async () => {
    const host = makeHost()
    await host.create('alice', opts())
    api.nextExec = { exitCode: 7, stdout: 'out', stderr: 'err' }

    const result = await host.exec('alice', 'cat', ['/shared/x.txt'], { input: 'hi', timeoutMs: 4321 })
    expect(result).toEqual({ code: 7, stdout: 'out', stderr: 'err' })
    const execCalls = api.callsOf('exec')
    expect(execCalls).toHaveLength(1)
    const [name, spec] = execCalls[0] as [string, DockerExecSpec]
    expect(name).toBe(ownContainerName('alice'))
    expect(spec.command).toEqual(['cat', '/shared/x.txt'])
    expect(spec.input).toBe('hi')
    expect(spec.timeoutMs).toBe(4321)
  })

  it('12. copyIn tars the local path (root = its basename) and PUTs it at the container path', async () => {
    const host = makeHost()
    await host.create('alice', opts())
    const file = join(base, 'hello.txt')
    writeFileSync(file, 'hello from the host', 'utf8')

    await host.copyIn('alice', file, '/home/bot/data/hello.txt')

    const putCalls = api.callsOf('putArchive')
    expect(putCalls).toHaveLength(1)
    const [name, containerPath] = putCalls[0] as [string, string]
    expect(name).toBe(ownContainerName('alice'))
    expect(containerPath).toBe('/home/bot/data/hello.txt')

    const stored = api.containers.get(ownContainerName('alice'))!.files.get('/home/bot/data/hello.txt')!
    const out = join(base, 'extracted')
    await extractTar(stored, out)
    expect(existsSync(join(out, 'hello.txt'))).toBe(true)
    expect(readFileSync(join(out, 'hello.txt'), 'utf8')).toBe('hello from the host')
  })

  it('13. copyOut extracts into a directory (form 1) or renames the leaf to the given path (form 2); an unreachable engine classifies', async () => {
    const host = makeHost()
    await host.create('alice', opts())
    const name = ownContainerName('alice')
    const src = join(base, 'foo.txt')
    writeFileSync(src, 'copied out', 'utf8')

    // Form 1: an existing directory drops the tar root inside it; a trailing separator does the same.
    const dirTarget = join(base, 'dir')
    mkdirSync(dirTarget)
    await host.copyIn('alice', src, '/home/bot/data/foo.txt')
    await host.copyOut('alice', '/home/bot/data/foo.txt', dirTarget)
    expect(readFileSync(join(dirTarget, 'foo.txt'), 'utf8')).toBe('copied out')
    await host.copyOut('alice', '/home/bot/data/foo.txt', `${dirTarget}\\`)
    expect(readFileSync(join(dirTarget, 'foo.txt'), 'utf8')).toBe('copied out')

    // Form 2: a bare leaf path in a not-yet-existing directory writes exactly that file.
    const fileTarget = join(base, 'nested', 'out.txt')
    await host.copyIn('alice', src, '/home/bot/data/sub/foo.txt')
    await host.copyOut('alice', '/home/bot/data/sub/foo.txt', fileTarget)
    expect(statSync(fileTarget).isFile()).toBe(true)
    expect(readFileSync(fileTarget, 'utf8')).toBe('copied out')
    expect(existsSync(join(fileTarget, 'foo.txt'))).toBe(false)

    // Engine down mid-copy: the classified error comes back as a BotHostError.
    api.engineDown = true
    await expect(host.copyOut('alice', '/home/bot/data/foo.txt', join(base, 'gone.txt'))).rejects.toMatchObject({
      code: 'engine-not-running'
    })
  })

  it('14. pull targets the default or overridden image, and buildLocal refuses with no API calls', async () => {
    const host = makeHost()
    await host.pull()
    expect(api.pulled).toEqual(['ghcr.io/deskmates/bot-pc:latest'])
    await host.pull('registry.example/team/pc:v1')
    expect(api.pulled).toEqual(['ghcr.io/deskmates/bot-pc:latest', 'registry.example/team/pc:v1'])

    const before = api.calls.length
    await expect(host.buildLocal('/tmp/ctx')).rejects.toMatchObject({
      code: 'unknown',
      message: "Building this bot's PC image locally works only for the local engine. Pull it on the Docker server instead."
    })
    expect(api.calls.length).toBe(before)
  })

  it('15. checkIdle stops idle PCs by the injected clock, skips recently used ones, and hands an idle shared turn on', async () => {
    let now = 1000
    const host = makeHost({ clock: () => now })
    await host.create('alice', opts({ idleStopMinutes: 10 }))
    await host.create('bob', opts({ idleStopMinutes: 10 }))

    await host.checkIdle()
    expect(api.callsOf('stopContainer')).toHaveLength(0)

    now = 1000 + 10 * 60_000 + 1
    await host.start('bob')
    await host.checkIdle()
    const stopped = api.callsOf('stopContainer').map(([n]) => n as string)
    expect(stopped).toContain(ownContainerName('alice'))
    expect(stopped).not.toContain(ownContainerName('bob'))

    const sharedApi = new FakeDockerApi()
    const sharedHost = new CloudHost({
      api: sharedApi,
      dataDir: join(base, 'data2'),
      endpointsHost: '198.51.100.7',
      clock: () => now,
      sharedOptions: { memoryMb: 1024, cpuLimit: 2, idleStopMinutes: 20 }
    })
    sharedHost.setMode('shared')
    await sharedHost.start('carol')
    const daveWait = sharedHost.start('dave')

    now = now + 20 * 60_000 + 1
    await sharedHost.checkIdle()
    expect(sharedApi.callsOf('stopContainer').map(([n]) => n as string)).toContain(SHARED_CONTAINER_NAME)
    const davePc = await daveWait
    expect(davePc.state).toBe('running')
    await sharedHost.stop('dave')
  })

  it('16. configureShared and updatePcOptions patch live records, mode round-trips, and targetFor picks the right container', async () => {
    const host = makeHost()
    expect(host.getMode()).toBe('own')
    host.setMode('shared')
    expect(host.getMode()).toBe('shared')
    host.setMode('own')

    await host.create('alice', opts())
    host.updatePcOptions('alice', { memoryMb: 2048 })
    const updated = await host.status('alice')
    expect(updated.memoryMb).toBe(2048)
    expect(updated.idleStopMinutes).toBe(15)

    host.setMode('shared')
    await host.start('bob')
    host.configureShared({ memoryMb: 4096, cpuLimit: 8, idleStopMinutes: 60 })
    await expect(host.status('bob')).resolves.toMatchObject({ memoryMb: 4096, idleStopMinutes: 60 })

    host.setMode('own')
    await expect(host.exec('zed', 'true', [])).rejects.toMatchObject({ code: 'not-created' })
    const ownExec = api.calls.filter((c) => c.method === 'exec').at(-1)!
    expect(ownExec.args[0]).toBe(ownContainerName('zed'))

    host.setMode('shared')
    await expect(host.exec('zed', 'true', [])).resolves.toEqual({ code: 0, stdout: '', stderr: '' })
    const sharedExec = api.calls.filter((c) => c.method === 'exec').at(-1)!
    expect(sharedExec.args[0]).toBe(SHARED_CONTAINER_NAME)
  })
})