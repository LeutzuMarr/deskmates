/**
 * Duo's brain in the core: its profile, Outbox, to-do list, conversation, Start cards and runs.
 *
 * Runs on Freebuff start only from a user's tap (a Start card, "Send approved", or a message they
 * type): Freebuff forbids automated use, so nothing here ever types a prompt into it on a timer.
 * At the brief and check-in times Duo only shows a card and notifies; the tap is the prompt.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ToolLoopAgent, isStepCount, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type { DuoCard, DuoMessage, DuoProfile, DuoState, OutboxItem, OutboxKind, SentRecord } from '../../shared/duo'
import { DEFAULT_DUO_PROFILE } from '../../shared/duo'
import { isCliProvider, type ModelRef, type ProviderId } from '../../shared/protocol'
import { parseTime } from '../../shared/when'
import type { EventBus } from '../events'
import { bareDomain, checkOutboxAdd, sameCompany } from './limits'
import type { DuoStore } from './store'
import { DUO_BRIEF, startPrompt } from './brief'

const MAX_TURN_MESSAGES = 30

export interface DuoServiceDeps {
  store: DuoStore
  bus: EventBus
  getProfile: () => DuoProfile
  setProfile: (profile: DuoProfile) => void
  /** Prepares Duo's workspace (AGENTS.md, profile.md, mcp.json) and returns its folder. */
  workspace: (profile: DuoProfile) => string
  /** Runs one Freebuff turn in Duo's folder (TerminalsService.execute with trustAgents). */
  runCli: (provider: ProviderId, folder: string, prompt: string, modelId: string, signal: AbortSignal) => Promise<{ text: string; error?: string; stopped?: boolean }>
  /** Resolves an API model, for when Duo runs on one. */
  resolveModel: (ref: ModelRef) => { model: LanguageModel }
  /** Tools for an API-model run: the browser (as Duo), web search and the prompt reader. */
  apiTools: () => ToolSet
  /** The user's prompt's first section and index, for an API-model run. */
  operatingPrompt: () => string | null
  notify: (title: string, body: string) => void
  now?: () => number
}

export class DuoService {
  private cards: DuoCard[] = []
  private working: string | null = null
  private run: AbortController | null = null
  /** Slots already turned into cards today ("2026-11-05 07:30"), so each shows once. */
  private readonly done = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: DuoServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  profile(): DuoProfile {
    const stored = this.deps.getProfile()
    return { ...DEFAULT_DUO_PROFILE, ...stored, limits: { ...DEFAULT_DUO_PROFILE.limits, ...(stored.limits ?? {}) } }
  }

  updateProfile(patch: Partial<DuoProfile>): DuoState {
    const next = { ...this.profile(), ...patch }
    for (const time of [next.briefTime, ...next.checkIns, next.quietFrom, next.quietTo]) {
      if (!parseTime(time)) throw new Error(`"${time}" isn't a time; use HH:MM.`)
    }
    this.deps.setProfile(next)
    this.deps.workspace(next)
    return this.emit()
  }

  state(): DuoState {
    return {
      profile: this.profile(),
      messages: this.deps.store.messages(),
      outbox: this.deps.store.outbox(),
      todos: this.deps.store.todos(),
      cards: [...this.cards],
      working: this.working,
      nextAt: this.nextSlot()
    }
  }

  // ---- Outbox ----

  addOutbox(input: { kind: OutboxKind; company: string; domain: string; to: string; source?: string; subject?: string; body: string; followUpNo?: number | null; note?: string }): OutboxItem {
    const profile = this.profile()
    const item = {
      kind: input.kind,
      company: input.company.trim(),
      domain: bareDomain(input.domain),
      to: input.to.trim(),
      followUpNo: input.followUpNo ?? null
    }
    const problem = checkOutboxAdd({ item, history: this.deps.store.history(), queued: this.deps.store.outbox(), limits: profile.limits, doNotContact: profile.doNotContact, now: this.now() })
    if (problem) throw new Error(problem)
    if (!input.body.trim()) throw new Error('The message is empty.')
    const added = this.deps.store.addItem({
      ...item,
      source: input.source ?? '',
      subject: input.subject ?? '',
      body: input.body,
      note: input.note ?? '',
      createdAt: this.now()
    })
    this.emit()
    return added
  }

  /** The user's decision. Approving an item already approved or sent changes nothing; edits only while it waits. */
  decide(id: string, decision: 'approve' | 'skip' | 'edit', edits?: { subject?: string; body?: string; to?: string }): OutboxItem {
    const item = this.deps.store.item(id)
    if (!item) throw new Error('That item is no longer in the Outbox.')
    if (decision === 'edit') {
      if (item.status !== 'pending') throw new Error('Only a draft waiting for you can be edited.')
      const next = this.deps.store.updateItem(id, { ...edits })
      this.emit()
      return next
    }
    if (item.status !== 'pending') return item
    const next = this.deps.store.updateItem(id, { status: decision === 'approve' ? 'approved' : 'skipped', decidedAt: this.now() })
    this.emit()
    return next
  }

