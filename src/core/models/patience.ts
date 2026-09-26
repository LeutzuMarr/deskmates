import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { APICallError, wrapLanguageModel } from 'ai'
import type { LanguageModel } from 'ai'

/** Most waiting per request before a full server is reported as an error. */
const WAIT_BUDGET_MS = 10 * 60_000
const MAX_PAUSE_MS = 60_000

type StreamPart = LanguageModelV4StreamPart

/**
 * A shared server that is full right now (NVIDIA's "Worker local total request limit reached",
 * overload answers, 502–504, 529). It clears up as other people's requests finish.
 */
export function isServerFull(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    if (status === 502 || status === 503 || status === 504 || status === 529) return true
  }
  const text =
    APICallError.isInstance(error)
      ? `${error.message} ${error.responseBody ?? ''}`
      : error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error)
  return /ResourceExhausted|request limit reached|overloaded|over capacity|server is busy/i.test(text)
}

function pause(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.min(attempt, 6), MAX_PAUSE_MS)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

const CONTENT_PARTS = new Set(['text-start', 'text-delta', 'reasoning-start', 'reasoning-delta', 'tool-input-start', 'tool-call', 'finish'])

/**
 * Reads a stream up to its first real output. A "server full" error that arrives before any output
 * (NVIDIA sends it inside an already-open stream) is thrown so the request can be retried; otherwise
 * the returned stream replays what was read and carries on with the rest.
 */
async function openedStream(stream: ReadableStream<StreamPart>): Promise<ReadableStream<StreamPart>> {
  const reader = stream.getReader()
  const buffered: StreamPart[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value.type === 'error' && isServerFull(value.error)) {
      reader.cancel().catch(() => undefined)
      throw value.error instanceof Error ? value.error : new Error(String((value.error as { message?: unknown })?.message ?? value.error))
    }
    buffered.push(value)
    if (CONTENT_PARTS.has(value.type)) break
  }
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part)
    },
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
}

export interface PatienceOptions {
  /** Told about each wait, e.g. to show it; `waitedMs` is the waiting done before this pause. */
  onWait?: (pauseMs: number, waitedMs: number) => void
  /** Replaceable in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Wraps a model so a full shared server is waited out (growing pauses, up to ten minutes per
 * request) instead of failing the run. Any other error passes straight through.
 */
export function patientModel<M extends LanguageModel>(model: M, options: PatienceOptions = {}): M {
  if (typeof model === 'string') return model
  const sleep = options.sleep ?? wait
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        let waited = 0
        for (let attempt = 0; ; attempt++) {
          try {
            return await doGenerate()
          } catch (error) {
            const ms = pause(attempt)
            if (!isServerFull(error) || waited + ms > WAIT_BUDGET_MS || params.abortSignal?.aborted) throw error
            options.onWait?.(ms, waited)
            waited += ms
            await sleep(ms, params.abortSignal)
          }
        }
      },
      wrapStream: async ({ doStream, params }) => {
        let waited = 0
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await doStream()
            return { ...result, stream: await openedStream(result.stream) }
          } catch (error) {
            const ms = pause(attempt)
            if (!isServerFull(error) || waited + ms > WAIT_BUDGET_MS || params.abortSignal?.aborted) throw error
            options.onWait?.(ms, waited)
            waited += ms
            await sleep(ms, params.abortSignal)
          }
        }
      }
    }
  }) as M
}
