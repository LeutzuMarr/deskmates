import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcMethod, RpcParams, RpcResult } from '../../src/shared/protocol'
import { EXIT_CORE_ERROR, EXIT_NOT_RUNNING, EXIT_OK, EXIT_USAGE, main, type CliDeps } from '../../src/bridge/cli'
import { NotRunningError, type CoreClient } from '../../src/bridge/client'

let tempDir: string

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

function makeDataDir(withGuide = false): string {
  tempDir = mkdtempSync(join(tmpdir(), 'deskmates-cli-'))
  if (withGuide) {
    mkdirSync(join(tempDir, 'agent-kit'), { recursive: true })
    writeFileSync(join(tempDir, 'agent-kit', 'DESKMATES-AGENTS.md'), '# the guide text', 'utf8')
  }
  return tempDir
}

interface FakeCoreState {
  calls: Array<{ method: RpcMethod; params: unknown }>
  replies: Partial<Record<RpcMethod, (params: unknown) => unknown>>
}

function makeDeps(state: FakeCoreState): {
  deps: CliDeps
  out: string[]
  err: string[]
  getCloses: () => number
} {
  const out: string[] = []
  const err: string[] = []
  let closes = 0
  const client: CoreClient = {
    call: (async <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      state.calls.push({ method, params })
      const reply = state.replies[method]
      if (!reply) throw new Error(`Unexpected call to ${method}`)
      return reply(params) as RpcResult<M>
    }) as CoreClient['call'],
    close: () => {
      closes++
    }
  }
  const deps: CliDeps = {
    connectCore: async () => client,
    log: (text) => out.push(text),
    error: (text) => err.push(text)
  }
  return { deps, out, err, getCloses: () => closes }
}

function newCore(replies: FakeCoreState['replies'] = {}): FakeCoreState & ReturnType<typeof makeDeps> {
  const state: FakeCoreState = { calls: [], replies }
  return { ...state, ...makeDeps(state) }
}

describe('usage and global flags', () => {
  it('prints the usage for no command, help and --help, with exit 0', async () => {
    const { deps, out } = newCore()
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      expect(await main(argv, deps)).toBe(EXIT_OK)
    }
    expect(out).toHaveLength(4)
    expect(out[0]).toContain('Usage: deskmates')
    expect(out[0]).toContain('design list')
  })

  it('fails with exit 1 when no data dir is known', async () => {
    const { deps, err } = newCore()
    expect(await main(['design', 'list'], deps)).toBe(EXIT_USAGE)
    expect(err[0]).toContain('DESKMATES_DATA_DIR')
    expect(err[0]).toContain('--data-dir')
  })

  it('takes the data dir from --data-dir', async () => {
    const dir = makeDataDir(true)
    const { deps, out } = newCore()
    expect(await main(['guide', '--data-dir', dir], deps)).toBe(EXIT_OK)
    expect(out).toEqual(['# the guide text'])
  })

  it('prefers --data-dir over DESKMATES_DATA_DIR', async () => {
    const dir = makeDataDir(true)
    const { deps, out } = newCore()
    process.env.DESKMATES_DATA_DIR = 'D:\\does-not-exist\\anywhere'
    try {
      expect(await main(['guide', '--data-dir', dir], deps)).toBe(EXIT_OK)
      expect(out).toEqual(['# the guide text'])
    } finally {
      delete process.env.DESKMATES_DATA_DIR
    }
  })

  it('falls back to DESKMATES_DATA_DIR', async () => {
    const dir = makeDataDir(true)
    const { deps, out } = newCore()
    const previous = process.env.DESKMATES_DATA_DIR
    process.env.DESKMATES_DATA_DIR = dir
    try {
      expect(await main(['guide'], deps)).toBe(EXIT_OK)
      expect(out).toEqual(['# the guide text'])
    } finally {
      if (previous === undefined) delete process.env.DESKMATES_DATA_DIR
      else process.env.DESKMATES_DATA_DIR = previous
    }
  })

  it('accepts --data-dir=<path> and --json anywhere', async () => {
    const dir = makeDataDir(true)
    const { deps, out } = newCore()
    expect(await main(['--json', 'guide', `--data-dir=${dir}`], deps)).toBe(EXIT_OK)
    expect(out).toEqual(['# the guide text'])
  })

  it('exits 1 for an unknown command', async () => {
    const dir = makeDataDir(true)
    const { deps, err } = newCore()
    expect(await main(['frobnicate', '--data-dir', dir], deps)).toBe(EXIT_USAGE)
    expect(err[0]).toContain('Unknown command: frobnicate')
  })
})

