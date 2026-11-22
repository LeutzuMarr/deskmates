import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ModelMessage } from 'ai'
import {
  DEFAULT_SETTINGS,
  type Bot,
  type BotPc,
  type BotRun,
  type ChangeKind,
  type Connector,
  type ConnectorTransport,
  type FileChange,
  type KnowledgeFile,
  type Handoff,
  type HandoffState,
  type Memory,
  type ModelRef,
  type PcMode,
  type PcState,
  type PlanItem,
  type Plugin,
  type Project,
  type ProjectKind,
  type ProviderId,
  type RunState,
  type Schedule,
  type Settings,
  type Skill,
  type Task,
  type TaskStatus,
  type UsageRow,
  type TaskSchedule,
  type When
} from '../../shared/protocol'
import type { HandoffRecord } from '../bots/tools/handoff'

/** Key the bots' PC mode is stored under in the `settings` table, outside the `Settings` type. */
const PC_MODE_KEY = 'bots.pcMode'

type Row = Record<string, unknown>

export interface StoredMessage {
  message: ModelMessage
  at: number
}

/** Local calendar day as YYYY-MM-DD. */
export const today = (date = new Date()): string => date.toLocaleDateString('en-CA')

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

export class SettingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const stored: Record<string, unknown> = {}
    for (const row of rows) if (row.key in DEFAULT_SETTINGS) stored[row.key] = JSON.parse(row.value)
    return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) }
  }

  update(patch: Partial<Settings>): Settings {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS && value !== undefined) upsert.run(key, JSON.stringify(value))
    }
    return this.get()
  }

  /** Each bot gets its own PC by default. Stored outside `Settings` (see `PC_MODE_KEY`) since `protocol.ts` isn't ours to extend. */
  getPcMode(): PcMode {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(PC_MODE_KEY) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as PcMode) : 'own'
  }

  /** A value kept next to `Settings` under its own key (browser sites, Duo's profile, paired phones). */
  getExtra<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`extra:${key}`) as { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  setExtra<T>(key: string, value: T): T {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`extra:${key}`, JSON.stringify(value))
    return value
  }

  setPcMode(mode: PcMode): PcMode {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(PC_MODE_KEY, JSON.stringify(mode))
    return mode
  }
}

const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  folder: r.folder as string,
  model: r.model ? (JSON.parse(r.model as string) as ModelRef) : null,
  createdAt: r.created_at as number,
  kind: r.kind === 'design' ? 'design' : 'work'
})

