import type { RenderRequest, RenderResult, VideoRequest, VideoResult } from '../core/render/types'

export type ProviderId =
  | 'google'
  | 'openai'
  | 'openrouter'
  | 'nvidia'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'together'
  | 'xai'
  | 'compatible'
  | 'ollama'
  | 'lmstudio'
  | 'opencode'
  | 'agy'
export const PROVIDERS: readonly ProviderId[] = [
  'google',
  'openai',
  'openrouter',
  'nvidia',
  'groq',
  'deepseek',
  'mistral',
  'together',
  'xai',
  'compatible',
  'ollama',
  'lmstudio',
  'opencode',
  'agy'
]

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: 'Google Gemini',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA NIM',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  together: 'Together AI',
  xai: 'xAI (Grok)',
  compatible: 'OpenAI-compatible server',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  opencode: 'OpenCode',
  agy: 'Agy'
}

/** Providers served by a model server running on this PC: no API key, and the base URL is editable. */
export const LOCAL_PROVIDERS: readonly ProviderId[] = ['ollama', 'lmstudio']

export function isLocalProvider(provider: ProviderId): boolean {
  return LOCAL_PROVIDERS.includes(provider)
}

/** Providers with no API key: the prompt is sent to a connected local CLI session instead (openCode
 *  `run` / agy `-p`), so they work everywhere a model can be picked once the CLI is installed. */
export const CLI_PROVIDERS: readonly ProviderId[] = ['opencode', 'agy']

export function isCliProvider(provider: ProviderId): boolean {
  return CLI_PROVIDERS.includes(provider)
}

export interface ModelRef {
  provider: ProviderId
  modelId: string
}

export interface FontChoice {
  name: string
  dataUrl: string
}

export interface AnimationChoice {
  name: string
  json: string
  fonts: FontChoice[]
}

export interface Appearance {
  logo: string | null
  uiFont: FontChoice | null
  replyFont: FontChoice | null
  idleAnimation: AnimationChoice | null
  workingAnimation: AnimationChoice | null
}

export interface Settings {
  defaultModel: ModelRef | null
  globalInstructions: string
  /** Base URL for the OpenAI-compatible provider (OpenRouter, Ollama, LM Studio…), ending in /v1. */
  compatibleBaseUrl: string
  /** Base URL of the local Ollama server's OpenAI-compatible API, ending in /v1. */
  ollamaBaseUrl: string
  /** Base URL of the local LM Studio server, ending in /v1. */
  lmstudioBaseUrl: string
  maxSteps: number
  appearance: Appearance
  /**
   * The phone number your bots message, in international format. A bot sends from its own dedicated
   * WhatsApp number (see spec 5.11) and may only ever message this one. Empty means not set up yet.
   */
  whatsappTo: string
  /**
   * Whether the app accepts connections from another device on the LAN (spec 5.12). While this is
   * on, a phone server listens on 0.0.0.0 and requires {@link pairingCode} as its sign-in token.
   */
  phoneAccess: boolean
  /** The six-digit code a phone enters to sign in. Doubles as the phone server's WebSocket token. */
  pairingCode: string
  /** Which implementation runs bot PCs: `'local'` (the app's own WSL engine) or `'cloud'` (a Docker server on the network, spec 5.8's CloudHost). */
  pcHost: PcHostKind
  /** How to reach the cloud Docker server. Meaningful only when `pcHost` is `'cloud'`; `null` otherwise. */
  pcConnection: PcCloudConnection | null
}

/** The two `BotHost` implementations the app can drive bot PCs through. */
export type PcHostKind = 'local' | 'cloud'