describe('the guide command', () => {
  it('prints the guide and exits 0', async () => {
    const dir = makeDataDir(true)
    const { deps, out } = newCore()
    expect(await main(['guide', '--data-dir', dir], deps)).toBe(EXIT_OK)
    expect(out).toEqual(['# the guide text'])
  })

  it('exits 2 when the guide file is missing (the app never ran)', async () => {
    const dir = makeDataDir(false)
    const { deps, err } = newCore()
    expect(await main(['guide', '--data-dir', dir], deps)).toBe(EXIT_NOT_RUNNING)
    expect(err[0]).toContain("Deskmates isn't running")
  })
})

describe('the design commands', () => {
  const DESIGN_ID = '5f0b3c2e-1a4b-4c8d-9e2f-3a1b2c3d4e5f'

  function designCore(): FakeCoreState & ReturnType<typeof makeDeps> {
    return newCore({
      'projects.list': () => [
        { id: 'p1', name: 'Work', folder: 'D:\\d\\work', kind: 'work', model: null, createdAt: 1 },
        { id: DESIGN_ID, name: 'Landing', folder: 'D:\\d\\designs\\abc', kind: 'design', model: null, createdAt: 2 }
      ],
      'designs.read': () => ({ html: '<p>hi</p>', updatedAt: 5 }),
      'designs.save': () => ({ updatedAt: 9 }),
      'designs.create': () => ({
        project: { id: DESIGN_ID, name: 'New', folder: 'D:\\d\\designs\\abc', kind: 'design', model: null, createdAt: 3 },
        task: { id: 't1' }
      })
    })
  }

  it('design list prints tab-separated rows', async () => {
    const dir = makeDataDir(true)
    const core = designCore()
    expect(await main(['design', 'list', '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    expect(core.out[0]).toContain(DESIGN_ID)
    expect(core.out[0]).toContain('D:\\d\\designs\\abc')
    expect(core.calls).toEqual([{ method: 'projects.list', params: {} }])
  })

  it('design list --json prints JSON', async () => {
    const dir = makeDataDir(true)
    const core = designCore()
    expect(await main(['design', 'list', '--json', '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    const parsed = JSON.parse(core.out[0]) as Array<{ id: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe(DESIGN_ID)
  })

  it('design list says when there are none', async () => {
    const dir = makeDataDir(true)
    const core = newCore({ 'projects.list': () => [] })
    expect(await main(['design', 'list', '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    expect(core.out[0]).toBe('No designs yet.')
  })

  it('design path prints the index.html path', async () => {
    const dir = makeDataDir(true)
    const core = designCore()
    expect(await main(['design', 'path', DESIGN_ID, '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    expect(core.out[0]).toBe(join('D:\\d\\designs\\abc', 'index.html'))
  })

  it('design read prints the HTML', async () => {
    const dir = makeDataDir(true)
    const core = designCore()
    expect(await main(['design', 'read', DESIGN_ID, '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    expect(core.out[0]).toBe('<p>hi</p>')
  })

  it('design write reads the file and saves it as external', async () => {
    const dir = makeDataDir(true)
    const htmlPath = join(tempDir, 'new.html')
    writeFileSync(htmlPath, '<p>new</p>', 'utf8')
    const core = designCore()
    expect(await main(['design', 'write', DESIGN_ID, htmlPath, '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    expect(core.calls[0]).toEqual({
      method: 'designs.save',
      params: { projectId: DESIGN_ID, html: '<p>new</p>', reason: 'external' }
    })
    expect(core.out[0]).toContain('Saved')
  })

  it('design create passes the name and prompt', async () => {
    const dir = makeDataDir(true)
    const core = designCore()
    expect(await main(['design', 'create', 'New', '--prompt', 'make it blue', '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    expect(core.calls[0]).toEqual({ method: 'designs.create', params: { name: 'New', prompt: 'make it blue' } })
    expect(core.out[0]).toContain('Created "New"')
  })

  it('design create works without a prompt', async () => {
    const dir = makeDataDir(true)
    const core = designCore()
    expect(await main(['design', 'create', 'New', '--data-dir', dir], core.deps)).toBe(EXIT_OK)
    expect(core.calls[0].params).toEqual({ name: 'New' })
  })

  it('design needs a subcommand and ids', async () => {
    const dir = makeDataDir(true)
    const core = designCore()
    expect(await main(['design', '--data-dir', dir], core.deps)).toBe(EXIT_USAGE)
    expect(await main(['design', 'read', '--data-dir', dir], core.deps)).toBe(EXIT_USAGE)
    expect(await main(['design', 'write', DESIGN_ID, '--data-dir', dir], core.deps)).toBe(EXIT_USAGE)
    expect(await main(['design', 'bogus', 'x', '--data-dir', dir], core.deps)).toBe(EXIT_USAGE)
  })

  it('a core error becomes exit 3 with the message on stderr', async () => {
    const dir = makeDataDir(true)
    const core = newCore({
      'projects.list': () => {
        throw new Error('core exploded')
      }
    })
    expect(await main(['design', 'list', '--data-dir', dir], core.deps)).toBe(EXIT_CORE_ERROR)
    expect(core.err[0]).toBe('core exploded')
  })
})


describe('the pc commands', () => {
  it('pc list reports that bot PCs aren\u2019t set up, with exit 3', async () => {
    const dir = makeDataDir(true)
    const { deps, err } = newCore()
    expect(await main(['pc', 'list', '--data-dir', dir], deps)).toBe(EXIT_CORE_ERROR)
    expect(err[0]).toContain("Bot PCs aren't set up")
    expect(err[0]).toContain('Set up bot PCs')
  })

  it('pc exec, open and screenshot say the same', async () => {
    const dir = makeDataDir(true)
    const { deps, err } = newCore()
    expect(await main(['pc', 'exec', 'pc1', '--', 'ls', '-la', '--data-dir', dir], deps)).toBe(EXIT_CORE_ERROR)
    expect(err[0]).toContain("Bot PCs aren't set up")
    expect(await main(['pc', 'open', 'pc1', 'https://example.com', '--data-dir', dir], deps)).toBe(EXIT_CORE_ERROR)
    expect(await main(['pc', 'screenshot', 'pc1', 'out.png', '--data-dir', dir], deps)).toBe(EXIT_CORE_ERROR)
  })

  it('pc exec without -- or a command is a usage error', async () => {
    const dir = makeDataDir(true)
    const { deps, err } = newCore()
    expect(await main(['pc', 'exec', '--data-dir', dir], deps)).toBe(EXIT_USAGE)
    expect(err[0]).toContain('pc exec needs')
  })

  it('pc open and screenshot without a url or file are usage errors', async () => {
    const dir = makeDataDir(true)
    const { deps, err } = newCore()
    expect(await main(['pc', 'open', 'pc1', '--data-dir', dir], deps)).toBe(EXIT_USAGE)
    expect(await main(['pc', 'screenshot', 'pc1', '--data-dir', dir], deps)).toBe(EXIT_USAGE)
    expect(await main(['pc', 'frobnicate', '--data-dir', dir], deps)).toBe(EXIT_USAGE)
  })
})

describe('not running and closing', () => {
  it('maps NotRunningError to exit 2 and the message on stderr', async () => {
    const dir = makeDataDir(true)
    const out: string[] = []
    const err: string[] = []
    const deps: CliDeps = {
      connectCore: async () => {
        throw new NotRunningError()
      },
      log: (text) => out.push(text),
      error: (text) => err.push(text)
    }
    expect(await main(['design', 'list', '--data-dir', dir], deps)).toBe(EXIT_NOT_RUNNING)
    expect(err[0]).toContain("Deskmates isn't running")
    expect(out).toEqual([])
  })

  it('maps a refused connection to exit 3', async () => {
    const dir = makeDataDir(true)
    const err: string[] = []
    const deps: CliDeps = {
      connectCore: async () => {
        throw new Error('ECONNREFUSED')
      },
      log: () => {},
      error: (text) => err.push(text)
    }
    expect(await main(['design', 'list', '--data-dir', dir], deps)).toBe(EXIT_CORE_ERROR)
    expect(err[0]).toBe('ECONNREFUSED')
  })

  it('always closes the client, even when the command throws', async () => {
    const dir = makeDataDir(true)
    const core = newCore({
      'projects.list': () => {
        throw new Error('boom')
      }
    })
    expect(await main(['design', 'list', '--data-dir', dir], core.deps)).toBe(EXIT_CORE_ERROR)
    expect(core.getCloses()).toBe(1)
  })
})