export class ProjectsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Row[]).map(toProject)
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? toProject(row) : undefined
  }

  require(id: string): Project {
    const project = this.get(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    return project
  }

  create(name: string, folder: string, kind: ProjectKind = 'work', id: string = randomUUID()): Project {
    const project: Project = { id, name, folder, model: null, createdAt: Date.now(), kind }
    this.db
      .prepare('INSERT INTO projects (id, name, folder, model, created_at, kind) VALUES (?, ?, ?, NULL, ?, ?)')
      .run(project.id, name, folder, project.createdAt, kind)
    return project
  }

  update(id: string, patch: { name?: string; model?: ModelRef | null }): Project {
    const current = this.require(id)
    const next: Project = {
      ...current,
      name: patch.name ?? current.name,
      model: patch.model === undefined ? current.model : patch.model
    }
    this.db
      .prepare('UPDATE projects SET name = ?, model = ? WHERE id = ?')
      .run(next.name, next.model ? JSON.stringify(next.model) : null, id)
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

const toTask = (r: Row): Task => ({
  id: r.id as string,
  projectId: r.project_id as string,
  title: r.title as string,
  status: r.status as TaskStatus,
  plan: JSON.parse(r.plan as string) as PlanItem[],
  autoApprove: JSON.parse(r.auto_approve as string) as string[],
  error: (r.error as string | null) ?? null,
  pinned: Number(r.pinned ?? 0) === 1,
  incognito: Number(r.incognito ?? 0) === 1,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

export type TaskPatch = Partial<Pick<Task, 'title' | 'status' | 'plan' | 'autoApprove' | 'error' | 'pinned'>>

export class TasksRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(projectId: string): Task[] {
    return (
      this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC').all(projectId) as Row[]
    ).map(toTask)
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return row ? toTask(row) : undefined
  }

  require(id: string): Task {
    const task = this.get(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }

  create(projectId: string, title = 'New task', incognito = false): Task {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at, incognito) VALUES (?, ?, ?, 'idle', ?, ?, ?)")
      .run(id, projectId, title, now, now, incognito ? 1 : 0)
    return this.require(id)
  }

  /** Incognito chats left from the last time Deskmates ran: they are never kept. Returns their ids. */
  deleteIncognito(): string[] {
    const rows = this.db.prepare('SELECT id FROM tasks WHERE incognito = 1').all() as Array<{ id: string }>
    this.db.prepare('DELETE FROM tasks WHERE incognito = 1').run()
    return rows.map((r) => r.id)
  }

  /**
   * Chats whose messages contain `query` (case-insensitive), newest first, with the matching line.
   * Incognito chats are left out.
   */
  search(query: string, limit = 30): Array<{ taskId: string; projectId: string; title: string; snippet: string; updatedAt: number }> {
    const needle = query.trim().toLowerCase()
    if (needle.length < 2) return []
    const rows = this.db
      .prepare(
        "SELECT t.id, t.project_id, t.title, t.updated_at, m.body FROM messages m JOIN tasks t ON t.id = m.task_id WHERE t.incognito = 0 AND instr(lower(m.body), ?) > 0 ORDER BY t.updated_at DESC, m.seq LIMIT 400"
      )
      .all(needle) as Array<{ id: string; project_id: string; title: string; updated_at: number; body: string }>
    const out = new Map<string, { taskId: string; projectId: string; title: string; snippet: string; updatedAt: number }>()
    for (const row of rows) {
      if (out.has(row.id)) continue
      const message = JSON.parse(row.body) as ModelMessage
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const content = message.content as unknown
      const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n') : ''
      const at = text.toLowerCase().indexOf(needle)
      if (at === -1) continue
      const start = Math.max(0, at - 50)
      const snippet = `${start > 0 ? '…' : ''}${text.slice(start, at + needle.length + 90).replace(/\s+/g, ' ').trim()}${at + needle.length + 90 < text.length ? '…' : ''}`
      out.set(row.id, { taskId: row.id, projectId: row.project_id, title: row.title, snippet, updatedAt: row.updated_at })
      if (out.size >= limit) break
    }
    return [...out.values()]
  }

  update(id: string, patch: TaskPatch): Task {
    const next: Task = { ...this.require(id), ...definedOnly(patch), updatedAt: Date.now() }
    this.db
      .prepare('UPDATE tasks SET title = ?, status = ?, plan = ?, auto_approve = ?, error = ?, pinned = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.status, JSON.stringify(next.plan), JSON.stringify(next.autoApprove), next.error, next.pinned ? 1 : 0, next.updatedAt, id)
    return next
  }

  /** Pins or unpins a chat without touching its updated time (pinning isn't activity). */
  setPinned(id: string, pinned: boolean): Task {
    this.db.prepare('UPDATE tasks SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
    return this.require(id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  /** Tasks left "running" by a crash or shutdown go back to idle with an explanation. */
  resetInterrupted(): Task[] {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as Array<{ id: string }>
    return rows.map(({ id }) => this.update(id, { status: 'idle', error: 'Stopped because Deskmates was closed.' }))
  }

  messages(id: string): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT body, created_at FROM messages WHERE task_id = ? ORDER BY seq')
      .all(id) as Array<{ body: string; created_at: number }>
    return rows.map((row) => ({ message: JSON.parse(row.body) as ModelMessage, at: row.created_at }))
  }

  /**
   * Drops the task's last user message and everything after it (for Edit and Retry), and returns
   * that message's text, or null when there is no user message.
   */
  dropFromLastUserMessage(id: string): { text: string; images: Array<{ dataUrl: string }> } | null {
    const rows = this.db.prepare('SELECT seq, body FROM messages WHERE task_id = ? ORDER BY seq').all(id) as Array<{ seq: number; body: string }>
    for (let i = rows.length - 1; i >= 0; i--) {
      const message = JSON.parse(rows[i]!.body) as ModelMessage
      if (message.role !== 'user') continue
      const content = message.content as unknown
      const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
      const text = typeof content === 'string' ? content : parts.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n')
      // The message's images go out again with it (Retry, or Edit of its text).
      const images = parts
        .filter((part) => part?.type === 'image' && typeof part.image === 'string')
        .map((part) => ({ dataUrl: `data:${String(part.mediaType ?? 'image/png')};base64,${String(part.image)}` }))
      this.db.prepare('DELETE FROM messages WHERE task_id = ? AND seq >= ?').run(id, rows[i]!.seq)
      return { text, images }
    }
    return null
  }

  // ---- Versions (edit branches) ----
  //
  // Editing or retrying a message keeps what was there: the message and everything after it are
  // saved as one version at that position, and the new message starts the next version there. The
  // user flips between versions with ‹ 1/2 ›, as in Claude. A version's body also carries the
  // versions saved further down its own branch, so each branch keeps its own history.

  /** Every position that has versions: how many, and which one is showing (0-based). */
  forks(id: string): Map<number, { index: number; count: number }> {
    const rows = this.db.prepare('SELECT at, version, active FROM message_versions WHERE task_id = ? ORDER BY at, version').all(id) as Array<{ at: number; version: number; active: number }>
    const out = new Map<number, { index: number; count: number }>()
    for (const row of rows) {
      const entry = out.get(row.at) ?? { index: 0, count: 0 }
      if (row.active) entry.index = entry.count
      entry.count++
      out.set(row.at, entry)
    }
    return out
  }

  /** The user message at position `at` (0-based, in stored order), or null when that isn't one. */
  userMessageAt(id: string, at: number): { text: string; images: Array<{ dataUrl: string }>; documents: string[] } | null {
    const row = this.db.prepare('SELECT body FROM messages WHERE task_id = ? ORDER BY seq LIMIT 1 OFFSET ?').get(id, at) as { body: string } | undefined
    if (!row) return null
    const message = JSON.parse(row.body) as ModelMessage
    if (message.role !== 'user') return null
    const content = message.content as unknown
    const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
    const texts = parts.filter((part) => part?.type === 'text').map((part) => String(part.text ?? ''))
    // Attached documents travel as their own text parts; they go out again with the message.
    const isDocument = (t: string): boolean => t.startsWith('<document name="')
    const text = typeof content === 'string' ? content : texts.filter((t) => !isDocument(t)).join('\n')
    const images = parts
      .filter((part) => part?.type === 'image' && typeof part.image === 'string')
      .map((part) => ({ dataUrl: `data:${String(part.mediaType ?? 'image/png')};base64,${String(part.image)}` }))
    return { text, images, documents: texts.filter(isDocument) }
  }

  /** Position of the last user message, or -1. */
  lastUserPosition(id: string): number {
    const rows = this.db.prepare('SELECT body FROM messages WHERE task_id = ? ORDER BY seq').all(id) as Array<{ body: string }>
    for (let i = rows.length - 1; i >= 0; i--) if ((JSON.parse(rows[i]!.body) as ModelMessage).role === 'user') return i
    return -1
  }

  /** Takes the messages from position `at` on (and the versions below it) out, as one saved body. */
  private cutBranch(id: string, at: number): string {
    const rows = this.db.prepare('SELECT seq, body FROM messages WHERE task_id = ? ORDER BY seq').all(id) as Array<{ seq: number; body: string }>
    const tail = rows.slice(at)
    const nested = this.db.prepare('SELECT at, version, body, active, created_at FROM message_versions WHERE task_id = ? AND at > ?').all(id, at)
    if (tail.length) this.db.prepare('DELETE FROM messages WHERE task_id = ? AND seq >= ?').run(id, tail[0]!.seq)
    this.db.prepare('DELETE FROM message_versions WHERE task_id = ? AND at > ?').run(id, at)
    return JSON.stringify({ messages: tail.map((row) => JSON.parse(row.body) as unknown), versions: nested })
  }

  /** Puts a saved body back at the end of the task. */
  private restoreBranch(id: string, body: string): void {
    const saved = JSON.parse(body || '{}') as { messages?: ModelMessage[]; versions?: Array<{ at: number; version: number; body: string; active: number; created_at: number }> }
    this.appendMessages(id, saved.messages ?? [])
    const insert = this.db.prepare('INSERT INTO message_versions (task_id, at, version, body, active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const v of saved.versions ?? []) insert.run(id, v.at, v.version, v.body, v.active, v.created_at)
  }

  /**
   * Starts a new version at position `at` (a user message): what is there now is saved as a version
   * and removed, so the edited (or retried) message can go out in its place. Returns that message.
   */
  forkAt(id: string, at: number): { text: string; images: Array<{ dataUrl: string }>; documents: string[] } | null {
    const message = this.userMessageAt(id, at)
    if (!message) return null
    this.db.exec('BEGIN')
    try {
      const now = Date.now()
      const existing = this.db.prepare('SELECT version, active FROM message_versions WHERE task_id = ? AND at = ? ORDER BY version').all(id, at) as Array<{ version: number; active: number }>
      const body = this.cutBranch(id, at)
      if (existing.length === 0) {
        this.db.prepare('INSERT INTO message_versions (task_id, at, version, body, active, created_at) VALUES (?, ?, 0, ?, 0, ?)').run(id, at, body, now)
      } else {
        this.db.prepare('UPDATE message_versions SET body = ?, active = 0 WHERE task_id = ? AND at = ? AND active = 1').run(body, id, at)
      }
      const next = existing.length ? Math.max(...existing.map((v) => v.version)) + 1 : 1
      this.db.prepare("INSERT INTO message_versions (task_id, at, version, body, active, created_at) VALUES (?, ?, ?, '', 1, ?)").run(id, at, next, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return message
  }

  /** Shows version `index` (0-based) at position `at`: the current one is saved, that one put back. */
  switchVersion(id: string, at: number, index: number): void {
    const versions = this.db.prepare('SELECT version, active, body FROM message_versions WHERE task_id = ? AND at = ? ORDER BY version').all(id, at) as Array<{ version: number; active: number; body: string }>
    const target = versions[index]
    if (!target) throw new Error(`There is no version ${index + 1} of that message.`)
    if (target.active) return
    this.db.exec('BEGIN')
    try {
      const body = this.cutBranch(id, at)
      this.db.prepare('UPDATE message_versions SET body = ?, active = 0 WHERE task_id = ? AND at = ? AND active = 1').run(body, id, at)
      this.restoreBranch(id, target.body)
      this.db.prepare("UPDATE message_versions SET body = '', active = 1 WHERE task_id = ? AND at = ? AND version = ?").run(id, at, target.version)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- Feedback (thumbs up and down on replies) ----

  /** Ratings on this task's replies, by timeline item id. */
  feedback(id: string): Record<string, { rating: 'up' | 'down'; comment: string; text: string }> {
    const rows = this.db.prepare('SELECT item_id, rating, comment, text FROM feedback WHERE task_id = ?').all(id) as Array<{ item_id: string; rating: string; comment: string; text: string }>
    return Object.fromEntries(rows.map((r) => [r.item_id, { rating: r.rating === 'down' ? 'down' : 'up', comment: r.comment, text: r.text }]))
  }

  /** Rates one reply (null clears it). `text` is the reply, kept so a rating follows its own words. */
  setFeedback(id: string, itemId: string, rating: 'up' | 'down' | null, comment = '', text = ''): void {
    if (rating === null) {
      this.db.prepare('DELETE FROM feedback WHERE task_id = ? AND item_id = ?').run(id, itemId)
      return
    }
    this.db
      .prepare('INSERT INTO feedback (task_id, item_id, rating, comment, text, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, item_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, text = excluded.text, created_at = excluded.created_at')
      .run(id, itemId, rating, comment.slice(0, 2000), text.slice(0, 4000), Date.now())
  }

  /** The project's most recent thumbs-down notes with a reason, newest first, for the agent to learn from. */
  recentCriticism(projectId: string, limit = 5): Array<{ comment: string; text: string }> {
    return this.db
      .prepare("SELECT f.comment, f.text FROM feedback f JOIN tasks t ON t.id = f.task_id WHERE t.project_id = ? AND f.rating = 'down' AND f.comment != '' ORDER BY f.created_at DESC LIMIT ?")
      .all(projectId, limit) as Array<{ comment: string; text: string }>
  }

  appendMessages(id: string, messages: ModelMessage[], at = Date.now()): void {
    const { last } = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS last FROM messages WHERE task_id = ?')
      .get(id) as { last: number }
    const insert = this.db.prepare('INSERT INTO messages (task_id, seq, body, created_at) VALUES (?, ?, ?, ?)')
    messages.forEach((message, index) => insert.run(id, last + 1 + index, JSON.stringify(message), at))
  }
}

const toMemory = (r: Row): Memory => ({
  id: r.id as string,
  projectId: r.project_id as string,
  content: r.content as string,
  createdAt: r.created_at as number
})

export class MemoriesRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(projectId: string): Memory[] {
    return (
      this.db.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY created_at').all(projectId) as Row[]
    ).map(toMemory)
  }

  add(projectId: string, content: string): Memory {
    const memory: Memory = { id: randomUUID(), projectId, content, createdAt: Date.now() }
    this.db
      .prepare('INSERT INTO memories (id, project_id, content, created_at) VALUES (?, ?, ?, ?)')
      .run(memory.id, projectId, content, memory.createdAt)
    return memory
  }

  delete(id: string, projectId: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ? AND project_id = ?').run(id, projectId).changes > 0
  }
}

/** Files the user added to a project's knowledge, as text: every chat in the project can read them. */
export class KnowledgeRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(projectId: string): KnowledgeFile[] {
    return (this.db.prepare('SELECT id, project_id, name, size, created_at, length(text) AS chars FROM knowledge WHERE project_id = ? ORDER BY created_at').all(projectId) as Row[]).map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      name: r.name as string,
      size: Number(r.size),
      chars: Number(r.chars),
      createdAt: Number(r.created_at)
    }))
  }

  /** The files with their text, for the agent. */
  texts(projectId: string): Array<{ name: string; text: string }> {
    return this.db.prepare('SELECT name, text FROM knowledge WHERE project_id = ? ORDER BY created_at').all(projectId) as Array<{ name: string; text: string }>
  }

  add(projectId: string, name: string, text: string, size: number): KnowledgeFile {
    const id = randomUUID()
    const createdAt = Date.now()
    this.db.prepare('INSERT INTO knowledge (id, project_id, name, text, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, name, text, size, createdAt)
    return { id, projectId, name, size, chars: text.length, createdAt }
  }

  delete(id: string, projectId: string): boolean {
    return this.db.prepare('DELETE FROM knowledge WHERE id = ? AND project_id = ?').run(id, projectId).changes > 0
  }
}

/** A change as stored, including the private paths the UI never sees. */
export interface ChangeRecord extends FileChange {
  absPath: string
  backup: string | null
  movedToAbs: string | null
}

const toChangeRecord = (r: Row): ChangeRecord => ({
  id: r.id as string,
  taskId: r.task_id as string,
  path: r.path as string,
  kind: r.kind as ChangeKind,
  movedTo: (r.moved_to_rel as string | null) ?? null,
  undone: r.undone === 1,
  createdAt: r.created_at as number,
  absPath: r.abs_path as string,
  backup: (r.backup as string | null) ?? null,
  movedToAbs: (r.moved_to as string | null) ?? null
})

const toFileChange = (c: ChangeRecord): FileChange => ({
  id: c.id,
  taskId: c.taskId,
  path: c.path,
  kind: c.kind,
  movedTo: c.movedTo,
  undone: c.undone,
  createdAt: c.createdAt
})

export class ChangesRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(change: Omit<ChangeRecord, 'undone' | 'createdAt'>): ChangeRecord {
    this.db
      .prepare(
        'INSERT INTO changes (id, task_id, path, abs_path, kind, backup, moved_to, moved_to_rel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        change.id,
        change.taskId,
        change.path,
        change.absPath,
        change.kind,
        change.backup,
        change.movedToAbs,
        change.movedTo,
        Date.now()
      )
    return this.require(change.id)
  }

  get(id: string): ChangeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Row | undefined
    return row ? toChangeRecord(row) : undefined
  }

  require(id: string): ChangeRecord {
    const change = this.get(id)
    if (!change) throw new Error(`Change not found: ${id}`)
    return change
  }

  listRecords(taskId: string): ChangeRecord[] {
    return (
      this.db.prepare('SELECT * FROM changes WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Row[]
    ).map(toChangeRecord)
  }

  list(taskId: string): FileChange[] {
    return this.listRecords(taskId).map(toFileChange)
  }

  markUndone(id: string): void {
    this.db.prepare('UPDATE changes SET undone = 1 WHERE id = ?').run(id)
  }
}

export class UsageRepo {
  constructor(private readonly db: DatabaseSync) {}

  add(provider: ProviderId, requests: number, inputTokens: number, outputTokens: number, day = today()): void {
    this.db
      .prepare(
        `INSERT INTO usage (day, provider, requests, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, provider) DO UPDATE SET
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`
      )
      .run(day, provider, requests, inputTokens, outputTokens)
  }

  list(limit = 60): UsageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM usage ORDER BY day DESC, provider LIMIT ?')
      .all(limit) as Row[]
    return rows.map((r) => ({
      day: r.day as string,
      provider: r.provider as ProviderId,
      requests: r.requests as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number
    }))
  }
}

// ---- Bots (stage 2) ----

const toBot = (r: Row): Bot => ({
  id: r.id as string,
  name: r.name as string,
  avatar: (r.avatar as string | null) ?? null,
  instructions: r.instructions as string,
  model: r.model ? (JSON.parse(r.model as string) as ModelRef) : null,
  autoApprove: JSON.parse(r.auto_approve as string) as string[],
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

export type BotPatch = Partial<Pick<Bot, 'name' | 'instructions' | 'model' | 'avatar' | 'autoApprove'>>

export class BotsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): Bot[] {
    return (this.db.prepare('SELECT * FROM bots ORDER BY created_at').all() as Row[]).map(toBot)
  }

  get(id: string): Bot | undefined {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as Row | undefined
    return row ? toBot(row) : undefined
  }

  require(id: string): Bot {
    const bot = this.get(id)
    if (!bot) throw new Error(`Bot not found: ${id}`)
    return bot
  }

  create(name: string, instructions = '', model: ModelRef | null = null, id: string = randomUUID()): Bot {
    const now = Date.now()
    const bot: Bot = { id, name, avatar: null, instructions, model, autoApprove: [], createdAt: now, updatedAt: now }
    this.db
      .prepare(
        'INSERT INTO bots (id, name, avatar, instructions, model, auto_approve, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
      )
      .run(bot.id, name, instructions, model ? JSON.stringify(model) : null, JSON.stringify(bot.autoApprove), now, now)
    return bot
  }

  update(id: string, patch: BotPatch): Bot {
    const next: Bot = { ...this.require(id), ...definedOnly(patch), updatedAt: Date.now() }
    this.db
      .prepare('UPDATE bots SET name = ?, avatar = ?, instructions = ?, model = ?, auto_approve = ?, updated_at = ? WHERE id = ?')
      .run(
        next.name,
        next.avatar,
        next.instructions,
        next.model ? JSON.stringify(next.model) : null,
        JSON.stringify(next.autoApprove),
        next.updatedAt,
        id
      )
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM bots WHERE id = ?').run(id)
  }
}

const toBotPc = (r: Row): BotPc => ({
  botId: r.bot_id as string,
  state: r.state as PcState,
  containerId: (r.container_id as string | null) ?? null,
  memoryMb: r.memory_mb as number,
  idleStopMinutes: r.idle_stop_minutes as number,
  lastUsedAt: (r.last_used_at as number | null) ?? null,
  error: (r.error as string | null) ?? null
})

/** The live fields a `BotHost` reports back; `save()` writes these without touching the stored memory/idle settings. */
export type BotPcSnapshot = Pick<BotPc, 'botId' | 'state' | 'containerId' | 'lastUsedAt' | 'error'>

export class BotPcsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): BotPc[] {
    return (this.db.prepare('SELECT * FROM bot_pcs ORDER BY bot_id').all() as Row[]).map(toBotPc)
  }

  get(botId: string): BotPc | undefined {
    const row = this.db.prepare('SELECT * FROM bot_pcs WHERE bot_id = ?').get(botId) as Row | undefined
    return row ? toBotPc(row) : undefined
  }

  require(botId: string): BotPc {
    const pc = this.get(botId)
    if (!pc) throw new Error(`PC not found for bot: ${botId}`)
    return pc
  }

  /** Inserts the default (absent, unstarted) row a bot gets as soon as it's created. */
  create(botId: string): BotPc {
    this.db.prepare('INSERT INTO bot_pcs (bot_id) VALUES (?)').run(botId)
    return this.require(botId)
  }

  /** Persists a fresh live snapshot from the PC host: state, container id, last-used time, error. */
  save(pc: BotPcSnapshot): BotPc {
    this.db
      .prepare('UPDATE bot_pcs SET state = ?, container_id = ?, last_used_at = ?, error = ? WHERE bot_id = ?')
      .run(pc.state, pc.containerId, pc.lastUsedAt, pc.error, pc.botId)
    return this.require(pc.botId)
  }

  /** Changes the user-configured memory/idle settings (`pcs.update`). */
  updateSettings(botId: string, patch: { memoryMb?: number; idleStopMinutes?: number }): BotPc {
    const current = this.require(botId)
    const memoryMb = patch.memoryMb ?? current.memoryMb
    const idleStopMinutes = patch.idleStopMinutes ?? current.idleStopMinutes
    this.db.prepare('UPDATE bot_pcs SET memory_mb = ?, idle_stop_minutes = ? WHERE bot_id = ?').run(memoryMb, idleStopMinutes, botId)
    return this.require(botId)
  }
}

const toTaskSchedule = (r: Row): TaskSchedule => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  instruction: r.instruction as string,
  when: JSON.parse(r.when_json as string) as When,
  enabled: r.enabled === 1,
  missed: r.missed === 'skip' ? 'skip' : 'run-late',
  lastRunAt: (r.last_run_at as number | null) ?? null,
  nextRunAt: (r.next_run_at as number | null) ?? null,
  pendingSince: (r.pending_since as number | null) ?? null,
  lastTaskId: (r.last_task_id as string | null) ?? null,
  createdAt: r.created_at as number
})

export type TaskSchedulePatch = Partial<
  Pick<TaskSchedule, 'name' | 'instruction' | 'when' | 'enabled' | 'missed' | 'lastRunAt' | 'nextRunAt' | 'pendingSince' | 'lastTaskId'>
>

/** Scheduled tasks of Work and Design projects (see `core/schedules/task-scheduler.ts`). */
export class TaskSchedulesRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(projectId?: string): TaskSchedule[] {
    const rows = projectId
      ? (this.db.prepare('SELECT * FROM task_schedules WHERE project_id = ? ORDER BY created_at').all(projectId) as Row[])
      : (this.db.prepare('SELECT * FROM task_schedules ORDER BY created_at').all() as Row[])
    return rows.map(toTaskSchedule)
  }

  get(id: string): TaskSchedule | undefined {
    const row = this.db.prepare('SELECT * FROM task_schedules WHERE id = ?').get(id) as Row | undefined
    return row ? toTaskSchedule(row) : undefined
  }

  require(id: string): TaskSchedule {
    const schedule = this.get(id)
    if (!schedule) throw new Error(`Scheduled task not found: ${id}`)
    return schedule
  }

  create(input: { projectId: string; name: string; instruction: string; when: When; missed?: TaskSchedule['missed']; now?: number }): TaskSchedule {
    const id = randomUUID()
    const createdAt = input.now ?? Date.now()
    this.db
      .prepare('INSERT INTO task_schedules (id, project_id, name, instruction, when_json, enabled, missed, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, input.projectId, input.name, input.instruction, JSON.stringify(input.when), input.missed ?? 'run-late', createdAt)
    return this.require(id)
  }

  update(id: string, patch: TaskSchedulePatch): TaskSchedule {
    const next: TaskSchedule = { ...this.require(id), ...definedOnly(patch) }
    // null is a real value for these (cleared), so take them from the patch even when null.
    for (const key of ['lastRunAt', 'nextRunAt', 'pendingSince', 'lastTaskId'] as const) {
      if (key in patch) (next as unknown as Record<string, unknown>)[key] = patch[key] ?? null
    }
    this.db
      .prepare(
        'UPDATE task_schedules SET name = ?, instruction = ?, when_json = ?, enabled = ?, missed = ?, last_run_at = ?, next_run_at = ?, pending_since = ?, last_task_id = ? WHERE id = ?'
      )
      .run(next.name, next.instruction, JSON.stringify(next.when), next.enabled ? 1 : 0, next.missed, next.lastRunAt, next.nextRunAt, next.pendingSince, next.lastTaskId, id)
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM task_schedules WHERE id = ?').run(id)
  }
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id as string,
  botId: r.bot_id as string,
  cron: r.cron as string,
  task: r.task as string,
  enabled: r.enabled === 1,
  missed: r.missed as Schedule['missed'],
  lastRunAt: (r.last_run_at as number | null) ?? null,
  nextRunAt: (r.next_run_at as number | null) ?? null
})

