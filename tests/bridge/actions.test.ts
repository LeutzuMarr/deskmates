import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcMethod, RpcParams, RpcResult } from '../../src/shared/protocol'
import {
  PCS_NOT_SET_UP,
  PcNotSetUpError,
  designCreate,
  designList,
  designPath,
  designRead,
  designWrite,
  guide,
  pcExec,
  pcList,
  pcOpen,
  pcScreenshot,
  type Call
} from '../../src/bridge/actions'

interface RecordedCall {
  method: RpcMethod
  params: unknown
}

/** A fake core: records every call and answers from a canned reply table. */
function fakeCore(replies: Partial<Record<RpcMethod, (params: unknown) => unknown>> = {}): {
  call: Call
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const call = (async <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
    calls.push({ method, params })
    const reply = replies[method]
    if (!reply) throw new Error(`Unexpected call to ${method}`)
    return reply(params) as RpcResult<M>
  }) as Call
  return { call, calls }
}

let tempDir: string

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'deskmates-actions-'))
  return tempDir
}

const WORK_PROJECT = { id: 'p-work', name: 'Invoices', folder: 'D:\\d\\work', kind: 'work' as const, model: null, createdAt: 1 }
const DESIGN_PROJECT = {
  id: '5f0b3c2e-1a4b-4c8d-9e2f-3a1b2c3d4e5f',
  name: 'Landing page',
  folder: 'D:\\d\\designs\\5f0b',
  kind: 'design' as const,
  model: null,
  createdAt: 2
}

describe('designList', () => {
  it('calls projects.list and keeps only design projects', async () => {
    const { call, calls } = fakeCore({
      'projects.list': () => [WORK_PROJECT, DESIGN_PROJECT]
    })
    const designs = await designList(call)
    expect(calls).toEqual([{ method: 'projects.list', params: {} }])
    expect(designs).toEqual([{ id: DESIGN_PROJECT.id, name: DESIGN_PROJECT.name, folder: DESIGN_PROJECT.folder }])
  })

  it('returns an empty list when there are no designs', async () => {
    const { call } = fakeCore({ 'projects.list': () => [] })
    expect(await designList(call)).toEqual([])
  })
})

describe('designPath', () => {
  it('joins the design folder with index.html', async () => {
    const { call } = fakeCore({ 'projects.list': () => [DESIGN_PROJECT] })
    expect(await designPath(call, DESIGN_PROJECT.id)).toBe(join(DESIGN_PROJECT.folder, 'index.html'))
  })

  it('throws for an unknown id', async () => {
    const { call } = fakeCore({ 'projects.list': () => [] })
    await expect(designPath(call, 'nope')).rejects.toThrow('No design with id nope.')
  })
})

describe('designRead', () => {
  it('passes the projectId through to designs.read', async () => {
    const { call, calls } = fakeCore({ 'designs.read': () => ({ html: '<p>hi</p>', updatedAt: 5 }) })
    const result = await designRead(call, DESIGN_PROJECT.id)
    expect(result).toEqual({ html: '<p>hi</p>', updatedAt: 5 })
    expect(calls).toEqual([{ method: 'designs.read', params: { projectId: DESIGN_PROJECT.id } }])
  })
})

describe('designWrite', () => {
  it('sends the html with reason external', async () => {
    const { call, calls } = fakeCore({ 'designs.save': () => ({ updatedAt: 9 }) })
    const result = await designWrite(call, DESIGN_PROJECT.id, '<p>new</p>')
    expect(result).toEqual({ updatedAt: 9 })
    expect(calls).toEqual([
      { method: 'designs.save', params: { projectId: DESIGN_PROJECT.id, html: '<p>new</p>', reason: 'external' } }
    ])
  })
})

describe('designCreate', () => {
  it('omits the prompt when none is given', async () => {
    const { call, calls } = fakeCore({ 'designs.create': () => ({ project: DESIGN_PROJECT, task: { id: 't1' } }) })
    await designCreate(call, 'Landing page')
    expect(calls[0].params).toEqual({ name: 'Landing page' })
  })

  it('passes the prompt through', async () => {
    const { call, calls } = fakeCore({ 'designs.create': () => ({ project: DESIGN_PROJECT, task: { id: 't1' } }) })
    await designCreate(call, 'Landing page', 'make it blue')
    expect(calls[0].params).toEqual({ name: 'Landing page', prompt: 'make it blue' })
  })
})

describe('the pc actions', () => {
  const { call } = fakeCore()

  it('all four throw PcNotSetUpError with the same message', async () => {
    for (const action of [
      () => pcList(call),
      () => pcExec(call, 'pc1', 'ls'),
      () => pcOpen(call, 'pc1', 'https://example.com'),
      () => pcScreenshot(call, 'pc1', 'out.png')
    ]) {
      await expect(action()).rejects.toThrow(PcNotSetUpError)
      await expect(action()).rejects.toThrow(PCS_NOT_SET_UP)
      await expect(action()).rejects.toThrow(/Set up bot PCs/)
    }
  })

  it('gives the error the name PcNotSetUpError', async () => {
    const error = await pcList(call).catch((caught: Error) => caught)
    expect(error.name).toBe('PcNotSetUpError')
  })
})

describe('guide', () => {
  it('reads the guide file from the agent-kit folder', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'agent-kit'), { recursive: true })
    writeFileSync(join(dir, 'agent-kit', 'DESKMATES-AGENTS.md'), '# guide body', 'utf8')
    expect(guide(dir)).toBe('# guide body')
  })

  it('round-trips with writeAgentGuide', async () => {
    const { writeAgentGuide } = await import('../../src/core/agents/guide')
    const dir = makeTempDir()
    const written = writeAgentGuide({ dataDir: dir, commandPath: join(dir, 'agent-kit', 'deskmates.cmd'), appVersion: '0.1.0', pcs: { installed: false } })
    expect(guide(dir)).toBe(written.markdown)
    expect(readFileSync(written.path, 'utf8')).toBe(written.markdown)
  })
})
