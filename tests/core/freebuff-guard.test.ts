import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { THIRD_PARTY_REFUSAL, blockFreebuff, blockedMessage, freebuffBlock, freebuffTurnError, setFreebuffGuardFile, unblockFreebuff } from '../../src/core/terminals/freebuff-guard'
import { FreebuffPool } from '../../src/core/terminals/freebuff-pool'
import { extractReply, groupWork } from '../../src/core/terminals/freebuff-host'

const REFUSAL =
  'Freebuff free mode only works through the official Freebuff CLI, Freebuff Desktop and freebuff.com. This request came from a third-party client, harness or proxy, so it was refused and recorded as strike 1 on this account. Requests from the official apps are unaffected.'

/** A fake home with Freebuff's chat log for the folder "Daily outreach", as Freebuff writes it. */
function freebuffHome(messages: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), 'dm-fb-home-'))
  const chat = join(home, '.config', 'manicode', 'projects', 'Daily outreach', 'chats', '2026-11-22T15-38-50.782Z')
  mkdirSync(chat, { recursive: true })
  writeFileSync(join(chat, 'chat-messages.json'), JSON.stringify(messages))
  return home
}

const dirs: string[] = []
afterEach(() => {
  unblockFreebuff()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Freebuff's refusals", () => {
  it("are read from Freebuff's own chat log, not its screen", () => {
    const at = 1795361942245
    const home = freebuffHome([
      { id: `user-${at - 1000}`, variant: 'user', content: 'First read …' },
      { id: `ai-${at}-d27306`, variant: 'ai', content: '', userError: REFUSAL },
      { id: `sys-${at + 1500}`, variant: 'ai', content: "Not now: we'll ask again in 14 days." }
    ])
    dirs.push(home)
    expect(freebuffTurnError('C:\\Users\\x\\Desktop\\Daily outreach', at - 5000, home)).toBe(REFUSAL)
    expect(THIRD_PARTY_REFUSAL.test(REFUSAL)).toBe(true)
    // An older error is not this turn's.
    expect(freebuffTurnError('C:\\Users\\x\\Desktop\\Daily outreach', at + 60_000, home)).toBeNull()
    // A turn that hasn't been answered yet has no error.
    const waiting = freebuffHome([{ id: 'user-1', variant: 'user', content: 'hi' }])
    dirs.push(waiting)
    expect(freebuffTurnError('C:\\x\\Daily outreach', 0, waiting)).toBeNull()
    expect(freebuffTurnError('C:\\x\\Nowhere', 0, waiting)).toBeNull()
  })

  it('block Freebuff across restarts until the user allows it again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-fb-guard-'))
    dirs.push(dir)
    const file = join(dir, 'freebuff-block.json')
    setFreebuffGuardFile(file)
    expect(freebuffBlock()).toBeNull()
    blockFreebuff(REFUSAL, 1795361942245)
    setFreebuffGuardFile(file)
    expect(freebuffBlock()).toEqual({ reason: REFUSAL, at: 1795361942245 })
    expect(blockedMessage(freebuffBlock()!)).toContain('stopped sending anything to Freebuff')
    unblockFreebuff()
    expect(existsSync(file)).toBe(false)
    setFreebuffGuardFile(file)
    expect(freebuffBlock()).toBeNull()
  })

  it('stop every request while blocked, without starting Freebuff', async () => {
    blockFreebuff(REFUSAL)
    const result = await new FreebuffPool().execute('C:\\x\\Daily outreach', 'Send the emails', undefined)
    expect(result.text).toBe('')
    expect(result.error).toContain('Freebuff refused')
    expect(freebuffBlock()).not.toBeNull()
  })
})

describe("Freebuff's own screen text never becomes a reply", () => {
  it('skips the keyboard hint and the survey note', () => {
    const screen = [
      'what?? ⎘',
      "Not now: we'll ask again in 14 days.",
      'The real answer.',
      '↻ ← for history · ? for help',
      '⎘ • 3s • △▽'
    ].join('\n')
    expect(extractReply(screen, 'what??')).toEqual({ text: 'The real answer.', done: true })
    expect(groupWork(['↻ ← for history · ? for help', "Not now: we'll ask again in 14 days.", '• Read file.ts'])).toEqual(['• Read file.ts'])
  })
})
