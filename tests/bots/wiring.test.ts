import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type PcCloudConnection, type Settings } from '../../src/shared/protocol'
import { CloudHost } from '../../src/core/bots/cloud-host'
import { LocalWslHost } from '../../src/core/bots/local-wsl-host'
import { BotHostError } from '../../src/core/bots/host'
import { resolveBotHost, UnavailableHost } from '../../src/core/bots/wiring'

const EMPTY_CONNECTION: PcCloudConnection = {
  endpoint: '',
  tlsCertPath: '',
  tlsKeyPath: '',
  tlsCaPath: '',
  registryUsername: '',
  registryPassword: ''
}

function settings(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'deskmates-wiring-'))
}

const runner = {
  run: async () => ({ code: 0, stdout: '', stderr: '' })
}

describe('resolveBotHost', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('returns a LocalWslHost when pcHost is local', () => {
    const host = resolveBotHost({ settings: settings({ pcHost: 'local' }), dataDir: tmpDir(), runner })
    expect(host).toBeInstanceOf(LocalWslHost)
  })

  it('returns null for cloud mode without a connection object', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const host = resolveBotHost({ settings: settings({ pcHost: 'cloud', pcConnection: null }), dataDir, runner })
    expect(host).toBeNull()
  })

  it('returns null for cloud mode with an empty endpoint', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const host = resolveBotHost({
      settings: settings({ pcHost: 'cloud', pcConnection: { ...EMPTY_CONNECTION, endpoint: '   ' } }),
      dataDir,
      runner
    })
    expect(host).toBeNull()
  })

  it('returns null for a malformed endpoint', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const host = resolveBotHost({
      settings: settings({ pcHost: 'cloud', pcConnection: { ...EMPTY_CONNECTION, endpoint: 'not-a-url' } }),
      dataDir,
      runner
    })
    expect(host).toBeNull()
  })

  it('returns null when http(s) endpoints are missing a port', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const host = resolveBotHost({
      settings: settings({ pcHost: 'cloud', pcConnection: { ...EMPTY_CONNECTION, endpoint: 'https://10.0.0.5' } }),
      dataDir,
      runner
    })
    expect(host).toBeNull()
  })

  it('returns a CloudHost for a valid tcp endpoint without TLS', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const host = resolveBotHost({
      settings: settings({ pcHost: 'cloud', pcConnection: { ...EMPTY_CONNECTION, endpoint: 'tcp://10.0.0.5:2375' } }),
      dataDir,
      runner
    })
    expect(host).toBeInstanceOf(CloudHost)
  })

  it('returns a CloudHost when all three TLS files are readable', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const cert = join(dataDir, 'cert.pem')
    const key = join(dataDir, 'key.pem')
    const ca = join(dataDir, 'ca.pem')
    writeFileSync(cert, 'cert', 'utf8')
    writeFileSync(key, 'key', 'utf8')
    writeFileSync(ca, 'ca', 'utf8')
    const host = resolveBotHost({
      settings: settings({
        pcHost: 'cloud',
        pcConnection: { ...EMPTY_CONNECTION, endpoint: 'tcp://10.0.0.5:2376', tlsCertPath: cert, tlsKeyPath: key, tlsCaPath: ca }
      }),
      dataDir,
      runner
    })
    expect(host).toBeInstanceOf(CloudHost)
  })

  it('returns null when only some TLS files are configured', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const host = resolveBotHost({
      settings: settings({
        pcHost: 'cloud',
        pcConnection: { ...EMPTY_CONNECTION, endpoint: 'tcp://10.0.0.5:2376', tlsCertPath: join(dataDir, 'cert.pem') }
      }),
      dataDir,
      runner
    })
    expect(host).toBeNull()
  })

  it('returns null when a configured TLS file is unreadable', () => {
    const dataDir = tmpDir()
    dirs.push(dataDir)
    const cert = join(dataDir, 'cert.pem')
    const key = join(dataDir, 'key.pem')
    writeFileSync(cert, 'cert', 'utf8')
    writeFileSync(key, 'key', 'utf8')
    const host = resolveBotHost({
      settings: settings({
        pcHost: 'cloud',
        pcConnection: {
          ...EMPTY_CONNECTION,
          endpoint: 'tcp://10.0.0.5:2376',
          tlsCertPath: cert,
          tlsKeyPath: key,
          tlsCaPath: join(dataDir, 'missing.pem')
        }
      }),
      dataDir,
      runner
    })
    expect(host).toBeNull()
  })
})

describe('UnavailableHost', () => {
  it('rejects usage calls with an engine-not-running BotHostError', async () => {
    const host = new UnavailableHost()
    await expect(host.start('bot-1')).rejects.toMatchObject({ code: 'engine-not-running' })
    await expect(host.pull()).rejects.toMatchObject({ code: 'engine-not-running' })
  })

  it('reports status as an error state instead of throwing', async () => {
    const host = new UnavailableHost()
    const pc = await host.status('bot-1')
    expect(pc.state).toBe('error')
    expect(pc.error).toContain("aren't set up")
  })

  it('throws BotHostError instances with a plain message', async () => {
    const host = new UnavailableHost()
    try {
      await host.exec('bot-1', 'echo', ['hi'])
      expect.unreachable('exec should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BotHostError)
      expect((error as BotHostError).message).toContain("Bot PCs aren't set up yet.")
    }
  })
})