import { create } from 'zustand'
import { core } from './rpc'
import type {
  ComputerSession,
  AppInfo,
  AttachedTerminalSession,
  Bot,
  BotPc,
  BotRun,
  Connector,
  CoreEvent,
  DetectedTerminalAgent,
  EngineStatus,
  FileChange,
  Handoff,
  Memory,
  PcMode,
  Plugin,
  Project,
  ProviderId,
  Schedule,
  Settings,
  Skill,
  Task,
  TerminalSession,
  TerminalTool,
  TimelineItem,
  UsageRow
} from '../../../shared/protocol'
import type { InstallWslResult } from '../../../shared/desktop-api'

export type View =
  | { name: 'home' }
  | { name: 'project'; projectId: string }
  | { name: 'task'; projectId: string; taskId: string }
  | { name: 'settings' }
  | { name: 'project-settings'; projectId: string }
  | { name: 'design-home' }
  | { name: 'design'; projectId: string }
  | { name: 'bots-home' }
  | { name: 'bot'; botId: string }
  | { name: 'agents-home' }
  | { name: 'agents-session'; sessionId: string }
  | { name: 'agents-attach'; sessionId: string }
  | { name: 'extras-home' }

export type ConnectionStatus = 'connecting' | 'open' | 'closed'
export type Tab = 'work' | 'design' | 'bots' | 'agents' | 'extras'
export interface ToastAction {
  label: string
  onClick: () => void
}
export interface ToastState {
  message: string
  action?: ToastAction
}

const TAB_STORAGE_KEY = 'deskmates:tab'

const TAB_HOMES: Record<Tab, View> = {
  work: { name: 'home' },
  design: { name: 'design-home' },
  bots: { name: 'bots-home' },
  agents: { name: 'agents-home' },
  extras: { name: 'extras-home' }
}

function readStoredTab(): Tab {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY)
    return raw === 'design' || raw === 'bots' || raw === 'agents' || raw === 'extras' ? raw : 'work'
  } catch {
    return 'work'
  }
}

function storeTab(tab: Tab): void {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    // localStorage may be unavailable; the tab choice just won't survive a restart.
  }
}

