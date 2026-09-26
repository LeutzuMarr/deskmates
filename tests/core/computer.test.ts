import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { ModelMessage } from 'ai'
import { APICallError, simulateReadableStream } from 'ai'
import { ComputerUseService, actionFromText, explainModelError, inPixels, lessThinking, perform, pruneScreenshots, retryPlan, toScreen, webAddress } from '../../src/core/computer/service'
import { encodeCommand } from '../../src/core/computer/desktop'
import type { Desktop, Screenshot } from '../../src/core/computer/desktop'
import type { CoreEvent } from '../../src/shared/protocol'

const SHOT: Screenshot = { data: 'AAAA', width: 1280, height: 720, screenWidth: 1920, screenHeight: 1080 }
const USAGE = { inputTokens: { total: 10 }, outputTokens: { total: 5 } } as any

function fakeDesktop() {
  const calls: string[] = []
  const desktop: Desktop = {
    screenshot: vi.fn(async () => SHOT),
    move: vi.fn(async (x, y) => void calls.push(`move ${x},${y}`)),
    click: vi.fn(async (x, y, button, count) => void calls.push(`click ${x},${y} ${button} x${count}`)),
    drag: vi.fn(async (a, b, c, d) => void calls.push(`drag ${a},${b}->${c},${d}`)),
    scroll: vi.fn(async (x, y, amount) => void calls.push(`scroll ${x},${y} ${amount}`)),
    type: vi.fn(async (text) => void calls.push(`type ${text}`)),
    key: vi.fn(async (combo) => void calls.push(`key ${combo}`)),
    openUrl: vi.fn(async (url) => void calls.push(`openUrl ${url}`)),
    close: vi.fn()
  }
  return { desktop, calls }
}

/** Stream chunks for one model turn: a tool call, or a plain text reply. */
function turn(step: { tool?: Record<string, unknown>; text?: string }, id: string): any[] {
  if (step.tool) {
    return [
      { type: 'tool-call', toolCallId: id, toolName: 'computer', input: JSON.stringify(step.tool) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE }
    ]
  }
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: step.text ?? '' },
    { type: 'text-end', id },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE }
  ]
}

function scripted(steps: Array<{ tool?: Record<string, unknown>; text?: string }>) {
  let n = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[n++]
      if (!step) throw new Error('model called too many times')
      return { stream: simulateReadableStream({ chunks: turn(step, `c${n}`) }) } as any
    }
  })
}

function service(model: MockLanguageModelV4, desktop: Desktop, cli = false) {
  const events: CoreEvent[] = []
  const active: boolean[] = []
  const svc = new ComputerUseService({
    bus: { emit: (event: CoreEvent) => events.push(event) } as any,
    models: { resolve: () => ({ model, provider: 'google', modelId: 'gemini-test', cli }) } as any,
    createDesktop: () => desktop,
    onActiveChange: (value) => active.push(value),
    sleep: async () => undefined
  })
  return { svc, events, active }
}

