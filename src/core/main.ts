import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CoreToHost, HostToCore, Settings } from '../shared/protocol'
import { agentCommandFileName, agentKitDir, writeAgentGuide } from './agents/guide'
import { ExecCommandRunner } from './bots/command-runner'
import { EngineManager } from './bots/engine'
import { BotRunner } from './bots/runner'
import { HandoffService } from './bots/handoffs'
import { LocalDockerHost } from './bots/local-docker-host'
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
import { GoogleAuth, type GoogleClient } from './google/auth'
import { createSubagentRunner } from './engine/subagents'
import { ChildProcessSpawner } from './terminals/process'
import { PsAttachHelperSpawner } from './terminals/attach'
import { LinuxAttachHelperSpawner } from './terminals/attach-linux'
import { TerminalsManager } from './terminals/service'
import { ComputerUseService } from './computer/service'
import { WindowsDesktop } from './computer/desktop'
import { LinuxDesktop } from './computer/linux-desktop'
import { ScreenGuideService } from './screen/guide'
import { ParentPortRenderClient } from './render/client'
import { BrowserService } from './browser/service'
import { TaskScheduler } from './schedules/task-scheduler'
import { ScreenControl } from './tools/screen-control'
import { DuoStore } from './duo/store'
import { RemoteAccess, type RemoteConfig } from './phone/remote'
import { DuoService } from './duo/service'
import { prepareDuoWorkspace } from './duo/workspace'
import { duoTools } from './tools/duo'
import { agentBrowserTools } from './tools/browser'
import { webFetchText, webSearchResults } from './tools/web'
import { myPromptBrief, myPromptPath, promptSectionTool } from './engine/my-prompt'
import { DEFAULT_DUO_PROFILE, type DuoProfile } from '../shared/duo'
import { tool as aiTool } from 'ai'
import { z } from 'zod'
import { WakeTimerManager } from './scheduler/wake-timers'
import { isCliProvider } from '../shared/protocol'

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
  // Skills installed for Claude Code (~/.claude/skills) are used in place, so Deskmates sees new ones without an import.
  const skills = new SkillsService({ repos, dataDir, linkedDirs: [join(homedir(), '.claude', 'skills')] })
  const connectors = new McpConnectorManager({ repos, createTransport: createMcpTransport })
  void connectors.refresh().catch((error) => {
    console.error('[core] connector startup failed', error)
  })
  // Every external command (bot PCs, plugin clones) goes through this one runner.
  const commandRunner = new ExecCommandRunner()
  const plugins = new PluginsService({ repos, dataDir, runner: commandRunner, skills })
  const subagents = createSubagentRunner({ models })
  const render = parentPort ? new ParentPortRenderClient(parentPort) : undefined
  const browser = new BrowserService({
    bus,
    port: parentPort,
    sites: { get: () => repos.settings.getExtra<string[]>('browserSites', []), set: (sites) => repos.settings.setExtra('browserSites', sites) },
    notify: (title, body) => bus.emit({ type: 'notify', title, body })
  })
  // The Work and Design agents' own mouse and keyboard (screen_look / screen_act), with the same
  // "controlling this computer" bar and Stop as the Agents tab's computer use.
  const screenControl = new ScreenControl({
    createDesktop: () =>
      process.platform === 'win32'
        ? new WindowsDesktop()
        : new LinuxDesktop({
            runner: commandRunner,
            readFile: (path) => readFileSync(path),
            removeFile: (path) => rmSync(path, { force: true })
          }),
    onActiveChange: (active) => parentPort?.postMessage({ type: 'computer-use', active } satisfies CoreToHost)
  })
  // Google sign-in: the OAuth client comes from the app's settings (loaded once from the
  // client_secret file) or the environment; the user only presses Connect.
  const google = new GoogleAuth({
    dataDir,
    client: () => {
      const saved = repos.settings.getExtra<GoogleClient | null>('googleClient', null)
      if (saved?.clientId && saved.clientSecret) return saved
      const clientId = process.env.DESKMATES_GOOGLE_CLIENT_ID?.trim()
      const clientSecret = process.env.DESKMATES_GOOGLE_CLIENT_SECRET?.trim()
      return clientId && clientSecret ? { clientId, clientSecret } : null
    },
    onChange: (status) => bus.emit({ type: 'google.updated', status })
  })
  void google.load()
  const runner = new TaskRunner({
    repos,
    dataDir,
    google,
    bus,
    // Read only when a task runs, by which time the agent kit below exists.
    agentCommand: () => commandPath,
    models,
    changes,
    skills,
    connectors,
    plugins,
    subagents,
    createTools: buildTools,
    getTerminals: () => terminals,
    render,
    browser,
    screen: screenControl,
    getSchedules: () => taskSchedules,
    agentNameFor: (taskId) => repos.taskSchedules.list().find((s) => s.lastTaskId === taskId)?.name
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
  const taskWakeTimers = new WakeTimerManager({ runner: commandRunner, dataDir })
  const taskSchedules = new TaskScheduler({
    repos,
    bus,
    send: (taskId, text) => runner.send(taskId, text),
    whenIdle: (taskId) => runner.whenIdle(taskId),
    isRunning: (taskId) => runner.isRunning(taskId),
    isCliProject: (project) => {
      const model = project.model ?? repos.settings.get().defaultModel
      return model !== null && isCliProvider(model.provider)
    },
    wake: process.platform === 'win32' ? { upsert: (id, nextMs) => taskWakeTimers.upsert(id, 'task', nextMs), remove: (id) => taskWakeTimers.remove(id) } : undefined,
    notify: (title, body) => bus.emit({ type: 'notify', title, body })
  })
  const handoffs = new HandoffService({ repos, bus, dataDir, run: botRunner })

  // LocalDockerHost/CloudHost checkIdle() does the actual idle check but owns no timer of its own;
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

  const commandPath = join(kitDir, agentCommandFileName())
  // The mounted prompt directories (DESKMATES_PROMPTS_DIR set by the host; falls back to a local
  // ./prompts for standalone runs). Connected terminal agents get the user's own prompt: its first
  // section in full plus an index of the rest (with line numbers in the real file), written next to
  // the agent kit, so they never have to read the whole 470 KB file.
  const promptRoot = process.env.DESKMATES_PROMPTS_DIR ?? join(process.cwd(), 'prompts')
  const codePromptPath = join(kitDir, 'operating-prompt.md')
  const writeTerminalBrief = (): string | null => {
    const brief = myPromptBrief('file', myPromptPath(promptRoot))
    mkdirSync(kitDir, { recursive: true })
    if (brief) writeFileSync(codePromptPath, `${brief}\n`, 'utf8')
    else rmSync(codePromptPath, { force: true })
    return brief
  }
  const terminalBrief = writeTerminalBrief()
  // Keep it current when the user edits their prompt while Deskmates runs, as the Work tab does.
  watchFile(myPromptPath(promptRoot), { interval: 5000, persistent: false }, () => {
    try {
      writeTerminalBrief()
    } catch (error) {
      console.error("[core] couldn't refresh the terminal agents' prompt", error)
    }
  })
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
    attachSpawner: process.platform === 'win32' ? new PsAttachHelperSpawner() : new LinuxAttachHelperSpawner(commandRunner),
    bus,
    guidePath: guide.path,
    guideVersion: guide.version,
    phrase: guide.phrase,
    promptPath: existsSync(codePromptPath) ? codePromptPath : undefined
  })

  const computer = new ComputerUseService({
    bus,
    models,
    createDesktop: () =>
      process.platform === 'win32'
        ? new WindowsDesktop()
        : new LinuxDesktop({
            runner: commandRunner,
            readFile: (path) => readFileSync(path),
            removeFile: (path) => rmSync(path, { force: true })
          }),
    onActiveChange: (active) => parentPort?.postMessage({ type: 'computer-use', active } satisfies CoreToHost)
  })

  const screenGuide = new ScreenGuideService({
    runner: commandRunner,
    createDesktop: () =>
      process.platform === 'win32'
        ? new WindowsDesktop()
        : new LinuxDesktop({
            runner: commandRunner,
            readFile: (path) => readFileSync(path),
            removeFile: (path) => rmSync(path, { force: true })
          }),
    showOverlay: (marks, seconds) => parentPort?.postMessage({ type: 'overlay', marks, seconds } satisfies CoreToHost)
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

  // Duo: its workspace, store and service. Freebuff runs start only from the user's taps.
  const duoFolder = DuoService.folder(dataDir)
  const duoPlaybook = join(duoFolder, 'playbook.md')
  const duo: DuoService = new DuoService({
    store: new DuoStore(db),
    bus,
    getProfile: () => repos.settings.getExtra<DuoProfile>('duo', DEFAULT_DUO_PROFILE),
    setProfile: (profile) => repos.settings.setExtra('duo', profile),
    workspace: (profile) => {
      prepareDuoWorkspace({ dir: duoFolder, agentCommand: commandPath, profile, myPromptPath: myPromptPath(promptRoot) })
      return duoFolder
    },
    runCli: (provider, folder, prompt, modelId, signal, onItem) => {
      if (provider !== 'freebuff' && provider !== 'opencode' && provider !== 'agy') return Promise.resolve({ text: '', error: 'Not a command-line model.' })
      return terminals.execute(provider, folder, prompt, modelId, { signal, trustAgents: true, onItem })
    },
    defaultModel: () => repos.settings.get().defaultModel,
    resolveModel: (ref) => models.resolve(ref),
    apiTools: () => ({
      ...agentBrowserTools({ browser, agent: 'Duo', runKey: 'duo', sendPermit: (domain) => duo.sendPermit(domain), screenshotDir: join(duoFolder, 'screenshots') }),
      ...duoTools(duo, duoPlaybook),
      ...promptSectionTool(myPromptPath(promptRoot)),
      web_search: aiTool({
        description: 'Search the web (company research). Returns titles, links and snippets.',
        inputSchema: z.object({ query: z.string().min(1) }),
        execute: async ({ query }, { abortSignal }) => webSearchResults(query, abortSignal)
      }),
      web_fetch: aiTool({
        description: "Read a public page as text (a company's site or contact page).",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }, { abortSignal }) => webFetchText(url, abortSignal)
      })
    }),
    operatingPrompt: () => myPromptBrief('tool', myPromptPath(promptRoot)),
    notify: (title, body) => bus.emit({ type: 'notify', title, body })
  })
  try {
    prepareDuoWorkspace({ dir: duoFolder, agentCommand: commandPath, profile: duo.profile(), myPromptPath: myPromptPath(promptRoot) })
  } catch (error) {
    console.error('[duo] could not prepare its workspace', error)
  }

  // Deskmates from anywhere: paired phones over the encrypted relay, joined to this RPC server.
  const EMPTY_REMOTE: RemoteConfig = { relay: '', anon: '', appUrl: '', vapid: null, devices: [] }
  let rpcAddress: { port: number; token: string } | null = null
  const remote = new RemoteAccess({
    bus,
    getConfig: () => ({ ...EMPTY_REMOTE, ...repos.settings.getExtra<RemoteConfig>('remote', EMPTY_REMOTE) }),
    setConfig: (config) => repos.settings.setExtra('remote', config),
    core: () => rpcAddress
  })

  const handlers = createHandlers({
    repos,
    google,
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
    computer,
    screen: screenGuide,
    browser,
    taskSchedules,
    duo,
    duoTools: () => duoTools(duo, duoPlaybook),
    duoSendPermit: (domain) => duo.sendPermit(domain),
    remote,
    setRemoteConfig: (patch) => repos.settings.setExtra('remote', { ...EMPTY_REMOTE, ...repos.settings.getExtra<RemoteConfig>('remote', EMPTY_REMOTE), ...patch })
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
      methods: ['app.info', 'projects.list', 'designs.read', 'designs.save', 'designs.create', 'screen.look', 'screen.point', 'screen.say', 'screen.clear', 'browser.state', 'browser.tool', 'duo.tool'],
      events: ['design.updated', 'project.updated']
    }
  })

  writeBridgeInfo(kitDir, { port: server.port, token: agentToken, pid: process.pid })
  rpcAddress = { port: server.port, token: server.token }
  try {
    remote.start()
  } catch (error) {
    console.error('[remote] could not start', error)
  }
  // Every notification also reaches paired phones, as a short push.
  bus.on((event) => {
    if (event.type === 'notify') void remote.push(event.title, event.body).catch(() => undefined)
  })
  watcher.start()
  scheduler.start()
  taskSchedules.start()
  duo.start()
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
        screenGuide.dispose()
        screenControl.dispose()
        watcher.stop()
        scheduler.stop()
        taskSchedules.stop()
        duo.stop()
        remote.stop()
        handoffs.stop()
        if (idleCheckTimer) clearInterval(idleCheckTimer)
        await runner.stopAll()
        await botRunner.stopAll()
        // After the runners, so no turn is mid-flight on a server that is being shut down underneath
        // it; these outlive the app otherwise, holding their port and their 175KB session.
        terminals.dispose()
        if (host instanceof LocalDockerHost) host.dispose()
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
      if (message?.type === 'computer-stop') {
        computer.stop()
        screenControl.stop()
      }
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