  approveAll(): number {
    const pending = this.deps.store.outbox().filter((i) => i.status === 'pending')
    for (const item of pending) this.deps.store.updateItem(item.id, { status: 'approved', decidedAt: this.now() })
    this.emit()
    return pending.length
  }

  /** The next approved item to send, oldest first. */
  nextApproved(): OutboxItem | null {
    return this.deps.store.outbox().filter((i) => i.status === 'approved').sort((a, b) => a.createdAt - b.createdAt)[0] ?? null
  }

  /** The browser's send rule for Duo: an approved email waiting for this site lets one Send through. */
  sendPermit(domain: string): { id: string; summary: string } | null {
    const profile = this.profile()
    const webmail = profile.email.webmailUrl ? bareDomain(profile.email.webmailUrl) : ''
    const approved = this.deps.store.outbox().filter((i) => i.status === 'approved' && i.kind !== 'linkedin')
    const item = approved.find((i) => (webmail && sameCompany(domain, webmail)) || sameCompany(domain, i.domain))
    return item ? { id: item.id, summary: `${item.kind} to ${item.to}` } : null
  }

  markSent(id: string): OutboxItem {
    const item = this.deps.store.item(id)
    if (!item) throw new Error('No such item.')
    if (item.status !== 'approved') throw new Error(`That item is ${item.status}, not approved, so it can't be marked sent.`)
    const sent = this.deps.store.updateItem(id, { status: 'sent', sentAt: this.now(), error: null })
    const kind: SentRecord['kind'] | null = item.kind === 'email' ? 'first' : item.kind === 'followup' ? 'followup' : item.kind === 'linkedin' ? 'linkedin' : null
    if (kind) this.deps.store.record({ domain: item.domain, company: item.company, kind, at: this.now() })
    this.emit()
    return sent
  }

  markFailed(id: string, error: string): OutboxItem {
    const next = this.deps.store.updateItem(id, { status: 'failed', error })
    this.emit()
    return next
  }

  /** A LinkedIn message filled in and waiting for the user to press Send themselves. */
  markWithUser(id: string): OutboxItem {
    const item = this.deps.store.item(id)
    if (!item || item.status !== 'approved') throw new Error('Only an approved item can be handed to the user.')
    const next = this.deps.store.updateItem(id, { status: 'with-user' })
    if (item.kind === 'linkedin') this.deps.store.record({ domain: item.domain, company: item.company, kind: 'linkedin', at: this.now() })
    this.deps.notify('Ready for you to send on LinkedIn', `${item.company}: the message is filled in. Open Deskmates' browser and press Send.`)
    this.emit()
    return next
  }

  /** A reply or bounce Duo found, or an email sent before Duo (imported history). */
  record(entry: { domain: string; company: string; kind: SentRecord['kind']; at?: number }): void {
    this.deps.store.record({ domain: bareDomain(entry.domain), company: entry.company, kind: entry.kind, at: entry.at ?? this.now() })
    this.emit()
  }

  // ---- to-dos and the thread ----

  addTodo(text: string, due: string | null, source: string): void {
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('due must be YYYY-MM-DD.')
    this.deps.store.addTodo(text.trim(), due, source, this.now())
    this.emit()
  }

  setTodoDone(id: string, done: boolean): void {
    this.deps.store.setTodoDone(id, done)
    this.emit()
  }

  removeTodo(id: string): void {
    this.deps.store.removeTodo(id)
    this.emit()
  }

  post(role: DuoMessage['role'], text: string, kind: DuoMessage['kind'] = 'chat'): DuoMessage {
    const message = this.deps.store.addMessage(role, text, kind, this.now())
    this.emit()
    return message
  }

