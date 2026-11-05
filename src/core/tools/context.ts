import type { ModelRef, PlanItem } from '../../shared/protocol'
import type { ChangeLog } from '../fs/change-log'
import type { SkillsService } from '../extensions/skills'
import type { McpConnectorManager } from '../connectors'
import type { PluginsService } from '../extensions/plugins'
import type { SubagentRunner } from '../engine/subagents'
import type { MemoriesRepo } from '../store/repos'
import type { RenderClient } from '../render/types'
import type { BrowserService } from '../browser/service'
import type { TaskScheduler } from '../schedules/task-scheduler'

/** Everything a tool needs to act for one task. Built fresh for every run. */
export interface ToolContext {
  taskId: string
  projectId: string
  /** Absolute path of the project folder. */
  root: string
  changes: ChangeLog
  memories: MemoriesRepo
  /** The project's chosen model, so delegated children resolve the same one (spec 5.1). */
  modelRef: ModelRef
  /** The skills library, when skills are set up on this machine; absent otherwise. */
  skills?: SkillsService
  /** MCP connectors (spec 5.6); absent until that task is wired up, so runs get no connector tools then. */
  connectors?: McpConnectorManager
  /** The plugins library, for install_plugin; absent in tests and bots. */
  plugins?: PluginsService
  /** Sub-agent runner (spec 5.1); absent until wired up, so runs get no delegate tool then. */
  subagents?: SubagentRunner
  /** 'design' for Design tab projects, 'work' otherwise; decides which extra tool families a run gets. */
  projectKind?: 'work' | 'design'
  /** Renames the project (set_project_title). */
  renameProject?(title: string): void
  /** Opens a file from the design folder in the user's preview pane (show_to_user). */
  showInPreview?(path: string): void
  /** Sends `prompt` to this same task after a delay, if it is idle by then (ScheduleWakeup). */
  scheduleWakeup?(delayMs: number, prompt: string): void
  /** Offscreen page rendering in the host: screenshots, scripts, PDFs. Absent when there is no host. */
  render?: RenderClient
  /** The agent browser the user can watch from the title bar. Absent without the app. */
  browser?: BrowserService
  /** Who is acting, as the user reads it in browser questions: "Work", "Design", or a scheduled task's name. */
  agentName?: string
  /** Scheduled tasks; absent in tests and bots. */
  schedules?: TaskScheduler
  /** Whether this project's model is a command-line tool (its scheduled runs wait for a Start tap). */
  cliModel?: boolean
  /** Stops the run (so a browser wait doesn't outlive it). */
  signal?: AbortSignal
  onPlan(items: PlanItem[]): void
  onNotify(title: string, body: string): void
  onChangesUpdated(): void
  onMemoryUpdated(): void
}