async function settle(svc: ComputerUseService): Promise<void> {
  for (let i = 0; i < 50 && svc.isRunning(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('ComputerUseService', () => {
  it('runs the see-act loop, scales clicks to the real screen, and finishes on a plain reply', async () => {
    const { desktop, calls } = fakeDesktop()
    const model = scripted([
      { tool: { action: 'click', x: 640, y: 360 } },
      { tool: { action: 'type', text: 'hello' } },
      { text: 'Typed hello into the box.' }
    ])
    const { svc, events, active } = service(model, desktop)
    svc.start('type hello', null)
    await settle(svc)

    expect(calls).toEqual(['click 960,540 left x1', 'type hello'])
    const session = svc.current()!
    expect(session.status).toBe('done')
    expect(session.steps.at(-1)).toMatchObject({ kind: 'done', text: 'Typed hello into the box.' })
    expect(session.screenshot).toBe('data:image/jpeg;base64,AAAA')
    expect(active).toEqual([true, false])
    expect(events.some((e) => e.type === 'notify')).toBe(true)
    expect(desktop.close).toHaveBeenCalled()
    // Every step after the first gets a fresh screenshot as a user message.
    const prompt = model.doStreamCalls[2].prompt
    expect(prompt.filter((m) => m.role === 'user')).toHaveLength(3)
  })

  it('refuses CLI providers, empty prompts, and a second session', () => {
    const { desktop } = fakeDesktop()
    expect(() => service(scripted([]), desktop, true).svc.start('x', null)).toThrow(/see images/)
    const { svc } = service(scripted([{ tool: { action: 'wait' } }, { text: 'ok' }]), desktop)
    expect(() => svc.start('  ', null)).toThrow(/Describe/)
    svc.start('go', null)
    expect(() => svc.start('again', null)).toThrow(/already running/)
  })

  it('stop() ends the session as stopped and hands control back', async () => {
    const { desktop } = fakeDesktop()
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) =>
        new Promise((_, reject) => abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    const { svc, active } = service(model, desktop)
    svc.start('long task', null)
    await new Promise((resolve) => setTimeout(resolve, 10))
    svc.stop()
    await settle(svc)
    expect(svc.current()!.status).toBe('stopped')
    expect(active).toEqual([true, false])
  })
})

describe('models that misbehave', () => {
  it('reminds a model that answers in words to act, then carries on', async () => {
    const { desktop, calls } = fakeDesktop()
    const model = scripted([{ text: 'I will open the Start menu.' }, { tool: { action: 'key', keys: 'win' } }, { text: 'Opened it.' }])
    const { svc } = service(model, desktop)
    svc.start('open start', null)
    await settle(svc)
    expect(calls).toEqual(['key win'])
    expect(svc.current()!.status).toBe('done')
    expect(svc.current()!.steps.some((s) => s.text.includes('asking it to use the mouse and keyboard'))).toBe(true)
  })

  it('gives up with a clear reason when a model never acts', async () => {
    const { desktop } = fakeDesktop()
    const { svc } = service(scripted([{ text: 'a' }, { text: 'b' }, { text: 'c' }]), desktop)
    svc.start('do it', null)
    await settle(svc)
    expect(svc.current()!.status).toBe('error')
    expect(svc.current()!.steps.at(-1)!.text).toMatch(/can’t call tools/)
  })

  it('hands an invalid action back to the model as an error it can correct', async () => {
    const { desktop, calls } = fakeDesktop()
    const model = scripted([{ tool: { action: 'left_click', x: 5, y: 5 } }, { tool: { action: 'click', x: 5, y: 5 } }, { text: 'Clicked.' }])
    const { svc } = service(model, desktop)
    svc.start('click', null)
    await settle(svc)
    expect(calls).toEqual(['click 8,8 left x1'])
    expect(svc.current()!.status).toBe('done')
    expect(svc.current()!.steps.some((s) => s.kind === 'error' && s.text.includes("isn't a valid action"))).toBe(true)
  })

  it('runs an action the provider returned as text', async () => {
    const { desktop, calls } = fakeDesktop()
    const model = scripted([{ text: 'Sure:\n```json\n{"action": "type", "text": "hi"}\n```' }, { text: 'Typed.' }])
    const { svc } = service(model, desktop)
    svc.start('type hi', null)
    await settle(svc)
    expect(calls).toEqual(['type hi'])
    expect(svc.current()!.status).toBe('done')
  })

  it('waits out a rate limit and retries, but explains a missing model', async () => {
    const { desktop, calls } = fakeDesktop()
    let n = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n++
        if (n === 1) {
          throw new APICallError({ message: 'Too Many Requests', url: 'u', requestBodyValues: {}, statusCode: 429, responseBody: '{"retryDelay": "2s"}' })
        }
        const step = n === 2 ? { tool: { action: 'key', keys: 'enter' } } : { text: 'ok' }
        return { stream: simulateReadableStream({ chunks: turn(step, `r${n}`) }) } as any
      }
    })
    const { svc } = service(model, desktop)
    svc.start('press enter', null)
    await settle(svc)
    expect(calls).toEqual(['key enter'])
    expect(svc.current()!.steps.some((s) => s.text.includes('limiting how fast requests'))).toBe(true)

    const missing = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({ message: 'Not Found', url: 'u', requestBodyValues: {}, statusCode: 404, responseBody: '404 page not found' })
      }
    })
    const second = service(missing, fakeDesktop().desktop)
    second.svc.start('x', null)
    await settle(second.svc)
    expect(second.svc.current()!.steps.at(-1)!.text).toMatch(/can't use gemini-test/)
  })

  it('plans retries only for short waits and explains common failures', () => {
    const limited = (body: string) => new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 429, responseBody: body })
    expect(retryPlan(limited('{"retryDelay": "30s"}'), 0)?.waitMs).toBe(30000)
    expect(retryPlan(limited('{"retryDelay": "3600s"}'), 0)).toBeNull()
    const full = new APICallError({
      message: 'ResourceExhausted: Worker local total request limit reached (16/16)',
      url: 'u',
      requestBodyValues: {},
      statusCode: 503
    })
    expect(retryPlan(full, 0)).toMatchObject({ waitMs: 5000, busy: true })
    expect(retryPlan(full, 3)?.waitMs).toBe(40000)
    expect(retryPlan(full, 9)?.waitMs).toBe(60000)
    expect(retryPlan(full, 20, 9.5 * 60_000)).toBeNull()
    expect(explainModelError(full, 'm', 10 * 60_000)).toMatch(/stayed full for 10m 00s/)
    expect(retryPlan(new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 500 }), 3)).toBeNull()
    const bad = new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 400, responseBody: 'image_url is not supported' })
    expect(explainModelError(bad, 'm')).toMatch(/can't read screenshots/)
    expect(explainModelError(new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 401 }), 'm')).toMatch(/refused your API key/)
  })

  it('waits out a full server with one updating log line, then carries on', async () => {
    const { desktop, calls } = fakeDesktop()
    let n = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n++
        if (n <= 3) {
          throw new APICallError({ message: 'ResourceExhausted: Worker local total request limit reached (16/16)', url: 'u', requestBodyValues: {}, statusCode: 503 })
        }
        const step = n === 4 ? { tool: { action: 'key', keys: 'enter' } } : { text: 'Done.' }
        return { stream: simulateReadableStream({ chunks: turn(step, `b${n}`) }) } as any
      }
    })
    const { svc } = service(model, desktop)
    svc.start('press enter', null)
    await settle(svc)
    expect(calls).toEqual(['key enter'])
    expect(svc.current()!.status).toBe('done')
    const waits = svc.current()!.steps.filter((s) => s.text.includes('servers for this model are full'))
    expect(waits).toHaveLength(1)
    expect(waits[0].text).toMatch(/waited 15s so far/)
  })

  it('also waits when the provider says it is full in the middle of an answer', async () => {
    const { desktop, calls } = fakeDesktop()
    let n = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n++
        const chunks =
          n === 1
            ? [{ type: 'error', error: { message: 'ResourceExhausted: Worker local total request limit reached (16/16)', type: 'internal_server_error' } }]
            : turn(n === 2 ? { tool: { action: 'key', keys: 'enter' } } : { text: 'Done.' }, `m${n}`)
        return { stream: simulateReadableStream({ chunks }) } as any
      }
    })
    const { svc } = service(model, desktop)
    svc.start('press enter', null)
    await settle(svc)
    expect(calls).toEqual(['key enter'])
    expect(svc.current()!.status).toBe('done')
    expect(svc.current()!.steps.some((s) => s.text.includes('servers for this model are full'))).toBe(true)
  })

  it('does not wait on an account whose limit is zero', () => {
    const zero = new APICallError({
      message: 'Rate limit exceeded',
      url: 'u',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'x-ratelimit-limit-req-minute': '0', 'x-ratelimit-remaining-req-minute': '0' },
      responseBody: '{"message":"Rate limit exceeded","type":"rate_limited","code":"1300"}'
    })
    expect(retryPlan(zero, 0)).toBeNull()
    expect(explainModelError(zero, 'mistral-small-latest')).toMatch(/limit at the provider is 0 requests/)
  })

  it('reads fractions and 0-1000 grids as screen positions, and leaves pixels alone', () => {
    expect(inPixels({ action: 'click', x: 0.5, y: 0.25 }, SHOT)).toMatchObject({ x: 640, y: 180 })
    expect(inPixels({ action: 'click', x: 500, y: 900 }, SHOT)).toMatchObject({ x: 640, y: 648 })
    expect(inPixels({ action: 'click', x: 500, y: 300 }, SHOT)).toMatchObject({ x: 500, y: 300 })
    expect(inPixels({ action: 'drag', x: 0.1, y: 0.1, toX: 0.9, toY: 0.9 }, SHOT)).toMatchObject({ x: 128, y: 72, toX: 1152, toY: 648 })
    expect(inPixels({ action: 'key', keys: 'win' }, SHOT)).toEqual({ action: 'key', keys: 'win' })
  })

  it('opens web addresses in the browser and apps through Start', async () => {
    const { desktop, calls } = fakeDesktop()
    const sleep = async () => undefined
    expect(await perform(desktop, { action: 'open', target: 'youtube.com' }, SHOT, sleep)).toBe('open https://youtube.com/')
    expect(await perform(desktop, { action: 'open', target: 'Chrome' }, SHOT, sleep)).toBe('open Chrome')
    expect(calls).toEqual(['openUrl https://youtube.com/', 'key win', 'type Chrome', 'key enter'])
    await expect(perform(desktop, { action: 'open' }, SHOT, sleep)).rejects.toThrow(/needs a target/)
    expect(webAddress('file:///C:/secret.txt')).toBeNull()
    expect(webAddress('Notepad')).toBeNull()
    expect(webAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })

  it('asks reasoning models to think less, in each provider’s own terms', () => {
    expect(lessThinking('nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')).toEqual({
      nvidia: { chat_template_kwargs: { enable_thinking: false, thinking: false } }
    })
    expect(lessThinking('google', 'gemini-2.5-flash')).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } })
    expect(lessThinking('google', 'gemini-3-pro-preview')).toEqual({ google: { thinkingConfig: { thinkingLevel: 'low' } } })
    expect(lessThinking('openai', 'gpt-4o')).toBeUndefined()
    expect(lessThinking('groq', 'llama-3.3-70b-versatile')).toBeUndefined()
  })

  it('reads actions out of text only when they are valid', () => {
    expect(actionFromText('<tool_call>{"name": "computer", "arguments": {"action": "click", "x": 5, "y": 6}}</tool_call>')).toEqual({ action: 'click', x: 5, y: 6 })
    expect(actionFromText('{"action": "fly"}')).toBeNull()
    expect(
      actionFromText('<function=computer>\n<parameter=action>\nclick\n</parameter>\n<parameter=x>\n0.0184\n</parameter>\n<parameter=y>\n0.9753\n</parameter>\n</function>\n</tool_call>')
    ).toEqual({ action: 'click', x: 0.0184, y: 0.9753 })
    expect(actionFromText('<function=computer><parameter=action>type</parameter><parameter=text>2024</parameter></function>')).toEqual({ action: 'type', text: '2024' })
    expect(actionFromText('All done, the file is saved.')).toBeNull()
  })
})

