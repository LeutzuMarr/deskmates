import { vi } from 'vitest'
import type { Mock } from 'vitest'

/**
 * A stand-in for a live `opencode serve`.
 *
 * Enough of the real thing to drive the pool without spawning anything: the health probe, the event
 * stream, and the three endpoints a turn touches. The event stream is a real `ReadableStream` the
 * test pushes frames into, so the client's reconnect loop, frame splitting and abort handling are all
 * exercised for real rather than stubbed around.
 *
 * Every shape here was captured from opencode 1.18.18 on the development machine — see
 * `readSse` in src/core/terminals/opencode-server.ts for the contract these mocks encode.
 *
 * The message list deliberately answers `/message` **out of chronological order**, because that is
 * what the real server does: probed live against opencode 1.18.18, `?limit=2` over three messages
 * returned the third and the first, and `?limit=3` returned all three as second, third, first. A
 * mock that answered in order would let an ordering assumption through untested.
 */
export interface FakeOpenCode {
  fetch: Mock
  /** The `{model, system, parts}` bodies sent to `prompt_async`, in order. */
  prompts: Array<Record<string, any>>
  /** The bodies sent to `POST /session`. */
  sessions: Array<Record<string, any>>
  /** The `{providerID, modelID}` bodies sent to `/summarize`, in order. */
  summaries: Array<Record<string, any>>
  /** The message list `/session/:id/message` answers with, as the newest assistant message the pool
   *  should read tokens from. Set `summarized` to make that message a compaction summary. */
  setMessages: (messages: Array<Record<string, any>>) => void
  /** The context window `/config/providers` reports for the `opencode` provider's models. */
  setContextLimit: (limit: number | null) => void
  /** How many times the client opened `/event`. More than one means it reconnected. */
  streamOpens: () => number
  /** Whether `/event` is currently open. */
  streamOpen: () => boolean
  /** End the event stream, the way a server going away does. */
  close: () => void
  /** Push one event frame down the stream. */
  emit: (type: string, properties?: Record<string, unknown>) => void
  /** A whole single-step turn: the assistant message, its growing text part, the completed message
   *  that closes the *step*, and then `session.idle`, which is what actually ends the turn. */
  reply: (sessionId: string, text: string, partId?: string) => void
  /** A turn that uses a tool, exactly as opencode 1.18.18 sends it: one assistant message per step,
   *  each closed by its own completed message, and only then `session.idle`. Captured from a live
   *  server reading a file, where a single prompt produced *two* completed assistant messages. */
  toolTurn: (sessionId: string, tool: string, answer: string) => void
  /** Broadcast the prompt back the way a real server does — the user's `message.updated`, then a
   *  `message.part.updated` for it holding the prompt text. Captured from opencode 1.18.18; this is the
   *  echo that used to render the prompt as if the assistant had said it. */
  echoUser: (sessionId: string, text: string, messageId?: string) => void
  /** Close a step with a completed assistant message, and end the turn with `session.idle`. */
  complete: (sessionId: string, messageId?: string) => void
  /** `session.idle` on its own, for tests that need the turn to end at an exact moment. */
  idle: (sessionId: string) => void
  /** Report a mid-turn failure the way the server does. */
  error: (sessionId: string, message: string) => void
  /** Report one tool call, in a given state. */
  tool: (
    sessionId: string,
    partId: string,
    state: 'pending' | 'running' | 'completed' | 'error',
    extra?: Record<string, unknown>
  ) => void
  /** How many times `prompt_async` was called. */
  promptCount: () => number
  restore: () => void
}

