import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CalendarClock, Check, Pause, Pencil, Play, Send, Settings2, Square, X } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { AssistantText } from '../components/Markdown'
import { BrandMark } from '../components/Mascot'
import { quickReplies } from '../../../shared/quick-replies'
import type { DuoProfile, DuoState, OutboxItem } from '../../../shared/duo'

async function call<T>(run: () => Promise<T>, toast: (m: string) => void): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

const KIND_LABEL: Record<OutboxItem['kind'], string> = { email: 'New pitch', followup: 'Follow-up', linkedin: 'LinkedIn', reply: 'Reply', other: 'Other' }
const clock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** "Your morning brief is ready · Start": every Freebuff run starts with this tap. */
function StartCards({ duo }: { duo: DuoState }): ReactNode {
  const toast = useStore((s) => s.showToast)
  if (duo.cards.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {duo.cards.map((card) => (
        <div key={card.id} className="msg-in flex items-center gap-3 rounded-3xl border border-clay/40 bg-card px-5 py-4">
          <CalendarClock size={20} className="shrink-0 text-clay" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="font-serif text-[18px]">{card.kind === 'brief' ? 'Your morning brief is ready' : 'Time for a check-in'}</div>
            <div className="text-[12px] text-ink-muted">Due {clock(card.at)}. Duo only runs when you tap Start.</div>
          </div>
          <button type="button" className="btn btn-text" onClick={() => void call(() => core.call('duo.dismiss', { cardId: card.id }), toast)}>
            Skip
          </button>
          <button
            type="button"
            className="btn btn-clay r-concentric"
            style={concentricVars(14)}
            disabled={Boolean(duo.working)}
            onClick={() => void call(() => core.call('duo.start', { cardId: card.id }), toast)}
          >
            <Play size={14} aria-hidden="true" /> Start
          </button>
        </div>
      ))}
    </div>
  )
}

function OutboxCard({ item }: { item: OutboxItem }): ReactNode {
  const toast = useStore((s) => s.showToast)
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(item.subject)
  const [body, setBody] = useState(item.body)
  const [open, setOpen] = useState(false)
  const decide = (decision: 'approve' | 'skip'): void => void call(() => core.call('duo.outbox.decide', { id: item.id, decision }), toast)
  const save = (): void =>
    void call(() => core.call('duo.outbox.decide', { id: item.id, decision: 'edit', subject, body }), toast).then(() => setEditing(false))
  const pending = item.status === 'pending'
  return (
    <li className="rounded-3xl border border-rule bg-card px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="font-serif text-[17px]">{item.company}</span>
          <span className="ml-2 rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-muted">{KIND_LABEL[item.kind]}{item.followUpNo ? ` #${item.followUpNo}` : ''}</span>
        </div>
        <span className={`shrink-0 text-[12px] ${item.status === 'failed' ? 'text-brick' : 'text-ink-faint'}`}>{item.status === 'with-user' ? 'waiting for you on LinkedIn' : item.status}</span>
      </div>
      <div className="mt-1 truncate text-[12px] text-ink-muted" title={item.source}>
        To {item.to}
        {item.note ? ` · ${item.note}` : ''}
      </div>
      {editing ? (
        <div className="mt-3 flex flex-col gap-2">
          {item.kind !== 'linkedin' && <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />}
          <textarea className="input min-h-[160px] resize-y" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
        </div>
      ) : (
        <button type="button" className="mt-2 block w-full text-left" onClick={() => setOpen(!open)}>
          {item.subject && <div className="text-[14px] font-medium text-ink">{item.subject}</div>}
          <div className={`whitespace-pre-wrap text-[13px] leading-relaxed text-ink-muted ${open ? '' : 'line-clamp-3'}`}>{item.body}</div>
        </button>
      )}
      {item.error && <div className="mt-2 text-[12px] text-brick">{item.error}</div>}
      {pending && (
        <div className="mt-3 flex justify-end gap-2">
          {editing ? (
            <>
              <button type="button" className="btn btn-text" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-ivory r-concentric" style={concentricVars(14)} onClick={save}>
                Save
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-text" onClick={() => decide('skip')}>
                <X size={14} aria-hidden="true" /> Skip
              </button>
              <button type="button" className="btn btn-outline r-concentric" style={concentricVars(14)} onClick={() => setEditing(true)}>
                <Pencil size={13} aria-hidden="true" /> Edit
              </button>
              <button type="button" className="btn btn-clay r-concentric" style={concentricVars(14)} onClick={() => decide('approve')}>
                <Check size={14} aria-hidden="true" /> Approve
              </button>
            </>
          )}
        </div>
      )}
    </li>
  )
}