export type SchedulePatch = Partial<Pick<Schedule, 'cron' | 'task' | 'enabled' | 'missed' | 'lastRunAt' | 'nextRunAt'>>

export class SchedulesRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(botId?: string): Schedule[] {
    const rows = botId
      ? (this.db.prepare('SELECT * FROM schedules WHERE bot_id = ? ORDER BY rowid').all(botId) as Row[])
      : (this.db.prepare('SELECT * FROM schedules ORDER BY rowid').all() as Row[])
    return rows.map(toSchedule)
  }

  get(id: string): Schedule | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined
    return row ? toSchedule(row) : undefined
  }

  require(id: string): Schedule {
    const schedule = this.get(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    return schedule
  }

  create(botId: string, cron: string, task: string, missed: Schedule['missed'] = 'run-late', id: string = randomUUID()): Schedule {
    const schedule: Schedule = { id, botId, cron, task, enabled: true, missed, lastRunAt: null, nextRunAt: null }
    this.db
      .prepare('INSERT INTO schedules (id, bot_id, cron, task, enabled, missed) VALUES (?, ?, ?, ?, 1, ?)')
      .run(id, botId, cron, task, missed)
    return schedule
  }

  update(id: string, patch: SchedulePatch): Schedule {
    const next: Schedule = { ...this.require(id), ...definedOnly(patch) }
    this.db
      .prepare('UPDATE schedules SET cron = ?, task = ?, enabled = ?, missed = ?, last_run_at = ?, next_run_at = ? WHERE id = ?')
      .run(next.cron, next.task, next.enabled ? 1 : 0, next.missed, next.lastRunAt, next.nextRunAt, id)
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
  }
}

