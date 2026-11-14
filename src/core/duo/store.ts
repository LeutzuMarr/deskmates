import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DuoMessage, DuoTodo, OutboxItem, OutboxKind, OutboxStatus, SentRecord } from '../../shared/duo'

type Row = Record<string, unknown>

const toItem = (r: Row): OutboxItem => ({
  id: r.id as string,
  kind: r.kind as OutboxKind,
  company: r.company as string,
  domain: r.domain as string,
  to: r.to_addr as string,
  source: r.source as string,
  subject: r.subject as string,
  body: r.body as string,
  followUpNo: (r.follow_up_no as number | null) ?? null,
  note: r.note as string,
  status: r.status as OutboxStatus,
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as number,
  decidedAt: (r.decided_at as number | null) ?? null,
  sentAt: (r.sent_at as number | null) ?? null
})

/** Duo's own tables: its conversation, the Outbox, its to-do list and the outreach history. */
export class DuoStore {
  constructor(private readonly db: DatabaseSync) {}

  // ---- messages ----
  messages(limit = 200): DuoMessage[] {
    const rows = this.db.prepare('SELECT * FROM duo_messages ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as Row[]
    return rows.reverse().map((r) => ({ id: r.id as string, role: r.role as DuoMessage['role'], text: r.text as string, kind: r.kind as DuoMessage['kind'], at: r.at as number }))
  }

  addMessage(role: DuoMessage['role'], text: string, kind: DuoMessage['kind'], at: number): DuoMessage {
    const message: DuoMessage = { id: randomUUID(), role, text, kind, at }
    this.db.prepare('INSERT INTO duo_messages (id, role, text, kind, at) VALUES (?, ?, ?, ?, ?)').run(message.id, role, text, kind, at)
    return message
  }

  // ---- outbox ----
  outbox(): OutboxItem[] {
    return (this.db.prepare('SELECT * FROM duo_outbox ORDER BY created_at DESC LIMIT 300').all() as Row[]).map(toItem)
  }

  item(id: string): OutboxItem | undefined {
    const row = this.db.prepare('SELECT * FROM duo_outbox WHERE id = ?').get(id) as Row | undefined
    return row ? toItem(row) : undefined
  }

  addItem(input: Omit<OutboxItem, 'id' | 'status' | 'error' | 'decidedAt' | 'sentAt'>): OutboxItem {
    const id = randomUUID().slice(0, 8)
    this.db
      .prepare(
        'INSERT INTO duo_outbox (id, kind, company, domain, to_addr, source, subject, body, follow_up_no, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.kind, input.company, input.domain, input.to, input.source, input.subject, input.body, input.followUpNo, input.note, 'pending', input.createdAt)
    return this.item(id)!
  }

  updateItem(id: string, patch: Partial<Pick<OutboxItem, 'subject' | 'body' | 'to' | 'status' | 'error' | 'decidedAt' | 'sentAt'>>): OutboxItem {
    const current = this.item(id)
    if (!current) throw new Error(`There is no Outbox item ${id}.`)
    const next = { ...current, ...patch }
    this.db
      .prepare('UPDATE duo_outbox SET subject = ?, body = ?, to_addr = ?, status = ?, error = ?, decided_at = ?, sent_at = ? WHERE id = ?')
      .run(next.subject, next.body, next.to, next.status, next.error, next.decidedAt, next.sentAt, id)
    return next
  }

  // ---- history ----
  history(): SentRecord[] {
    return (this.db.prepare('SELECT * FROM duo_sent ORDER BY at').all() as Row[]).map((r) => ({
      domain: r.domain as string,
      company: r.company as string,
      kind: r.kind as SentRecord['kind'],
      at: r.at as number
    }))
  }

  record(entry: SentRecord): void {
    this.db.prepare('INSERT INTO duo_sent (domain, company, kind, at) VALUES (?, ?, ?, ?)').run(entry.domain, entry.company, entry.kind, entry.at)
  }

  // ---- todos ----
  todos(): DuoTodo[] {
    return (this.db.prepare('SELECT * FROM duo_todos ORDER BY done, COALESCE(due, \'9999\'), created_at').all() as Row[]).map((r) => ({
      id: r.id as string,
      text: r.text as string,
      due: (r.due as string | null) ?? null,
      done: r.done === 1,
      source: r.source as string,
      createdAt: r.created_at as number
    }))
  }

  addTodo(text: string, due: string | null, source: string, at: number): DuoTodo {
    const id = randomUUID().slice(0, 8)
    this.db.prepare('INSERT INTO duo_todos (id, text, due, done, source, created_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, text, due, source, at)
    return this.todos().find((t) => t.id === id)!
  }

  setTodoDone(id: string, done: boolean): void {
    this.db.prepare('UPDATE duo_todos SET done = ? WHERE id = ?').run(done ? 1 : 0, id)
  }

  removeTodo(id: string): void {
    this.db.prepare('DELETE FROM duo_todos WHERE id = ?').run(id)
  }
}
