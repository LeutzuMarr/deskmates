import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomInt, randomUUID } from 'node:crypto'
import { basename, join, resolve, sep } from 'node:path'
import { designFolder, listDesignFiles, readDesign, starterHtml, writeDesign } from '../designs/files'
import type { EngineService, PcService, RunService, ScheduleService } from '../bots/services'
import { BOT_TEMPLATES, createBotFromTemplate } from '../bots/templates'
import type { EventBus } from '../events'
import type { ChangeLog } from '../fs/change-log'
import { projectInstructionsPath } from '../engine/instructions'
import type { TaskRunner } from '../engine/runner'
import type { KeyStore } from '../models/keys'
import type { ModelService } from '../models/providers'
import type { Handler, Handlers, HandlerContext } from './rpc-server'
import type { Repos } from '../store/repos'
import type { TerminalsService } from '../terminals/service'
import type {
  ConnectorTransport,
  DesignChangeSource,
  ModelRef,
  PcMode,
  PhoneInfo,
  ProviderId,
  RpcMethod,
  Settings
} from '../../shared/protocol'
import { generatePairingCode, isValidPairingCode } from '../phone/server'
import type { PluginsService } from '../extensions/plugins'
import type { SkillsService } from '../extensions/skills'
import type { McpConnectorManager } from '../connectors'
import type { ComputerUseService } from '../computer/service'

/** Shown to the user when a bots/pcs/engine call needs the PC host or engine machinery and it isn't wired up yet. */
const PC_NOT_SET_UP = "Bot PCs aren't set up on this computer yet."
/** Shown when a run-related call needs the bot runner and it isn't wired up yet. */
const RUNS_NOT_SET_UP = "Bot runs aren't set up on this computer yet."
/** Shown when a terminals.* call needs detection/managed mode and it isn't wired up yet. */
const TERMINALS_NOT_SET_UP = "Terminal agents aren't set up on this computer yet."
/** Shown when a skills/plugins.* call needs the extensions machinery and it isn't wired up yet. */
const SKILLS_NOT_SET_UP = "Skills and plugins aren't set up on this computer yet."
/** Shown when a connectors.* call needs the MCP machinery and it isn't wired up yet. */
const CONNECTORS_NOT_SET_UP = "Connectors aren't set up on this computer yet."
/** Shown when phone access (spec 5.12) isn't wired up yet. */
const PHONE_NOT_SET_UP = "Phone access isn't set up on this computer yet."
/** CPU cap given to a bot's PC when creating it; not user-configurable (BotPc has no cpuLimit field). */
const DEFAULT_PC_CPU_LIMIT = 2

export interface HandlerServices {
  repos: Repos
  bus: EventBus
  runner: TaskRunner
  changes: ChangeLog
  models: ModelService
  keys: KeyStore
  version: string
  dataDir: string
  /** Where connected agents find the guide and the deskmates command; set once the agent kit is wired up. */
  agentKit?: { guidePath: string; commandPath: string }
  /** Called after designs.save writes the file, so the designs-folder watcher can ignore its own write. */
  onDesignWritten?: (projectId: string, updatedAt: number) => void
  /** Detects and sets up the WSL engine. Absent until that task is wired up; engine.* answers with PC_NOT_SET_UP until then. */
  engine?: EngineService
  /** Creates, runs and talks to bot PCs. Absent until that task is wired up; pcs.start/stop/reset/endpoints answer with PC_NOT_SET_UP until then. */
  pc?: PcService
  /** Runs a bot's task end to end. Absent until that task is wired up; bots.run/stopRun and runs.items answer with RUNS_NOT_SET_UP until then. */
  run?: RunService
  /** Cron parsing and wake-timer registration. Absent until that task is wired up; schedule CRUD still works, but nextRunAt stays null. */
  schedule?: ScheduleService
  /** Terminal-agent detection and managed mode. Absent until that task is wired up; terminals.* answers with TERMINALS_NOT_SET_UP until then. */
  terminals?: TerminalsService
  /** Skills and plugins (spec 5.5). Absent until that task is wired up; skills and plugins RPC methods answer with SKILLS_NOT_SET_UP until then. */
  skills?: SkillsService
  plugins?: PluginsService
  /** MCP connectors (spec 5.6). Absent until that task is wired up; connectors.* answers with CONNECTORS_NOT_SET_UP until then. */
  connectors?: McpConnectorManager
  /** Phone (LAN) access state (spec 5.12). Absent until that task is wired up; phone.info answers with PHONE_NOT_SET_UP. */
  phone?: { info(): PhoneInfo }
  /** Computer use (Agents tab): a model driving the user's own mouse and keyboard. */
  computer?: ComputerUseService
}