const toBotRun = (r: Row): BotRun => ({
  id: r.id as string,
  botId: r.bot_id as string,
  scheduleId: (r.schedule_id as string | null) ?? null,
  state: r.state as RunState,
  task: r.task as string,
  startedAt: r.started_at as number,
  finishedAt: (r.finished_at as number | null) ?? null,
  error: (r.error as string | null) ?? null,
  folder: r.folder as string
})

export type RunPatch = Partial<Pick<BotRun, 'state' | 'finishedAt' | 'error'>>

export class RunsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(botId?: string, limit = 50): BotRun[] {
    const rows = botId
      ? (this.db.prepare('SELECT * FROM runs WHERE bot_id = ? ORDER BY started_at DESC LIMIT ?').all(botId, limit) as Row[])
      : (this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[])
    return rows.map(toBotRun)
  }

  get(id: string): BotRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined
    return row ? toBotRun(row) : undefined
  }

  /** Whether the bot has a run that isn't finished yet — used to avoid piling further runs (e.g.
   *  handoff pickups) onto a bot that's already busy working. */
  isActive(botId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS one FROM runs WHERE bot_id = ? AND state IN ('queued', 'running', 'waiting-approval') LIMIT 1")
      .get(botId) as { one: number } | undefined
    return row !== undefined
  }

  require(id: string): BotRun {
    const run = this.get(id)
    if (!run) throw new Error(`Run not found: ${id}`)
    return run
  }

  create(botId: string, task: string, folder: string, scheduleId: string | null = null, id: string = randomUUID()): BotRun {
    const run: BotRun = { id, botId, scheduleId, state: 'queued', task, startedAt: Date.now(), finishedAt: null, error: null, folder }
    this.db
      .prepare('INSERT INTO runs (id, bot_id, schedule_id, state, task, started_at, folder) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, botId, scheduleId, run.state, task, run.startedAt, folder)
    return run
  }

  update(id: string, patch: RunPatch): BotRun {
    const next: BotRun = { ...this.require(id), ...definedOnly(patch) }
    this.db
      .prepare('UPDATE runs SET state = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(next.state, next.finishedAt, next.error, id)
    return next
  }

  /**
   * Runs left "running" or "waiting-approval" by a crash or shutdown go to "error" with a plain
   * explanation — mirrors `TasksRepo.resetInterrupted()` for the Work tab, but also covers
   * "waiting-approval": `BotRunner`'s pending approvals live only in memory, so a run stuck there
   * has no live state left to resume once the process that was running it is gone, and would
   * otherwise sit unanswerable forever (no RPC call can ever change its state).
   */
  resetInterrupted(): BotRun[] {
    const rows = this.db
      .prepare("SELECT id FROM runs WHERE state = 'running' OR state = 'waiting-approval'")
      .all() as Array<{ id: string }>
    return rows.map(({ id }) => this.update(id, { state: 'error', error: 'Stopped because Deskmates was closed.', finishedAt: Date.now() }))
  }
}

// ---- Bot handoffs (spec 5.9) ----

const toHandoff = (r: Row): Handoff => ({
  id: r.id as string,
  fromBotId: r.from_bot_id as string,
  toBotId: r.to_bot_id as string,
  task: r.task as string,
  files: JSON.parse(r.files as string) as string[],
  state: r.state as HandoffState,
  runId: (r.run_id as string | null) ?? null,
  result: (r.result as string | null) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

export class HandoffsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(botId?: string): Handoff[] {
    const rows = botId
      ? (this.db.prepare('SELECT * FROM handoffs WHERE to_bot_id = ? ORDER BY created_at DESC, rowid').all(botId) as Row[])
      : (this.db.prepare('SELECT * FROM handoffs ORDER BY created_at DESC, rowid').all() as Row[])
    return rows.map(toHandoff)
  }

  get(id: string): Handoff | undefined {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as Row | undefined
    return row ? toHandoff(row) : undefined
  }

  require(id: string): Handoff {
    const handoff = this.get(id)
    if (!handoff) throw new Error(`Handoff not found: ${id}`)
    return handoff
  }

  /** Scans see the same handoff file repeatedly (it is never deleted), so this inserts only the first
   *  time; a row already present — running, done or failed — is left exactly as it is. `inserted`
   *  tells the caller whether this scan actually created a fresh row (the signal to surface it). */
  upsertFromRecord(record: HandoffRecord): { handoff: Handoff; inserted: boolean } {
    const { changes } = this.db
      .prepare(
        'INSERT INTO handoffs (id, from_bot_id, to_bot_id, task, files, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
      )
      .run(record.id, record.fromBotId, record.toBotId, record.task, JSON.stringify(record.files), record.createdAt, record.createdAt)
    return { handoff: this.require(record.id), inserted: changes > 0 }
  }

  markRunning(id: string, runId: string): Handoff {
    this.require(id)
    this.db.prepare("UPDATE handoffs SET state = 'running', run_id = ?, updated_at = ? WHERE id = ?").run(runId, Date.now(), id)
    return this.require(id)
  }

  /** Records the receiving bot's final outcome, from the run that picked the handoff up. */
  finish(id: string, state: 'done' | 'error', result: string): Handoff {
    this.require(id)
    this.db.prepare('UPDATE handoffs SET state = ?, result = ?, updated_at = ? WHERE id = ?').run(state, result, Date.now(), id)
    return this.require(id)
  }

  /** The handoff a run picked up, if any — lets the run-end handler find its handoff by run id alone. */
  byRun(runId: string): Handoff | undefined {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE run_id = ?').get(runId) as Row | undefined
    return row ? toHandoff(row) : undefined
  }
}

// ---- Extensions (stage 1: skills and plugins) ----

const toSkill = (r: Row): Skill => ({
  id: r.id as string,
  name: r.name as string,
  folder: r.folder as string,
  enabled: r.enabled === 1,
  source: r.source as string,
  createdAt: r.created_at as number
})

export class SkillsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): Skill[] {
    return (this.db.prepare('SELECT * FROM skills ORDER BY name').all() as Row[]).map(toSkill)
  }

  get(id: string): Skill | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Row | undefined
    return row ? toSkill(row) : undefined
  }

  require(id: string): Skill {
    const skill = this.get(id)
    if (!skill) throw new Error(`Skill not found: ${id}`)
    return skill
  }

  getByName(name: string): Skill | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as Row | undefined
    return row ? toSkill(row) : undefined
  }

  create(name: string, folder: string, source: string, id: string = randomUUID()): Skill {
    const skill: Skill = { id, name, folder, enabled: true, source, createdAt: Date.now() }
    this.db
      .prepare('INSERT INTO skills (id, name, folder, enabled, source, created_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(skill.id, name, folder, source, skill.createdAt)
    return skill
  }

  /** Re-imports a skill that already exists (same name): keeps the id and enabled flag, refreshes the folder and source. */
  updateFolder(name: string, folder: string, source: string): Skill {
    const current = this.getByName(name)
    if (!current) return this.create(name, folder, source)
    this.db.prepare('UPDATE skills SET folder = ?, source = ? WHERE id = ?').run(folder, source, current.id)
    return this.require(current.id)
  }

  update(id: string, patch: { name?: string; enabled?: boolean }): Skill {
    const next: Skill = { ...this.require(id), ...definedOnly(patch) }
    this.db.prepare('UPDATE skills SET name = ?, enabled = ? WHERE id = ?').run(next.name, next.enabled ? 1 : 0, id)
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  }
}

