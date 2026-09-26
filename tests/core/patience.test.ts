import { describe, expect, it } from 'vitest'
import { APICallError, simulateReadableStream, streamText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { isServerFull, patientModel } from '../../src/core/models/patience'

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as any
const reply = (text: string): any[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE }
]
const full = () =>
  new APICallError({ message: 'ResourceExhausted: Worker local total request limit reached (16/16)', url: 'u', requestBodyValues: {}, statusCode: 503 })

describe('patientModel', () => {
  it('waits out a full server, whether it refuses the request or says so inside the stream', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++
        if (calls === 1) throw full()
        const chunks = calls === 2 ? [{ type: 'error', error: { message: 'ResourceExhausted: Worker local total request limit reached (16/16)' } }] : reply('Hello')
        return { stream: simulateReadableStream({ chunks }) } as any
      }
    })
    const waits: number[] = []
    const patient = patientModel(model, { onWait: (ms) => waits.push(ms), sleep: async () => undefined })
    const result = streamText({ model: patient, prompt: 'hi' })
    expect(await result.text).toBe('Hello')
    expect(calls).toBe(3)
    expect(waits).toEqual([5000, 10000])
  })

  it('passes any other error straight through, without waiting', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({ message: 'Not Found', url: 'u', requestBodyValues: {}, statusCode: 404 })
      }
    })
    const waits: number[] = []
    const patient = patientModel(model, { onWait: (ms) => waits.push(ms), sleep: async () => undefined })
    const errors: unknown[] = []
    const result = streamText({ model: patient, prompt: 'hi', onError: ({ error }) => void errors.push(error) })
    await result.consumeStream()
    expect(waits).toEqual([])
    expect(APICallError.isInstance(errors[0]) && errors[0].statusCode).toBe(404)
  })

  it('recognises full servers by status or by message', () => {
    expect(isServerFull(full())).toBe(true)
    expect(isServerFull(new Error('The model is overloaded, try later'))).toBe(true)
    expect(isServerFull(new APICallError({ message: 'Bad Request', url: 'u', requestBodyValues: {}, statusCode: 400 }))).toBe(false)
  })
})
