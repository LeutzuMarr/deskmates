/**
 * HTTP client for one bot PC's agent service (`bot-image/agent.py`). Every call carries the
 * `X-Deskmates-Token` header the agent requires; nothing here ever puts the token in a thrown
 * error or a returned value, since tool results end up in the run log.
 */
import { PcUnreachableError } from './types'

/** Mirrors `handle_input`'s action union in `bot-image/agent.py`. */
export type InputAction =
  | { action: 'move'; x: number; y: number }
  | { action: 'click' | 'double_click'; x?: number; y?: number; button?: number }
  | { action: 'type'; text: string }
  | { action: 'key'; keys: string }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; x?: number; y?: number }

/** Mirrors `handle_exec`'s JSON response shape in `bot-image/agent.py`. */
export interface AgentExecResult {
  code: number | null
  timedOut: boolean
  stdout: string
  stdoutTruncated: boolean
  stderr: string
  stderrTruncated: boolean
}

export interface AgentExecOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** What the bot tools need from a running PC's agent service. `HttpAgentClient` is the real implementation; tests inject a fake. */
export interface AgentClient {
  screenshot(signal?: AbortSignal): Promise<Buffer>
  input(action: InputAction, signal?: AbortSignal): Promise<void>
  exec(command: string[], options?: AgentExecOptions): Promise<AgentExecResult>
  readFile(path: string, signal?: AbortSignal): Promise<Buffer>
  writeFile(path: string, data: Buffer | string, signal?: AbortSignal): Promise<{ bytes: number }>
}

/** An agent request failed with a plain-sentence message; never includes the token. */
export class AgentClientError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AgentClientError'
    this.status = status
  }
}

export const TOKEN_HEADER = 'X-Deskmates-Token'

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown }
    if (body && typeof body.error === 'string' && body.error) return body.error
  } catch {
    // Not JSON, or no body — fall through to a generic message below.
  }
  return `The bot's PC agent returned ${res.status}.`
}

/** The real client: talks to `<agent baseUrl>` over plain `fetch`. */
export class HttpAgentClient implements AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async screenshot(signal?: AbortSignal): Promise<Buffer> {
    const res = await this.request('/screenshot', { method: 'GET', signal })
    return Buffer.from(await res.arrayBuffer())
  }

  async input(action: InputAction, signal?: AbortSignal): Promise<void> {
    await this.request('/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
      signal
    })
  }

  async exec(command: string[], options: AgentExecOptions = {}): Promise<AgentExecResult> {
    const res = await this.request('/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }),
      signal: options.signal
    })
    return (await res.json()) as AgentExecResult
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.request(`/files?path=${encodeURIComponent(path)}`, { method: 'GET', signal })
    return Buffer.from(await res.arrayBuffer())
  }

  async writeFile(path: string, data: Buffer | string, signal?: AbortSignal): Promise<{ bytes: number }> {
    const res = await this.request(`/files?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: data,
      signal
    })
    return (await res.json()) as { bytes: number }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers: { ...init.headers, [TOKEN_HEADER]: this.token } })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new PcUnreachableError('PC', error)
    }
    if (!res.ok) throw new AgentClientError(res.status, await readErrorMessage(res))
    return res
  }
}