const toPlugin = (r: Row): Plugin => ({
  id: r.id as string,
  name: r.name as string,
  folder: r.folder as string,
  sourceKind: r.source_kind as Plugin['sourceKind'],
  source: r.source as string,
  installedAt: r.installed_at as number
})

export class PluginsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): Plugin[] {
    return (this.db.prepare('SELECT * FROM plugins ORDER BY name').all() as Row[]).map(toPlugin)
  }

  get(id: string): Plugin | undefined {
    const row = this.db.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as Row | undefined
    return row ? toPlugin(row) : undefined
  }

  require(id: string): Plugin {
    const plugin = this.get(id)
    if (!plugin) throw new Error(`Plugin not found: ${id}`)
    return plugin
  }

  getByName(name: string): Plugin | undefined {
    const row = this.db.prepare('SELECT * FROM plugins WHERE name = ?').get(name) as Row | undefined
    return row ? toPlugin(row) : undefined
  }

  create(name: string, folder: string, sourceKind: Plugin['sourceKind'], source: string, id: string = randomUUID()): Plugin {
    const plugin: Plugin = { id, name, folder, sourceKind, source, installedAt: Date.now() }
    this.db
      .prepare('INSERT INTO plugins (id, name, folder, source_kind, source, installed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(plugin.id, name, folder, sourceKind, source, plugin.installedAt)
    return plugin
  }

  update(id: string, patch: { name?: string; folder?: string; sourceKind?: Plugin['sourceKind']; source?: string }): Plugin {
    const next: Plugin = { ...this.require(id), ...definedOnly(patch) }
    this.db
      .prepare('UPDATE plugins SET name = ?, folder = ?, source_kind = ?, source = ? WHERE id = ?')
      .run(next.name, next.folder, next.sourceKind, next.source, id)
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id)
  }
}