function Outbox({ duo }: { duo: DuoState }): ReactNode {
  const toast = useStore((s) => s.showToast)
  const [showDone, setShowDone] = useState(false)
  const pending = duo.outbox.filter((i) => i.status === 'pending')
  const approved = duo.outbox.filter((i) => i.status === 'approved')
  const rest = duo.outbox.filter((i) => i.status !== 'pending' && i.status !== 'approved')
  if (duo.outbox.length === 0) return null
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-2">
        <h2 className="caption">
          Outbox · {pending.length} waiting for you{approved.length ? ` · ${approved.length} approved` : ''}
        </h2>
        <div className="flex gap-2">
          {pending.length > 1 && (
            <button type="button" className="btn btn-outline r-concentric" style={concentricVars(14)} onClick={() => void call(() => core.call('duo.outbox.approveAll', {}), toast)}>
              Approve all
            </button>
          )}
          {approved.length > 0 && (
            <button
              type="button"
              className="btn btn-clay r-concentric"
              style={concentricVars(14)}
              disabled={Boolean(duo.working)}
              onClick={() => void call(() => core.call('duo.sendApproved', {}), toast)}
            >
              <Send size={13} aria-hidden="true" /> Send approved ({approved.length})
            </button>
          )}
        </div>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {[...pending, ...approved].map((item) => (
          <OutboxCard key={item.id} item={item} />
        ))}
      </ul>
      {rest.length > 0 && (
        <button type="button" className="btn btn-text mt-2" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hide' : 'Show'} {rest.length} sent, skipped or failed
        </button>
      )}
      {showDone && (
        <ul className="mt-2 flex flex-col gap-2 opacity-80">
          {rest.slice(0, 40).map((item) => (
            <OutboxCard key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Thread({ duo }: { duo: DuoState }): ReactNode {
  const toast = useStore((s) => s.showToast)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [duo.messages.length, duo.working])
  const last = duo.messages.at(-1)
  const replies = last?.role === 'duo' && !duo.working ? quickReplies(last.text) : null
  return (
    <section className="mt-8 flex flex-col gap-4">
      {duo.messages.length === 0 && !duo.working && (
        <p className="text-[13px] text-ink-faint">Nothing yet. Your morning brief arrives here, or ask Duo anything below.</p>
      )}
      {duo.messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="flex justify-end">
            <div className="user-bubble max-w-[80%] whitespace-pre-wrap">{m.text}</div>
          </div>
        ) : (
          <div key={m.id} className="flex gap-3">
            <div className="mt-1 shrink-0">
              <BrandMark size={20} />
            </div>
            <div className={`min-w-0 flex-1 ${m.kind === 'brief' ? 'rounded-3xl border border-rule bg-card px-5 py-4' : ''}`}>
              {m.kind === 'brief' && <div className="caption mb-2">Morning brief · {clock(m.at)}</div>}
              <AssistantText text={m.text} />
            </div>
          </div>
        )
      )}
      {replies && (
        <div className="ml-8 flex flex-wrap gap-2">
          {replies.options.map((option) => (
            <button key={option} type="button" className="btn btn-outline r-concentric" style={concentricVars(14)} onClick={() => void call(() => core.call('duo.ask', { text: option }), toast)}>
              {option}
            </button>
          ))}
        </div>
      )}
      {duo.working && (
        <div className="flex items-center gap-3 text-[13px] text-ink-muted">
          <BrandMark size={20} working />
          <span>{duo.working}…</span>
        </div>
      )}
      <div ref={end} />
    </section>
  )
}

function Composer({ duo }: { duo: DuoState }): ReactNode {
  const toast = useStore((s) => s.showToast)
  const [text, setText] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!text.trim()) return
    void call(() => core.call('duo.ask', { text }), toast).then((ok) => {
      if (ok) setText('')
    })
  }
  return (
    <form className="sticky bottom-0 mt-6 flex items-end gap-2 bg-canvas pb-6 pt-2" onSubmit={submit}>
      <textarea
        className="input min-h-[48px] flex-1 resize-none"
        rows={2}
        placeholder={duo.working ? 'Duo is working…' : 'Ask Duo anything, or tell it what to do'}
        value={text}
        disabled={Boolean(duo.working)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e)
        }}
        aria-label="Message Duo"
      />
      {duo.working ? (
        <button type="button" className="btn btn-outline r-concentric" style={concentricVars(16)} onClick={() => void call(() => core.call('duo.cancel', {}), toast)}>
          <Square size={13} aria-hidden="true" /> Stop
        </button>
      ) : (
        <button type="submit" className="btn btn-clay r-concentric" style={concentricVars(16)} disabled={!text.trim()}>
          <Send size={14} aria-hidden="true" />
        </button>
      )}
    </form>
  )
}

