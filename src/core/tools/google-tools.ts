/**
 * Gmail, Google Calendar and Google Drive for the Work tab's agent, under the names the user's
 * operating prompt teaches (mcp__Gmail__*, mcp__Google_Calendar__*, mcp__Google_Drive__*) and with
 * its input shapes, running on the Google account connected through GoogleAuth. Sending, replying,
 * forwarding, deleting, sharing and calendar changes ask the user first (see engine/approvals.ts).
 */
import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { jsonSchemaToZod } from '../connectors/schema'
import { promptToolSpecs } from '../engine/my-prompt'
import type { GoogleAuth } from '../google/auth'
import { htmlToText } from './web'

type Input = Record<string, any>
type Run = (input: Input, signal?: AbortSignal) => Promise<unknown>

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const MAX_TEXT = 60_000

/** The Google tools that change something for other people or can't be undone: they ask first. */
export const GOOGLE_RISKY_TOOLS = [
  'mcp__Gmail__send_message',
  'mcp__Gmail__reply',
  'mcp__Gmail__forward',
  'mcp__Gmail__delete_draft',
  'mcp__Gmail__delete_label',
  'mcp__Google_Calendar__create_event',
  'mcp__Google_Calendar__update_event',
  'mcp__Google_Calendar__delete_event',
  'mcp__Google_Calendar__respond_to_event',
  'mcp__Google_Drive__share_file',
  'mcp__Google_Drive__trash_file'
]

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(Boolean) : typeof value === 'string' && value ? value.split(',').map((v) => v.trim()).filter(Boolean) : [])

/** RFC 2047 encoding for a header holding non-ASCII text. */
const encodeHeader = (value: string): string => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`)
const base64url = (text: string | Buffer): string => Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64url = (data: string): string => Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

interface Mime {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  body?: string
  htmlBody?: string
  inReplyTo?: string
  references?: string
}

/** A plain-text (and optional HTML) email as base64url raw MIME, the form the Gmail API takes. */
export function buildRawEmail(mail: Mime): string {
  const headers: string[] = ['MIME-Version: 1.0']
  if (mail.to?.length) headers.push(`To: ${mail.to.join(', ')}`)
  if (mail.cc?.length) headers.push(`Cc: ${mail.cc.join(', ')}`)
  if (mail.bcc?.length) headers.push(`Bcc: ${mail.bcc.join(', ')}`)
  headers.push(`Subject: ${encodeHeader(mail.subject ?? '')}`)
  if (mail.inReplyTo) headers.push(`In-Reply-To: ${mail.inReplyTo}`)
  if (mail.references) headers.push(`References: ${mail.references}`)
  const text = mail.body ?? (mail.htmlBody ? htmlToText(mail.htmlBody).text : '')
  let content: string
  if (mail.htmlBody) {
    const boundary = `dm_${Date.now().toString(36)}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    content = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(mail.htmlBody, 'utf8').toString('base64'),
      `--${boundary}--`
    ].join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64')
    content = Buffer.from(text, 'utf8').toString('base64')
  }
  return base64url(`${headers.join('\r\n')}\r\n\r\n${content}`)
}

interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: Array<{ name: string; value: string }>
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}

/** A Gmail message in a form an agent can read: headers, labels and its text. */
export function readableMessage(message: { id?: string; threadId?: string; labelIds?: string[]; snippet?: string; payload?: GmailPart; internalDate?: string }, full = true): Record<string, unknown> {
  const headers = Object.fromEntries((message.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]))
  let plain = ''
  let html = ''
  const attachments: string[] = []
  const walk = (part: GmailPart | undefined): void => {
    if (!part) return
    if (part.filename) attachments.push(part.filename)
    else if (part.mimeType === 'text/plain' && part.body?.data && !plain) plain = fromBase64url(part.body.data)
    else if (part.mimeType === 'text/html' && part.body?.data && !html) html = fromBase64url(part.body.data)
    part.parts?.forEach(walk)
  }
  walk(message.payload)
  const body = plain || (html ? htmlToText(html).text : '')
  return {
    messageId: message.id,
    threadId: message.threadId,
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    subject: headers.subject,
    date: headers.date,
    labelIds: message.labelIds,
    snippet: message.snippet,
    ...(full ? { body: body.slice(0, MAX_TEXT) } : {}),
    ...(attachments.length ? { attachments } : {}),
    rfcMessageId: headers['message-id']
  }
}