// ---- MCP connectors (spec 5.6) ----

const toConnector = (r: Row): Connector => ({
  id: r.id as string,
  name: r.name as string,
  transport: r.transport as ConnectorTransport,
  command: (r.command as string | null) ?? null,
  args: JSON.parse(r.args as string) as string[],
  url: (r.url as string | null) ?? null,
  env: JSON.parse(r.env as string) as Record<string, string>,
  enabled: r.enabled === 1,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

export type ConnectorPatch = Partial<
  Pick<Connector, 'name' | 'transport' | 'command' | 'args' | 'url' | 'env' | 'enabled'>
>

export class ConnectorsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): Connector[] {
    return (this.db.prepare('SELECT * FROM connectors ORDER BY name').all() as Row[]).map(toConnector)
  }

  get(id: string): Connector | undefined {
    const row = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Row | undefined
    return row ? toConnector(row) : undefined
  }

  require(id: string): Connector {
    const connector = this.get(id)
    if (!connector) throw new Error(`Connector not found: ${id}`)
    return connector
  }

  getByName(name: string): Connector | undefined {
    const row = this.db.prepare('SELECT * FROM connectors WHERE name = ?').get(name) as Row | undefined
    return row ? toConnector(row) : undefined
  }

  create(
    input: {
      name: string
      transport: ConnectorTransport
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    },
    id: string = randomUUID()
  ): Connector {
    const now = Date.now()
    const connector: Connector = {
      id,
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      url: input.url ?? null,
      env: input.env ?? {},
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now
    }
    this.db
      .prepare(
        'INSERT INTO connectors (id, name, transport, command, args, url, env, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        connector.id,
        connector.name,
        connector.transport,
        connector.command,
        JSON.stringify(connector.args),
        connector.url,
        JSON.stringify(connector.env),
        connector.enabled ? 1 : 0,
        now,
        now
      )
    return connector
  }

  update(id: string, patch: ConnectorPatch): Connector {
    const next: Connector = { ...this.require(id), ...definedOnly(patch), updatedAt: Date.now() }
    this.db
      .prepare(
        'UPDATE connectors SET name = ?, transport = ?, command = ?, args = ?, url = ?, env = ?, enabled = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        next.name,
        next.transport,
        next.command,
        JSON.stringify(next.args),
        next.url,
        JSON.stringify(next.env),
        next.enabled ? 1 : 0,
        next.updatedAt,
        id
      )
    return next
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM connectors WHERE id = ?').run(id)
  }
}

