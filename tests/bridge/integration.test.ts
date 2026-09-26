import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { agentKitDir } from '../../src/core/agents/guide'
import { EventBus } from '../../src/core/events'
import { ChangeLog } from '../../src/core/fs/change-log'
import { TaskRunner } from '../../src/core/engine/runner'
import { KeyStore } from '../../src/core/models/keys'
import { ModelService } from '../../src/core/models/providers'
import { createHandlers } from '../../src/core/server/handlers'
import { startRpcServer, type AgentAccess } from '../../src/core/server/rpc-server'
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'
import { buildTools } from '../../src/core/tools'
import type { CoreEvent } from '../../src/shared/protocol'
import { type Call, designCreate, designList, designRead, designWrite } from '../../src/bridge/actions'
import { connectCore, type CoreClient } from '../../src/bridge/client'

/** The same allowlist src/core/main.ts gives connected agents. */
const AGENT_METHODS = ['app.info', 'projects.list', 'designs.read', 'designs.save', 'designs.create'] as const
const AGENT_EVENTS = ['design.updated', 'project.updated'] as const

interface Rig {
  dataDir: string
  events: CoreEvent[]
  client: CoreClient
  call: Call
  cleanup(): Promise<void>
}

let rigs: Rig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.cleanup()
})

/**
 * Assembles a real RPC server and real handlers over a temp data folder and an in-memory
 * database, mirroring how src/core/main.ts wires the agent kit, writes bridge.json, then
 * connects to it with the real bridge client using the agent token (not the app token).
 */
async function startRig(): Promise<Rig> {
  const dataDir = mkdtempSync(join(tmpdir(), 'deskmates-bridge-integration-'))
  const db: DatabaseSync = openDatabase(':memory:')
  const repos = createRepos(db)
  const bus = new EventBus()
  const keys = new KeyStore()
  const models = new ModelService(keys, () => repos.settings.get())
  const changes = new ChangeLog(repos.changes, join(dataDir, 'snapshots'))
  const runner = new TaskRunner({ repos, bus, models, changes, createTools: buildTools })

  const events: CoreEvent[] = []
  bus.on((event) => events.push(event))

  const agentToken = randomBytes(24).toString('hex')
  const agent: AgentAccess = { token: agentToken, methods: AGENT_METHODS, events: AGENT_EVENTS }

  const handlers = createHandlers({
    repos,
    bus,
    runner,
    changes,
    models,
    keys,
    version: '0.1.0',
    dataDir,
    agentKit: {
      guidePath: join(dataDir, 'agent-kit', 'DESKMATES-AGENTS.md'),
      commandPath: join(dataDir, 'agent-kit', 'deskmates.cmd')
    }
  })

  const server = await startRpcServer({ handlers, bus, port: 0, agent })

  const kitDir = agentKitDir(dataDir)
  mkdirSync(kitDir, { recursive: true })
  writeFileSync(join(kitDir, 'bridge.json'), JSON.stringify({ port: server.port, token: agentToken }), 'utf8')

  const client = await connectCore({ dataDir })
  const call: Call = (method, params) => client.call(method, params)

  return {
    dataDir,
    events,
    client,
    call,
    cleanup: async () => {
      client.close()
      await server.close()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

async function makeRig(): Promise<Rig> {
  const rig = await startRig()
  rigs.push(rig)
  return rig
}

describe('the bridge against a real core', () => {
  it('an agent creates, lists, reads and writes a design over the wire, reported as an external change', async () => {
    const rig = await makeRig()

    const created = await designCreate(rig.call, 'Landing page')
    expect(created.project.kind).toBe('design')

    const list = await designList(rig.call)
    expect(list).toEqual([{ id: created.project.id, name: 'Landing page', folder: created.project.folder }])

    const read1 = await designRead(rig.call, created.project.id)
    expect(read1.html).toContain('Landing page')

    rig.events.length = 0
    const html = '<!doctype html><html><body><p>Edited by an agent</p></body></html>'
    const written = await designWrite(rig.call, created.project.id, html)
    expect(typeof written.updatedAt).toBe('number')

    const read2 = await designRead(rig.call, created.project.id)
    expect(read2.html).toBe(html)

    const updates = rig.events.filter((event) => event.type === 'design.updated')
    expect(updates).toEqual([
      { type: 'design.updated', projectId: created.project.id, updatedAt: written.updatedAt, source: 'external' }
    ])
  })

  it('refuses a method outside the agent allowlist', async () => {
    const rig = await makeRig()

    await expect(rig.client.call('settings.get', {})).rejects.toThrow(
      "This method isn't available to connected agents."
    )
  })
})