/** Connection details for `pcHost: 'cloud'`. Paths are on this machine; empty strings mean "not used". */
export interface PcCloudConnection {
  /** Docker Engine URL on the cloud server: `tcp://host:port`, `http://host:port` or `https://host:port`. */
  endpoint: string
  /** Absolute path to a PEM client certificate for the Docker server, or ''. */
  tlsCertPath: string
  /** Absolute path to the PEM private key for the client certificate, or ''. */
  tlsKeyPath: string
  /** Absolute path to the PEM CA bundle that signed the Docker server's certificate, or ''. */
  tlsCaPath: string
  /** Private-registry username used when pulling the bot image; '' when the image is public. */
  registryUsername: string
  /** Private-registry password used when pulling the bot image; '' when the image is public. */
  registryPassword: string
}

/** Live state of phone (LAN) access: whether it's listening, on which port, and the URLs to open. */
export interface PhoneInfo {
  enabled: boolean
  port: number | null
  urls: string[]
  error: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: null,
  globalInstructions: '',
  compatibleBaseUrl: 'https://openrouter.ai/api/v1',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  lmstudioBaseUrl: 'http://localhost:1234/v1',
  maxSteps: 40,
  whatsappTo: '',
  phoneAccess: false,
  pairingCode: '',
  pcHost: 'local',
  pcConnection: null,
  appearance: {
    logo: null,
    uiFont: null,
    replyFont: null,
    idleAnimation: null,
    workingAnimation: null
  }
}

/** `work` projects are folders on disk (the Work tab); `design` projects are web designs (the Design tab). */
export type ProjectKind = 'work' | 'design'

export interface Project {
  id: string
  name: string
  folder: string
  model: ModelRef | null
  createdAt: number
  kind: ProjectKind
}

/** Preview widths in CSS pixels for the Design tab's device switcher. */
export const DEVICE_WIDTHS = { desktop: 1440, tablet: 834, phone: 390 } as const
export type DeviceSize = keyof typeof DEVICE_WIDTHS

/** Who saved a design file. The preview reloads for every source except `editor` (the user's own direct edits). */
export type DesignChangeSource = 'editor' | 'assistant' | 'external'

/** A page in a design's folder the preview can show: plain HTML or a Design Component (`.dc.html`). */
export interface DesignFile {
  /** Relative to the design folder, with forward slashes. */
  path: string
  updatedAt: number
  kind: 'html' | 'dc'
}

/** Largest design HTML file the core reads or writes. */
export const MAX_DESIGN_HTML_BYTES = 5 * 1024 * 1024

export type TaskStatus = 'idle' | 'running' | 'waiting-approval' | 'error'

export interface PlanItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface Task {
  id: string
  projectId: string
  title: string
  status: TaskStatus
  plan: PlanItem[]
  /** Risky tools the user chose to always allow for this task. */
  autoApprove: string[]
  error: string | null
  createdAt: number
  updatedAt: number
}

export type ToolItemState = 'running' | 'awaiting-approval' | 'done' | 'error' | 'denied'

export interface ToolItem {
  kind: 'tool'
  id: string
  at: number
  toolName: string
  input: unknown
  state: ToolItemState
  output?: unknown
  error?: string
  approvalId?: string
}

export type TimelineItem =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; text: string }
  | ToolItem

export interface Memory {
  id: string
  projectId: string
  content: string
  createdAt: number
}

export type ChangeKind = 'create' | 'modify' | 'delete' | 'move'

export interface FileChange {
  id: string
  taskId: string
  /** Path relative to the project folder, with forward slashes. */
  path: string
  kind: ChangeKind
  /** For moves: the destination, relative to the project folder. */
  movedTo: string | null
  undone: boolean
  createdAt: number
}

export interface UsageRow {
  day: string
  provider: ProviderId
  requests: number
  inputTokens: number
  outputTokens: number
}

export interface AppInfo {
  version: string
  dataDir: string
  /** Providers that currently have an API key. */
  keys: ProviderId[]
  /** Where connected coding agents find the Deskmates guide and the `deskmates` command. */
  agentKit: { guidePath: string; commandPath: string }
}

// ---- Skills and plugins (spec 5.5) ----

