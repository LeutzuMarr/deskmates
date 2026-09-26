import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Exported so tests can apply a prefix to build a database "at the previous version" and check the next migration. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL, status TEXT NOT NULL,
     plan TEXT NOT NULL DEFAULT '[]', auto_approve TEXT NOT NULL DEFAULT '[]', error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX tasks_by_project ON tasks(project_id, updated_at);
   CREATE TABLE messages (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (task_id, seq));
   CREATE TABLE memories (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     content TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE changes (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     path TEXT NOT NULL, abs_path TEXT NOT NULL, kind TEXT NOT NULL,
     backup TEXT, moved_to TEXT, moved_to_rel TEXT,
     undone INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE INDEX changes_by_task ON changes(task_id, created_at);
   CREATE TABLE usage (
     day TEXT NOT NULL, provider TEXT NOT NULL,
     requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, provider));`,
  `ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';`,
  `CREATE TABLE bots (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT,
     instructions TEXT NOT NULL DEFAULT '', model TEXT, auto_approve TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE bot_pcs (
     bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
     state TEXT NOT NULL DEFAULT 'absent', container_id TEXT,
     memory_mb INTEGER NOT NULL DEFAULT 1024, idle_stop_minutes INTEGER NOT NULL DEFAULT 30,
     last_used_at INTEGER, error TEXT);
   CREATE TABLE schedules (
     id TEXT PRIMARY KEY,
     bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
     cron TEXT NOT NULL, task TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
     missed TEXT NOT NULL DEFAULT 'run-late', last_run_at INTEGER, next_run_at INTEGER);
   CREATE INDEX schedules_by_bot ON schedules(bot_id);
   CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
     schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
     state TEXT NOT NULL DEFAULT 'queued', task TEXT NOT NULL,
     started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT, folder TEXT NOT NULL);
   CREATE INDEX runs_by_bot ON runs(bot_id, started_at);`,
   `CREATE TABLE skills (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, folder TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE plugins (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, folder TEXT NOT NULL,
     source_kind TEXT NOT NULL, source TEXT NOT NULL, installed_at INTEGER NOT NULL);`,
  `CREATE TABLE connectors (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
     command TEXT, args TEXT NOT NULL DEFAULT '[]', url TEXT,
     env TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  `CREATE TABLE handoffs (
     id TEXT PRIMARY KEY,
     from_bot_id TEXT NOT NULL,
     to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
     task TEXT NOT NULL,
     files TEXT NOT NULL DEFAULT '[]',
     state TEXT NOT NULL DEFAULT 'pending',
     run_id TEXT, result TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX handoffs_by_bot ON handoffs(to_bot_id, created_at);`
]

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let next = version; next < MIGRATIONS.length; next++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[next]!)
      db.exec(`PRAGMA user_version = ${next + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return db
}
