import { request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { BotHostError } from './host'

/** Docker Engine API version used for every path below. */
export const DOCKER_API_VERSION = '1.41'

export interface DockerTls {
  cert: Buffer
  key: Buffer
  ca: Buffer
}

export interface DockerRegistryAuth {
  username: string
  password: string
  /** Registry address, e.g. ghcr.io; the image reference's registry when absent. */
  serveraddress?: string
}

/** A parsed, validated connection target. */
export interface DockerEndpoint {
  host: string
  port: number
  secure: boolean
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)$/i

/**
 * Parses `endpoint` (e.g. `tcp://192.168.1.20:2375`, `http://…`, `https://…`).
 * `tcp://host:port` becomes plain http, unless `hasTls` is true, in which case https.
 * http:// -> secure false, https:// -> secure true (hasTls is then irrelevant).
 * Returns null for anything malformed (missing scheme, missing host, missing/non-numeric port).
 * IPv6 literals in brackets must work.
 */
export function parseDockerEndpoint(endpoint: string, hasTls: boolean): DockerEndpoint | null {
  const match = SCHEME_RE.exec(endpoint)
  if (!match) return null
  const scheme = match[1].toLowerCase()
  const rest = match[2]
  if (rest.length === 0) return null

  let host: string
  let portText: string | null
  if (rest[0] === '[') {
    const close = rest.indexOf(']')
    if (close === -1) return null
    host = rest.slice(1, close)
    const after = rest.slice(close + 1)
    portText = after.startsWith(':') ? after.slice(1) : null
  } else {
    const colon = rest.indexOf(':')
    host = colon === -1 ? rest : rest.slice(0, colon)
    if (host.length === 0) return null
    portText = colon === -1 ? null : rest.slice(colon + 1)
  }
  if (host.length === 0) return null
  if (portText === null || portText.length === 0) return null
  if (!/^\d+$/.test(portText)) return null

  const port = Number(portText)
  if (scheme === 'http') return { host, port, secure: false }
  if (scheme === 'https') return { host, port, secure: true }
  if (scheme === 'tcp') return { host, port, secure: hasTls }
  return null
}

/** The raw HTTP surface an injected fake implements in tests; the real transport never sees these. */
export interface DockerRequest {
  method: string
  /** Full request target INCLUDING query string, starting with '/'. */
  path: string
  headers?: Record<string, string>
  body?: Uint8Array
}
export interface DockerResponse {
  status: number
  body: Uint8Array
}
/** Injectable for tests. Defaults to a real Node http/https transport honoring the options' baseUrl + tls + timeoutMs. */
export type DockerTransport = (req: DockerRequest) => Promise<DockerResponse>

export interface DockerApiOptions {
  /** Already resolved base URL, e.g. `http://192.168.1.20:2375` or `https://…`. Endpoints are appended as-is. */
  baseUrl: string
  tls?: DockerTls | null
  registryAuth?: DockerRegistryAuth | null
  transport?: DockerTransport
  /** Request timeout in ms. Default 60_000; exec() ignores this and uses spec.timeoutMs ?? 120_000. */
  timeoutMs?: number
}

export interface DockerPortBinding {
  hostIp: string
  hostPort: number
  containerPort: number
}

export interface DockerContainerSpec {
  image: string
  name: string
  command?: string[]
  env: Record<string, string>
  memoryMb: number
  /** Fractional CPUs; omit to leave uncapped. */
  cpus?: number
  ports: DockerPortBinding[]
  /** `volume-name:/container/path` entries. */
  volumes: string[]
  /** An existing user-defined network to attach this container to. */
  network?: string
}

export interface DockerContainerState {
  id: string | null
  state: 'running' | 'starting' | 'stopped' | 'absent' | 'error'
  error: string | null
  /**
   * Set only when the probe itself failed (server unreachable, daemon down): the fully classified
   * error, so callers that need to throw can reuse its code/cause. Absent for container-level
   * errors read on a successful inspect (Dead / OOMKilled / State.Error).
   */
  hostError?: BotHostError
}

export interface DockerExecSpec {
  /** Full argv, already wrapped by the caller (CloudHost passes `['/bin/sh', '-c', '…']`). */
  command: string[]
  /** stdin text; when set, AttachStdin is enabled. */
  input?: string
  /** Default false: keeps stdout/stderr demultiplexed. */
  tty?: boolean
  timeoutMs?: number
}

export interface DockerExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface DockerApi {
  /** GET /_ping — 200 with any body means healthy; anything else throws. */
  ping(): Promise<void>
  /** POST /images/create?fromImage=<url-encoded> with X-Registry-Auth (base64 JSON) when registryAuth is set. 200/ok on success (the image-name body stream is ignored). */
  pull(image: string): Promise<void>
  /** POST /build?t=<url-encoded image>&dockerfile=Dockerfile with Content-Type: application/x-tar carrying a Docker build context tar. 200 ok (build log body ignored); other statuses classified. */
  build(tar: Uint8Array, image: string): Promise<void>
  /** POST /networks/create {Name}. A 409 conflict is tolerated (already exists). */
  createNetwork(name: string): Promise<void>
  /** DELETE /networks/<name>. A 404 is tolerated (already gone). */
  removeNetwork(name: string): Promise<void>
  /** POST /containers/create?name=<name> with the spec body. Returns the container Id. See body mapping below. */
  createContainer(spec: DockerContainerSpec): Promise<string>
  /** POST /containers/<id>/start. A 304 (already running) is tolerated. */
  startContainer(nameOrId: string): Promise<void>
  /** POST /containers/<id>/stop?t=<timeoutSeconds?>. A 304 (already stopped) is tolerated. */
  stopContainer(nameOrId: string, timeoutSeconds?: number): Promise<void>
  /** DELETE /containers/<id>?force=<0|1>. A 404 is tolerated (already gone). */
  removeContainer(nameOrId: string, force?: boolean): Promise<void>
  /** GET /containers/<id>/json, mapped to DockerContainerState (never throws for a reachable engine). */
  inspectContainer(nameOrId: string): Promise<DockerContainerState>
  /** The full exec round trip: exec create -> exec start (streaming the response, demultiplexing the 8-byte-header frames) -> exec inspect for the exit code. */
  exec(containerNameOrId: string, spec: DockerExecSpec): Promise<DockerExecResult>
  /** PUT /containers/<id>/archive?path=<url-encoded> with the tar as application/x-tar (docker cp semantics: the tar's entry names are relative to `path`). */
  putArchive(containerNameOrId: string, containerPath: string, tar: Uint8Array): Promise<void>
  /** GET /containers/<id>/archive?path=<url-encoded>; returns the raw tar bytes. */
  getArchive(containerNameOrId: string, containerPath: string): Promise<Uint8Array>
}

const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' }
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_EXEC_TIMEOUT_MS = 120_000

function jsonBody(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300
}

/** Splits an exec multiplexed stream (Tty false) into its stdout and stderr halves. */
function demultiplex(body: Uint8Array): { stdout: string; stderr: string } {
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  const buf = Buffer.from(body)
  let offset = 0
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4)
    const end = offset + 8 + size
    if (end > buf.length) break
    const chunk = buf.subarray(offset + 8, end)
    if (buf[offset] === 2) stderrChunks.push(chunk)
    else if (buf[offset] === 1) stdoutChunks.push(chunk)
    offset = end
  }
  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8')
  }
}

