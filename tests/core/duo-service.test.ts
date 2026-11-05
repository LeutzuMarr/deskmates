import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/core/store/db'
import { EventBus } from '../../src/core/events'
import { DuoStore } from '../../src/core/duo/store'
import { DuoService } from '../../src/core/duo/service'
import { prepareDuoWorkspace } from '../../src/core/duo/workspace'
import { DEFAULT_DUO_PROFILE, type DuoProfile } from '../../src/shared/duo'

function setup(start = new Date(2026, 10, 5, 7, 0).getTime()) {
  let now = start
  let profile: DuoProfile = { ...DEFAULT_DUO_PROFILE, ready: true, email: { address: 'me@velosyntech.com', webmailUrl: 'https://mail.zoho.eu' } }
  const cli: Array<{ prompt: string; folder: string }> = []
  const notes: string[] = []
  let release: () => void = () => undefined
  const duo = new DuoService({
    store: new DuoStore(openDatabase(':memory:')),
    bus: new EventBus(),
    getProfile: () => profile,
    setProfile: (p) => (profile = p),
    workspace: () => 'C:/duo',
    runCli: async (_provider, folder, prompt) => {
      cli.push({ prompt, folder })
      await new Promise<void>((resolve) => (release = resolve))
      return { text: 'Here is your brief.' }
    },
    resolveModel: () => {
      throw new Error('no api model in tests')
    },
    apiTools: () => ({}),
    operatingPrompt: () => null,
    notify: (title) => notes.push(title),
    now: () => now
  })
  return { duo, cli, notes, setNow: (t: number) => (now = t), finish: () => release() }
}

const pitch = { kind: 'email' as const, company: 'Hotel Roma', domain: 'hotelroma.it', to: 'info@hotelroma.it', subject: 'Ciao', body: 'Buongiorno…' }

describe('Duo', () => {
  it('approve twice sends once, and only approved items can be marked sent', () => {
    const { duo } = setup()
    const item = duo.addOutbox(pitch)
    expect(() => duo.markSent(item.id)).toThrow(/not approved/)
    duo.decide(item.id, 'approve')
    duo.decide(item.id, 'approve')
    expect(duo.nextApproved()?.id).toBe(item.id)
    duo.markSent(item.id)
    expect(duo.nextApproved()).toBeNull()
    // The history now blocks pitching them again.
    expect(() => duo.addOutbox(pitch)).toThrow(/already pitched/)
  })

  it('edit after approve refused, edit while pending changes the text', () => {
    const { duo } = setup()
    const item = duo.addOutbox(pitch)
    duo.decide(item.id, 'edit', { body: 'Better text' })
    expect(duo.state().outbox[0]!.body).toBe('Better text')
    duo.decide(item.id, 'approve')
    expect(() => duo.decide(item.id, 'edit', { body: 'x' })).toThrow(/Only a draft/)
  })

  it('the send permit is the webmail site with an approved email, never LinkedIn', () => {
    const { duo } = setup()
    expect(duo.sendPermit('mail.zoho.eu')).toBeNull()
    const item = duo.addOutbox(pitch)
    duo.decide(item.id, 'approve')
    expect(duo.sendPermit('mail.zoho.eu')?.id).toBe(item.id)
    expect(duo.sendPermit('evil.example')).toBeNull()
  })

  it('scheduler makes cards not runs, once per slot', () => {
    const t = setup()
    t.duo.tick(new Date(2026, 10, 5, 7, 29).getTime())
    expect(t.duo.state().cards).toHaveLength(0)
    t.duo.tick(new Date(2026, 10, 5, 7, 30).getTime())
    t.duo.tick(new Date(2026, 10, 5, 7, 31).getTime())
    expect(t.duo.state().cards.map((c) => c.kind)).toEqual(['brief'])
    expect(t.cli).toHaveLength(0)
    expect(t.notes).toEqual(['Your morning brief is ready'])
  })

  it('start sends one prompt with the date, and is idempotent per card', async () => {
    const t = setup()
    t.duo.tick(new Date(2026, 10, 5, 7, 30).getTime())
    const card = t.duo.state().cards[0]!
    const first = t.duo.startCard(card.id)
    const second = await t.duo.startCard(card.id)
    expect(second).toBe(false)
    await new Promise((r) => setTimeout(r, 5))
    expect(t.cli).toHaveLength(1)
    expect(t.cli[0]!.prompt).toMatch(/Thursday 5 November.*Do my morning brief/)
    t.finish()
    expect(await first).toBe(true)
    expect(t.duo.state().messages.at(-1)?.text).toBe('Here is your brief.')
  })

  it('no cards while paused or not set up', () => {
    const t = setup()
    t.duo.updateProfile({ paused: true })
    t.duo.tick(new Date(2026, 10, 5, 7, 30).getTime())
    expect(t.duo.state().cards).toHaveLength(0)
  })
})

describe('Duo workspace', () => {
  it('writes mcp.json without a BOM pointing at the deskmates command as Duo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duo-ws-'))
    const prompt = join(dir, 'source-prompt.md')
    writeFileSync(prompt, '# behavior\nBe kind.\n# tools\nList.\n')
    prepareDuoWorkspace({ dir: join(dir, 'ws'), agentCommand: 'C:\\kit\\deskmates.cmd', profile: DEFAULT_DUO_PROFILE, myPromptPath: prompt })
    const raw = readFileSync(join(dir, 'ws', '.agents', 'mcp.json'))
    expect(raw[0]).not.toBe(0xef)
    const config = JSON.parse(raw.toString('utf8'))
    expect(config.mcpServers.deskmates.env.DESKMATES_AGENT).toBe('Duo')
    expect(JSON.stringify(config)).toContain('deskmates.cmd')
    const agents = readFileSync(join(dir, 'ws', 'AGENTS.md'), 'utf8')
    expect(agents).toContain('Be kind.')
    expect(agents).toContain('# You are Duo')
    expect(agents).not.toContain('List.')
    expect(readFileSync(join(dir, 'ws', 'profile.md'), 'utf8')).toContain('romgaz.ro')
  })
})

describe('Duo quiet hours', () => {
  it('no brief card late at night, and no check-in either', () => {
    const t = setup(new Date(2026, 10, 5, 23, 50).getTime())
    t.duo.tick(new Date(2026, 10, 5, 23, 50).getTime())
    expect(t.duo.state().cards).toHaveLength(0)
    expect(t.notes).toHaveLength(0)
  })
})