/** A skill: a folder holding the Agent Skills format `SKILL.md`, importable as one unit. */
export interface Skill {
  id: string
  name: string
  /** Absolute path to the skill folder (which contains `SKILL.md`). */
  folder: string
  enabled: boolean
  /** Where it came from: the original folder path when imported by the user, `plugin:<name>` when a plugin bundled it. */
  source: string
  createdAt: number
}

/** A plugin: a folder or GitHub repo bundling skills, connector configs, bot templates and schedule templates. */
export interface Plugin {
  id: string
  name: string
  /** Absolute path to the installed plugin folder under `<dataDir>/plugins`. */
  folder: string
  sourceKind: 'folder' | 'repo'
  /** The original folder path, or the GitHub repo URL the plugin was cloned from. */
  source: string
  installedAt: number
}

// ---- MCP connectors (spec 5.6) ----

/** How a connector talks to its MCP server: spawn a command over stdio, or HTTP streamable endpoints. */
export type ConnectorTransport = 'stdio' | 'http'

/** One MCP server the assistant and bots can use: spawned via stdio, or reached over HTTP streamable. */
export interface Connector {
  id: string
  name: string
  transport: ConnectorTransport
  /** Stdio: the executable (plus any absolute flags) that launches the server. */
  command: string | null
  /** Stdio: command-line arguments for `command`. */
  args: string[]
  /** HTTP: the streamable-http server URL. */
  url: string | null
  /** Stdio: extra environment variables for the spawned process. */
  env: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
}

// ---- Bots (stage 2) ----

/** `own` gives each bot its own PC; `shared` puts every bot on one PC, taking turns. */
export type PcMode = 'own' | 'shared'

export type PcState = 'absent' | 'stopped' | 'starting' | 'running' | 'error'

export interface BotPc {
  botId: string
  state: PcState
  /** Container id, when one exists. */
  containerId: string | null
  memoryMb: number
  /** Minutes of inactivity before the PC stops; 0 keeps it running. */
  idleStopMinutes: number
  lastUsedAt: number | null
  error: string | null
}

export interface Bot {
  id: string
  name: string
  avatar: string | null
  instructions: string
  model: ModelRef | null
  /** Tools the bot may use without asking, for unattended runs. */
  autoApprove: string[]
  createdAt: number
  updatedAt: number
}

export type RunState = 'queued' | 'running' | 'waiting-approval' | 'done' | 'error' | 'stopped'

export interface BotRun {
  id: string
  botId: string
  scheduleId: string | null
  state: RunState
  /** What the bot was asked to do. */
  task: string
  startedAt: number
  finishedAt: number | null
  error: string | null
  /** Folder under <dataDir>/runs holding log.jsonl and screenshots. */
  folder: string
}

export interface Schedule {
  id: string
  botId: string
  /** Five-field cron in the user's local time. */
  cron: string
  task: string
  enabled: boolean
  /** What to do with a run missed while the PC was off. */
  missed: 'run-late' | 'skip'
  lastRunAt: number | null
  nextRunAt: number | null
}

/** Lifecycle of a handoff file a sending bot dropped in the shared folder (spec 5.9). */
export type HandoffState = 'pending' | 'running' | 'done' | 'error'

/** A task one bot handed to another: dropped as a JSON file in `<dataDir>/shared/handoffs`. */
export interface Handoff {
  id: string
  fromBotId: string
  toBotId: string
  /** What the receiving bot was asked to do. */
  task: string
  /** Files the sender placed in the shared folder for the receiver, relative with forward slashes. */
  files: string[]
  state: HandoffState
  /** Run that picked this handoff up, once one has. */
  runId: string | null
  /** The receiving bot's final reply (state `done`) or an error message (state `error`). */
  result: string | null
  createdAt: number
  updatedAt: number
}

/** One thing a bot template asks the user for before it can build the bot. */
export interface BotTemplateField {
  key: string
  label: string
  description: string
  kind: 'text' | 'url' | 'time'
  required: boolean
  placeholder?: string
}

