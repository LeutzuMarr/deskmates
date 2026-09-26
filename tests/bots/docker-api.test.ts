import { describe, expect, it } from 'vitest'
import { BotHostError } from '../../src/core/bots/host'
import {
  DOCKER_API_VERSION,
  createDockerApi,
  parseDockerEndpoint,
  type DockerApi,
  type DockerApiOptions,
  type DockerContainerSpec,
  type DockerRequest,
  type DockerResponse,
  type DockerTransport
} from '../../src/core/bots/docker-api'

const BASE_URL = 'http://172.16.0.5:2375'

interface CallRecord {
  method: string
  path: string
  headers?: Record<string, string>
  body?: Uint8Array
}

/** Records every request and answers from a per-test queue; a dry queue returns 200 empty. */
class FakeTransport {
  readonly calls: CallRecord[] = []
  private readonly queue: Array<DockerResponse | Error> = []

  readonly transport: DockerTransport = async (req: DockerRequest): Promise<DockerResponse> => {
    this.calls.push({ ...req })
    const next = this.queue.shift()
    if (next === undefined) return { status: 200, body: new Uint8Array() }
    if (next instanceof Error) throw next
    return next
  }

  queueResponse(status: number, body: string | Uint8Array = new Uint8Array()): void {
    this.queue.push({
      status,
      body: typeof body === 'string' ? new TextEncoder().encode(body) : body
    })
  }

  queueError(message: string): void {
    this.queue.push(new Error(message))
  }
}

function makeApi(transport: FakeTransport, options: Partial<DockerApiOptions> = {}): DockerApi {
  return createDockerApi({ baseUrl: BASE_URL, ...options, transport: transport.transport })
}

function bodyJson(call: CallRecord): Record<string, unknown> {
  return JSON.parse(Buffer.from(call.body as Uint8Array).toString('utf8')) as Record<string, unknown>
}

function multiplexed(...frames: Array<[number, string]>): Uint8Array {
  const parts: Buffer[] = []
  for (const [streamType, text] of frames) {
    const payload = Buffer.from(text, 'utf8')
    const header = Buffer.alloc(8)
    header[0] = streamType
    header.writeUInt32BE(payload.length, 4)
    parts.push(header, payload)
  }
  return Buffer.concat(parts)
}

function sampleSpec(): DockerContainerSpec {
  return {
    image: 'ghcr.io/deskmates/bot-pc:latest',
    name: 'deskmates-bot-x',
    env: { DESKMATES_TOKEN: 'tok', HELLO: 'world' },
    memoryMb: 1024,
    cpus: 2,
    ports: [{ hostIp: '0.0.0.0', hostPort: 5901, containerPort: 5900 }],
    volumes: ['deskmates-bot-x-data:/home/bot/data'],
    network: 'deskmates-bot-x-net'
  }
}

describe('parseDockerEndpoint', () => {
  it('maps tcp to http, or to https when hasTls is set', () => {
    expect(parseDockerEndpoint('tcp://192.168.1.20:2375', false)).toEqual({ host: '192.168.1.20', port: 2375, secure: false })
    expect(parseDockerEndpoint('tcp://192.168.1.20:2375', true)).toEqual({ host: '192.168.1.20', port: 2375, secure: true })
    expect(parseDockerEndpoint('http://192.168.1.20:2375', true)).toEqual({ host: '192.168.1.20', port: 2375, secure: false })
    expect(parseDockerEndpoint('https://192.168.1.20:2375', false)).toEqual({ host: '192.168.1.20', port: 2375, secure: true })
  })

  it('returns null for a missing scheme, host, or non-numeric port', () => {
    expect(parseDockerEndpoint('192.168.1.20:2375', false)).toBeNull()
    expect(parseDockerEndpoint('tcp://:2375', false)).toBeNull()
    expect(parseDockerEndpoint('tcp://192.168.1.20', false)).toBeNull()
    expect(parseDockerEndpoint('http://host', false)).toBeNull()
    expect(parseDockerEndpoint('tcp://192.168.1.20:port', false)).toBeNull()
  })

  it('accepts a bracketed IPv6 literal', () => {
    expect(parseDockerEndpoint('tcp://[::1]:2375', false)).toEqual({ host: '::1', port: 2375, secure: false })
    expect(parseDockerEndpoint('https://[2001:db8::1]:1234', true)).toEqual({ host: '2001:db8::1', port: 1234, secure: true })
  })
})

