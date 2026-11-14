import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FreebuffPool } from '../../src/core/terminals/freebuff-pool'

/**
 * Drives a real, hidden Freebuff through the Work tab's code path. Needs Freebuff installed and
 * signed in, so it only runs with FREEBUFF_LIVE=1. It switches Freebuff's model (a global Freebuff
 * setting) to an Unlimited one, which costs no Freebucks, and back to Solar Pro 4 at the end.
 */
const live = process.env.FREEBUFF_LIVE === '1'

describe.skipIf(!live)('Freebuff as a Work-tab responder (live)', () => {
  const folder = mkdtempSync(join(tmpdir(), 'deskmates-freebuff-live-'))
  const pool = new FreebuffPool()

  afterAll(async () => {
    await pool.execute(folder, 'Reply with exactly: BACK', 'Solar Pro 4')
    pool.dispose()
    // Freebuff keeps the folder open until its process has fully exited.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(folder, { recursive: true, force: true })
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }, 180_000)

  it('answers a prompt, with the standing instructions handed over through a file', async () => {
    const items: string[] = []
    const result = await pool.execute(folder, 'Reply with exactly: PONG', 'current', {
      system: 'You are the Deskmates assistant. Keep answers short.',
      onItem: (item) => items.push(item.kind)
    })
    expect(result.error).toBeUndefined()
    expect(result.text).toContain('PONG')
    expect(items).toContain('assistant')
    const status = pool.status(folder)
    expect(status?.model).toBeTruthy()
    expect(status?.sessionMinutesLeft).toBeGreaterThan(0)
  }, 180_000)

  it("switches Freebuff's model through its picker", async () => {
    const result = await pool.execute(folder, 'Reply with exactly: SWITCHED', 'Nemotron 3.5 Lightning')
    expect(result.error).toBeUndefined()
    expect(result.text).toContain('SWITCHED')
    expect(pool.status(folder)?.model).toBe('Nemotron 3.5 Lightning')
  }, 180_000)

  it('stops a long answer, then takes the next prompt at once', async () => {
    const controller = new AbortController()
    const long = pool.execute(folder, 'Write a 400 word story about a lighthouse keeper. No tools.', 'current', {
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 6000)
    expect((await long).stopped).toBe(true)
    const next = await pool.execute(folder, 'Reply with exactly: AFTER STOP', 'current')
    expect(next.error).toBeUndefined()
    expect(next.text).toContain('AFTER STOP')
  }, 240_000)
})