export interface BotTemplateInfo {
  id: string
  name: string
  description: string
  /** Pre-filled default for the template's time field; the user picks the real one. */
  suggestedTime: string
  /** What this template's bot is built around, for the UI to explain. */
  tools: string[]
  fields: BotTemplateField[]
}

export type EngineStep = 'wsl' | 'distro' | 'docker' | 'image'
export type EngineStepState = 'ok' | 'missing' | 'needs-admin' | 'needs-restart' | 'working' | 'error'

export interface EngineStatus {
  ready: boolean
  virtualization: boolean
  steps: Record<EngineStep, { state: EngineStepState; detail: string }>
}

// ---- Terminal agents (stage 3 beta: detection + managed mode) ----

/** The coding-agent CLIs Deskmates can find and drive. Two ways: managed mode (the app runs the
 *  official non-interactive command itself, spec 5.13) and attach mode (the app types into a
 *  terminal window the user already has open and mirrors its screen back, spec 5.14~5.16). */
export type TerminalTool = 'opencode' | 'agy'

/** One running OpenCode or agy process found on the machine, independent of whether Deskmates
 *  started it. `folder` is read cheaply off the command line (a `--dir` flag); it's `null` when the
 *  process wasn't started that way, since reading another process's real working directory needs
 *  more than a process listing. */
export interface DetectedTerminalAgent {
  tool: TerminalTool
  pid: number
  /** Epoch milliseconds, or null when Windows didn't report a creation time. */
  startedAt: number | null
  commandLine: string
  folder: string | null
}

/** Whether a managed session's agent has read the Deskmates guide and confirmed with the check-in
 *  line (spec 5.14) — same states as the shared `OnboardingTracker`, exposed to the UI as ``Knows
 *  Deskmates`` / ``Didn't confirm``. */
export type TerminalOnboardingState = 'unknown' | 'primed' | 'confirmed' | 'failed'

export type TerminalSessionState = 'starting' | 'busy' | 'idle' | 'error'

/** A managed-mode conversation the app started and can keep sending prompts to. */
export interface TerminalSession {
  id: string
  tool: TerminalTool
  folder: string
  /** `provider/model` for OpenCode, a bare model name for agy, or null to use the CLI's own default. */
  model: string | null
  /** The CLI's own session/conversation id, once the first run reports one; used to keep the
   *  conversation going (OpenCode `-s`, agy `--conversation`). */
  cliSessionId: string | null
  state: TerminalSessionState
  onboarding: TerminalOnboardingState
  error: string | null
  createdAt: number
  updatedAt: number
}

/** Lifecycle of an attached terminal — one the app did NOT start, but is typing into and reading
 *  the screen of through a helper process (spec 5.14). */
export type AttachedTerminalState = 'attaching' | 'priming' | 'connected' | 'closed' | 'error'

/** An attached session: the app drives a terminal the user already has open. `screen` is a live
 *  mirror of the terminal's visible rows (best-effort, updated on each poll); `error` explains in
 *  plain language why `state` is `error`. */
export interface AttachedTerminalSession {
  id: string
  tool: TerminalTool
  pid: number
  state: AttachedTerminalState
  onboarding: TerminalOnboardingState
  error: string | null
  /** Epoch milliseconds when the session was created. */
  createdAt: number
  /** Epoch milliseconds of the last state or screen change. */
  updatedAt: number
  /** The mirror of the attached terminal's visible rows as plain text (no ANSI codes). */
  screen: string
  /** A permission question the agent is showing right now (read a file, run a command…), if any. */
  permission?: TerminalPermissionPrompt | null
}

/** A terminal agent's permission question, read off its screen, with the answers Deskmates can give. */
export interface TerminalPermissionPrompt {
  /** Identifies this question, so an answer or a notification applies to it only once. */
  key: string
  title: string
  detail: string | null
  options: Array<{ id: string; label: string; danger?: boolean }>
}

