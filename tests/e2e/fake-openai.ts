import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeToolCall {
  id: string
  name: string
  args: object
}

export interface FakeReply {
  text?: string
  toolCalls?: FakeToolCall[]
}

export interface FakeOpenAI {
  url: string
  requests: any[]
  close(): Promise<void>
}

/** Splits `text` into up to `maxParts` roughly-even, non-empty chunks (in source order). */
function splitIntoChunks(text: string, maxParts: number): string[] {
  if (text.length === 0) return []
  const parts = Math.max(1, Math.min(maxParts, text.length))
  const size = Math.ceil(text.length / parts)
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function toolCallDelta(tc: FakeToolCall, index: number): unknown {
  return {
    index,
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.args) }
  }
}

/**
 * Starts a fake OpenAI-compatible server for the e2e tests. `steps` is consumed one call per
 * POST /v1/chat/completions; once exhausted, every further call answers with the text "Done."
 */
export async function startFakeOpenAI(steps: Array<(body: any) => FakeReply>): Promise<FakeOpenAI> {
  const requests: any[] = []
  let stepIndex = 0

  function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch {
          resolve({})
        }
      })
    })
  }

  function sendJson(res: ServerResponse, reply: FakeReply): void {
    const toolCalls = reply.toolCalls?.map(toolCallDelta)
    const message: Record<string, unknown> = { role: 'assistant', content: reply.text ?? null }
    if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls
    const finishReason = toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop'
    const payload = {
      id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-model',
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  function sendStream(res: ServerResponse, reply: FakeReply): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const base = {
      id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-model'
    }
    const write = (delta: unknown, finishReason: string | null, usage?: unknown): void => {
      const chunk = {
        ...base,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {})
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    write({ role: 'assistant', content: '' }, null)

    if (reply.text) {
      for (const part of splitIntoChunks(reply.text, 3)) write({ content: part }, null)
    }

    if (reply.toolCalls) {
      reply.toolCalls.forEach((tc, index) => {
        write({ tool_calls: [toolCallDelta(tc, index)] }, null)
      })
    }

    const finishReason = reply.toolCalls && reply.toolCalls.length > 0 ? 'tool_calls' : 'stop'
    write({}, finishReason, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
    res.write('data: [DONE]\n\n')
    res.end()
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))
        return
      }

      if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
        const body = await readBody(req)
        requests.push(body)

        const stepFn = steps[stepIndex]
        stepIndex += 1
        const reply: FakeReply = stepFn ? stepFn(body) : { text: 'Done.' }

        if (body?.stream === true) sendStream(res, reply)
        else sendJson(res, reply)
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
    })().catch((error) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
      } catch {
        // Response may already be closed.
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}
