/**
 * Small helpers used only by `core/main.ts` to wire the bot services together safely. Kept out of
 * `engine.ts`/`local-wsl-host.ts` themselves so those stay exactly what their own tasks built and
 * tested; this file only adds a defensive layer on top for the composition root.
 */
import { readFileSync } from 'node:fs'
import type { EventBus } from '../events'
import type { BotPc, EngineStatus, Settings } from '../../shared/protocol'
import type { Repos } from '../store/repos'
import type { CommandRunner } from './command-runner'
import type { BotHost, CreatePcOptions, PcEndpoints, PcMode, ExecOptions, ExecResult } from './host'
import { BotHostError } from './host'
import type { EngineService } from './services'
import { LocalWslHost } from './local-wsl-host'
import { CloudHost } from './cloud-host'
import { createDockerApi, parseDockerEndpoint, type DockerTls } from './docker-api'

/**
 * Wraps a real `EngineService` so nothing it does can ever reject `engine.status`/`engine.setup`
 * or throw past the RPC handler — the Bots tab always gets back a real `EngineStatus` to render
 * (steps, plain-language detail) instead of a bare RPC error string. `EngineManager` already
 * resolves instead of throwing for every failure mode it recognizes (see task-22-report.md); this
 * is a backstop for whatever it doesn't, so a bug here degrades to an honest "something went
 * wrong" status rather than taking the whole call down.
 */
export function wrapEngineService(engine: EngineService): EngineService {
  const fallback = (error: unknown): EngineStatus => {
    const message = error instanceof Error ? error.message : String(error)
    const waiting = (detail: string) => ({ state: 'missing' as const, detail })
    return {
      ready: false,
      // Left true: an unexpected exception here isn't evidence virtualization is off, and this
      // module has no way to actually check it.
      virtualization: true,
      steps: {
        wsl: { state: 'error', detail: `Checking bot PCs failed unexpectedly: ${message}` },
        distro: waiting('Waiting for WSL to be ready first.'),
        docker: waiting('Waiting for the deskmates-engine distro first.'),
        image: waiting('Waiting for Docker to be ready first.')
      }
    }
  }

  return {
    async status() {
      try {
        return await engine.status()
      } catch (error) {
        return fallback(error)
      }
    },
    async setup(onProgress) {
      try {
        return await engine.setup(onProgress)
      } catch (error) {
        return fallback(error)
      }
    }
  }
}

/**
 * A `BotHost` for when no PC host is configured or reachable (cloud mode with an incomplete or
 * unreadable connection): every usage method answers with an "not set up yet" `BotHostError`, so
 * a bot run fails fast with a plain message instead of an unhandled rejection. `status()` honors
 * its BotHost contract of never throwing and reports an error state instead.
 */
export class UnavailableHost implements BotHost {
  private async fail(): Promise<never> {
    throw new BotHostError('engine-not-running', "Bot PCs aren't set up yet.")
  }

  create(_botId: string, _options: CreatePcOptions): Promise<BotPc> {
    return this.fail()
  }
  start(_botId: string): Promise<BotPc> {
    return this.fail()
  }
  stop(_botId: string): Promise<BotPc> {
    return this.fail()
  }
  reset(_botId: string): Promise<BotPc> {
    return this.fail()
  }
  delete(_botId: string): Promise<void> {
    return this.fail()
  }
  endpoints(_botId: string): Promise<PcEndpoints | null> {
    return this.fail()
  }
  exec(_botId: string, _command: string, _args: string[], _options?: ExecOptions): Promise<ExecResult> {
    return this.fail()
  }
  copyIn(_botId: string, _localPath: string, _containerPath: string): Promise<void> {
    return this.fail()
  }
  copyOut(_botId: string, _containerPath: string, _localPath: string): Promise<void> {
    return this.fail()
  }
  pull(_image?: string): Promise<void> {
    return this.fail()
  }
  buildLocal(_contextDir: string, _image?: string): Promise<void> {
    return this.fail()
  }
  async status(botId: string): Promise<BotPc> {
    return {
      botId,
      state: 'error',
      containerId: null,
      memoryMb: 0,
      idleStopMinutes: 0,
      lastUsedAt: null,
      error: "Bot PCs aren't set up yet."
    }
  }
}

/**
 * Picks which `BotHost` implementation bot PCs run on for this session, from the saved settings.
 * `pcHost: 'local'` always yields a `LocalWslHost`; `'cloud'` yields a `CloudHost` only when the
 * connection is complete (a parseable endpoint, and — if any TLS path is set — all three TLS files
 * readable) and `null` otherwise, so callers can fall back to "not set up" answers instead of
 * guessing. Both returned concrete hosts carry the extra methods `PcService` wants (setMode,
 * updatePcOptions), so they can be handed to handlers unchanged. The host is chosen once at boot;
 * changing the settings takes effect on the next restart.
 */
export function resolveBotHost(options: {
  settings: Settings
  dataDir: string
  runner: CommandRunner
  mode?: PcMode
}): LocalWslHost | CloudHost | null {
  const { settings, dataDir, runner, mode } = options
  if (settings.pcHost !== 'cloud') {
    return new LocalWslHost({ runner, dataDir, mode: mode ?? 'own' })
  }

  const connection = settings.pcConnection
  if (!connection || connection.endpoint.trim() === '') return null

  const tlsPaths = [connection.tlsCertPath, connection.tlsKeyPath, connection.tlsCaPath].map((p) => p.trim())
  const parsed = parseDockerEndpoint(connection.endpoint.trim(), tlsPaths.some((p) => p !== ''))
  if (!parsed) return null

  let tls: DockerTls | null = null
  if (tlsPaths.some((p) => p !== '')) {
    if (tlsPaths.some((p) => p === '')) return null
    try {
      tls = { cert: readFileSync(tlsPaths[0]), key: readFileSync(tlsPaths[1]), ca: readFileSync(tlsPaths[2]) }
    } catch (error) {
      console.warn('[core] cloud bot PC TLS files were unreadable; no PC host until they can be read', error)
      return null
    }
  }

  const username = connection.registryUsername.trim()
  const password = connection.registryPassword.trim()
  const registryAuth = username !== '' && password !== '' ? { username, password } : undefined

  const api = createDockerApi({
    baseUrl: `${parsed.secure ? 'https' : 'http'}://${parsed.host}:${parsed.port}`,
    tls: tls ?? null,
    registryAuth
  })
  return new CloudHost({ api, dataDir, mode: mode ?? 'own', endpointsHost: parsed.host })
}

/**
 * Refreshes every bot's PC row from the real host right after startup, so state left over from a
 * previous session — a container still running, one that's gone, or an engine that isn't reachable
 * at all — resolves to what's actually true before the Bots tab loads, instead of whatever was last
 * saved. `BotHost.status()` never throws on its own (failures come back as `state: 'error'`), but
 * each bot is still reconciled independently and defensively so one unexpected exception can't stop
 * the rest, and nothing here is awaited by `main()` itself — a slow or hanging external command must
 * never delay startup.
 */
export async function reconcilePcs(options: {
  repos: Pick<Repos, 'botPcs'>
  host: Pick<BotHost, 'status'>
  bus: EventBus
}): Promise<void> {
  const { repos, host, bus } = options
  const pcs = repos.botPcs.list()
  await Promise.all(
    pcs.map(async (pc) => {
      try {
        const live = await host.status(pc.botId)
        const saved = repos.botPcs.save(live)
        bus.emit({ type: 'pc.updated', pc: saved })
      } catch (error) {
        console.error(`[core] failed to reconcile bot PC state for ${pc.botId}`, error)
      }
    })
  )
}