/** Calendar time input: an RFC 3339 dateTime, or a plain date for all-day events. */
function eventTime(value: unknown, allDay: boolean, timeZone?: string): Record<string, string> | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value.slice(0, 10) }
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) }
}

function attendeesOf(input: Input, emailsKey: string, objectsKey: string): Array<{ email: string; optional?: boolean }> {
  const out = list(input[emailsKey]).map((email) => ({ email }))
  if (Array.isArray(input[objectsKey])) {
    for (const a of input[objectsKey] as Array<{ email?: string; optional?: boolean }>) if (a?.email) out.push({ email: a.email, ...(a.optional ? { optional: true } : {}) })
  }
  return out
}

const SEND_UPDATES: Record<string, string> = { NONE: 'none', EXTERNAL_ONLY: 'externalOnly', ALL: 'all' }

export function googleTools(auth: GoogleAuth, fetchImpl: typeof fetch = fetch): ToolSet {
  const call = async (method: string, url: string, body?: unknown, signal?: AbortSignal, raw = false): Promise<any> => {
    const token = await auth.accessToken()
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : raw ? (body as RequestInit['body']) : JSON.stringify(body),
      signal
    })
    if (response.status === 204) return { ok: true }
    const type = response.headers.get('content-type') ?? ''
    const data = /json/.test(type) ? await response.json().catch(() => ({})) : await response.text()
    if (!response.ok) {
      const message = typeof data === 'object' ? (data as { error?: { message?: string } }).error?.message : String(data).slice(0, 300)
      throw new Error(`Google answered ${response.status}: ${message ?? 'request failed'}`)
    }
    return data
  }
  const get = (url: string, signal?: AbortSignal) => call('GET', url, undefined, signal)
  const qs = (params: Record<string, unknown>): string => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)))
      else p.set(k, String(v))
    }
    const s = p.toString()
    return s ? `?${s}` : ''
  }
  const format = (input: Input): string => (input.messageFormat === 'MINIMAL' || input.messageFormat === 'METADATA' ? 'metadata' : 'full')
  const message = async (id: string, signal?: AbortSignal) => get(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, signal)
  const modifyMessage = (id: string, add: string[], remove: string[], signal?: AbortSignal) =>
    call('POST', `${GMAIL}/messages/${encodeURIComponent(id)}/modify`, { addLabelIds: add, removeLabelIds: remove }, signal)
  const modifyThread = (id: string, add: string[], remove: string[], signal?: AbortSignal) =>
    call('POST', `${GMAIL}/threads/${encodeURIComponent(id)}/modify`, { addLabelIds: add, removeLabelIds: remove }, signal)
  const mimeOf = (input: Input): Mime => ({ to: list(input.to), cc: list(input.cc), bcc: list(input.bcc), subject: input.subject, body: input.body, htmlBody: input.htmlBody })
  /** Reply or forward headers from the original message. */
  const quoteOf = async (id: string, signal?: AbortSignal) => {
    const original = readableMessage(await message(id, signal))
    return original as { threadId?: string; from?: string; to?: string; cc?: string; subject?: string; date?: string; body?: string; rfcMessageId?: string }
  }
  const driveFields = 'id,name,mimeType,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress),parents,description'
  const calendarId = (input: Input): string => encodeURIComponent(input.calendarId || 'primary')
  const eventBody = (input: Input, update: boolean): Record<string, unknown> => {
    const allDay = input.allDay === true
    const body: Record<string, unknown> = {}
    if (input.summary !== undefined || input.title !== undefined) body.summary = input.summary ?? input.title
    if (input.description !== undefined) body.description = input.description
    if (input.location !== undefined) body.location = input.location
    const start = eventTime(input.startTime, allDay, input.timeZone)
    const end = eventTime(input.endTime, allDay, input.timeZone)
    if (start) body.start = start
    if (end) body.end = end
    if (input.colorId) body.colorId = String(input.colorId)
    if (input.recurrence) body.recurrence = list(input.recurrence)
    if (input.visibility) body.visibility = String(input.visibility).replace(/^VISIBILITY_/, '').toLowerCase()
    if (input.availability) body.transparency = /FREE/.test(String(input.availability)) ? 'transparent' : 'opaque'
    if (!update) {
      const attendees = attendeesOf(input, 'attendeeEmails', 'attendees')
      if (attendees.length) body.attendees = attendees
    }
    if (input.addGoogleMeetUrl) body.conferenceData = { createRequest: { requestId: `dm-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    return body
  }

  const impl: Record<string, Run> = {
    // ---- Gmail ----
    mcp__Gmail__search_threads: async (input, signal) => {
      const found = await get(`${GMAIL}/threads${qs({ q: input.query, maxResults: Math.min(Number(input.pageSize) || 20, 50), pageToken: input.pageToken, includeSpamTrash: input.includeTrash })}`, signal)
      const threads = await Promise.all(
        (found.threads ?? []).map(async (t: { id: string }) => {
          const thread = await get(`${GMAIL}/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, signal)
          const msgs = (thread.messages ?? []) as Array<Parameters<typeof readableMessage>[0]>
          const last = msgs[msgs.length - 1]
          return { threadId: t.id, messages: msgs.length, latest: last ? readableMessage(last, false) : null }
        })
      )
      return { threads, nextPageToken: found.nextPageToken ?? null }
    },
    mcp__Gmail__get_thread: async (input, signal) => {
      const thread = await get(`${GMAIL}/threads/${encodeURIComponent(input.threadId)}?format=${format(input)}`, signal)
      return { threadId: thread.id, messages: (thread.messages ?? []).map((m: Parameters<typeof readableMessage>[0]) => readableMessage(m, format(input) === 'full')) }
    },
    mcp__Gmail__get_message: async (input, signal) => readableMessage(await get(`${GMAIL}/messages/${encodeURIComponent(input.messageId)}?format=${format(input)}`, signal), format(input) === 'full'),
    mcp__Gmail__list_labels: async (_input, signal) => ((await get(`${GMAIL}/labels`, signal)).labels ?? []).map((l: Record<string, unknown>) => ({ labelId: l.id, name: l.name, type: l.type })),
    mcp__Gmail__create_label: async (input, signal) =>
      call('POST', `${GMAIL}/labels`, { name: input.displayName, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, signal),
    mcp__Gmail__update_label: async (input, signal) => call('PATCH', `${GMAIL}/labels/${encodeURIComponent(input.labelId)}`, { ...(input.displayName ? { name: input.displayName } : {}) }, signal),
    mcp__Gmail__delete_label: async (input, signal) => call('DELETE', `${GMAIL}/labels/${encodeURIComponent(input.labelId)}`, undefined, signal),
    mcp__Gmail__label_message: async (input, signal) => modifyMessage(input.messageId, list(input.labelIds), [], signal),
    mcp__Gmail__unlabel_message: async (input, signal) => modifyMessage(input.messageId, [], list(input.labelIds), signal),
    mcp__Gmail__label_thread: async (input, signal) => modifyThread(input.threadId, list(input.labelIds), [], signal),
    mcp__Gmail__unlabel_thread: async (input, signal) => modifyThread(input.threadId, [], list(input.labelIds), signal),
    mcp__Gmail__update_message_labels: async (input, signal) => modifyMessage(input.messageId, list(input.addLabelIds), list(input.removeLabelIds), signal),
    mcp__Gmail__trash_message: async (input, signal) => call('POST', `${GMAIL}/messages/${encodeURIComponent(input.messageId)}/trash`, undefined, signal),
    mcp__Gmail__untrash_message: async (input, signal) => call('POST', `${GMAIL}/messages/${encodeURIComponent(input.messageId)}/untrash`, undefined, signal),
    mcp__Gmail__trash_thread: async (input, signal) => call('POST', `${GMAIL}/threads/${encodeURIComponent(input.threadId)}/trash`, undefined, signal),
    mcp__Gmail__untrash_thread: async (input, signal) => call('POST', `${GMAIL}/threads/${encodeURIComponent(input.threadId)}/untrash`, undefined, signal),
    mcp__Gmail__mark_message_spam: async (input, signal) => modifyMessage(input.messageId, ['SPAM'], ['INBOX'], signal),
    mcp__Gmail__unmark_message_spam: async (input, signal) => modifyMessage(input.messageId, ['INBOX'], ['SPAM'], signal),
    mcp__Gmail__mark_thread_spam: async (input, signal) => modifyThread(input.threadId, ['SPAM'], ['INBOX'], signal),
    mcp__Gmail__unmark_thread_spam: async (input, signal) => modifyThread(input.threadId, ['INBOX'], ['SPAM'], signal),
    mcp__Gmail__apply_sensitive_message_label: async (input, signal) =>
      input.labelOption === 'SPAM' ? modifyMessage(input.messageId, ['SPAM'], ['INBOX'], signal) : call('POST', `${GMAIL}/messages/${encodeURIComponent(input.messageId)}/trash`, undefined, signal),
    mcp__Gmail__apply_sensitive_thread_label: async (input, signal) =>
      input.labelOption === 'SPAM' ? modifyThread(input.threadId, ['SPAM'], ['INBOX'], signal) : call('POST', `${GMAIL}/threads/${encodeURIComponent(input.threadId)}/trash`, undefined, signal),
    mcp__Gmail__list_drafts: async (input, signal) => {
      const found = await get(`${GMAIL}/drafts${qs({ q: input.query, maxResults: Math.min(Number(input.pageSize) || 20, 50), pageToken: input.pageToken })}`, signal)
      const drafts = await Promise.all((found.drafts ?? []).map(async (d: { id: string }) => {
        const draft = await get(`${GMAIL}/drafts/${d.id}?format=metadata`, signal)
        return { draftId: d.id, ...readableMessage(draft.message ?? {}, false) }
      }))
      return { drafts, nextPageToken: found.nextPageToken ?? null }
    },
    mcp__Gmail__get_draft: async (input, signal) => {
      const draft = await get(`${GMAIL}/drafts/${encodeURIComponent(input.draftId)}?format=full`, signal)
      return { draftId: draft.id, ...readableMessage(draft.message ?? {}) }
    },
    mcp__Gmail__create_draft: async (input, signal) => {
      let thread: { threadId?: string; rfcMessageId?: string } = {}
      if (input.replyToMessageId) thread = await quoteOf(input.replyToMessageId, signal)
      const raw = buildRawEmail({ ...mimeOf(input), inReplyTo: thread.rfcMessageId, references: thread.rfcMessageId })
      const draft = await call('POST', `${GMAIL}/drafts`, { message: { raw, ...(thread.threadId ? { threadId: thread.threadId } : {}) } }, signal)
      return { draftId: draft.id, messageId: draft.message?.id, note: 'Saved as a draft in Gmail; nothing was sent.' }
    },
    mcp__Gmail__update_draft: async (input, signal) => {
      const draft = await call('PUT', `${GMAIL}/drafts/${encodeURIComponent(input.draftId)}`, { message: { raw: buildRawEmail(mimeOf(input)) } }, signal)
      return { draftId: draft.id, note: 'Draft updated; nothing was sent.' }
    },
    mcp__Gmail__delete_draft: async (input, signal) => call('DELETE', `${GMAIL}/drafts/${encodeURIComponent(input.draftId)}`, undefined, signal),
    mcp__Gmail__send_message: async (input, signal) => {
      if (input.draftId) {
        const sent = await call('POST', `${GMAIL}/drafts/send`, { id: input.draftId }, signal)
        return { sent: true, messageId: sent.id, threadId: sent.threadId }
      }
      let thread: { threadId?: string; rfcMessageId?: string } = {}
      if (input.replyToMessageId) thread = await quoteOf(input.replyToMessageId, signal)
      const raw = buildRawEmail({ ...mimeOf(input), inReplyTo: thread.rfcMessageId, references: thread.rfcMessageId })
      const sent = await call('POST', `${GMAIL}/messages/send`, { raw, ...(input.replyThreadId || thread.threadId ? { threadId: input.replyThreadId || thread.threadId } : {}) }, signal)
      return { sent: true, messageId: sent.id, threadId: sent.threadId }
    },
    mcp__Gmail__reply: async (input, signal) => {
      const original = await quoteOf(input.messageId, signal)
      const replyTo = list(input.to).length ? list(input.to) : [original.from ?? ''].filter(Boolean)
      const cc = list(input.cc).length ? list(input.cc) : input.replyAll ? list(original.cc ?? '').concat(list(original.to ?? '')) : []
      const subject = /^re:/i.test(original.subject ?? '') ? (original.subject as string) : `Re: ${original.subject ?? ''}`
      const raw = buildRawEmail({ to: replyTo, cc, bcc: list(input.bcc), subject, body: input.body, htmlBody: input.htmlBody, inReplyTo: original.rfcMessageId, references: original.rfcMessageId })
      const sent = await call('POST', `${GMAIL}/messages/send`, { raw, threadId: original.threadId }, signal)
      return { sent: true, messageId: sent.id, threadId: sent.threadId }
    },
    mcp__Gmail__forward: async (input, signal) => {
      const original = await quoteOf(input.messageId, signal)
      const subject = /^fwd?:/i.test(original.subject ?? '') ? (original.subject as string) : `Fwd: ${original.subject ?? ''}`
      const quoted = `${input.forwardText ? `${input.forwardText}\n\n` : ''}---------- Forwarded message ---------\nFrom: ${original.from ?? ''}\nDate: ${original.date ?? ''}\nSubject: ${original.subject ?? ''}\nTo: ${original.to ?? ''}\n\n${original.body ?? ''}`
      const raw = buildRawEmail({ to: list(input.to), cc: list(input.cc), bcc: list(input.bcc), subject, body: quoted })
      const sent = await call('POST', `${GMAIL}/messages/send`, { raw }, signal)
      return { sent: true, messageId: sent.id }
    },

    // ---- Google Calendar ----
    mcp__Google_Calendar__list_calendars: async (input, signal) => {
      const found = await get(`${CALENDAR}/users/me/calendarList${qs({ maxResults: input.pageSize, pageToken: input.pageToken })}`, signal)
      return { calendars: (found.items ?? []).map((c: Record<string, unknown>) => ({ calendarId: c.id, name: c.summary, primary: c.primary === true, accessRole: c.accessRole, timeZone: c.timeZone })), nextPageToken: found.nextPageToken ?? null }
    },
    mcp__Google_Calendar__list_events: async (input, signal) => {
      const found = await get(
        `${CALENDAR}/calendars/${calendarId(input)}/events${qs({ timeMin: input.startTime, timeMax: input.endTime, q: input.fullText, maxResults: Math.min(Number(input.pageSize) || 50, 250), pageToken: input.pageToken, singleEvents: true, orderBy: 'startTime', timeZone: input.timeZone, eventTypes: Array.isArray(input.eventType) ? input.eventType : undefined })}`,
        signal
      )
      return { events: (found.items ?? []).map(eventSummary), nextPageToken: found.nextPageToken ?? null, timeZone: found.timeZone }
    },
    mcp__Google_Calendar__search_events: async (input, signal) => {
      const found = await get(`${CALENDAR}/calendars/primary/events${qs({ q: input.query, maxResults: Math.min(Number(input.pageSize) || 25, 250), pageToken: input.pageToken, singleEvents: true })}`, signal)
      return { events: (found.items ?? []).map(eventSummary), nextPageToken: found.nextPageToken ?? null }
    },
    mcp__Google_Calendar__get_event: async (input, signal) => eventSummary(await get(`${CALENDAR}/calendars/${calendarId(input)}/events/${encodeURIComponent(input.eventId)}`, signal)),
    mcp__Google_Calendar__create_event: async (input, signal) => {
      const body = eventBody(input, false)
      const created = await call('POST', `${CALENDAR}/calendars/${calendarId(input)}/events${qs({ sendUpdates: SEND_UPDATES[String(input.notificationLevel ?? '').replace(/^NOTIFICATION_LEVEL_/, '')] ?? 'all', conferenceDataVersion: input.addGoogleMeetUrl ? 1 : undefined })}`, body, signal)
      return eventSummary(created)
    },
    mcp__Google_Calendar__update_event: async (input, signal) => {
      const body = eventBody(input, true)
      const added = attendeesOf(input, 'addedAttendeeEmails', 'addedAttendees')
      const removed = new Set(list(input.removedAttendeeEmails).map((e) => e.toLowerCase()))
      if (added.length || removed.size) {
        const current = await get(`${CALENDAR}/calendars/${calendarId(input)}/events/${encodeURIComponent(input.eventId)}`, signal)
        const attendees = ((current.attendees ?? []) as Array<{ email: string }>).filter((a) => !removed.has(a.email.toLowerCase()))
        body.attendees = [...attendees, ...added.filter((a) => !attendees.some((b) => b.email.toLowerCase() === a.email.toLowerCase()))]
      }
      const updated = await call('PATCH', `${CALENDAR}/calendars/${calendarId(input)}/events/${encodeURIComponent(input.eventId)}${qs({ sendUpdates: SEND_UPDATES[String(input.notificationLevel ?? '').replace(/^NOTIFICATION_LEVEL_/, '')] ?? 'all', conferenceDataVersion: input.addGoogleMeetUrl ? 1 : undefined })}`, body, signal)
      return eventSummary(updated)
    },
    mcp__Google_Calendar__delete_event: async (input, signal) =>
      call('DELETE', `${CALENDAR}/calendars/${calendarId(input)}/events/${encodeURIComponent(input.eventId)}${qs({ sendUpdates: SEND_UPDATES[String(input.notificationLevel ?? '').replace(/^NOTIFICATION_LEVEL_/, '')] ?? 'all' })}`, undefined, signal),
    mcp__Google_Calendar__respond_to_event: async (input, signal) => {
      const url = `${CALENDAR}/calendars/${calendarId(input)}/events/${encodeURIComponent(input.eventId)}`
      const event = await get(url, signal)
      const me = ((event.attendees ?? []) as Array<{ self?: boolean; email: string; responseStatus?: string; comment?: string }>)
      const status = String(input.responseStatus).replace(/^RESPONSE_STATUS_/, '').toLowerCase().replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())
      const attendees = me.map((a) => (a.self ? { ...a, responseStatus: status, ...(input.responseComment ? { comment: input.responseComment } : {}) } : a))
      if (!attendees.some((a) => a.self)) throw new Error("You aren't on this event's guest list, so there's nothing to answer.")
      return eventSummary(await call('PATCH', `${url}${qs({ sendUpdates: SEND_UPDATES[String(input.notificationLevel ?? '').replace(/^NOTIFICATION_LEVEL_/, '')] ?? 'all' })}`, { attendees }, signal))
    },
    mcp__Google_Calendar__suggest_time: async (input, signal) => {
      const emails = ['primary', ...list(input.attendeeEmails)]
      const busy = await call('POST', `${CALENDAR}/freeBusy`, { timeMin: input.startTime, timeMax: input.endTime, timeZone: input.timeZone, items: emails.map((id) => ({ id })) }, signal)
      const blocks = Object.values(busy.calendars ?? {}).flatMap((c: any) => (c.busy ?? []) as Array<{ start: string; end: string }>).map((b) => [Date.parse(b.start), Date.parse(b.end)] as const).sort((a, b) => a[0] - b[0])
      const duration = (Number(input.durationMinutes) || 30) * 60_000
      const slots: Array<{ start: string; end: string }> = []
      let cursor = Date.parse(input.startTime)
      const end = Date.parse(input.endTime)
      for (const [s, e] of [...blocks, [end, end] as const]) {
        while (cursor + duration <= Math.min(s, end) && slots.length < 10) {
          slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + duration).toISOString() })
          cursor += duration
        }
        cursor = Math.max(cursor, e)
        if (slots.length >= 10) break
      }
      return { freeSlots: slots, note: 'Free for everyone listed, in UTC; check working hours before proposing one.' }
    },

    // ---- Google Drive ----
    mcp__Google_Drive__search_files: async (input, signal) => {
      const raw = String(input.query ?? '').trim()
      const q = !raw ? 'trashed = false' : /\b(contains|=|!=|in parents|mimeType|modifiedTime)\b/.test(raw) ? raw : `fullText contains '${raw.replace(/'/g, "\\'")}' and trashed = false`
      const found = await get(`${DRIVE}/files${qs({ q, pageSize: Math.min(Number(input.pageSize) || 20, 100), pageToken: input.pageToken, fields: `nextPageToken,files(${driveFields})` })}`, signal)
      return { files: found.files ?? [], nextPageToken: found.nextPageToken ?? null }
    },
    mcp__Google_Drive__list_recent_files: async (input, signal) => {
      const found = await get(`${DRIVE}/files${qs({ q: 'trashed = false', orderBy: input.orderBy || 'viewedByMeTime desc', pageSize: Math.min(Number(input.pageSize) || 20, 100), pageToken: input.pageToken, fields: `nextPageToken,files(${driveFields})` })}`, signal)
      return { files: found.files ?? [], nextPageToken: found.nextPageToken ?? null }
    },
    mcp__Google_Drive__get_file_metadata: async (input, signal) => get(`${DRIVE}/files/${encodeURIComponent(input.fileId)}${qs({ fields: driveFields })}`, signal),
    mcp__Google_Drive__get_file_permissions: async (input, signal) => get(`${DRIVE}/files/${encodeURIComponent(input.fileId)}/permissions${qs({ fields: 'permissions(id,type,role,emailAddress,displayName)' })}`, signal),
    mcp__Google_Drive__read_file_content: async (input, signal) => {
      const meta = await get(`${DRIVE}/files/${encodeURIComponent(input.fileId)}${qs({ fields: 'id,name,mimeType,size' })}`, signal)
      const exportAs: Record<string, string> = {
        'application/vnd.google-apps.document': 'text/plain',
        'application/vnd.google-apps.spreadsheet': 'text/csv',
        'application/vnd.google-apps.presentation': 'text/plain'
      }
      const target = exportAs[meta.mimeType]
      const url = target ? `${DRIVE}/files/${meta.id}/export${qs({ mimeType: target })}` : `${DRIVE}/files/${meta.id}?alt=media`
      if (!target && !/^text\/|json|xml|csv|javascript/.test(meta.mimeType)) {
        return { name: meta.name, mimeType: meta.mimeType, note: 'This file isn\'t text. Use download_file_content to save it into the project and read it from there.' }
      }
      const text = String(await call('GET', url, undefined, signal))
      return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT }
    },
    mcp__Google_Drive__download_file_content: async (input, signal) => {
      const meta = await get(`${DRIVE}/files/${encodeURIComponent(input.fileId)}${qs({ fields: 'id,name,mimeType' })}`, signal)
      const url = /google-apps/.test(meta.mimeType) ? `${DRIVE}/files/${meta.id}/export${qs({ mimeType: input.exportMimeType || 'application/pdf' })}` : `${DRIVE}/files/${meta.id}?alt=media`
      const token = await auth.accessToken()
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal })
      if (!response.ok) throw new Error(`Google answered ${response.status} for the download.`)
      const buffer = Buffer.from(await response.arrayBuffer())
      return { name: meta.name, mimeType: response.headers.get('content-type'), bytes: buffer.length, base64: buffer.length <= 2_000_000 ? buffer.toString('base64') : undefined, note: buffer.length > 2_000_000 ? 'Too large to return; read it as text with read_file_content if it is a document.' : 'Base64 content; write it into the project with a file tool to use it.' }
    },
    mcp__Google_Drive__create_file: async (input, signal) => {
      const content = input.textContent ?? input.content ?? (input.base64Content ? Buffer.from(String(input.base64Content), 'base64') : '')
      const contentType = input.contentMimeType || (input.base64Content ? 'application/octet-stream' : 'text/plain')
      const metadata: Record<string, unknown> = { name: input.title, ...(input.parentId ? { parents: [input.parentId] } : {}) }
      if (input.mimeType) metadata.mimeType = input.mimeType
      else if (!input.disableConversionToGoogleType && contentType === 'text/plain') metadata.mimeType = 'application/vnd.google-apps.document'
      const boundary = `dm_${Date.now().toString(36)}`
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
        Buffer.from(`\r\n--${boundary}--`)
      ])
      const token = await auth.accessToken()
      const response = await fetchImpl(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(driveFields)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
        signal
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`Google answered ${response.status}: ${(data as { error?: { message?: string } }).error?.message ?? 'upload failed'}`)
      return data
    },
    mcp__Google_Drive__copy_file: async (input, signal) => call('POST', `${DRIVE}/files/${encodeURIComponent(input.fileId)}/copy${qs({ fields: driveFields })}`, { ...(input.title ? { name: input.title } : {}), ...(input.parentId ? { parents: [input.parentId] } : {}) }, signal),
    mcp__Google_Drive__update_file: async (input, signal) => {
      let addParents: string | undefined
      let removeParents: string | undefined
      if (input.parentId) {
        const meta = await get(`${DRIVE}/files/${encodeURIComponent(input.fileId)}?fields=parents`, signal)
        addParents = input.parentId
        removeParents = (meta.parents ?? []).join(',') || undefined
      }
      return call('PATCH', `${DRIVE}/files/${encodeURIComponent(input.fileId)}${qs({ addParents, removeParents, fields: driveFields })}`, { ...(input.title ? { name: input.title } : {}) }, signal)
    },
    mcp__Google_Drive__trash_file: async (input, signal) => call('PATCH', `${DRIVE}/files/${encodeURIComponent(input.fileId)}${qs({ fields: 'id,name,trashed' })}`, { trashed: true }, signal),
    mcp__Google_Drive__share_file: async (input, signal) =>
      call('POST', `${DRIVE}/files/${encodeURIComponent(input.fileId)}/permissions${qs({ sendNotificationEmail: true, fields: 'id,type,role,emailAddress' })}`, { type: 'user', role: String(input.role).toLowerCase().replace(/^role_/, ''), emailAddress: input.emailAddress }, signal)
  }

  const specs = promptToolSpecs()
  const out: ToolSet = {}
  for (const [name, run] of Object.entries(impl)) {
    const spec = specs.get(name)
    out[name] = tool({
      description: spec?.description || `${name.replace(/^mcp__/, '').replace(/__/g, ': ').replace(/_/g, ' ')} (the user's connected Google account).`,
      inputSchema: (spec?.schema ? jsonSchemaToZod(spec.schema) : z.looseObject({})) as z.ZodType<Input>,
      execute: async (input: Input, options: { abortSignal?: AbortSignal }) => run(input ?? {}, options.abortSignal)
    }) as Tool
  }
  return out
}

function eventSummary(e: Record<string, any>): Record<string, unknown> {
  return {
    eventId: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    allDay: Boolean(e.start?.date),
    location: e.location,
    description: typeof e.description === 'string' ? e.description.slice(0, 2000) : undefined,
    attendees: (e.attendees ?? []).map((a: Record<string, unknown>) => ({ email: a.email, responseStatus: a.responseStatus, self: a.self === true })),
    meetLink: e.hangoutLink,
    htmlLink: e.htmlLink,
    status: e.status,
    organizer: e.organizer?.email
  }
}