type NoParams = Record<string, never>

/** One line in a computer-use session's log. */
export interface ComputerStep {
  at: number
  kind: 'action' | 'note' | 'done' | 'error'
  text: string
}

/** A session where a model drives the user's own mouse and keyboard (Agents tab → Computer use). */
export interface ComputerSession {
  id: string
  prompt: string
  model: string
  status: 'running' | 'done' | 'stopped' | 'error'
  startedAt: number
  endedAt: number | null
  steps: ComputerStep[]
  /** The latest screenshot the model saw, as a JPEG data URL. */
  screenshot: string | null
  /** When the current wait for the model's next move began; null while acting or when finished. */
  waitingSince: number | null
  /** How much the model has written (thinking included) during the current wait, to show it's alive. */
  thinkingChars: number
}

/** Whether a key can call a model the provider lists, and why not. */
export interface ModelCheck {
  usable: boolean
  detail: string
  /** A passing problem (the model didn't answer in time), worth checking again soon. */
  temporary?: boolean
}

export interface RpcMethods {
  'app.info': { params: NoParams; result: AppInfo }
  'settings.get': { params: NoParams; result: Settings }
  'settings.update': { params: Partial<Settings>; result: Settings }
  'phone.info': { params: NoParams; result: PhoneInfo }
  'models.list': { params: { provider: ProviderId }; result: string[] }
  /** Sends one tiny request to tell whether the saved key can really call this model. */
  'models.check': { params: ModelRef; result: ModelCheck }
  'projects.list': { params: NoParams; result: Project[] }
  'projects.create': { params: { name: string; folder: string }; result: Project }
  'projects.update': { params: { id: string; name?: string; model?: ModelRef | null }; result: Project }
  'projects.delete': { params: { id: string }; result: null }
  'projects.instructions.get': { params: { id: string }; result: { path: string; content: string } }
  'projects.instructions.set': { params: { id: string; content: string }; result: null }
  'tasks.list': { params: { projectId: string }; result: Task[] }
  'tasks.create': { params: { projectId: string }; result: Task }
  'tasks.get': { params: { id: string }; result: { task: Task; timeline: TimelineItem[] } }
  'tasks.rename': { params: { id: string; title: string }; result: Task }
  'tasks.delete': { params: { id: string }; result: null }
  'tasks.send': { params: { id: string; text: string }; result: null }
  'tasks.stop': { params: { id: string }; result: null }
  'approvals.respond': {
    params: { taskId: string; approvalId: string; approved: boolean; always?: boolean }
    result: null
  }
  'changes.list': { params: { taskId: string }; result: FileChange[] }
  'changes.undo': { params: { id: string }; result: FileChange[] }
  'changes.undoAll': { params: { taskId: string }; result: FileChange[] }
  'memory.list': { params: { projectId: string }; result: Memory[] }
  'memory.add': { params: { projectId: string; content: string }; result: Memory[] }
  'memory.delete': { params: { id: string; projectId: string }; result: Memory[] }
  'usage.list': { params: NoParams; result: UsageRow[] }
  /** Creates a design project (with its starter index.html) and its first conversation. With a prompt, also sends it. */
  'designs.create': { params: { name: string; prompt?: string }; result: { project: Project; task: Task } }
  /** Reads the design's index.html. */
  'designs.read': { params: { projectId: string }; result: { html: string; updatedAt: number } }
  /**
   * Replaces one of the design's plain HTML pages (`path`, index.html by default), for example with the
   * user's direct edits from the preview. Refuses Design Component (.dc.html) files.
   */
  'designs.save': { params: { projectId: string; html: string; reason: string; path?: string }; result: { updatedAt: number } }
  /** Lists the design's viewable pages (.html and .dc.html), newest first. */
  'designs.files': { params: { projectId: string }; result: DesignFile[] }