const FREEBUFF_MODEL = { provider: 'freebuff' as const, modelId: 'current' }

function Setup({ duo, onDone }: { duo: DuoState; onDone: () => void }): ReactNode {
  const toast = useStore((s) => s.showToast)
  const setBrowserOpen = useStore((s) => s.setBrowserOpen)
  const [p, setP] = useState<DuoProfile>(duo.profile)
  const field = 'input w-full'
  const set = <K extends keyof DuoProfile>(key: K, value: DuoProfile[K]): void => setP((prev) => ({ ...prev, [key]: value }))
  const save = (event: FormEvent): void => {
    event.preventDefault()
    void call(() => core.call('duo.profile.update', { patch: { ...p, model: p.model ?? FREEBUFF_MODEL, ready: true } }), toast).then((ok) => {
      if (ok) onDone()
    })
  }
  const signIn = (url: string): void => {
    if (!url) return
    void call(() => core.call('browser.tool', { name: 'browser_open', input: { url } }), toast).then(() => setBrowserOpen(true))
  }
  const row = (label: string, child: ReactNode): ReactNode => (
    <label className="flex flex-col gap-1 text-[13px] text-ink-muted">
      {label}
      {child}
    </label>
  )
  return (
    <form className="mt-6 flex flex-col gap-4 rounded-3xl border border-rule bg-card p-6" onSubmit={save}>
      <div className="font-serif text-[20px]">{duo.profile.ready ? 'Duo settings' : 'Set up Duo'}</div>
      <p className="text-[13px] text-ink-muted">
        Duo prepares your outreach, school work and day in the background. It drafts; you approve. Nothing goes out in your name without your yes, and on LinkedIn you press Send yourself.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {row('Your name', <input className={field} value={p.name} onChange={(e) => set('name', e.target.value)} />)}
        {row('About you', <input className={field} value={p.about} placeholder="Student at …, founder of …" onChange={(e) => set('about', e.target.value)} />)}
        {row('School', <input className={field} value={p.school.name} onChange={(e) => set('school', { ...p.school, name: e.target.value })} />)}
        {row('School website (homework, tests)', <input className={field} value={p.school.url} placeholder="https://…" onChange={(e) => set('school', { ...p.school, url: e.target.value })} />)}
        {row('Company', <input className={field} value={p.company.name} onChange={(e) => set('company', { ...p.company, name: e.target.value })} />)}
        {row('Company website', <input className={field} value={p.company.url} onChange={(e) => set('company', { ...p.company, url: e.target.value })} />)}
        {row('Email you pitch from', <input className={field} value={p.email.address} onChange={(e) => set('email', { ...p.email, address: e.target.value })} />)}
        {row('Webmail address', <input className={field} value={p.email.webmailUrl} placeholder="https://mail.zoho.eu" onChange={(e) => set('email', { ...p.email, webmailUrl: e.target.value })} />)}
        {row('Your LinkedIn', <input className={field} value={p.linkedinUrl} onChange={(e) => set('linkedinUrl', e.target.value)} />)}
        {row('Morning brief at', <input type="time" className={field} value={p.briefTime} onChange={(e) => set('briefTime', e.target.value)} />)}
        {row('Check-ins at (comma separated)', <input className={field} value={p.checkIns.join(', ')} onChange={(e) => set('checkIns', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} />)}
        {row('Quiet from – to', (
          <div className="flex gap-2">
            <input type="time" className={field} value={p.quietFrom} onChange={(e) => set('quietFrom', e.target.value)} />
            <input type="time" className={field} value={p.quietTo} onChange={(e) => set('quietTo', e.target.value)} />
          </div>
        ))}
        {row('Never contact (comma separated)', <input className={field} value={p.doNotContact.join(', ')} onChange={(e) => set('doNotContact', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} />)}
        {row('Model', (
          <select
            className={field}
            value={p.model?.provider === 'freebuff' || !p.model ? 'freebuff' : 'default'}
            onChange={(e) => set('model', e.target.value === 'freebuff' ? FREEBUFF_MODEL : null)}
          >
            <option value="freebuff">Freebuff (each run starts with your tap)</option>
            <option value="default">Deskmates' default model</option>
          </select>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
        Sign in once in Duo's browser:
        <button type="button" className="btn btn-outline" onClick={() => signIn(p.email.webmailUrl)} disabled={!p.email.webmailUrl}>Email</button>
        <button type="button" className="btn btn-outline" onClick={() => signIn('https://www.linkedin.com/login')}>LinkedIn</button>
        <button type="button" className="btn btn-outline" onClick={() => signIn(p.school.url)} disabled={!p.school.url}>School</button>
      </div>
      <div className="flex justify-end gap-2">
        {duo.profile.ready && (
          <button type="button" className="btn btn-text" onClick={onDone}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-clay r-concentric" style={concentricVars(16)}>
          {duo.profile.ready ? 'Save' : 'Start using Duo'}
        </button>
      </div>
    </form>
  )
}

export function DuoView(): ReactNode {
  const duo = useStore((s) => s.duo)
  const toast = useStore((s) => s.showToast)
  const [settings, setSettings] = useState(false)
  if (!duo) return <main className="flex h-full items-center justify-center text-[13px] text-ink-faint">Connecting to Duo…</main>
  const setup = !duo.profile.ready || settings
  const status = duo.working
    ? `Working: ${duo.working}`
    : duo.profile.paused
      ? 'Paused'
      : duo.nextAt
        ? `Next: ${new Date(duo.nextAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
        : ''
  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col px-6 pt-8 md:px-8">
        <header className="flex items-center gap-3">
          <BrandMark size={28} working={Boolean(duo.working)} />
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-[30px] leading-tight">Duo</h1>
            <div className="text-[12px] text-ink-muted">{status}</div>
          </div>
          {duo.profile.ready && (
            <>
              <button
                type="button"
                className="btn-icon"
                aria-pressed={duo.profile.paused}
                aria-label={duo.profile.paused ? 'Resume Duo' : 'Pause Duo'}
                title={duo.profile.paused ? 'Resume' : 'Pause'}
                onClick={() => void call(() => core.call('duo.profile.update', { patch: { paused: !duo.profile.paused } }), toast)}
              >
                {duo.profile.paused ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button type="button" className="btn-icon" aria-label="Duo settings" title="Settings" onClick={() => setSettings(!settings)}>
                <Settings2 size={16} />
              </button>
            </>
          )}
        </header>
        {setup ? (
          <Setup duo={duo} onDone={() => setSettings(false)} />
        ) : (
          <>
            <div className="mt-6">
              <StartCards duo={duo} />
            </div>
            <Outbox duo={duo} />
            <Thread duo={duo} />
            <div className="flex-1" />
            <Composer duo={duo} />
          </>
        )}
      </div>
    </main>
  )
}

/** The sidebar beside Duo: its to-do list. */
export function DuoSidebar(): ReactNode {
  const duo = useStore((s) => s.duo)
  const toast = useStore((s) => s.showToast)
  const todos = duo?.todos ?? []
  return (
    <aside className="flex h-full flex-col gap-2 overflow-y-auto px-3 py-4">
      <div className="caption px-2">To do</div>
      {todos.length === 0 && <p className="px-2 text-[12px] text-ink-faint">Homework, tests and replies Duo finds land here.</p>}
      <ul className="flex flex-col gap-1">
        {todos.map((t) => (
          <li key={t.id} className="group flex items-start gap-2 rounded-xl px-2 py-1.5 hover:bg-ink/5">
            <input type="checkbox" className="checkbox mt-0.5" checked={t.done} onChange={(e) => void call(() => core.call('duo.todo.done', { id: t.id, done: e.target.checked }), toast)} aria-label={t.text} />
            <div className={`min-w-0 flex-1 text-[13px] ${t.done ? 'text-ink-faint line-through' : 'text-ink'}`}>
              {t.text}
              {t.due && <div className="text-[11px] text-ink-muted">due {t.due}</div>}
            </div>
            <button type="button" className="text-ink-faint opacity-0 group-hover:opacity-100" aria-label="Remove" onClick={() => void call(() => core.call('duo.todo.remove', { id: t.id }), toast)}>
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