interface StoreState {
  started: boolean
  status: ConnectionStatus
  appInfo: AppInfo | null
  settings: Settings | null
  projects: Project[]
  tasksByProject: Record<string, Task[]>
  timelines: Record<string, TimelineItem[]>
  changes: Record<string, FileChange[]>
  memories: Record<string, Memory[]>
  keyStatus: ProviderId[]
  models: Partial<Record<ProviderId, string[]>>
  usage: UsageRow[]
  view: View
  tab: Tab
  workView: View
  designView: View
  botsView: View
  agentsView: View
  extrasView: View
  /** Where Settings was opened from: Settings is a detour, so leaving or reopening the tab goes back there. */
  settingsReturn: View | null
  toast: ToastState | null
  bots: Bot[]
  botPcs: Record<string, BotPc>
  runsByBot: Record<string, BotRun[]>
  runItemsByRun: Record<string, TimelineItem[]>
  schedulesByBot: Record<string, Schedule[]>
  handoffs: Handoff[]
  skills: Skill[]
  plugins: Plugin[]
  connectors: Connector[]
  engineStatus: EngineStatus | null
  pcMode: PcMode | null
  /** Result of the last `engine.installWsl()` elevation attempt, kept here (not local component state)
   *  so it survives the setup wizard unmounting when the user switches tabs and comes back. Reset to
   *  null at the start of each attempt; a real Windows restart + app relaunch replaces it for good with
   *  a fresh `engineStatus` from the new process. */
  wslInstallOutcome: InstallWslResult | null
  wslInstalling: boolean
  detectedAgents: DetectedTerminalAgent[]
  terminalSessions: TerminalSession[]
  terminalItemsBySession: Record<string, TimelineItem[]>
  attachedTerminalSessions: AttachedTerminalSession[]
  computerSession: ComputerSession | null
  /** The file each design's preview shows (relative to the design folder); unset means its default page. */
  designFiles: Record<string, string>
  init: () => void
  navigate: (view: View) => void
  setTab: (tab: Tab) => void
  showToast: (message: string, action?: ToastAction) => void
  clearToast: () => void
  createProject: (name: string, folder: string) => Promise<Project>
  createTask: (projectId: string) => Promise<Task | null>
  openTask: (projectId: string, taskId: string) => Promise<void>
  openProjectSettings: (projectId: string) => Promise<void>
  loadModels: (provider: ProviderId) => Promise<string[]>
  setKeyStatus: (keys: ProviderId[]) => void
  addMemory: (projectId: string, content: string) => Promise<Memory[] | null>
  deleteMemory: (id: string, projectId: string) => Promise<Memory[] | null>
  createDesign: (name: string, prompt?: string) => Promise<{ project: Project; task: Task } | null>
  openDesign: (projectId: string) => Promise<void>
  setDesignFile: (projectId: string, path: string) => void
  createBot: (name: string, instructions?: string) => Promise<Bot | null>
  deleteBot: (id: string) => Promise<boolean>
  openBot: (botId: string) => Promise<void>
  openRun: (runId: string) => Promise<void>
  setupEngine: () => Promise<void>
  installWsl: () => Promise<void>
  refreshDetectedAgents: () => Promise<void>
  startTerminalSession: (tool: TerminalTool, folder: string, model?: string) => Promise<TerminalSession | null>
  sendTerminalPrompt: (id: string, text: string) => Promise<void>
  stopTerminalSession: (id: string) => Promise<void>
  openTerminalSession: (id: string) => Promise<void>
  attachTerminal: (tool: TerminalTool, pid: number) => Promise<void>
  sendAttachedPrompt: (id: string, text: string) => Promise<void>
  retryAttachedPrimer: (id: string) => Promise<void>
  answerAttachedPermission: (id: string, key: string, option: string) => Promise<void>
  stopAttachedTerminal: (id: string) => Promise<void>
  importSkill: (folder: string) => Promise<Skill[] | null>
  setSkillEnabled: (id: string, enabled: boolean) => Promise<Skill[] | null>
  removeSkill: (id: string) => Promise<Skill[] | null>
  installPlugin: (source: string) => Promise<Plugin[] | null>
  removePlugin: (id: string) => Promise<Plugin[] | null>
  createConnector: (input: {
    name: string
    transport: Connector['transport']
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
  }) => Promise<Connector[] | null>
  updateConnector: (
    id: string,
    patch: {
      name?: string
      transport?: Connector['transport']
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    }
  ) => Promise<Connector[] | null>
  deleteConnector: (id: string) => Promise<Connector[] | null>
  testConnector: (id: string) => Promise<string[] | null>
  importConnectorConfig: (path: string) => Promise<Connector[] | null>
}

function upsertTask(tasks: Task[], task: Task): Task[] {
  const list = [...tasks.filter((t) => t.id !== task.id), task]
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  return list
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id)
  if (index >= 0) {
    const copy = [...items]
    copy[index] = item
    return copy
  }
  return [...items, item]
}

/** A concrete, honest EngineStatus for when `engine.status` itself couldn't be reached (the engine
 *  service isn't constructed on this build yet, or the call otherwise failed) — so the setup panel
 *  always has something plain-language to show instead of silently rendering nothing forever.
 *  Never claims virtualization is off; that's a specific diagnosis we have no evidence for here. */
function engineUnreachableStatus(message: string): EngineStatus {
  return {
    ready: false,
    virtualization: true,
    steps: {
      wsl: { state: 'error', detail: message },
      distro: { state: 'missing', detail: 'Waiting for WSL to be ready first.' },
      docker: { state: 'missing', detail: 'Waiting for the deskmates-engine distro first.' },
      image: { state: 'missing', detail: 'Waiting for Docker to be ready first.' }
    }
  }
}