  'bots.list': { params: NoParams; result: Bot[] }
  'bots.create': { params: { name: string; instructions?: string; model?: ModelRef | null }; result: Bot }
  'bots.update': {
    params: { id: string; name?: string; instructions?: string; model?: ModelRef | null; avatar?: string | null; autoApprove?: string[] }
    result: Bot
  }
  /**
   * Deletes the bot's own record (cascading its PC row, schedules and runs). Also tears down its
   * PC container and storage unless `deletePc` is explicitly `false`; if that teardown fails (or
   * bot PCs aren't set up on this computer at all), the bot is still deleted and `pcWarning`
   * explains in plain language what was left behind.
   */
  'bots.delete': { params: { id: string; deletePc?: boolean }; result: { pcWarning: string | null } }
  /** The bot templates the setup wizard can offer, with the fields each one asks for. */
  'bots.templates': { params: NoParams; result: BotTemplateInfo[] }
  /** Creates a bot, its PC, its first schedule and its starting memory from a template, in one step. */
  'bots.createFromTemplate': {
    params: { templateId: string; values: Record<string, string> }
    result: { bot: Bot; schedule: Schedule; warnings: string[] }
  }
  /** Starts a run now. Returns the run; progress arrives as `run.updated` and `run.item` events. */
  'bots.run': { params: { botId: string; task: string }; result: BotRun }
  'bots.stopRun': { params: { runId: string }; result: null }
  'runs.list': { params: { botId?: string; limit?: number }; result: BotRun[] }
  'runs.items': { params: { runId: string }; result: TimelineItem[] }
  /** Answers an approval a bot asked for mid-run. `always` adds the tool to the bot's auto-approved list. */
  'runs.respond': {
    params: { runId: string; approvalId: string; approved: boolean; always?: boolean }
    result: null
  }

  'pcs.list': { params: NoParams; result: BotPc[] }
  'pcs.start': { params: { botId: string }; result: BotPc }
  'pcs.stop': { params: { botId: string }; result: BotPc }
  'pcs.reset': { params: { botId: string }; result: BotPc }
  'pcs.update': { params: { botId: string; memoryMb?: number; idleStopMinutes?: number }; result: BotPc }
  /** Live view and control endpoints for a running PC, bound to 127.0.0.1. */
  'pcs.endpoints': { params: { botId: string }; result: { novnc: string; agent: string; cdp: string } | null }
  'pcs.mode.get': { params: NoParams; result: PcMode }
  'pcs.mode.set': { params: { mode: PcMode }; result: PcMode }
  /**
   * Pauses (`on: true`) or resumes (`on: false`) a bot's own PC-touching tools while a human has
   * taken over its mouse and keyboard — spec 5.8. While paused, the run service refuses to run the
   * screen/browser/pc-file tools for this bot, in the current run and any future one, until this
   * is called again with `on: false`.
   */
  'pcs.takeOver': { params: { botId: string; on: boolean }; result: null }

  'engine.status': { params: NoParams; result: EngineStatus }
  /** Runs the next setup step it can; progress arrives as `engine.progress` events. */
  'engine.setup': { params: NoParams; result: EngineStatus }

  'schedules.list': { params: { botId?: string }; result: Schedule[] }
  'schedules.create': { params: { botId: string; cron: string; task: string; missed?: 'run-late' | 'skip' }; result: Schedule }
  'schedules.update': {
    params: { id: string; cron?: string; task?: string; enabled?: boolean; missed?: 'run-late' | 'skip' }
    result: Schedule
  }
  'schedules.delete': { params: { id: string }; result: null }

  'handoffs.list': { params: { botId?: string }; result: Handoff[] }
  'handoffs.item': { params: { id: string }; result: Handoff }

