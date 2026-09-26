/**
 * The handoff tool: leaves a task, and optionally files, for another bot in the shared folder
 * (design spec 5.9). This only writes the handoff record — a receiving bot picking these up from
 * `<dataDir>/shared/handoffs/` is a scheduler-side concern (a later task), not this one.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'

export interface HandoffLookup {
  get(botId: string): { id: string; name: string } | undefined
}

export interface HandoffRecord {
  id: string
  fromBotId: string
  toBotId: string
  task: string
  /** Paths relative to the shared folder root, forward-slashed. */
  files: string[]
  createdAt: number
}

/** Builds the handoff tool. `dataDir`/`fromBotId` are fixed for the run; `now` defaults to Date.now so tests can fix it. */
export function handoffTools(deps: { dataDir: string; fromBotId: string; lookup: HandoffLookup; now?: () => number }) {
  const now = deps.now ?? Date.now

  return {
    handoff: tool({
      description:
        'Leave a task, and optionally files, for another bot to pick up. Files must already be under "shared/...", since that is the only folder both bots can see — write them there first with write_pc_file if needed.',
      inputSchema: z.object({
        to_bot_id: z.string().min(1),
        task: z.string().min(1),
        files: z.array(z.string()).default([]).describe('Paths under "shared/...", for example "shared/report.txt"')
      }),
      execute: async ({ to_bot_id, task, files }) => {
        if (to_bot_id === deps.fromBotId) throw new Error("A bot can't hand a task to itself.")
        const target = deps.lookup.get(to_bot_id)
        if (!target) throw new Error('No bot with that id.')

        const sharedRoot = join(deps.dataDir, 'shared')
        const relFiles = files.map((f) => {
          if (f.includes('\\') || f.includes('\0')) throw new Error(`Invalid file reference: ${f}`)
          const rel = f.startsWith('shared/') ? f.slice('shared/'.length) : f
          const segments = rel.split('/').filter((s) => s !== '')
          if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) throw new Error(`Invalid file reference: ${f}`)
          const normalized = segments.join('/')
          if (!existsSync(join(sharedRoot, normalized))) throw new Error(`File not found in the shared folder: shared/${normalized}`)
          return normalized
        })

        const record: HandoffRecord = {
          id: randomUUID(),
          fromBotId: deps.fromBotId,
          toBotId: to_bot_id,
          task,
          files: relFiles,
          createdAt: now()
        }
        const handoffDir = join(sharedRoot, 'handoffs')
        mkdirSync(handoffDir, { recursive: true })
        writeFileSync(join(handoffDir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8')

        return { handoffId: record.id, toBot: target.name, files: relFiles }
      }
    })
  }
}