export const useStore = create<StoreState>()((set, get) => {
  const applyEvent = (event: CoreEvent): void => {
    const state = get()
    switch (event.type) {
      case 'task.item': {
        const timeline = state.timelines[event.taskId] ?? []
        set({ timelines: { ...state.timelines, [event.taskId]: upsertById(timeline, event.item) } })
        break
      }
      case 'task.timeline':
        set({ timelines: { ...state.timelines, [event.taskId]: event.timeline } })
        break
      case 'task.updated': {
        const tasks = state.tasksByProject[event.task.projectId] ?? []
        set({
          tasksByProject: {
            ...state.tasksByProject,
            [event.task.projectId]: upsertTask(tasks, event.task)
          }
        })
        break
      }
      case 'task.deleted': {
        const tasks = (state.tasksByProject[event.projectId] ?? []).filter((t) => t.id !== event.taskId)
        const timelines = { ...state.timelines }
        delete timelines[event.taskId]
        const changes = { ...state.changes }
        delete changes[event.taskId]
        set({
          tasksByProject: { ...state.tasksByProject, [event.projectId]: tasks },
          timelines,
          changes
        })
        break
      }
      case 'project.updated': {
        const projects = state.projects.filter((p) => p.id !== event.project.id)
        set({ projects: [...projects, event.project] })
        break
      }
      case 'project.deleted': {
        const projects = state.projects.filter((p) => p.id !== event.projectId)
        const tasksByProject = { ...state.tasksByProject }
        delete tasksByProject[event.projectId]
        set({ projects, tasksByProject })
        break
      }
      case 'changes.updated':
        set({ changes: { ...state.changes, [event.taskId]: event.changes } })
        break
      case 'memory.updated':
        set({ memories: { ...state.memories, [event.projectId]: event.memories } })
        break
      case 'settings.updated':
        set({ settings: event.settings })
        break
      case 'usage.updated':
        set({ usage: event.usage })
        break
      case 'notify':
        break
      case 'design.updated':
        // PreviewPane listens for this directly (it needs the design's own `source` and reload timing).
        break
      case 'design.show':
        set({ designFiles: { ...state.designFiles, [event.projectId]: event.path } })
        break
      case 'bot.updated':
        set({ bots: upsertById(state.bots, event.bot) })
        break
      case 'bot.deleted': {
        const bots = state.bots.filter((b) => b.id !== event.botId)
        const botPcs = { ...state.botPcs }
        delete botPcs[event.botId]
        const runsByBot = { ...state.runsByBot }
        delete runsByBot[event.botId]
        const schedulesByBot = { ...state.schedulesByBot }
        delete schedulesByBot[event.botId]
        // Handoffs aimed at the deleted bot are cascade-deleted on the core side; drop them here too so
        // the inbox never lists work for a bot that no longer exists.
        const handoffs = state.handoffs.filter((h) => h.toBotId !== event.botId)
        set({ bots, botPcs, runsByBot, schedulesByBot, handoffs })
        break
      }
      case 'pc.updated':
        set({ botPcs: { ...state.botPcs, [event.pc.botId]: event.pc } })
        break
      case 'engine.progress':
        set({ engineStatus: event.status })
        break
      case 'run.updated': {
        const list = state.runsByBot[event.run.botId] ?? []
        const next = upsertById(list, event.run).sort((a, b) => b.startedAt - a.startedAt)
        set({ runsByBot: { ...state.runsByBot, [event.run.botId]: next } })
        break
      }
      case 'run.item': {
        const items = state.runItemsByRun[event.runId] ?? []
        set({ runItemsByRun: { ...state.runItemsByRun, [event.runId]: upsertById(items, event.item) } })
        break
      }
      case 'schedule.updated': {
        const list = state.schedulesByBot[event.schedule.botId] ?? []
        set({ schedulesByBot: { ...state.schedulesByBot, [event.schedule.botId]: upsertById(list, event.schedule) } })
        break
      }
      case 'schedule.deleted': {
        const schedulesByBot: Record<string, Schedule[]> = {}
        for (const [botId, list] of Object.entries(state.schedulesByBot)) {
          schedulesByBot[botId] = list.filter((s) => s.id !== event.scheduleId)
        }
        set({ schedulesByBot })
        break
      }
      case 'handoff.updated':
        // Newest first, matching the repo's handoffs.list ordering.
        set({ handoffs: upsertById(state.handoffs, event.handoff).sort((a, b) => b.createdAt - a.createdAt) })
        break
      case 'terminals.session.updated':
        set({ terminalSessions: upsertById(state.terminalSessions, event.session) })
        break
      case 'terminals.session.item': {
        const items = state.terminalItemsBySession[event.sessionId] ?? []
        set({ terminalItemsBySession: { ...state.terminalItemsBySession, [event.sessionId]: [...items, event.item] } })
        break
      }
      case 'terminals.attach.updated':
        set({ attachedTerminalSessions: upsertById(state.attachedTerminalSessions, event.session) })
        break
      case 'skills.updated':
        set({ skills: event.skills })
        break
      case 'plugins.updated':
        set({ plugins: event.plugins })
        break
      case 'connectors.updated':
        set({ connectors: event.connectors })
        break
      case 'computer.updated':
        set({ computerSession: event.session })
        break
    }
  }

  const loadAll = async (): Promise<void> => {
    try {
      const [appInfo, settings, projects, keyStatus, usage] = await Promise.all([
        core.call('app.info', {}),
        core.call('settings.get', {}),
        core.call('projects.list', {}),
        window.deskmates.secrets.status(),
        core.call('usage.list', {})
      ])
      const tasksByProject: Record<string, Task[]> = {}
      await Promise.all(
        projects.map(async (project) => {
          const tasks = await core.call('tasks.list', { projectId: project.id })
          tasks.sort((a, b) => b.updatedAt - a.updatedAt)
          tasksByProject[project.id] = tasks
        })
      )
      set({ appInfo, settings, projects, keyStatus, usage, tasksByProject })
    } catch (error) {
      console.error('[renderer] initial load failed', error)
    }
  }

  // Kept separate from loadAll(): a bots-related RPC failing (e.g. the engine service not wired up
  // yet) must never block the Work/Design tabs from loading.
  //
  // The four calls below are settled independently rather than bundled in one Promise.all: on a
  // machine where the engine/PC services aren't constructed yet, `engine.status` rejects (a plain
  // "Bot PCs aren't set up on this computer yet." Error) while `bots.list`, `pcs.list` and
  // `pcs.mode.get` succeed normally. Bundling them meant that one expected rejection wiped out every
  // other result — bots and the PC mode switch never loaded, and engineStatus stayed null forever,
  // which the setup wizard treats as "not checked yet" and renders nothing at all.
  const loadBots = async (): Promise<void> => {
    const [botsResult, pcsResult, pcModeResult, engineResult, handoffsResult] = await Promise.allSettled([
      core.call('bots.list', {}),
      core.call('pcs.list', {}),
      core.call('pcs.mode.get', {}),
      core.call('engine.status', {}),
      core.call('handoffs.list', {})
    ])

    const next: Partial<StoreState> = {}

    if (botsResult.status === 'fulfilled') {
      next.bots = botsResult.value
    } else {
      console.error('[renderer] bots.list failed', botsResult.reason)
    }

    if (pcsResult.status === 'fulfilled') {
      const botPcs: Record<string, BotPc> = {}
      for (const pc of pcsResult.value) botPcs[pc.botId] = pc
      next.botPcs = botPcs
    } else {
      console.error('[renderer] pcs.list failed', pcsResult.reason)
    }

    if (pcModeResult.status === 'fulfilled') {
      next.pcMode = pcModeResult.value
    } else {
      console.error('[renderer] pcs.mode.get failed', pcModeResult.reason)
    }

    if (engineResult.status === 'fulfilled') {
      next.engineStatus = engineResult.value
    } else {
      console.error('[renderer] engine.status failed', engineResult.reason)
      const message = engineResult.reason instanceof Error ? engineResult.reason.message : String(engineResult.reason)
      next.engineStatus = engineUnreachableStatus(message)
    }

    if (handoffsResult.status === 'fulfilled') {
      next.handoffs = handoffsResult.value
    } else {
      console.error('[renderer] handoffs.list failed', handoffsResult.reason)
    }

    set(next)
  }

  // Same reasoning as loadBots: terminals.* rejecting (the service not wired up on this build) must
  // never block the rest of the app from loading.
  const loadTerminals = async (): Promise<void> => {
    const [detectedResult, sessionsResult, attachedResult] = await Promise.allSettled([
      core.call('terminals.detect', {}),
      core.call('terminals.sessions.list', {}),
      core.call('terminals.attach.list', {})
    ])
    const next: Partial<StoreState> = {}
    if (detectedResult.status === 'fulfilled') next.detectedAgents = detectedResult.value
    else console.error('[renderer] terminals.detect failed', detectedResult.reason)
    if (sessionsResult.status === 'fulfilled') next.terminalSessions = sessionsResult.value
    else console.error('[renderer] terminals.sessions.list failed', sessionsResult.reason)
    if (attachedResult.status === 'fulfilled') next.attachedTerminalSessions = attachedResult.value
    else console.error('[renderer] terminals.attach.list failed', attachedResult.reason)
    set(next)
  }

  // Same reasoning as above: skills.* and plugins.* can reject before the extensions services are
  // wired up on this build, and must never block the rest of the app from loading.
  const loadExtras = async (): Promise<void> => {
    const [skillsResult, pluginsResult, connectorsResult] = await Promise.allSettled([
      core.call('skills.list', {}),
      core.call('plugins.list', {}),
      core.call('connectors.list', {})
    ])
    const next: Partial<StoreState> = {}
    if (skillsResult.status === 'fulfilled') next.skills = skillsResult.value
    else console.error('[renderer] skills.list failed', skillsResult.reason)
    if (pluginsResult.status === 'fulfilled') next.plugins = pluginsResult.value
    else console.error('[renderer] plugins.list failed', pluginsResult.reason)
    if (connectorsResult.status === 'fulfilled') next.connectors = connectorsResult.value
    else console.error('[renderer] connectors.list failed', connectorsResult.reason)
    set(next)
  }

  const initialTab = readStoredTab()
  const initialView: View =
    initialTab === 'design'
      ? { name: 'design-home' }
      : initialTab === 'bots'
        ? { name: 'bots-home' }
        : initialTab === 'agents'
          ? { name: 'agents-home' }
          : initialTab === 'extras'
            ? { name: 'extras-home' }
            : { name: 'home' }

  return {
    started: false,
    status: 'connecting',
    appInfo: null,
    settings: null,
    projects: [],
    tasksByProject: {},
    timelines: {},
    changes: {},
    memories: {},
    keyStatus: [],
    models: {},
    usage: [],
    tab: initialTab,
    workView: { name: 'home' },
    designView: { name: 'design-home' },
    botsView: { name: 'bots-home' },
    agentsView: { name: 'agents-home' },
    extrasView: { name: 'extras-home' },
    settingsReturn: null,
    view: initialView,
    toast: null,
    bots: [],
    botPcs: {},
    runsByBot: {},
    runItemsByRun: {},
    schedulesByBot: {},
    handoffs: [],
    skills: [],
    plugins: [],
    connectors: [],
    engineStatus: null,
    pcMode: null,
    wslInstallOutcome: null,
    wslInstalling: false,
    detectedAgents: [],
    terminalSessions: [],
    terminalItemsBySession: {},
    attachedTerminalSessions: [],
    computerSession: null,
    designFiles: {},

    init: () => {
      const state = get()
      if (state.started) return
      set({ started: true })
      core.onEvent(applyEvent)
      core.onStatus((status) => {
        set({ status })
        if (status === 'open') {
          void loadAll()
          void loadBots()
          void loadTerminals()
          void loadExtras()
        }
      })
      void core.connect()
    },

    navigate: (view) => {
      const current = get().view
      if (view.name === 'settings' && current.name !== 'settings') set({ settingsReturn: current })
      else if (view.name !== 'settings') set({ settingsReturn: null })
      set({ view })
      if (view.name === 'task') void get().openTask(view.projectId, view.taskId)
      if (view.name === 'project-settings') void get().openProjectSettings(view.projectId)
      if (view.name === 'design') void get().openDesign(view.projectId)
      if (view.name === 'bot') void get().openBot(view.botId)
      if (view.name === 'agents-session') void get().openTerminalSession(view.sessionId)
    },

    setTab: (tab) => {
      const state = get()
      // Agents can install connectors, skills and plugins, so the lists are reread on every visit.
      if (tab === 'extras') void loadExtras()
      // Leaving Settings (by switching tabs, or clicking the tab it was opened from) closes it.
      const leaving = state.view.name === 'settings' ? (state.settingsReturn ?? TAB_HOMES[state.tab]) : state.view
      if (tab === state.tab) {
        if (state.view.name === 'settings') get().navigate(leaving)
        return
      }
      const saved: Record<Tab, View> = {
        work: state.workView,
        design: state.designView,
        bots: state.botsView,
        agents: state.agentsView,
        extras: state.extrasView
      }
      saved[state.tab] = leaving
      const next = saved[tab].name === 'settings' ? TAB_HOMES[tab] : saved[tab]
      set({
        tab,
        view: next,
        settingsReturn: null,
        workView: saved.work,
        designView: saved.design,
        botsView: saved.bots,
        agentsView: saved.agents,
        extrasView: saved.extras
      })
      storeTab(tab)
    },

    showToast: (message, action) => set({ toast: { message, action } }),
    clearToast: () => set({ toast: null }),

    createProject: async (name, folder) => {
      const project = await core.call('projects.create', { name, folder })
      set({ projects: upsertById(get().projects, project) })
      get().navigate({ name: 'project', projectId: project.id })
      return project
    },

    createTask: async (projectId) => {
      try {
        const task = await core.call('tasks.create', { projectId })
        const tasks = get().tasksByProject[projectId] ?? []
        set({ tasksByProject: { ...get().tasksByProject, [projectId]: upsertTask(tasks, task) } })
        return task
      } catch (error) {
        get().showToast(`Couldn't create the task: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    openTask: async (projectId, taskId) => {
      try {
        const { task, timeline } = await core.call('tasks.get', { id: taskId })
        const changes = await core.call('changes.list', { taskId })
        const tasks = get().tasksByProject[projectId] ?? []
        set({
          tasksByProject: { ...get().tasksByProject, [projectId]: upsertTask(tasks, task) },
          timelines: { ...get().timelines, [taskId]: timeline },
          changes: { ...get().changes, [taskId]: changes }
        })
      } catch (error) {
        get().showToast(`Couldn't open the task: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    openProjectSettings: async (projectId) => {
      try {
        const memories = await core.call('memory.list', { projectId })
        set({ memories: { ...get().memories, [projectId]: memories } })
      } catch (error) {
        get().showToast(`Couldn't load project settings: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    loadModels: async (provider) => {
      const models = await core.call('models.list', { provider })
      set({ models: { ...get().models, [provider]: models } })
      return models
    },

    setKeyStatus: (keys) => set({ keyStatus: keys }),

    addMemory: async (projectId, content) => {
      try {
        const memories = await core.call('memory.add', { projectId, content })
        set({ memories: { ...get().memories, [projectId]: memories } })
        return memories
      } catch (error) {
        get().showToast(`Couldn't save the memory: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    deleteMemory: async (id, projectId) => {
      try {
        const memories = await core.call('memory.delete', { id, projectId })
        set({ memories: { ...get().memories, [projectId]: memories } })
        return memories
      } catch (error) {
        get().showToast(`Couldn't forget the memory: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    createDesign: async (name, prompt) => {
      try {
        const { project, task } = await core.call('designs.create', { name, prompt })
        const tasks = get().tasksByProject[project.id] ?? []
        set({
          projects: upsertById(get().projects, project),
          tasksByProject: { ...get().tasksByProject, [project.id]: upsertTask(tasks, task) }
        })
        return { project, task }
      } catch (error) {
        get().showToast(`Couldn't start the design: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    openDesign: async (projectId) => {
      const tasks = get().tasksByProject[projectId] ?? []
      const latest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (latest) await get().openTask(projectId, latest.id)
    },

    setDesignFile: (projectId, path) => {
      set({ designFiles: { ...get().designFiles, [projectId]: path } })
    },

    createBot: async (name, instructions) => {
      try {
        const bot = await core.call('bots.create', instructions ? { name, instructions } : { name })
        set({ bots: upsertById(get().bots, bot) })
        return bot
      } catch (error) {
        get().showToast(`Couldn't create the bot: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    deleteBot: async (id) => {
      try {
        // Matches the confirmation dialog ("This removes the bot, its runs and its memory."): the
        // PC and its storage — including the browser profile and any signed-in WhatsApp session —
        // come out too. A failed teardown (engine down, PCs never set up on this machine) no longer
        // blocks deleting the bot record itself; the handler deletes it regardless and reports what
        // was left behind in pcWarning, so nothing is silently orphaned.
        const { pcWarning } = await core.call('bots.delete', { id, deletePc: true })
        if (pcWarning) get().showToast(pcWarning)
        return true
      } catch (error) {
        get().showToast(`Couldn't delete the bot: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },

    openBot: async (botId) => {
      try {
        const [runs, schedules] = await Promise.all([
          core.call('runs.list', { botId }),
          core.call('schedules.list', { botId })
        ])
        set({
          runsByBot: { ...get().runsByBot, [botId]: runs },
          schedulesByBot: { ...get().schedulesByBot, [botId]: schedules }
        })
      } catch (error) {
        get().showToast(`Couldn't load the bot: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    openRun: async (runId) => {
      try {
        const items = await core.call('runs.items', { runId })
        set({ runItemsByRun: { ...get().runItemsByRun, [runId]: items } })
      } catch (error) {
        get().showToast(`Couldn't load the run: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    setupEngine: async () => {
      try {
        const status = await core.call('engine.setup', {})
        set({ engineStatus: status })
      } catch (error) {
        get().showToast(`Couldn't continue setup: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    installWsl: async () => {
      set({ wslInstalling: true, wslInstallOutcome: null })
      try {
        const outcome = await window.deskmates.engine.installWsl()
        set({ wslInstallOutcome: outcome })
      } catch (error) {
        set({ wslInstallOutcome: { outcome: 'error', message: error instanceof Error ? error.message : String(error) } })
      } finally {
        set({ wslInstalling: false })
      }
    },

    refreshDetectedAgents: async () => {
      try {
        const detectedAgents = await core.call('terminals.detect', {})
        set({ detectedAgents })
      } catch (error) {
        console.error('[renderer] terminals.detect failed', error)
      }
    },

    startTerminalSession: async (tool, folder, model) => {
      try {
        const session = await core.call('terminals.sessions.start', model ? { tool, folder, model } : { tool, folder })
        set({ terminalSessions: upsertById(get().terminalSessions, session) })
        get().navigate({ name: 'agents-session', sessionId: session.id })
        return session
      } catch (error) {
        get().showToast(`Couldn't start the session: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    sendTerminalPrompt: async (id, text) => {
      try {
        await core.call('terminals.sessions.send', { id, text })
      } catch (error) {
        get().showToast(`Couldn't send the prompt: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    stopTerminalSession: async (id) => {
      try {
        await core.call('terminals.sessions.stop', { id })
      } catch (error) {
        get().showToast(`Couldn't stop the session: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    openTerminalSession: async (id) => {
      try {
        const items = await core.call('terminals.sessions.items', { id })
        set({ terminalItemsBySession: { ...get().terminalItemsBySession, [id]: items } })
      } catch (error) {
        get().showToast(`Couldn't load the session: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    attachTerminal: async (tool, pid) => {
      try {
        const session = await core.call('terminals.attach', { pid, tool })
        set({ attachedTerminalSessions: upsertById(get().attachedTerminalSessions, session) })
        get().navigate({ name: 'agents-attach', sessionId: session.id })
      } catch (error) {
        get().showToast(`Couldn't attach to the terminal: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    sendAttachedPrompt: async (id, text) => {
      try {
        await core.call('terminals.attach.send', { id, text })
      } catch (error) {
        get().showToast(`Couldn't send the prompt: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    retryAttachedPrimer: async (id) => {
      try {
        await core.call('terminals.attach.retry', { id })
      } catch (error) {
        get().showToast(`Couldn't retry the check-in: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    answerAttachedPermission: async (id, key, option) => {
      try {
        await core.call('terminals.attach.answer', { id, key, option })
      } catch (error) {
        get().showToast(`Couldn't answer the agent: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    stopAttachedTerminal: async (id) => {
      try {
        await core.call('terminals.attach.stop', { id })
      } catch (error) {
        get().showToast(`Couldn't detach from the terminal: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    importSkill: async (folder) => {
      try {
        const skills = await core.call('skills.import', { folder })
        set({ skills })
        return skills
      } catch (error) {
        get().showToast(`Couldn't import the skill: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    setSkillEnabled: async (id, enabled) => {
      try {
        const skills = await core.call('skills.setEnabled', { id, enabled })
        set({ skills })
        return skills
      } catch (error) {
        get().showToast(`Couldn't update the skill: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    removeSkill: async (id) => {
      try {
        const skills = await core.call('skills.remove', { id })
        set({ skills })
        return skills
      } catch (error) {
        get().showToast(`Couldn't remove the skill: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    installPlugin: async (source) => {
      try {
        const plugins = await core.call('plugins.install', { source })
        set({ plugins })
        return plugins
      } catch (error) {
        get().showToast(`Couldn't install the plugin: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    removePlugin: async (id) => {
      try {
        const plugins = await core.call('plugins.remove', { id })
        set({ plugins })
        return plugins
      } catch (error) {
        get().showToast(`Couldn't remove the plugin: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    createConnector: async (input) => {
      try {
        const connectors = await core.call('connectors.create', input)
        set({ connectors })
        return connectors
      } catch (error) {
        get().showToast(`Couldn't add the connector: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    updateConnector: async (id, patch) => {
      try {
        const connectors = await core.call('connectors.update', { id, ...patch })
        set({ connectors })
        return connectors
      } catch (error) {
        get().showToast(`Couldn't update the connector: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    deleteConnector: async (id) => {
      try {
        const connectors = await core.call('connectors.delete', { id })
        set({ connectors })
        return connectors
      } catch (error) {
        get().showToast(`Couldn't remove the connector: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    testConnector: async (id) => {
      try {
        return await core.call('connectors.test', { id })
      } catch (error) {
        get().showToast(error instanceof Error ? error.message : String(error))
        return null
      }
    },

    importConnectorConfig: async (path) => {
      try {
        const connectors = await core.call('connectors.import', { path })
        set({ connectors })
        return connectors
      } catch (error) {
        get().showToast(`Couldn't import the config: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }
  }
})