export function fakeOpenCode(
  options: { healthy?: boolean; baseUrl?: string; summarizeStatus?: number; contextLimit?: number | null } = {}
): FakeOpenCode {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:41234'
  const prompts: Array<Record<string, any>> = []
  const sessions: Array<Record<string, any>> = []
  const summaries: Array<Record<string, any>> = []
  /** Defaults to one completed assistant turn, so `usage()` has something to read without every test
   *  having to build a conversation first. */
  let messages: Array<Record<string, any>> = [
    {
      info: {
        role: 'assistant',
        id: 'msg_1',
        sessionID: 'ses_1',
        time: { created: 1_790_000_000_000, completed: 1_790_000_001_000 },
        tokens: { total: 42_896, input: 40_952, output: 4, reasoning: 0, cache: { read: 1_940, write: 0 } }
      },
      parts: [{ id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'hi' }]
    }
  ]
  let opens = 0
  let open = 0
  /** Every open `/event` connection, because a real one is a broadcast: each client gets every event
   *  and filters by session itself. With one shared sink instead, a second folder's stream would
   *  silently steal the first's frames. */
  const sinks = new Set<(frame: string) => void>()
  const closers = new Set<() => void>()
  // A real server mints a new id per conversation, and a restarted one never reuses the old — which is
  // what lets a test tell "same conversation" from "new one" apart.
  let made = 0

  const emit = (type: string, properties?: Record<string, unknown>): void => {
    // A real SSE frame, prefix and all — `readSse` looks for `data:`, and a test double that skipped
    // it would pass while the client silently ignored every event.
    const frame = `data: ${JSON.stringify({ type, properties: properties ?? {} })}\n\n`
    for (const sink of [...sinks]) sink(frame)
  }

  const completedMessage = (session: string, messageId: string) => ({
    role: 'assistant',
    id: `msg_${messageId}`,
    sessionID: session,
    time: { created: 1_790_000_000_000, completed: 1_790_000_001_000 }
  })

  // A message frame with no `time.completed` — the assistant message as it is created, which a real
  // server sends before any of its parts.
  const openMessage = (session: string, role: string, messageId: string) => ({
    role,
    id: `msg_${messageId}`,
    sessionID: session,
    time: { created: 1_790_000_000_000 }
  })

  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined

    if (url.endsWith('/global/health')) {
      return new Response(JSON.stringify({ healthy: options.healthy !== false, version: '1.18.18' }), {
        status: 200
      })
    }

    if (url.endsWith('/event')) {
      opens += 1
      open += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          const sink = (frame: string): void => {
            try {
              controller.enqueue(encoder.encode(frame))
            } catch {
              sinks.delete(sink)
            }
          }
          const shut = (): void => {
            open -= 1
            sinks.delete(sink)
            closers.delete(shut)
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          }
          sinks.add(sink)
          closers.add(shut)
          // The first frame a real server sends, so the client sees the stream come alive.
          sink(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
          init?.signal?.addEventListener('abort', shut)
        },
        cancel() {
          open -= 1
        }
      })
      return new Response(stream, { status: 200 })
    }

    if (url.endsWith('/session') && method === 'POST') {
      sessions.push(body ?? {})
      made += 1
      return new Response(JSON.stringify({ id: `ses_${made}` }), { status: 200 })
    }

    if (url.includes('/prompt_async')) {
      prompts.push(body ?? {})
      return new Response(null, { status: 204 })
    }

    // The context meter's read. Answered in whatever order it is given rather than sorted, so a test
    // that doesn't sort by `time.created` picks the wrong message and fails.
    if (url.includes('/message')) {
      return new Response(JSON.stringify(messages), { status: 200 })
    }

    if (url.includes('/summarize')) {
      if (options.summarizeStatus && options.summarizeStatus !== 200) {
        return new Response('', { status: options.summarizeStatus })
      }
      summaries.push(body ?? {})
      return new Response(JSON.stringify(true), { status: 200 })
    }

    if (url.endsWith('/config/providers')) {
      const limit = options.contextLimit === undefined ? 200_000 : options.contextLimit
      return new Response(
        JSON.stringify({
          providers: [
            {
              id: 'opencode',
              name: 'opencode',
              models: limit === null ? {} : { 'big-pickle': { limit: { context: limit } } }
            }
          ],
          default: {}
        }),
        { status: 200 }
      )
    }

    if (url.includes('/abort')) return new Response(null, { status: 204 })

    return new Response('', { status: 404 })
  })

  vi.stubGlobal('fetch', fetchMock)

  return {
    fetch: fetchMock,
    prompts,
    sessions,
    summaries,
    setMessages: (next) => {
      messages = next
    },
    setContextLimit: (limit) => {
      options.contextLimit = limit
    },
    streamOpens: () => opens,
    streamOpen: () => open > 0,
    close: () => {
      for (const shut of [...closers]) shut()
    },
    emit,
    reply: (session, text, partId = 'prt_1') => {
      // The assistant message is announced before its parts, exactly as on the wire.
      emit('message.updated', { sessionID: session, info: openMessage(session, 'assistant', '1') })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: partId, messageID: 'msg_1', type: 'text', text }
      })
      emit('message.updated', { sessionID: session, info: completedMessage(session, '1') })
      emit('session.idle', { sessionID: session })
    },
    toolTurn: (session, tool, answer) => {
      // Step one: the model reaches for a file, and that step closes with its own completed message.
      emit('message.updated', { sessionID: session, info: openMessage(session, 'assistant', '1') })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: 'prt_s1', messageID: 'msg_1', type: 'step-start' }
      })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: 'prt_tool', messageID: 'msg_1', type: 'tool', tool, state: { status: 'running', input: {} } }
      })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: 'prt_tool', messageID: 'msg_1', type: 'tool', tool, state: { status: 'completed', input: {}, title: 'done' } }
      })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: 'prt_s1f', messageID: 'msg_1', type: 'step-finish' }
      })
      emit('message.updated', { sessionID: session, info: completedMessage(session, '1') })
      // Step two: a separate assistant message, and the only place the answer the user asked for
      // exists. Ending the turn on the completed message above throws all of this away — which is
      // what made a tool-using prompt look like it had stalled.
      emit('message.updated', { sessionID: session, info: openMessage(session, 'assistant', '2') })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: 'prt_s2', messageID: 'msg_2', type: 'step-start' }
      })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: 'prt_answer', messageID: 'msg_2', type: 'text', text: answer }
      })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: 'prt_s2f', messageID: 'msg_2', type: 'step-finish' }
      })
      emit('message.updated', { sessionID: session, info: completedMessage(session, '2') })
      emit('session.idle', { sessionID: session })
    },
    echoUser: (session, text, messageId = '0') => {
      emit('message.updated', { sessionID: session, info: openMessage(session, 'user', messageId) })
      emit('message.part.updated', {
        sessionID: session,
        part: { id: `prt_u${messageId}`, messageID: `msg_${messageId}`, type: 'text', text }
      })
    },
    complete: (session, messageId = '1') => {
      emit('message.updated', { sessionID: session, info: completedMessage(session, messageId) })
      emit('session.idle', { sessionID: session })
    },
    idle: (session) => {
      emit('session.idle', { sessionID: session })
    },
    error: (session, message) => {
      emit('session.error', { sessionID: session, error: message })
    },
    tool: (session, partId, state, extra = {}) => {
      emit('message.part.updated', {
        sessionID: session,
        part: {
          id: partId,
          messageID: 'msg_1',
          type: 'tool',
          tool: 'read',
          state: { status: state, input: {}, ...extra }
        }
      })
    },
    promptCount: () => prompts.length,
    restore: () => vi.unstubAllGlobals()
  }
}