/** Implements every method of RpcMethods. Handlers emit bus events the UI listens to. */
export function createHandlers(services: HandlerServices): Handlers {
  const { repos, bus, runner, changes, models, keys, version, dataDir, agentKit, onDesignWritten } = services

  const requireDesign = (projectId: string) => {
    const project = repos.projects.require(projectId)
    if (project.kind !== 'design') throw new Error("That project isn't a design.")
    return project
  }

  const requireBotName = (raw: string): string => {
    const name = raw.trim()
    if (!name) throw new Error("The bot's name can't be empty.")
    if (name.length > 120) throw new Error("The bot's name can't be longer than 120 characters.")
    return name
  }

  /** Removes a design's generated folder, but only when it lives under <dataDir>/designs. */
  const removeDesignFolder = (folder: string): void => {
    let target = resolve(folder)
    let root = resolve(dataDir, 'designs')
    try {
      target = realpathSync.native(target)
      root = realpathSync.native(root)
    } catch {
      return
    }
    if (target === root || target.startsWith(root + sep)) rmSync(target, { recursive: true, force: true })
  }

  /** After an assistant change to a design's files, tell the preview to reload. */
  const emitDesignUpdated = (taskId: string): void => {
    const task = repos.tasks.get(taskId)
    if (!task) return
    const project = repos.projects.get(task.projectId)
    if (project?.kind === 'design') {
      bus.emit({ type: 'design.updated', projectId: project.id, updatedAt: Date.now(), source: 'assistant' })
    }
  }

  const handlers: { [M in RpcMethod]: Handler } = {
    'app.info': async () => ({
      version,
      dataDir,
      keys: keys.providers(),
      agentKit: agentKit ?? { guidePath: '', commandPath: '' }
    }),

    'settings.get': () => repos.settings.get(),

    'settings.update': (patch: Partial<Settings>) => {
      if (patch.maxSteps !== undefined) {
        if (!Number.isInteger(patch.maxSteps) || patch.maxSteps < 1 || patch.maxSteps > 200) {
          throw new Error('maxSteps must be a whole number between 1 and 200.')
        }
      }
      if (patch.phoneAccess !== undefined && typeof patch.phoneAccess !== 'boolean') {
        throw new Error('phoneAccess must be true or false.')
      }
      if (patch.pcHost !== undefined && patch.pcHost !== 'local' && patch.pcHost !== 'cloud') {
        throw new Error("pcHost must be 'local' or 'cloud'.")
      }
      if (patch.pcConnection !== undefined && patch.pcConnection !== null) {
        const con = patch.pcConnection
        if (typeof con !== 'object' || Array.isArray(con)) {
          throw new Error('pcConnection must be a connection object or null.')
        }
        for (const key of ['endpoint', 'tlsCertPath', 'tlsKeyPath', 'tlsCaPath', 'registryUsername', 'registryPassword'] as const) {
          if (typeof con[key] !== 'string') throw new Error(`pcConnection.${key} must be a string.`)
        }
      }
      const merged = { ...repos.settings.get(), ...patch }
      if (merged.pairingCode !== '' && !isValidPairingCode(merged.pairingCode)) {
        throw new Error('The pairing code must be exactly 6 digits.')
      }
      // Turning phone access on, or asking to regenerate (the UI sends an empty code), always
      // lands on a fresh six-digit code — the code doubles as the phone server's token.
      if (merged.phoneAccess && !isValidPairingCode(merged.pairingCode)) {
        merged.pairingCode = generatePairingCode()
      }
      const settings = repos.settings.update(merged)
      bus.emit({ type: 'settings.updated', settings })
      return settings
    },

    'phone.info': (): PhoneInfo => {
      if (!services.phone) throw new Error(PHONE_NOT_SET_UP)
      return services.phone.info()
    },

    'models.list': (params: { provider: ProviderId }) => models.listModels(params.provider),
    'models.check': (params: ModelRef) => models.checkModel({ provider: params.provider, modelId: params.modelId }),

    'projects.list': () => repos.projects.list(),

    'projects.create': (params: { name: string; folder: string }) => {
      if (!existsSync(params.folder) || !statSync(params.folder).isDirectory()) {
        throw new Error('That folder doesn\'t exist.')
      }
      const folder = realpathSync.native(params.folder)
      const name = params.name.trim() || basename(folder)
      const duplicate = repos.projects.list().some((project) => project.folder === folder)
      if (duplicate) {
        throw new Error('This folder is already a project.')
      }
      const project = repos.projects.create(name, folder)
      bus.emit({ type: 'project.updated', project })
      return project
    },

    'projects.update': (params: { id: string; name?: string; model?: ModelRef | null }) => {
      const project = repos.projects.update(params.id, { name: params.name, model: params.model })
      bus.emit({ type: 'project.updated', project })
      return project
    },

    'projects.delete': async (params: { id: string }) => {
      const project = repos.projects.require(params.id)
      const tasks = repos.tasks.list(params.id)
      for (const task of tasks) {
        runner.stop(task.id)
        await runner.whenIdle(task.id)
        changes.discard(task.id)
      }
      repos.projects.delete(params.id)
      if (project.kind === 'design') removeDesignFolder(project.folder)
      bus.emit({ type: 'project.deleted', projectId: params.id })
      return null
    },

    'projects.instructions.get': (params: { id: string }) => {
      const project = repos.projects.require(params.id)
      const path = projectInstructionsPath(project.folder)
      const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
      return { path, content }
    },

    'projects.instructions.set': (params: { id: string; content: string }) => {
      const project = repos.projects.require(params.id)
      const path = projectInstructionsPath(project.folder)
      mkdirSync(project.folder, { recursive: true })
      writeFileSync(path, params.content)
      return null
    },

    'tasks.list': (params: { projectId: string }) => repos.tasks.list(params.projectId),

    'tasks.create': (params: { projectId: string }) => {
      repos.projects.require(params.projectId)
      const task = repos.tasks.create(params.projectId)
      bus.emit({ type: 'task.updated', task })
      return task
    },

    'tasks.get': (params: { id: string }) => {
      const task = repos.tasks.require(params.id)
      return { task, timeline: runner.timeline(params.id) }
    },

    'tasks.rename': (params: { id: string; title: string }) => {
      const title = params.title.trim()
      if (!title) throw new Error('The task title can\'t be empty.')
      if (title.length > 120) throw new Error('The task title can\'t be longer than 120 characters.')
      const task = repos.tasks.update(params.id, { title })
      bus.emit({ type: 'task.updated', task })
      return task
    },

    'tasks.delete': async (params: { id: string }) => {
      const task = repos.tasks.require(params.id)
      runner.stop(params.id)
      await runner.whenIdle(params.id)
      repos.tasks.delete(params.id)
      changes.discard(params.id)
      bus.emit({ type: 'task.deleted', taskId: params.id, projectId: task.projectId })
      return null
    },

    'tasks.send': (params: { id: string; text: string }) => runner.send(params.id, params.text),

    'tasks.stop': (params: { id: string }) => {
      runner.stop(params.id)
      return null
    },

    'approvals.respond': (params: { taskId: string; approvalId: string; approved: boolean; always?: boolean }) =>
      runner.respond(params.taskId, params.approvalId, params.approved, params.always),

    'changes.list': (params: { taskId: string }) => repos.changes.list(params.taskId),

    'changes.undo': (params: { id: string }) => {
      const record = changes.undo(params.id)
      const list = repos.changes.list(record.taskId)
      bus.emit({ type: 'changes.updated', taskId: record.taskId, changes: list })
      emitDesignUpdated(record.taskId)
      return list
    },

    'changes.undoAll': (params: { taskId: string }) => {
      changes.undoAll(params.taskId)
      const list = repos.changes.list(params.taskId)
      bus.emit({ type: 'changes.updated', taskId: params.taskId, changes: list })
      emitDesignUpdated(params.taskId)
      return list
    },

    'memory.list': (params: { projectId: string }) => repos.memories.list(params.projectId),

    'memory.add': (params: { projectId: string; content: string }) => {
      const content = params.content.trim()
      if (!content) throw new Error('The memory can\'t be empty.')
      repos.memories.add(params.projectId, content)
      const memories = repos.memories.list(params.projectId)
      bus.emit({ type: 'memory.updated', projectId: params.projectId, memories })
      return memories
    },

    'memory.delete': (params: { id: string; projectId: string }) => {
      repos.memories.delete(params.id, params.projectId)
      const memories = repos.memories.list(params.projectId)
      bus.emit({ type: 'memory.updated', projectId: params.projectId, memories })
      return memories
    },

    'usage.list': () => repos.usage.list(),

    'designs.create': async (params: { name: string; prompt?: string }) => {
      const name = params.name.trim()
      if (!name || name.length > 120) throw new Error('Give the design a name (up to 120 characters).')
      const id = randomUUID()
      const folder = designFolder(dataDir, id)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'index.html'), starterHtml(name))
      const project = repos.projects.create(name, folder, 'design', id)
      bus.emit({ type: 'project.updated', project })
      const task = repos.tasks.create(project.id)
      bus.emit({ type: 'task.updated', task })
      if (params.prompt?.trim()) {
        void runner.send(task.id, params.prompt.trim()).catch(() => {})
      }
      return { project, task: repos.tasks.require(task.id) }
    },

    'designs.read': (params: { projectId: string }) => {
      const project = requireDesign(params.projectId)
      return readDesign(project.folder)
    },

    'designs.files': (params: { projectId: string }) => listDesignFiles(requireDesign(params.projectId).folder),

    'designs.save': (
      params: { projectId: string; html: string; reason: string; path?: string },
      context: HandlerContext = { caller: 'app' }
    ) => {
      const project = requireDesign(params.projectId)
      const running = repos.tasks.list(project.id).some((task) => runner.isRunning(task.id))
      if (running) {
        throw new Error("The assistant is changing this design right now. Try again when it's done.")
      }
      const updatedAt = writeDesign(project.folder, params.html, params.path)
      const source: DesignChangeSource = context.caller === 'agent' ? 'external' : 'editor'
      bus.emit({ type: 'design.updated', projectId: project.id, updatedAt, source })
      onDesignWritten?.(project.id, updatedAt)
      return { updatedAt }
    },

    // ---- Bots ----

    'bots.list': () => repos.bots.list(),

    'bots.create': (params: { name: string; instructions?: string; model?: ModelRef | null }) => {
      const name = requireBotName(params.name)
      const bot = repos.bots.create(name, params.instructions ?? '', params.model ?? null)
      const pc = repos.botPcs.create(bot.id)
      bus.emit({ type: 'bot.updated', bot })
      bus.emit({ type: 'pc.updated', pc })
      return bot
    },

    'bots.update': (params: {
      id: string
      name?: string
      instructions?: string
      model?: ModelRef | null
      avatar?: string | null
      autoApprove?: string[]
    }) => {
      const name = params.name !== undefined ? requireBotName(params.name) : undefined
      const bot = repos.bots.update(params.id, {
        name,
        instructions: params.instructions,
        model: params.model,
        avatar: params.avatar,
        autoApprove: params.autoApprove
      })
      bus.emit({ type: 'bot.updated', bot })
      return bot
    },

    'bots.delete': async (params: { id: string; deletePc?: boolean }) => {
      const bot = repos.bots.require(params.id)
      // Matches the confirmation dialog's own promise ("This removes the bot, its runs and its
      // memory."): the PC and its storage — including the browser profile and any signed-in
      // WhatsApp session — come out by default. A failed teardown (or bot PCs not being set up at
      // all) must never block deleting the bot record itself; it's reported back instead, so the
      // leftover container/files aren't silently forgotten.
      let pcWarning: string | null = null
      if (params.deletePc !== false) {
        if (!services.pc) {
          pcWarning = `${PC_NOT_SET_UP} If ${bot.name} ever had a PC, its container and files are still there.`
        } else {
          try {
            await services.pc.delete(bot.id)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            pcWarning = `Couldn't remove ${bot.name}'s PC and storage: ${message} Its container and files were left in place.`
          }
        }
      }
      // The bot's schedules get removed by the cascading delete below, which would leave their
      // Windows wake timers registered against machines that no longer exist. Unregister them
      // first, same as `schedules.delete` does — and, like a failed PC teardown, report a failure
      // without blocking the deletion itself.
      if (services.schedule) {
        for (const schedule of repos.schedules.list(bot.id)) {
          try {
            await services.schedule.unsync(schedule.id)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            pcWarning = pcWarning
              ? `${pcWarning} A wake timer couldn't be removed: ${message}`
              : `A wake timer couldn't be removed: ${message}`
          }
        }
      }
      repos.bots.delete(bot.id) // cascades to bot_pcs, schedules and runs
      bus.emit({ type: 'bot.deleted', botId: bot.id })
      return { pcWarning }
    },

    'bots.templates': () =>
      BOT_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        suggestedTime: template.suggestedTime,
        tools: template.tools,
        fields: template.fields
      })),

    'bots.createFromTemplate': async (params: { templateId: string; values: Record<string, string> }) => {
      const template = BOT_TEMPLATES.find((candidate) => candidate.id === params.templateId)
      if (!template) throw new Error("That bot template doesn't exist.")
      const missing = template.fields.filter((field) => field.required && !params.values[field.key]?.trim())
      if (missing.length > 0) throw new Error(`Fill in ${missing.map((field) => field.label.toLowerCase()).join(' and ')} first.`)
      const created = await createBotFromTemplate(
        { repos, dataDir, schedule: services.schedule, bus },
        template,
        params.values
      )
      return { bot: created.bot, schedule: created.schedule, warnings: created.warnings }
    },

    'bots.run': (params: { botId: string; task: string }) => {
      if (!services.run) throw new Error(RUNS_NOT_SET_UP)
      const bot = repos.bots.require(params.botId)
      const task = params.task.trim()
      if (!task) throw new Error("Tell the bot what to do.")
      const id = randomUUID()
      const run = repos.runs.create(bot.id, task, join(dataDir, 'runs', id), null, id)
      bus.emit({ type: 'run.updated', run })
      // Fires and forgets: the run service owns state transitions and error handling from here,
      // reporting progress through run.updated / run.item events (same pattern as designs.create).
      void services.run.start(run, bot).catch(() => {})
      return run
    },

    'bots.stopRun': async (params: { runId: string }) => {
      if (!services.run) throw new Error(RUNS_NOT_SET_UP)
      repos.runs.require(params.runId)
      await services.run.stop(params.runId)
      return null
    },

    'runs.list': (params: { botId?: string; limit?: number }) => repos.runs.list(params.botId, params.limit),

    'runs.items': async (params: { runId: string }) => {
      if (!services.run) throw new Error(RUNS_NOT_SET_UP)
      repos.runs.require(params.runId)
      return services.run.items(params.runId)
    },

    'runs.respond': async (params: { runId: string; approvalId: string; approved: boolean; always?: boolean }) => {
      if (!services.run) throw new Error(RUNS_NOT_SET_UP)
      repos.runs.require(params.runId)
      await services.run.respond(params.runId, params.approvalId, params.approved, params.always)
      return null
    },

    // ---- Bot PCs ----

    'pcs.list': () => repos.botPcs.list(),

    'pcs.start': async (params: { botId: string }) => {
      if (!services.pc) throw new Error(PC_NOT_SET_UP)
      const record = repos.botPcs.require(params.botId)
      const live =
        record.state === 'absent'
          ? await services.pc.create(params.botId, {
              memoryMb: record.memoryMb,
              cpuLimit: DEFAULT_PC_CPU_LIMIT,
              idleStopMinutes: record.idleStopMinutes
            })
          : await services.pc.start(params.botId)
      const pc = repos.botPcs.save(live)
      bus.emit({ type: 'pc.updated', pc })
      return pc
    },

    'pcs.stop': async (params: { botId: string }) => {
      if (!services.pc) throw new Error(PC_NOT_SET_UP)
      repos.botPcs.require(params.botId)
      const live = await services.pc.stop(params.botId)
      const pc = repos.botPcs.save(live)
      bus.emit({ type: 'pc.updated', pc })
      return pc
    },

    'pcs.reset': async (params: { botId: string }) => {
      if (!services.pc) throw new Error(PC_NOT_SET_UP)
      repos.botPcs.require(params.botId)
      const live = await services.pc.reset(params.botId)
      const pc = repos.botPcs.save(live)
      bus.emit({ type: 'pc.updated', pc })
      return pc
    },

    'pcs.update': (params: { botId: string; memoryMb?: number; idleStopMinutes?: number }) => {
      repos.botPcs.require(params.botId)
      if (params.memoryMb !== undefined && (!Number.isInteger(params.memoryMb) || params.memoryMb < 512 || params.memoryMb > 8192)) {
        throw new Error('Memory must be a whole number of megabytes between 512 and 8192.')
      }
      if (
        params.idleStopMinutes !== undefined &&
        (!Number.isInteger(params.idleStopMinutes) || params.idleStopMinutes < 0 || params.idleStopMinutes > 1440)
      ) {
        throw new Error('Idle stop time must be a whole number of minutes between 0 and 1440.')
      }
      const pc = repos.botPcs.updateSettings(params.botId, { memoryMb: params.memoryMb, idleStopMinutes: params.idleStopMinutes })
      services.pc?.updatePcOptions(params.botId, { memoryMb: params.memoryMb, idleStopMinutes: params.idleStopMinutes })
      bus.emit({ type: 'pc.updated', pc })
      return pc
    },

    'pcs.endpoints': async (params: { botId: string }) => {
      if (!services.pc) throw new Error(PC_NOT_SET_UP)
      repos.botPcs.require(params.botId)
      const endpoints = await services.pc.endpoints(params.botId)
      return endpoints ? { novnc: endpoints.novnc, agent: endpoints.agent, cdp: endpoints.cdp } : null
    },

    'pcs.mode.get': () => repos.settings.getPcMode(),

    'pcs.mode.set': (params: { mode: PcMode }) => {
      if (params.mode !== 'own' && params.mode !== 'shared') throw new Error("PC mode must be 'own' or 'shared'.")
      const mode = repos.settings.setPcMode(params.mode)
      services.pc?.setMode(mode)
      return mode
    },

    'pcs.takeOver': (params: { botId: string; on: boolean }) => {
      if (!services.run) throw new Error(RUNS_NOT_SET_UP)
      repos.botPcs.require(params.botId)
      services.run.setTakenOver(params.botId, params.on)
      return null
    },

    // ---- Engine ----

    'engine.status': async () => {
      if (!services.engine) throw new Error(PC_NOT_SET_UP)
      return services.engine.status()
    },

    'engine.setup': async () => {
      if (!services.engine) throw new Error(PC_NOT_SET_UP)
      return services.engine.setup((status) => bus.emit({ type: 'engine.progress', status }))
    },

    // ---- Schedules ----

    'schedules.list': (params: { botId?: string }) => repos.schedules.list(params.botId),

    'schedules.create': async (params: { botId: string; cron: string; task: string; missed?: 'run-late' | 'skip' }) => {
      repos.bots.require(params.botId)
      const cron = params.cron.trim()
      if (!cron) throw new Error('The schedule needs a cron expression.')
      const task = params.task.trim()
      if (!task) throw new Error('Tell the bot what to do on this schedule.')
      let schedule = repos.schedules.create(params.botId, cron, task, params.missed ?? 'run-late')
      if (services.schedule) {
        const { nextRunAt } = await services.schedule.sync(schedule)
        schedule = repos.schedules.update(schedule.id, { nextRunAt })
      }
      bus.emit({ type: 'schedule.updated', schedule })
      return schedule
    },

    'schedules.update': async (params: {
      id: string
      cron?: string
      task?: string
      enabled?: boolean
      missed?: 'run-late' | 'skip'
    }) => {
      const cron = params.cron !== undefined ? params.cron.trim() : undefined
      if (cron !== undefined && !cron) throw new Error('The schedule needs a cron expression.')
      const task = params.task !== undefined ? params.task.trim() : undefined
      if (task !== undefined && !task) throw new Error('Tell the bot what to do on this schedule.')
      let schedule = repos.schedules.update(params.id, { cron, task, enabled: params.enabled, missed: params.missed })
      if (services.schedule) {
        const { nextRunAt } = await services.schedule.sync(schedule)
        schedule = repos.schedules.update(schedule.id, { nextRunAt })
      }
      bus.emit({ type: 'schedule.updated', schedule })
      return schedule
    },

    'schedules.delete': async (params: { id: string }) => {
      repos.schedules.require(params.id)
      if (services.schedule) await services.schedule.unsync(params.id)
      repos.schedules.delete(params.id)
      bus.emit({ type: 'schedule.deleted', scheduleId: params.id })
      return null
    },

    // ---- Bot handoffs (spec 5.9) ----

    // Like schedules, handoffs are data whose lifecycle is owned elsewhere (the HandoffService in
    // main.ts); these two are read-only lookups over the stored rows.
    'handoffs.list': (params: { botId?: string }) => repos.handoffs.list(params.botId),

    'handoffs.item': (params: { id: string }) => repos.handoffs.require(params.id),

    // ---- Terminal agents ----

    'terminals.detect': async () => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      return services.terminals.detect()
    },

    'terminals.sessions.list': () => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      return services.terminals.list()
    },

    'terminals.sessions.start': (params: { tool: 'opencode' | 'agy'; folder: string; model?: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      if (!existsSync(params.folder) || !statSync(params.folder).isDirectory()) {
        throw new Error("That folder doesn't exist.")
      }
      return services.terminals.start(params.tool, realpathSync.native(params.folder), params.model)
    },

    'terminals.sessions.send': (params: { id: string; text: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      const text = params.text.trim()
      if (!text) throw new Error("Type a prompt first.")
      services.terminals.send(params.id, text)
      return null
    },

    'terminals.sessions.stop': (params: { id: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      services.terminals.stop(params.id)
      return null
    },

    'terminals.sessions.items': (params: { id: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      return services.terminals.items(params.id)
    },

    'terminals.attach': (params: { pid: number; tool: 'opencode' | 'agy' }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      if (!Number.isInteger(params.pid) || params.pid <= 0) throw new Error('That terminal id is invalid.')
      return services.terminals.attach(params.pid, params.tool)
    },

    'terminals.attach.list': () => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      return services.terminals.attachedList()
    },

    'terminals.attach.send': (params: { id: string; text: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      const text = params.text.trim()
      if (!text) throw new Error('Type a prompt first.')
      services.terminals.attachSend(params.id, text)
      return null
    },

    'terminals.attach.retry': (params: { id: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      services.terminals.attachRetry(params.id)
      return null
    },

    'terminals.attach.answer': (params: { id: string; key: string; option: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      if (typeof params.key !== 'string' || typeof params.option !== 'string') throw new Error('That answer is invalid.')
      services.terminals.attachAnswer(params.id, params.key, params.option)
      return null
    },

    'terminals.attach.stop': (params: { id: string }) => {
      if (!services.terminals) throw new Error(TERMINALS_NOT_SET_UP)
      services.terminals.attachStop(params.id)
      return null
    },

    // ---- Skills and plugins (spec 5.5) ----

    'skills.list': () => {
      if (!services.skills) throw new Error(SKILLS_NOT_SET_UP)
      return services.skills.list()
    },

    'skills.import': (params: { folder: string }) => {
      if (!services.skills) throw new Error(SKILLS_NOT_SET_UP)
      const skills = services.skills.import(params.folder)
      bus.emit({ type: 'skills.updated', skills })
      return skills
    },

    'skills.setEnabled': (params: { id: string; enabled: boolean }) => {
      if (!services.skills) throw new Error(SKILLS_NOT_SET_UP)
      const skills = services.skills.setEnabled(params.id, params.enabled)
      bus.emit({ type: 'skills.updated', skills })
      return skills
    },

    'skills.remove': (params: { id: string }) => {
      if (!services.skills) throw new Error(SKILLS_NOT_SET_UP)
      const skills = services.skills.remove(params.id)
      bus.emit({ type: 'skills.updated', skills })
      return skills
    },

    'plugins.list': () => {
      if (!services.plugins) throw new Error(SKILLS_NOT_SET_UP)
      return services.plugins.list()
    },

    'plugins.install': async (params: { source: string }) => {
      if (!services.plugins) throw new Error(SKILLS_NOT_SET_UP)
      const plugins = await services.plugins.install(params.source)
      bus.emit({ type: 'plugins.updated', plugins })
      bus.emit({ type: 'skills.updated', skills: services.skills?.list() ?? [] })
      return plugins
    },

    'plugins.remove': (params: { id: string }) => {
      if (!services.plugins) throw new Error(SKILLS_NOT_SET_UP)
      const plugins = services.plugins.remove(params.id)
      bus.emit({ type: 'plugins.updated', plugins })
      return plugins
    },

    // ---- MCP connectors (spec 5.6) ----
    'connectors.list': () => {
      if (!services.connectors) throw new Error(CONNECTORS_NOT_SET_UP)
      return services.connectors.list()
    },

    'connectors.create': (params: { name: string; transport: ConnectorTransport; command?: string; args?: string[]; url?: string; env?: Record<string, string>; enabled?: boolean }) => {
      if (!services.connectors) throw new Error(CONNECTORS_NOT_SET_UP)
      const connectors = services.connectors.create(params)
      bus.emit({ type: 'connectors.updated', connectors })
      return connectors
    },

    'connectors.update': (params: {
      id: string
      name?: string
      transport?: ConnectorTransport
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    }) => {
      if (!services.connectors) throw new Error(CONNECTORS_NOT_SET_UP)
      const connectors = services.connectors.update(params.id, params)
      bus.emit({ type: 'connectors.updated', connectors })
      return connectors
    },

    'connectors.delete': (params: { id: string }) => {
      if (!services.connectors) throw new Error(CONNECTORS_NOT_SET_UP)
      const connectors = services.connectors.remove(params.id)
      bus.emit({ type: 'connectors.updated', connectors })
      return connectors
    },

    'connectors.test': async (params: { id: string }) => {
      if (!services.connectors) throw new Error(CONNECTORS_NOT_SET_UP)
      return services.connectors.test(params.id)
    },

    'connectors.import': (params: { path: string }) => {
      if (!services.connectors) throw new Error(CONNECTORS_NOT_SET_UP)
      const connectors = services.connectors.importMcpConfig(params.path)
      bus.emit({ type: 'connectors.updated', connectors })
      return connectors
    },

    'computer.start': (params: { prompt: string; model?: ModelRef | null }) => {
      if (!services.computer) throw new Error('Computer use is not available.')
      return services.computer.start(params.prompt, params.model ?? null)
    },
    'computer.stop': () => services.computer?.stop() ?? null,
    'computer.get': () => services.computer?.current() ?? null
  }

  return handlers
}