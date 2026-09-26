import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CoreToHost, HostToCore, Settings } from '../shared/protocol'
import { agentKitDir, writeAgentGuide } from './agents/guide'
import { ExecCommandRunner } from './bots/command-runner'
import { EngineManager } from './bots/engine'
import { BotRunner } from './bots/runner'
import { HandoffService } from './bots/handoffs'
import { LocalWslHost } from './bots/local-wsl-host'
import { reconcilePcs, resolveBotHost, UnavailableHost, wrapEngineService } from './bots/wiring'
import { Scheduler } from './scheduler'
import { DesignWatcher } from './designs/watcher'
import { EventBus } from './events'
import { ChangeLog } from './fs/change-log'
import { TaskRunner } from './engine/runner'
import { KeyStore, keysFromEnv } from './models/keys'
import { ModelService } from './models/providers'
import { createHandlers } from './server/handlers'
import { startRpcServer } from './server/rpc-server'
import { createPhoneServer, DEFAULT_PHONE_PORT } from './phone/server'
import { createRepos } from './store/repos'
import { openDatabase } from './store/db'
import { buildTools } from './tools'
import { PluginsService } from './extensions/plugins'
import { SkillsService } from './extensions/skills'
import { McpConnectorManager, createMcpTransport } from './connectors'
import { createSubagentRunner } from './engine/subagents'
import { ChildProcessSpawner } from './terminals/process'
import { PsAttachHelperSpawner } from './terminals/attach'
import { TerminalsManager } from './terminals/service'
import { ComputerUseService } from './computer/service'
import { WindowsDesktop } from './computer/desktop'
import { ParentPortRenderClient } from './render/client'

// Electron's utilityProcess.parentPort, typed locally so this imports nothing from 'electron'.
type ParentPort = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data?: unknown }) => void): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

interface BridgeInfo {
  port: number
  token: string
  pid: number
}

/** Writes bridge.json atomically: a temp file in the same folder, then a rename over it. */
function writeBridgeInfo(dir: string, info: BridgeInfo): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'bridge.json')
  const temp = join(dir, `bridge.json.tmp-${randomUUID()}`)
  writeFileSync(temp, JSON.stringify(info), 'utf8')
  renameSync(temp, file)
}

/** Deletes bridge.json, but only while it still names this process's pid (a newer instance may own it now). */
function removeBridgeInfoIfOwned(dir: string): void {
  const file = join(dir, 'bridge.json')
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as Partial<BridgeInfo>
    if (info.pid === process.pid) rmSync(file, { force: true })
  } catch {
    // Missing or unreadable: nothing of ours to clean up.
  }
}

