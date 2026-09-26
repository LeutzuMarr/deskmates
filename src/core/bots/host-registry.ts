import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CreatePcOptions } from './host'

/** The registry key for the one PC used in `shared` mode. Never a real botId (those are UUIDs). */
export const SHARED_PC_ID = '__shared__'

/** The shared PC's port slot is fixed, so it can never collide with a bot's own slot. */
const SHARED_SLOT = 0

export interface PcRecord extends CreatePcOptions {
  /** Stable per-PC index; host-side ports are `base + slot`. */
  slot: number
  /** The token this PC's agent service requires in its `X-Deskmates-Token` header. */
  token: string
}

type RegistryFile = Record<string, PcRecord>

/**
 * Remembers each PC's port slot, agent token and resource settings across app restarts. Backed
 * by one JSON file under `<dataDir>/pcs/`; loaded once and kept in memory after that.
 */
export class PcRegistry {
  private readonly file: string
  private data: RegistryFile

  constructor(dataDir: string) {
    this.file = join(dataDir, 'pcs', 'registry.json')
    this.data = this.load()
  }

  private load(): RegistryFile {
    if (!existsSync(this.file)) return {}
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as RegistryFile
    } catch {
      return {}
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  get(pcId: string): PcRecord | undefined {
    return this.data[pcId]
  }

  knownIds(): string[] {
    return Object.keys(this.data)
  }

  /** Returns the existing record for `pcId`, or allocates a new stable slot and token for it. */
  ensure(pcId: string, options: CreatePcOptions): PcRecord {
    const existing = this.data[pcId]
    if (existing) return existing
    const slot = pcId === SHARED_PC_ID ? SHARED_SLOT : this.nextFreeSlot()
    const record: PcRecord = { ...options, slot, token: randomBytes(24).toString('hex') }
    this.data[pcId] = record
    this.save()
    return record
  }

  /** Applies a settings change (memory, cpu, idle timeout) to an already-provisioned PC. No-op if it has none. */
  update(pcId: string, patch: Partial<CreatePcOptions>): PcRecord | undefined {
    const existing = this.data[pcId]
    if (!existing) return undefined
    const updated: PcRecord = { ...existing, ...patch }
    this.data[pcId] = updated
    this.save()
    return updated
  }

  delete(pcId: string): void {
    if (!(pcId in this.data)) return
    delete this.data[pcId]
    this.save()
  }

  private nextFreeSlot(): number {
    const used = new Set(
      Object.entries(this.data)
        .filter(([id]) => id !== SHARED_PC_ID)
        .map(([, record]) => record.slot)
    )
    let slot = 1
    while (used.has(slot)) slot++
    return slot
  }
}