  /** Lists OpenCode/agy processes currently running on this machine (attach-mode-style detection). */
  'terminals.detect': { params: NoParams; result: DetectedTerminalAgent[] }
  /** Lists managed sessions the app has started (any state, including ones that have finished). */
  'terminals.sessions.list': { params: NoParams; result: TerminalSession[] }
  /** Starts a managed session in `folder`: the app runs the tool's own non-interactive command,
   *  sends the Deskmates check-in primer as the first turn, and returns immediately with the new
   *  session in `starting` state — progress streams as `terminals.session.updated`/`.item` events. */
  'terminals.sessions.start': { params: { tool: TerminalTool; folder: string; model?: string }; result: TerminalSession }
  /** Sends a prompt on an existing managed session, continuing its CLI conversation. */
  'terminals.sessions.send': { params: { id: string; text: string }; result: null }
  /** Kills a managed session's running CLI call, if one is in flight. */
  'terminals.sessions.stop': { params: { id: string }; result: null }
  'terminals.sessions.items': { params: { id: string }; result: TimelineItem[] }

  /** Attaches Deskmates to a terminal the user already has open (spec 5.14): spawns a helper that
   *  attaches to the target console, types the primer, primes it, then starts mirroring the screen
   *  back as `terminals.attach.updated` events. Returns the new (or, if the pid was already
   *  attached, existing) session. */
  'terminals.attach': { params: { pid: number; tool: TerminalTool }; result: AttachedTerminalSession }
  /** Lists attached sessions (any state, including closed ones) — the mirror/reconcile endpoint. */
  'terminals.attach.list': { params: NoParams; result: AttachedTerminalSession[] }
  /** Types a prompt into an attached terminal. If the session's primer never confirmed, the primer
   *  is re-typed first (the ready-line handshake again), so the tool is guaranteed to be running
   *  before the user's text lands. */
  'terminals.attach.send': { params: { id: string; text: string }; result: null }
  /** Re-sends the primer to an attached terminal that hasn't confirmed yet (the ``Retry`` button). */
  'terminals.attach.retry': { params: { id: string }; result: null }
  /** Answers the permission question an attached agent is showing, by pressing the keys its prompt expects. */
  'terminals.attach.answer': { params: { id: string; key: string; option: string }; result: null }
  /** Detaches: tells the helper to stop typing/polling and closes it. The user's terminal itself
   *  keeps running untouched. */
  'terminals.attach.stop': { params: { id: string }; result: null }

  // ---- Skills and plugins (spec 5.5) ----
  'skills.list': { params: NoParams; result: Skill[] }
  /** Imports a skill folder (with a `SKILL.md`) into `<dataDir>/skills`. Re-importing a name refreshes it. Returns the full list. */
  'skills.import': { params: { folder: string }; result: Skill[] }
  'skills.setEnabled': { params: { id: string; enabled: boolean }; result: Skill[] }
  'skills.remove': { params: { id: string }; result: Skill[] }
  'plugins.list': { params: NoParams; result: Plugin[] }
  /** Installs a plugin from a local folder or a GitHub repo (`https://github.com/owner/repo` or `owner/repo`). */
  'plugins.install': { params: { source: string }; result: Plugin[] }
  'plugins.remove': { params: { id: string }; result: Plugin[] }

  // ---- MCP connectors (spec 5.6) ----
  'connectors.list': { params: NoParams; result: Connector[] }
  /** Creates a connector. Returns the full list. */
  'connectors.create': {
    params: {
      name: string
      transport: ConnectorTransport
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    }
    result: Connector[]
  }
  'connectors.update': {
    params: {
      id: string
      name?: string
      transport?: ConnectorTransport
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    }
    result: Connector[]
  }
  'connectors.delete': { params: { id: string }; result: Connector[] }
  /** Connects to the connector live, lists its tool names, then closes. Surfaces connection errors. */
  'connectors.test': { params: { id: string }; result: string[] }
  /** Imports MCP servers from an `mcp_config.json` file (e.g. Antigravity's). Adds each stdio/http server whose name isn't already present. */
  'connectors.import': { params: { path: string }; result: Connector[] }
  /** Starts a computer-use session: the model sees the screen and drives the user's mouse and keyboard. */
  'computer.start': { params: { prompt: string; model?: ModelRef | null }; result: ComputerSession }
  'computer.stop': { params: NoParams; result: ComputerSession | null }
  'computer.get': { params: NoParams; result: ComputerSession | null }
}