async function main(): Promise<void> {
  const dataDir = process.env.DESKMATES_DATA_DIR ?? join(homedir(), '.deskmates')
  const version = process.env.DESKMATES_VERSION ?? '0.0.0'
  const kitDir = agentKitDir(dataDir)

  // Registered early so it also cleans up a bridge.json from a partially-started run.
  process.once('exit', () => removeBridgeInfoIfOwned(kitDir))

  const db = openDatabase(join(dataDir, 'deskmates.db'))
  const repos = createRepos(db)
  repos.tasks.resetInterrupted()
  repos.runs.resetInterrupted()

  const bus = new EventBus()
  const keys = new KeyStore(keysFromEnv())
  const models = new ModelService(keys, () => repos.settings.get())
  const changes = new ChangeLog(repos.changes, join(dataDir, 'snapshots'))
  const skills = new SkillsService({ repos, dataDir })
  const connectors = new McpConnectorManager({ repos, createTransport: createMcpTransport })
  void connectors.refresh().catch((error) => {
    console.error('[core] connector startup failed', error)
  })
  // Every external command (bot PCs, plugin clones) goes through this one runner.
  const commandRunner = new ExecCommandRunner()
  const plugins = new PluginsService({ repos, dataDir, runner: commandRunner, skills })
  const subagents = createSubagentRunner({ models })
  const render = parentPort ? new ParentPortRenderClient(parentPort) : undefined
  const runner = new TaskRunner({
    repos,
    bus,
    models,
    changes,
    skills,
    connectors,
    plugins,
    subagents,
    createTools: buildTools,
    getTerminals: () => terminals,
    render
  })

  const engineManager = new EngineManager({ runner: commandRunner, dataDir })
  // Which host bot PCs run on is chosen once at boot from the saved settings: the local WSL engine
  // when it's selected, a remote Docker server when a complete cloud connection is configured, and
  // no host at all otherwise (`host === null` → the pcs.* handlers answer "not set up" and bot runs
  // fail fast through the UnavailableHost stub instead of crashing). Changing the setting in the UI
  // takes effect on the next restart.
  const host = resolveBotHost({
    settings: repos.settings.get(),
    dataDir,
    runner: commandRunner,
    mode: repos.settings.getPcMode()
  })
  const botHost = host ?? new UnavailableHost()
  const botRunner = new BotRunner({ repos, bus, host: botHost, models, dataDir, skills, connectors })
  const scheduler = new Scheduler({ repos, bus, runner: commandRunner, dataDir, run: botRunner })
  const handoffs = new HandoffService({ repos, bus, dataDir, run: botRunner })

  // LocalWslHost/CloudHost checkIdle() does the actual idle check but owns no timer of its own;
  // this is that timer. Only meaningful once a host exists, so it's skipped when there's none.
  // Unref'd so it can never by itself keep the process alive, and cleared in shutdown().
  let idleCheckTimer: NodeJS.Timeout | undefined
  if (host) {
    idleCheckTimer = setInterval(() => {
      void host.checkIdle().catch((error: unknown) => console.error('[core] bot PC idle check failed', error))
    }, 60_000)
    idleCheckTimer.unref()
  }

  // So agents can edit a design's index.html with their own file tools and the preview still reloads.
  const watcher = new DesignWatcher({
    root: join(dataDir, 'designs'),
    onExternalChange: (projectId, updatedAt) => {
      const project = repos.projects.get(projectId)
      if (project?.kind === 'design') {
        bus.emit({ type: 'design.updated', projectId, updatedAt, source: 'external' })
      }
    },
    isBusy: (projectId) => repos.tasks.list(projectId).some((task) => runner.isRunning(task.id))
  })

  const commandPath = join(kitDir, 'deskmates.cmd')
  // The mounted prompt directories (DESKMATES_PROMPTS_DIR set by the host; falls back to a local
  // ./prompts for standalone runs). The guide and the primer point agents at the claude-code
  // operating prompt — only when the file is actually there.
  const promptRoot = process.env.DESKMATES_PROMPTS_DIR ?? join(process.cwd(), 'prompts')
  const codePromptPath = join(promptRoot, 'claude-code', 'claude-code-opus-5.5.md')
  const guide = writeAgentGuide({
    dataDir,
    commandPath,
    appVersion: version,
    pcs: { installed: false },
    operatingPromptPath: existsSync(codePromptPath) ? codePromptPath : undefined
  })

  const terminals = new TerminalsManager({
    runner: commandRunner,
    spawner: new ChildProcessSpawner(),
    attachSpawner: new PsAttachHelperSpawner(),
    bus,
    guidePath: guide.path,
    guideVersion: guide.version,
    phrase: guide.phrase,
    promptPath: existsSync(codePromptPath) ? codePromptPath : undefined
  })

  const computer = new ComputerUseService({
    bus,
    models,
    createDesktop: () => new WindowsDesktop(),
    onActiveChange: (active) => parentPort?.postMessage({ type: 'computer-use', active } satisfies CoreToHost)
  })

  const agentToken = randomBytes(24).toString('hex')

  // Phone access (spec 5.12): a second listener that serves the built app over the LAN while the
  // user has it enabled. It reuses the same handlers; only its token (the pairing code) differs.
  const phone = createPhoneServer({
    rendererDir: process.env.DESKMATES_RENDERER_DIR,
    handlers: () => handlers,
    bus,
    port: Number(process.env.DESKMATES_PHONE_PORT ?? '') || DEFAULT_PHONE_PORT
  })

  const handlers = createHandlers({
    repos,
    bus,
    runner,
    changes,
    models,
    keys,
    version,
    dataDir,
    agentKit: { guidePath: guide.path, commandPath },
    onDesignWritten: (projectId, updatedAt) => watcher.noteOwnWrite(projectId, updatedAt),
    engine: wrapEngineService(engineManager),
    // When no host is configured, the pcs.* handlers answer PC_NOT_SET_UP themselves; a stub would
    // defeat that, so the handlers see `undefined` and the stub is reserved for BotRunner alone.
    pc: host ?? undefined,
    run: botRunner,
    schedule: scheduler,
    terminals,
    skills,
    plugins,
    connectors,
    phone: { info: () => phone.info() },
    computer
  })

  // Follows the settings toggle and code changes: on/off, and restarting when the code changes.
  const applyPhoneSettings = (settings: Settings): void => {
    void phone
      .sync(settings)
      .then((info) => {
        if (info.error) console.error('[core] phone access:', info.error)
      })
      .catch((error) => console.error('[core] phone access sync failed', error))
  }
  bus.on((event) => {
    if (event.type === 'settings.updated') applyPhoneSettings(event.settings)
  })
  applyPhoneSettings(repos.settings.get())

  const server = await startRpcServer({
    handlers,
    bus,
    port: Number(process.env.DESKMATES_PORT ?? 0),
    agent: {
      token: agentToken,
      methods: ['app.info', 'projects.list', 'designs.read', 'designs.save', 'designs.create'],
      events: ['design.updated', 'project.updated']
    }
  })

  writeBridgeInfo(kitDir, { port: server.port, token: agentToken, pid: process.pid })
  watcher.start()
  scheduler.start()
  handoffs.start()

  // A bot PC left running (or gone, or unreachable) from a previous session must not block startup
  // on a slow or hung external command, so this is fire-and-forget, not awaited — by this point the
  // RPC server is already listening and its bus subscription is already registered (see
  // startRpcServer), so any pc.updated event this produces still reaches an already-connected UI.
  // Skipped entirely when there's no host to reconcile against.
  if (host) {
    void reconcilePcs({ repos, host, bus }).catch((error) => {
      console.error('[core] bot PC reconciliation failed', error)
    })
  }

  const ready: CoreToHost = { type: 'ready', port: server.port, token: server.token }

  const shutdown = (): void => {
    void (async () => {
      try {
        computer.stop()
        watcher.stop()
        scheduler.stop()
        handoffs.stop()
        if (idleCheckTimer) clearInterval(idleCheckTimer)
        await runner.stopAll()
        await botRunner.stopAll()
        if (host instanceof LocalWslHost) host.dispose()
        await connectors.closeAll()
        await phone.stop()
        await server.close()
      } finally {
        removeBridgeInfoIfOwned(kitDir)
        process.exit(0)
      }
    })()
  }

  if (parentPort) {
    parentPort.on('message', (event) => {
      const message = event.data as HostToCore | undefined
      if (message?.type === 'keys') keys.set(message.keys)
      // Windows has no real signals, so the host asks for a clean exit instead of killing us.
      if (message?.type === 'shutdown') shutdown()
      if (message?.type === 'computer-stop') computer.stop()
    })
    bus.on((event) => {
      if (event.type === 'notify') parentPort.postMessage({ type: 'notify', title: event.title, body: event.body })
    })
    parentPort.postMessage(ready)
  } else {
    console.log(JSON.stringify(ready))
  }

  process.once('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[core] failed to start', error)
  process.exit(1)
})
