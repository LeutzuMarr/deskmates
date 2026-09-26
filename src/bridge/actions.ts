import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentKitDir } from '../core/agents/guide'
import type { RpcMethod, RpcParams, RpcResult } from '../shared/protocol'

/** The connectCore client satisfies this; tests pass a fake instead. */
export type Call = <M extends RpcMethod>(method: M, params: RpcParams<M>) => Promise<RpcResult<M>>

/** What the pc commands say until the bot engine ships (stage 2). */
export const PCS_NOT_SET_UP = "Bot PCs aren't set up on this computer yet. Open Deskmates → Bots → Set up bot PCs first."

/** Thrown by the pc actions until stage 2 wires them to the bot engine. */
export class PcNotSetUpError extends Error {
  constructor() {
    super(PCS_NOT_SET_UP)
    this.name = 'PcNotSetUpError'
  }
}
/** Prints the current agent guide. Reads the file directly; no connection needed. */
export function guide(dataDir: string): string {
  return readFileSync(join(agentKitDir(dataDir), 'DESKMATES-AGENTS.md'), 'utf8')
}

export interface DesignSummary {
  id: string
  name: string
  folder: string
}

/** Lists the designs (projects of kind `design`). */
export async function designList(call: Call): Promise<DesignSummary[]> {
  const projects = await call('projects.list', {})
  return projects
    .filter((project) => project.kind === 'design')
    .map((project) => ({ id: project.id, name: project.name, folder: project.folder }))
}

/** Prints the full path of a design's index.html. */
export async function designPath(call: Call, id: string): Promise<string> {
  const designs = await designList(call)
  const design = designs.find((entry) => entry.id === id)
  if (!design) throw new Error(`No design with id ${id}.`)
  return join(design.folder, 'index.html')
}

/** Reads a design's HTML. */
export function designRead(call: Call, id: string) {
  return call('designs.read', { projectId: id })
}

/** Replaces a design's HTML, marked as coming from outside the app. */
export function designWrite(call: Call, id: string, html: string) {
  return call('designs.save', { projectId: id, html, reason: 'external' })
}

// The pc actions stay stubs until stage 2 wires the bridge to the bot engine;
// the guide already tells agents the same thing these messages say.
export async function pcList(_call: Call): Promise<never> {
  throw new PcNotSetUpError()
}

export async function pcExec(_call: Call, _pc: string, _command: string): Promise<never> {
  throw new PcNotSetUpError()
}

export async function pcOpen(_call: Call, _pc: string, _url: string): Promise<never> {
  throw new PcNotSetUpError()
}

export async function pcScreenshot(_call: Call, _pc: string, _outFile: string): Promise<never> {
  throw new PcNotSetUpError()
}

/** Makes a new design, optionally with a first prompt for the assistant. */
export function designCreate(call: Call, name: string, prompt?: string) {
  return call('designs.create', prompt === undefined ? { name } : { name, prompt })
}