  // ---- cards and runs ----

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.run?.abort()
  }

  /** At each brief or check-in time: a card, once, unless paused, not set up or in quiet hours. */
  tick(now = this.now()): void {
    const profile = this.profile()
    if (!profile.ready || profile.paused) return
    const date = new Date(now)
    const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
    const minutes = date.getHours() * 60 + date.getMinutes()
    const slots: Array<{ kind: DuoCard['kind']; time: string }> = [{ kind: 'brief', time: profile.briefTime }, ...profile.checkIns.map((time) => ({ kind: 'check-in' as const, time }))]
    for (const slot of slots) {
      const t = parseTime(slot.time)
      if (!t) continue
      const at = t.hour * 60 + t.minute
      const key = `${day} ${slot.kind} ${slot.time}`
      if (minutes < at || this.done.has(key)) continue
      this.done.add(key)
      // A check-in missed by more than two hours is dropped (the next one covers it); the brief waits all day.
      if (slot.kind === 'check-in' && minutes - at > 120) continue
      if (slot.kind === 'check-in' && this.inQuietHours(profile, minutes)) continue
      if (this.cards.some((c) => c.kind === slot.kind)) continue
      const slotTime = new Date(date.getFullYear(), date.getMonth(), date.getDate(), t.hour, t.minute).getTime()
      this.cards.push({ id: randomUUID().slice(0, 8), kind: slot.kind, at: slotTime })
      this.deps.notify(
        slot.kind === 'brief' ? 'Your morning brief is ready' : 'Time for a Duo check-in',
        'Open Duo and press Start. Duo only runs when you tap it.'
      )
      this.emit()
    }
  }

  dismissCard(id: string): DuoState {
    this.cards = this.cards.filter((c) => c.id !== id)
    return this.emit()
  }

  /** The user tapped Start on a card. A second tap, or a card already gone, does nothing. */
  async startCard(id: string): Promise<boolean> {
    const card = this.cards.find((c) => c.id === id)
    if (!card || this.working) return false
    this.cards = this.cards.filter((c) => c.id !== id)
    await this.turn(startPrompt(card.kind, new Date(this.now())), card.kind === 'brief' ? 'brief' : 'check-in', card.kind === 'brief' ? 'Morning brief' : 'Check-in')
    return true
  }

  /** The user's own message, or their "Send approved" tap. */
  async ask(text: string): Promise<void> {
    if (this.working) throw new Error('Duo is still working. Wait for it, or press Stop.')
    if (!text.trim()) return
    this.post('user', text.trim())
    await this.turn(text.trim(), 'chat', 'Answering you', true)
  }

  async sendApproved(): Promise<void> {
    if (!this.nextApproved()) throw new Error('Nothing approved is waiting to be sent.')
    await this.turn(startPrompt('send', new Date(this.now())), 'chat', 'Sending what you approved')
  }

  cancel(): void {
    this.run?.abort()
  }

  private async turn(prompt: string, kind: DuoMessage['kind'], label: string, alreadyPosted = false): Promise<void> {
    if (this.working) return
    const profile = this.profile()
    if (!profile.model) throw new Error('Pick the model Duo runs on in its settings.')
    if (!alreadyPosted) this.post('user', prompt, kind)
    const controller = new AbortController()
    this.run = controller
    this.working = label
    this.emit()
    try {
      const folder = this.deps.workspace(profile)
      const reply = isCliProvider(profile.model.provider)
        ? await this.cliTurn(profile.model, folder, prompt, controller.signal)
        : await this.apiTurn(profile.model, controller.signal)
      if (reply) this.post('duo', reply, kind)
      if (reply) this.deps.notify(kind === 'brief' ? 'Your morning brief' : 'Duo', reply.replace(/\s+/g, ' ').slice(0, 140))
    } catch (error) {
      if (!controller.signal.aborted) this.post('duo', `I couldn't finish: ${error instanceof Error ? error.message : String(error)}`, 'note')
    } finally {
      this.run = null
      this.working = null
      this.emit()
    }
  }

  private async cliTurn(model: ModelRef, folder: string, prompt: string, signal: AbortSignal): Promise<string> {
    const result = await this.deps.runCli(model.provider, folder, prompt, model.modelId, signal)
    if (result.stopped) return ''
    if (result.error) throw new Error(result.error)
    return result.text.trim()
  }

  private async apiTurn(model: ModelRef, signal: AbortSignal): Promise<string> {
    const { model: resolved } = this.deps.resolveModel(model)
    const operating = this.deps.operatingPrompt()
    const agent = new ToolLoopAgent({
      model: resolved,
      instructions: [operating, operating ? '---' : '', DUO_BRIEF.replace(/Read profile\.md in this folder/, 'The user’s details are in duo_profile').replace(/Read playbook\.md before any outreach/, 'Read the playbook with duo_playbook before any outreach')]
        .filter(Boolean)
        .join('\n\n'),
      tools: this.deps.apiTools(),
      stopWhen: [isStepCount(60)]
    })
    const history: ModelMessage[] = this.deps.store
      .messages(MAX_TURN_MESSAGES)
      .filter((m) => m.kind !== 'note')
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    const result = await agent.generate({ messages: history, abortSignal: signal })
    return result.text.trim()
  }

  private inQuietHours(profile: DuoProfile, minutes: number): boolean {
    const from = parseTime(profile.quietFrom)
    const to = parseTime(profile.quietTo)
    if (!from || !to) return false
    const a = from.hour * 60 + from.minute
    const b = to.hour * 60 + to.minute
    return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b
  }

  private nextSlot(): number | null {
    const profile = this.profile()
    if (!profile.ready || profile.paused) return null
    const now = new Date(this.now())
    const times = [profile.briefTime, ...profile.checkIns]
      .map(parseTime)
      .filter((t): t is { hour: number; minute: number } => t !== null)
      .flatMap((t) => [0, 1].map((d) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, t.hour, t.minute).getTime()))
      .filter((t) => t > now.getTime())
      .sort((a, b) => a - b)
    return times[0] ?? null
  }

  private emit(): DuoState {
    const state = this.state()
    this.deps.bus.emit({ type: 'duo.updated', state })
    return state
  }

  /** Where Duo's workspace lives under the data folder. */
  static folder(dataDir: string): string {
    return join(dataDir, 'duo', 'workspace')
  }
}