describe('computer actions', () => {
  it('maps screenshot points onto the physical screen and clamps them', () => {
    expect(toScreen(SHOT, 1280, 720)).toEqual({ x: 1919, y: 1079 })
    expect(toScreen(SHOT, -5, 10)).toEqual({ x: 0, y: 15 })
  })

  it('scrolls down for a positive amount and validates required fields', async () => {
    const { desktop, calls } = fakeDesktop()
    const sleep = async () => undefined
    expect(await perform(desktop, { action: 'scroll', amount: 2 }, SHOT, sleep)).toBe('scroll down 2')
    expect(calls).toEqual(['scroll 960,540 -2'])
    await expect(perform(desktop, { action: 'click' }, SHOT, sleep)).rejects.toThrow(/needs x and y/)
    await expect(perform(desktop, { action: 'key' }, SHOT, sleep)).rejects.toThrow(/needs keys/)
  })

  it('keeps only the newest screenshots in the conversation', () => {
    const shot = (): ModelMessage => ({ role: 'user', content: [{ type: 'file', data: 'x', mediaType: 'image/jpeg' }] })
    const messages = [shot(), shot(), shot()]
    pruneScreenshots(messages, 2)
    expect((messages[0].content as any[])[0]).toEqual({ type: 'text', text: '[older screenshot removed]' })
    expect((messages[2].content as any[])[0].type).toBe('file')
  })

  it('escapes non-ASCII text for the helper so the console code page never matters', () => {
    expect(encodeCommand(1, { cmd: 'type', text: 'ciao è' })).toBe('{"id":1,"cmd":"type","text":"ciao \\u00e8"}')
  })
})