export type RpcMethod = keyof RpcMethods
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params']
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result']

export type CoreEvent =
  | { type: 'project.updated'; project: Project }
  | { type: 'project.deleted'; projectId: string }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string; projectId: string }
  | { type: 'task.item'; taskId: string; item: TimelineItem }
  | { type: 'task.timeline'; taskId: string; timeline: TimelineItem[] }
  | { type: 'changes.updated'; taskId: string; changes: FileChange[] }
  | { type: 'memory.updated'; projectId: string; memories: Memory[] }
  | { type: 'settings.updated'; settings: Settings }
  | { type: 'usage.updated'; usage: UsageRow[] }
  | { type: 'notify'; title: string; body: string }
  | { type: 'design.updated'; projectId: string; updatedAt: number; source: DesignChangeSource }
  /** The assistant asked to show this file (relative to the design folder) in the user's preview. */
  | { type: 'design.show'; projectId: string; path: string }
  | { type: 'bot.updated'; bot: Bot }
  | { type: 'bot.deleted'; botId: string }
  | { type: 'pc.updated'; pc: BotPc }
  | { type: 'engine.progress'; status: EngineStatus }
  | { type: 'run.updated'; run: BotRun }
  | { type: 'run.item'; runId: string; item: TimelineItem }
  | { type: 'handoff.updated'; handoff: Handoff }
  | { type: 'schedule.updated'; schedule: Schedule }
  | { type: 'schedule.deleted'; scheduleId: string }
  | { type: 'terminals.session.updated'; session: TerminalSession }
  | { type: 'terminals.session.item'; sessionId: string; item: TimelineItem }
  | { type: 'terminals.attach.updated'; session: AttachedTerminalSession }
  | { type: 'skills.updated'; skills: Skill[] }
  | { type: 'plugins.updated'; plugins: Plugin[] }
  | { type: 'connectors.updated'; connectors: Connector[] }
  | { type: 'computer.updated'; session: ComputerSession }

export type ClientMessage = { type: 'req'; id: number; method: RpcMethod; params: unknown }

export type ServerMessage =
  | { type: 'res'; id: number; ok: true; result: unknown }
  | { type: 'res'; id: number; ok: false; error: string }
  | { type: 'event'; event: CoreEvent }

/** Messages from the Electron main process to the core over the utility-process channel. */
export type HostToCore =
  | { type: 'keys'; keys: Partial<Record<ProviderId, string>> }
  /** Asks the core to clean up and exit by itself. Windows has no real signals, so a kill would skip its cleanup. */
  | { type: 'shutdown' }
  /** The user pressed the stop hotkey or the Stop button on the "controlling your computer" bar. */
  | { type: 'computer-stop' }
  /** The answer to a `render-request` with the same id. */
  | { type: 'render-result'; id: number; result: RenderResult }
  /** The answer to a `video-request` with the same id: the result, or why it failed. */
  | { type: 'video-result'; id: number; result?: VideoResult; error?: string }

/** Messages from the core to the Electron main process. */
export type CoreToHost =
  | { type: 'ready'; port: number; token: string }
  | { type: 'notify'; title: string; body: string }
  /** A computer-use session started or ended: the host shows or hides the "controlling" bar and the stop hotkey. */
  | { type: 'computer-use'; active: boolean }
  /** Asks the host to render a design page offscreen (screenshots, scripts, PDF); answered by `render-result`. */
  | { type: 'render-request'; id: number; request: RenderRequest }
  /** Asks the host to record a design page to a video file; answered by `video-result`. */
  | { type: 'video-request'; id: number; request: VideoRequest & { out: string } }