describe('createDockerApi', () => {
  it('ping resolves on 200 and throws on 500', async () => {
    const pingOk = new FakeTransport()
    pingOk.queueResponse(200, 'OK')
    await expect(makeApi(pingOk).ping()).resolves.toBeUndefined()
    expect(pingOk.calls[0]).toMatchObject({ method: 'GET', path: `/v${DOCKER_API_VERSION}/_ping` })

    const pingFail = new FakeTransport()
    pingFail.queueResponse(500, '{"message":"server exploded"}')
    const promise = makeApi(pingFail).ping()
    await expect(promise).rejects.toBeInstanceOf(BotHostError)
    await expect(promise).rejects.toMatchObject({ code: 'unknown', message: 'server exploded' })
  })

  it('createContainer posts the pinned path and body and returns the Id', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(201, '{"Id":"abc123"}')
    const api = makeApi(transport)

    const id = await api.createContainer(sampleSpec())

    expect(id).toBe('abc123')
    expect(transport.calls[0].path).toBe('/v1.41/containers/create?name=deskmates-bot-x')
    expect(transport.calls[0].method).toBe('POST')
    expect(transport.calls[0].headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(bodyJson(transport.calls[0])).toEqual({
      Image: 'ghcr.io/deskmates/bot-pc:latest',
      Env: ['DESKMATES_TOKEN=tok', 'HELLO=world'],
      HostConfig: {
        Memory: 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PortBindings: { '5900/tcp': [{ HostIp: '0.0.0.0', HostPort: '5901' }] },
        Binds: ['deskmates-bot-x-data:/home/bot/data'],
        RestartPolicy: { Name: 'no' }
      },
      NetworkingConfig: { EndpointsConfig: { 'deskmates-bot-x-net': {} } }
    })
    expect(bodyJson(transport.calls[0])).not.toHaveProperty('name')
  })

  it('createContainer omits Cmd, NanoCpus and NetworkingConfig when not given', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(201, '{"Id":"abc123"}')
    const api = makeApi(transport)

    await api.createContainer({ ...sampleSpec(), cpus: undefined, network: undefined })

    const body = bodyJson(transport.calls[0])
    expect(body).not.toHaveProperty('Cmd')
    expect(body.HostConfig).not.toHaveProperty('NanoCpus')
    expect(body).not.toHaveProperty('NetworkingConfig')
  })

  it('start, stop and remove hit their paths and tolerate 304/404', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(304)
    transport.queueResponse(304)
    transport.queueResponse(204)
    transport.queueResponse(404)
    const api = makeApi(transport)

    await api.startContainer('bot-x')
    await api.stopContainer('bot-x')
    await api.stopContainer('bot-x', 30)
    await api.removeContainer('bot-x', true)

    expect(transport.calls[0].path).toBe('/v1.41/containers/bot-x/start')
    expect(transport.calls[1].path).toBe('/v1.41/containers/bot-x/stop')
    expect(transport.calls[2].path).toBe('/v1.41/containers/bot-x/stop?t=30')
    expect(transport.calls[3].path).toBe('/v1.41/containers/bot-x?force=1')
  })

  it('removeContainer without force sends force=0 and tolerates 404', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(404)
    await expect(makeApi(transport).removeContainer('bot-x')).resolves.toBeUndefined()
    expect(transport.calls[0].path).toBe('/v1.41/containers/bot-x?force=0')
  })

  it('stop with a 404 throws not-created', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(404, '{"message":"No such container: bot-x"}')
    const promise = makeApi(transport).stopContainer('bot-x')
    await expect(promise).rejects.toBeInstanceOf(BotHostError)
    await expect(promise).rejects.toMatchObject({ code: 'not-created', message: "This bot's PC hasn't been created yet." })
  })

  it('inspectContainer maps running and stopped states', async () => {
    const running = new FakeTransport()
    running.queueResponse(200, '{"Id":"abc","State":{"Status":"running"}}')
    await expect(makeApi(running).inspectContainer('abc')).resolves.toEqual({ id: 'abc', state: 'running', error: null })

    const stopped = new FakeTransport()
    stopped.queueResponse(200, '{"Id":"abc","State":{"Status":"exited"}}')
    await expect(makeApi(stopped).inspectContainer('abc')).resolves.toEqual({ id: 'abc', state: 'stopped', error: null })
  })

  it('inspectContainer maps absent on 404 and on an empty body', async () => {
    const missing = new FakeTransport()
    missing.queueResponse(404, '{"message":"No such container: abc"}')
    await expect(makeApi(missing).inspectContainer('abc')).resolves.toEqual({ id: null, state: 'absent', error: null })

    const empty = new FakeTransport()
    empty.queueResponse(204)
    await expect(makeApi(empty).inspectContainer('abc')).resolves.toEqual({ id: null, state: 'absent', error: null })
  })

  it('inspectContainer maps Dead, OOMKilled and State.Error', async () => {
    const dead = new FakeTransport()
    dead.queueResponse(200, '{"Id":"abc","State":{"Status":"exited","Dead":true}}')
    await expect(makeApi(dead).inspectContainer('abc')).resolves.toMatchObject({
      id: 'abc',
      state: 'error',
      error: 'This PC died unexpectedly.'
    })

    const oom = new FakeTransport()
    oom.queueResponse(200, '{"Id":"abc","State":{"Status":"exited","OOMKilled":true}}')
    await expect(makeApi(oom).inspectContainer('abc')).resolves.toMatchObject({
      state: 'error',
      error: 'This PC ran out of memory and stopped. Increase its memory limit.'
    })

    const stateError = new FakeTransport()
    stateError.queueResponse(200, '{"Id":"abc","State":{"Status":"exited","Error":"boom"}}')
    await expect(makeApi(stateError).inspectContainer('abc')).resolves.toMatchObject({ state: 'error', error: 'boom' })
  })

  it('inspectContainer reports a transport failure as error with hostError', async () => {
    const transport = new FakeTransport()
    transport.queueError('connect ECONNREFUSED 172.16.0.5:2375')
    const result = await makeApi(transport).inspectContainer('abc')
    expect(result.state).toBe('error')
    expect(result.error).toBe("Can't reach the Docker server at http://172.16.0.5:2375.")
    expect(result.hostError).toBeInstanceOf(BotHostError)
    expect(result.hostError?.code).toBe('engine-not-running')
    expect(result.hostError?.cause).toBe('connect ECONNREFUSED 172.16.0.5:2375')
  })

  it('exec demultiplexes the stream and returns a non-zero exit code without throwing', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(201, '{"Id":"exec-1"}')
    transport.queueResponse(200, multiplexed([1, 'hello'], [2, 'oops']))
    transport.queueResponse(200, '{"ExitCode":7}')
    const api = makeApi(transport)

    const result = await api.exec('abc', { command: ['/bin/sh', '-c', 'echo hi'] })

    expect(result).toEqual({ exitCode: 7, stdout: 'hello', stderr: 'oops' })
    expect(transport.calls[0].path).toBe('/v1.41/containers/abc/exec')
    expect(bodyJson(transport.calls[0])).toEqual({
      Cmd: ['/bin/sh', '-c', 'echo hi'],
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false
    })
    expect(transport.calls[1].path).toBe('/v1.41/exec/exec-1/start')
    expect(transport.calls[1].body).toBeUndefined()
    expect(transport.calls[1].headers).toBeUndefined()
    expect(transport.calls[2].path).toBe('/v1.41/exec/exec-1/json')
  })

  it('exec with input enables AttachStdin and sends the input as the start body', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(201, '{"Id":"exec-1"}')
    transport.queueResponse(200, multiplexed([1, 'pong']))
    transport.queueResponse(200, '{"ExitCode":0}')
    const api = makeApi(transport)

    const result = await api.exec('abc', { command: ['/bin/sh', '-c', 'cat'], input: 'ping\n' })

    expect(result).toEqual({ exitCode: 0, stdout: 'pong', stderr: '' })
    expect(bodyJson(transport.calls[0])).toMatchObject({ AttachStdin: true })
    expect(transport.calls[1].headers).toMatchObject({ 'Content-Type': 'application/vnd.docker.multiplexed-stream' })
    expect(Buffer.from(transport.calls[1].body as Uint8Array).toString('utf8')).toBe('ping\n')
  })

  it('exec answers a 404 on create with not-created', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(404, '{"message":"No such container: abc"}')
    const promise = makeApi(transport).exec('abc', { command: ['/bin/sh', '-c', 'x'] })
    await expect(promise).rejects.toMatchObject({ code: 'not-created' })
  })

  it('pull url-encodes the image and sends base64 registry auth when configured', async () => {
    const withAuth = new FakeTransport()
    withAuth.queueResponse(200, '{"status":"Pulling from ghcr.io/deskmates/bot-pc"}')
    const api = makeApi(withAuth, { registryAuth: { username: 'u', password: 'p' } })

    await api.pull('ghcr.io/deskmates/bot-pc:latest')

    expect(withAuth.calls[0].path).toBe('/v1.41/images/create?fromImage=ghcr.io%2Fdeskmates%2Fbot-pc%3Alatest')
    const expected = Buffer.from('{"username":"u","password":"p"}', 'utf8').toString('base64')
    expect(withAuth.calls[0].headers).toMatchObject({ 'X-Registry-Auth': expected })

    const withServer = new FakeTransport()
    withServer.queueResponse(200)
    const authApi = makeApi(withServer, { registryAuth: { username: 'u', password: 'p', serveraddress: 'ghcr.io' } })
    await authApi.pull('some/image')
    const decoded = Buffer.from(withServer.calls[0].headers?.['X-Registry-Auth'] as string, 'base64').toString('utf8')
    expect(JSON.parse(decoded)).toEqual({ username: 'u', password: 'p', serveraddress: 'ghcr.io' })
  })

  it('pull omits the auth header when registryAuth is unset', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(200)
    await makeApi(transport).pull('ghcr.io/deskmates/bot-pc:latest')
    expect(transport.calls[0].headers).toBeUndefined()
  })

  it('build sends the tar at the pinned path with the x-tar content type', async () => {
    const transport = new FakeTransport()
    transport.queueResponse(200, '{"stream":"Step 1/1 : FROM scratch"}')
    const tar = new TextEncoder().encode('fake-tar-bytes')
    const api = makeApi(transport)

    await api.build(tar, 'ghcr.io/deskmates/bot-pc:latest')

    expect(transport.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1.41/build?t=ghcr.io%2Fdeskmates%2Fbot-pc%3Alatest&dockerfile=Dockerfile',
      headers: { 'Content-Type': 'application/x-tar' }
    })
    expect(Buffer.from(transport.calls[0].body as Uint8Array).equals(Buffer.from(tar))).toBe(true)
  })

  it('putArchive and getArchive pass the tar through and classify 404s', async () => {
    const tar = new TextEncoder().encode('tar-bytes')

    const putOk = new FakeTransport()
    putOk.queueResponse(200)
    const api = makeApi(putOk)
    await api.putArchive('abc', '/home/bot/data/in', tar)
    expect(putOk.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/v1.41/containers/abc/archive?path=%2Fhome%2Fbot%2Fdata%2Fin',
      headers: { 'Content-Type': 'application/x-tar' }
    })
    expect(Buffer.from(putOk.calls[0].body as Uint8Array).equals(Buffer.from(tar))).toBe(true)

    const getOk = new FakeTransport()
    getOk.queueResponse(200, tar)
    await expect(makeApi(getOk).getArchive('abc', '/home/bot/data/out')).resolves.toEqual(tar)
    expect(getOk.calls[0].path).toBe('/v1.41/containers/abc/archive?path=%2Fhome%2Fbot%2Fdata%2Fout')

    const put404 = new FakeTransport()
    put404.queueResponse(404, '{"message":"could not find the destination directory"}')
    await expect(makeApi(put404).putArchive('abc', '/home/bot/data/in', tar)).rejects.toMatchObject({
      code: 'unknown',
      message: "The destination folder doesn't exist in the bot's PC."
    })

    const get404 = new FakeTransport()
    get404.queueResponse(404, '{"message":"Could not find the file /home/bot/data/out"}')
    await expect(makeApi(get404).getArchive('abc', '/home/bot/data/out')).rejects.toMatchObject({
      code: 'unknown',
      message: "That folder or file doesn't exist in the bot's PC."
    })
  })

  it('classifies image-missing, port-taken, not-running and unknown responses', async () => {
    const imageMissing = new FakeTransport()
    imageMissing.queueResponse(404, '{"message":"pull access denied for ghcr.io/deskmates/bot-pc, repository does not exist"}')
    const imagePromise = makeApi(imageMissing).pull('ghcr.io/deskmates/bot-pc:latest')
    await expect(imagePromise).rejects.toMatchObject({
      code: 'image-missing',
      message: "This bot's PC image isn't installed yet. Download or build it from Settings."
    })

    const portTaken = new FakeTransport()
    portTaken.queueResponse(409, '{"message":"Bind for 0.0.0.0:5901 failed: port is already allocated"}')
    const portPromise = makeApi(portTaken).createContainer(sampleSpec())
    await expect(portPromise).rejects.toMatchObject({
      code: 'port-taken',
      message: "Another program is already using this bot's PC ports. Close it and try again."
    })

    const notRunning = new FakeTransport()
    notRunning.queueResponse(409, '{"message":"Container abc is not running"}')
    const execPromise = makeApi(notRunning).exec('abc', { command: ['/bin/sh', '-c', 'x'] })
    await expect(execPromise).rejects.toMatchObject({
      code: 'not-running',
      message: "This bot's PC isn't running right now."
    })

    const unknown = new FakeTransport()
    unknown.queueResponse(500, '{"message":"docker exploded"}')
    const unknownPromise = makeApi(unknown).build(new Uint8Array(), 'some/image')
    await expect(unknownPromise).rejects.toMatchObject({ code: 'unknown', message: 'docker exploded' })
  })

  it('classifies a transport rejection as engine-not-running', async () => {
    const transport = new FakeTransport()
    transport.queueError('connect ECONNREFUSED 172.16.0.5:2375')
    const promise = makeApi(transport).ping()
    await expect(promise).rejects.toBeInstanceOf(BotHostError)
    await expect(promise).rejects.toMatchObject({
      code: 'engine-not-running',
      message: "Can't reach the Docker server at http://172.16.0.5:2375."
    })
  })
})