export interface Repos {
  settings: SettingsRepo
  projects: ProjectsRepo
  tasks: TasksRepo
  memories: MemoriesRepo
  knowledge: KnowledgeRepo
  changes: ChangesRepo
  usage: UsageRepo
  bots: BotsRepo
  botPcs: BotPcsRepo
  schedules: SchedulesRepo
  taskSchedules: TaskSchedulesRepo
  runs: RunsRepo
  handoffs: HandoffsRepo
  skills: SkillsRepo
  plugins: PluginsRepo
  connectors: ConnectorsRepo
}

export function createRepos(db: DatabaseSync): Repos {
  return {
    settings: new SettingsRepo(db),
    projects: new ProjectsRepo(db),
    tasks: new TasksRepo(db),
    memories: new MemoriesRepo(db),
    knowledge: new KnowledgeRepo(db),
    changes: new ChangesRepo(db),
    usage: new UsageRepo(db),
    bots: new BotsRepo(db),
    botPcs: new BotPcsRepo(db),
    schedules: new SchedulesRepo(db),
    taskSchedules: new TaskSchedulesRepo(db),
    runs: new RunsRepo(db),
    handoffs: new HandoffsRepo(db),
    skills: new SkillsRepo(db),
    plugins: new PluginsRepo(db),
    connectors: new ConnectorsRepo(db)
  }
}