/**
 * A real Node `http`/`https` transport. `tls` is honored through an https Agent (an https Agent is
 * used whenever the baseUrl scheme is https, regardless of whether certs were given). A request
 * that outlives `timeoutMs` is destroyed; the resulting error is rethrown raw so the API layer
 * classifies it.
 */
function createNodeTransport(baseUrl: string, tls: DockerTls | null, timeoutMs: number): DockerTransport {
  let target: URL
  try {
    target = new URL(baseUrl)
  } catch {
    throw new Error(`Invalid Docker baseUrl: ${baseUrl}`)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Invalid Docker baseUrl scheme: ${baseUrl}`)
  }
  const isHttps = target.protocol === 'https:'
  const agent = isHttps ? new HttpsAgent(tls ? { cert: tls.cert, key: tls.key, ca: tls.ca } : undefined) : undefined
  const hostname = target.hostname.replace(/^\[|\]$/g, '')

  return (req) =>
    new Promise<DockerResponse>((resolve, reject) => {
      const clientRequest = (isHttps ? httpsRequest : httpRequest)(
        {
          method: req.method,
          hostname,
          port: target.port,
          path: req.path,
          headers: req.headers,
          agent
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
          })
          res.on('error', reject)
        }
      )
      clientRequest.setTimeout(timeoutMs, () => {
        clientRequest.destroy(new Error(`Request timed out after ${timeoutMs}ms.`))
      })
      clientRequest.on('error', reject)
      if (req.body && req.body.length > 0) clientRequest.write(Buffer.from(req.body))
      clientRequest.end()
    })
}

/** The `BotHost` `DockerApi` contract, implemented over the Docker Engine HTTP API. */
export function createDockerApi(options: DockerApiOptions): DockerApi {
  return new DockerApiClient(options)
}

class DockerApiClient implements DockerApi {
  private readonly baseUrl: string
  private readonly tls: DockerTls | null
  private readonly registryAuth: DockerRegistryAuth | null
  private readonly customTransport: DockerTransport | null
  private readonly transport: DockerTransport

  constructor(options: DockerApiOptions) {
    this.baseUrl = options.baseUrl
    this.tls = options.tls ?? null
    this.registryAuth = options.registryAuth ?? null
    this.customTransport = options.transport ?? null
    this.transport = this.customTransport ?? createNodeTransport(this.baseUrl, this.tls, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  /** GET /_ping — 200 with any body means healthy; anything else throws. */
  async ping(): Promise<void> {
    const res = await this.perform('GET', '/_ping')
    if (!isOk(res.status)) this.throwHttp(res, 'ping')
  }

  /** POST /images/create?fromImage=<url-encoded> with X-Registry-Auth (base64 JSON) when registryAuth is set. 200/ok on success (the image-name body stream is ignored). */
  async pull(image: string): Promise<void> {
    const headers: Record<string, string> | undefined = this.registryAuth
      ? {
          'X-Registry-Auth': Buffer.from(
            JSON.stringify({
              username: this.registryAuth.username,
              password: this.registryAuth.password,
              ...(this.registryAuth.serveraddress !== undefined ? { serveraddress: this.registryAuth.serveraddress } : {})
            }),
            'utf8'
          ).toString('base64')
        }
      : undefined
    const res = await this.perform('POST', `/images/create?fromImage=${encodeURIComponent(image)}`, undefined, headers)
    if (!isOk(res.status)) this.throwHttp(res, 'pull')
  }

  /** POST /build?t=<url-encoded image>&dockerfile=Dockerfile with Content-Type: application/x-tar carrying a Docker build context tar. 200 ok (build log body ignored); other statuses classified. */
  async build(tar: Uint8Array, image: string): Promise<void> {
    const res = await this.perform(
      'POST',
      `/build?t=${encodeURIComponent(image)}&dockerfile=Dockerfile`,
      tar,
      { 'Content-Type': 'application/x-tar' }
    )
    if (!isOk(res.status)) this.throwHttp(res, 'build')
  }

  /** POST /networks/create {Name}. A 409 conflict is tolerated (already exists). */
  async createNetwork(name: string): Promise<void> {
    const res = await this.perform('POST', '/networks/create', jsonBody({ Name: name }), JSON_CONTENT_TYPE)
    if (res.status === 409) return
    if (!isOk(res.status)) this.throwHttp(res, 'create-network')
  }

  /** DELETE /networks/<name>. A 404 is tolerated (already gone). */
  async removeNetwork(name: string): Promise<void> {
    const res = await this.perform('DELETE', `/networks/${encodeURIComponent(name)}`)
    if (res.status === 404) return
    if (!isOk(res.status)) this.throwHttp(res, 'remove-network')
  }

  /** POST /containers/create?name=<name> with the spec body. Returns the container Id. See body mapping below. */
  async createContainer(spec: DockerContainerSpec): Promise<string> {
    const res = await this.perform(
      'POST',
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      jsonBody(this.createContainerBody(spec)),
      JSON_CONTENT_TYPE
    )
    if (!isOk(res.status)) this.throwHttp(res, 'create-container')
    const body = this.parseBody(res)
    if (!body || typeof body.Id !== 'string' || body.Id.length === 0) {
      throw new BotHostError('unknown', "Docker didn't return an ID for the new container.")
    }
    return body.Id
  }

  private createContainerBody(spec: DockerContainerSpec): Record<string, unknown> {
    return {
      Image: spec.image,
      ...(spec.command ? { Cmd: spec.command } : {}),
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        Memory: spec.memoryMb * 1024 * 1024,
        ...(spec.cpus !== undefined ? { NanoCpus: Math.round(spec.cpus * 1e9) } : {}),
        PortBindings: Object.fromEntries(
          spec.ports.map((p) => [`${p.containerPort}/tcp`, [{ HostIp: p.hostIp, HostPort: String(p.hostPort) }]])
        ),
        Binds: spec.volumes,
        RestartPolicy: { Name: 'no' }
      },
      ...(spec.network ? { NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } } } : {})
    }
  }

  /** POST /containers/<id>/start. A 304 (already running) is tolerated. */
  async startContainer(nameOrId: string): Promise<void> {
    const res = await this.perform('POST', `/containers/${encodeURIComponent(nameOrId)}/start`)
    if (res.status === 304) return
    if (!isOk(res.status)) this.throwHttp(res, 'start-container')
  }

  /** POST /containers/<id>/stop?t=<timeoutSeconds?>. A 304 (already stopped) is tolerated. */
  async stopContainer(nameOrId: string, timeoutSeconds?: number): Promise<void> {
    const query = timeoutSeconds !== undefined ? `?t=${timeoutSeconds}` : ''
    const res = await this.perform('POST', `/containers/${encodeURIComponent(nameOrId)}/stop${query}`)
    if (res.status === 304) return
    if (!isOk(res.status)) this.throwHttp(res, 'stop-container')
  }

  /** DELETE /containers/<id>?force=<0|1>. A 404 is tolerated (already gone). */
  async removeContainer(nameOrId: string, force?: boolean): Promise<void> {
    const res = await this.perform('DELETE', `/containers/${encodeURIComponent(nameOrId)}?force=${force ? '1' : '0'}`)
    if (res.status === 404) return
    if (!isOk(res.status)) this.throwHttp(res, 'remove-container')
  }

  /** GET /containers/<id>/json, mapped to DockerContainerState (never throws for a reachable engine). */
  async inspectContainer(nameOrId: string): Promise<DockerContainerState> {
    let res: DockerResponse
    try {
      res = await this.perform('GET', `/containers/${encodeURIComponent(nameOrId)}/json`)
    } catch (error) {
      const hostError = error instanceof BotHostError ? error : this.engineError(error)
      return { state: 'error', id: null, error: hostError.message, hostError }
    }
    if (res.status === 404 || res.body.length === 0) return { state: 'absent', id: null, error: null }
    if (!isOk(res.status)) {
      const hostError = this.classifyHttp(res, 'inspect')
      return { state: 'error', id: null, error: hostError.message, hostError }
    }
    const parsed = this.parseBody(res)
    if (parsed === null) return { state: 'error', id: null, error: "Couldn't read this bot's PC status." }
    const id = typeof parsed.Id === 'string' && parsed.Id.length > 0 ? parsed.Id : null
    const state = typeof parsed.State === 'object' && parsed.State !== null ? (parsed.State as Record<string, unknown>) : null
    if (state === null) return { state: 'stopped', id, error: null }
    if (state.Dead) return { state: 'error', id, error: 'This PC died unexpectedly.' }
    if (state.OOMKilled) {
      return { state: 'error', id, error: 'This PC ran out of memory and stopped. Increase its memory limit.' }
    }
    if (typeof state.Error === 'string' && state.Error.length > 0) return { state: 'error', id, error: state.Error }
    if (state.Status === 'running') return { state: 'running', id, error: null }
    if (state.Status === 'restarting') return { state: 'starting', id, error: null }
    return { state: 'stopped', id, error: null }
  }

  /** The full exec round trip: exec create -> exec start (streaming the response, demultiplexing the 8-byte-header frames) -> exec inspect for the exit code. */
  async exec(containerNameOrId: string, spec: DockerExecSpec): Promise<DockerExecResult> {
    const execTransport = this.customTransport ?? createNodeTransport(this.baseUrl, this.tls, spec.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS)
    const created = await this.perform(
      'POST',
      `/containers/${encodeURIComponent(containerNameOrId)}/exec`,
      jsonBody({
        Cmd: spec.command,
        AttachStdin: spec.input !== undefined,
        AttachStdout: true,
        AttachStderr: true,
        Tty: !!spec.tty
      }),
      JSON_CONTENT_TYPE,
      execTransport
    )
    if (!isOk(created.status)) {
      if (created.status === 404) throw new BotHostError('not-created', "This bot's PC hasn't been created yet.")
      this.throwHttp(created, 'exec')
    }
    const createdBody = this.parseBody(created)
    if (!createdBody || typeof createdBody.Id !== 'string' || createdBody.Id.length === 0) {
      throw new BotHostError('unknown', "Couldn't start a command in this bot's PC.")
    }
    const execId = createdBody.Id
    const input = spec.input !== undefined ? Buffer.from(spec.input, 'utf8') : undefined
    const started = await this.perform(
      'POST',
      `/exec/${encodeURIComponent(execId)}/start`,
      input,
      input === undefined ? undefined : { 'Content-Type': 'application/vnd.docker.multiplexed-stream' },
      execTransport
    )
    if (!isOk(started.status)) this.throwHttp(started, 'exec')
    const stream = spec.tty
      ? { stdout: Buffer.from(started.body).toString('utf8'), stderr: '' }
      : demultiplex(started.body)
    const inspected = await this.perform('GET', `/exec/${encodeURIComponent(execId)}/json`, undefined, undefined, execTransport)
    if (!isOk(inspected.status)) this.throwHttp(inspected, 'exec')
    const inspectedBody = this.parseBody(inspected)
    const exitCode = inspectedBody && typeof inspectedBody.ExitCode === 'number' ? inspectedBody.ExitCode : 1
    return { exitCode, stdout: stream.stdout, stderr: stream.stderr }
  }

  /** PUT /containers/<id>/archive?path=<url-encoded> with the tar as application/x-tar (docker cp semantics: the tar's entry names are relative to `path`). */
  async putArchive(containerNameOrId: string, containerPath: string, tar: Uint8Array): Promise<void> {
    const res = await this.perform(
      'PUT',
      `/containers/${encodeURIComponent(containerNameOrId)}/archive?path=${encodeURIComponent(containerPath)}`,
      tar,
      { 'Content-Type': 'application/x-tar' }
    )
    if (!isOk(res.status)) this.throwHttp(res, 'put-archive')
  }

  /** GET /containers/<id>/archive?path=<url-encoded>; returns the raw tar bytes. */
  async getArchive(containerNameOrId: string, containerPath: string): Promise<Uint8Array> {
    const res = await this.perform(
      'GET',
      `/containers/${encodeURIComponent(containerNameOrId)}/archive?path=${encodeURIComponent(containerPath)}`
    )
    if (!isOk(res.status)) this.throwHttp(res, 'get-archive')
    return res.body
  }

  private async perform(
    method: string,
    path: string,
    body?: Uint8Array,
    headers?: Record<string, string>,
    transport?: DockerTransport
  ): Promise<DockerResponse> {
    try {
      return await (transport ?? this.transport)({
        method,
        path: `/v${DOCKER_API_VERSION}${path}`,
        headers,
        body
      })
    } catch (error) {
      throw this.engineError(error)
    }
  }

  private engineError(error: unknown): BotHostError {
    const cause = error instanceof Error ? error.message : String(error)
    return new BotHostError('engine-not-running', `Can't reach the Docker server at ${this.baseUrl}.`, cause)
  }

  private throwHttp(res: DockerResponse, method: string): never {
    throw this.classifyHttp(res, method)
  }

  private classifyHttp(res: DockerResponse, method: string): BotHostError {
    const bodyText = Buffer.from(res.body).toString('utf8').trim()
    const parsedMessage = this.parseErrorMessage(bodyText)
    const s = (parsedMessage ?? bodyText).toLowerCase()
    const cause = bodyText.length > 0 ? bodyText : undefined

    if (
      s.includes('no such image') ||
      s.includes('pull access denied') ||
      s.includes('manifest unknown') ||
      s.includes('repository does not exist')
    ) {
      return new BotHostError('image-missing', "This bot's PC image isn't installed yet. Download or build it from Settings.", cause)
    }
    if (s.includes('port is already allocated') || s.includes('address already in use') || /bind for [^\n]* failed/.test(s)) {
      return new BotHostError('port-taken', "Another program is already using this bot's PC ports. Close it and try again.", cause)
    }
    if (s.includes('cannot connect to the docker daemon') || s.includes('error during connect')) {
      return new BotHostError('engine-not-running', `Can't reach the Docker server at ${this.baseUrl}.`, cause)
    }
    if (s.includes('no such container')) {
      return new BotHostError('not-created', "This bot's PC hasn't been created yet.", cause)
    }
    if (res.status === 404 && method === 'get-archive') {
      return new BotHostError('unknown', "That folder or file doesn't exist in the bot's PC.", cause)
    }
    if (res.status === 404 && method === 'put-archive') {
      return new BotHostError('unknown', "The destination folder doesn't exist in the bot's PC.", cause)
    }
    if (res.status === 404) {
      return new BotHostError('not-created', "This bot's PC hasn't been created yet.", cause)
    }
    if (s.includes('is not running')) {
      return new BotHostError('not-running', "This bot's PC isn't running right now.", cause)
    }
    return new BotHostError('unknown', parsedMessage ?? (bodyText || "Something went wrong talking to this bot's PC."), cause)
  }

  private parseBody(res: DockerResponse): Record<string, unknown> | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(res.body).toString('utf8'))
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  }

  private parseErrorMessage(bodyText: string): string | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    const message = (parsed as Record<string, unknown>).message
    return typeof message === 'string' && message.length > 0 ? message : null
  }
}