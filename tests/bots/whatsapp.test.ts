import { describe, expect, it } from 'vitest'
import type { CdpClient, CdpTargetInfo, PageContent } from '../../src/core/bots/tools/cdp-client'
import type { SaveScreenshot } from '../../src/core/bots/tools/types'
import { whatsappTools } from '../../src/core/bots/tools/whatsapp'

/** Calls a tool's execute the way the agent loop would after validating input — same helper as bot-tools.test.ts. */
async function runTool<T = any>(t: { execute?: (input: never, options: never) => unknown }, input: unknown): Promise<T> {
  if (!t.execute) throw new Error('Tool has no execute function')
  const options = { toolCallId: 'test-call', messages: [], context: undefined, abortSignal: undefined }
  return (await t.execute(input as never, options as never)) as T
}

const ALLOWED_NUMBER = '+1 555 000 1111'

/** A fake WhatsApp Web: `loggedIn` toggles between the real login-gate page and a real chat page's text, and `composeBoxMissing` simulates WhatsApp having changed its markup out from under a known-logged-in session. */
class FakeCdpClient implements CdpClient {
  readonly calls: string[] = []
  private nextId = 1
  private readonly targets = new Map<string, string>() // targetId -> current url
  loggedIn = true
  composeBoxMissing = false

  async listTargets(): Promise<CdpTargetInfo[]> {
    this.calls.push('listTargets')
    return [...this.targets.entries()].map(([targetId, url]) => ({ targetId, url, title: 'WhatsApp' }))
  }

  async newTab(url: string): Promise<CdpTargetInfo> {
    this.calls.push(`newTab:${url}`)
    const targetId = `t${this.nextId++}`
    this.targets.set(targetId, url)
    return { targetId, url, title: 'WhatsApp' }
  }

  async navigate(targetId: string, url: string): Promise<CdpTargetInfo> {
    this.calls.push(`navigate:${targetId}:${url}`)
    if (!this.targets.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    this.targets.set(targetId, url)
    return { targetId, url, title: 'WhatsApp' }
  }

  async closeTab(targetId: string): Promise<void> {
    this.calls.push(`closeTab:${targetId}`)
    this.targets.delete(targetId)
  }

  async readPage(targetId: string): Promise<PageContent> {
    this.calls.push(`readPage:${targetId}`)
    const url = this.targets.get(targetId)
    if (url === undefined) throw new Error('No open tab with that id. Use tabs to see what is open.')
    const text = this.loggedIn
      ? 'Chat with +1 555 000 1111\nType a message'
      : 'Log into WhatsApp Web\nScan the QR code with your phone to link a device'
    return { url, title: 'WhatsApp', text, links: [], hasPasswordField: false }
  }

  async click(targetId: string, selector: string): Promise<void> {
    this.calls.push(`click:${targetId}:${selector}`)
    if (!this.targets.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
  }

  async typeText(targetId: string, selector: string, _text: string): Promise<void> {
    this.calls.push(`typeText:${targetId}:${selector}`)
    if (!this.targets.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    if (this.composeBoxMissing) throw new Error(`No element matches this selector: ${selector}`)
  }

  async screenshot(targetId: string): Promise<Buffer> {
    this.calls.push(`screenshot:${targetId}`)
    if (!this.targets.has(targetId)) throw new Error('No open tab with that id. Use tabs to see what is open.')
    return Buffer.from('fake-whatsapp-png')
  }

  async close(): Promise<void> {
    this.calls.push('close')
  }
}

function makeSaveScreenshot(): { save: SaveScreenshot; saved: Array<{ label: string; bytes: number }> } {
  const saved: Array<{ label: string; bytes: number }> = []
  let n = 0
  const save: SaveScreenshot = async (png, label) => {
    n++
    saved.push({ label, bytes: png.length })
    return { path: `${label}-${n}.png`, bytes: png.length }
  }
  return { save, saved }
}

describe('whatsappTools', () => {
  it('1. sends to the configured number: opens the deep link, types the message, clicks send and screenshots as proof', async () => {
    const cdp = new FakeCdpClient()
    const { save, saved } = makeSaveScreenshot()
    const tools = whatsappTools({ cdp, saveScreenshot: save, allowedNumber: ALLOWED_NUMBER })

    const result = await runTool(tools.whatsapp_send, { to: '+1 555 000 1111', message: 'Hello there' })

    expect(result).toEqual({ sent: true, screenshot: { path: 'whatsapp-1.png', bytes: Buffer.byteLength('fake-whatsapp-png') } })
    expect(cdp.calls).toEqual([
      'newTab:https://web.whatsapp.com/send?phone=15550001111&text=Hello%20there',
      'readPage:t1',
      'typeText:t1:footer [contenteditable="true"]',
      'click:t1:span[data-icon="send"]',
      'screenshot:t1'
    ])
    expect(saved).toEqual([{ label: 'whatsapp', bytes: Buffer.byteLength('fake-whatsapp-png') }])
  })

  it('2. refuses any number other than the one configured for this bot, before touching the browser at all', async () => {
    const cdp = new FakeCdpClient()
    const tools = whatsappTools({ cdp, saveScreenshot: makeSaveScreenshot().save, allowedNumber: ALLOWED_NUMBER })

    await expect(runTool(tools.whatsapp_send, { to: '+39 02 1234567', message: 'Hi' })).rejects.toThrow(
      'whatsapp_send can only message the number configured for this bot.'
    )
    expect(cdp.calls).toEqual([])
  })

  it('3. fails with a plain Take Over / QR code message when WhatsApp is not logged in, and never tries to type or send', async () => {
    const cdp = new FakeCdpClient()
    cdp.loggedIn = false
    const tools = whatsappTools({ cdp, saveScreenshot: makeSaveScreenshot().save, allowedNumber: ALLOWED_NUMBER })

    await expect(runTool(tools.whatsapp_send, { to: ALLOWED_NUMBER, message: 'Hi' })).rejects.toThrow(
      /take over.*qr code.*bot's phone/is
    )
    expect(cdp.calls.some((c) => c.startsWith('typeText:'))).toBe(false)
    expect(cdp.calls.some((c) => c.startsWith('click:'))).toBe(false)
    expect(cdp.calls.some((c) => c.startsWith('screenshot:'))).toBe(false)
  })

  it('4. reuses the same chat tab across calls in a run instead of opening a new one each time', async () => {
    const cdp = new FakeCdpClient()
    const tools = whatsappTools({ cdp, saveScreenshot: makeSaveScreenshot().save, allowedNumber: ALLOWED_NUMBER })

    await runTool(tools.whatsapp_send, { to: ALLOWED_NUMBER, message: 'First' })
    await runTool(tools.whatsapp_send, { to: ALLOWED_NUMBER, message: 'Second' })

    expect(cdp.calls.filter((c) => c.startsWith('newTab:'))).toHaveLength(1)
    expect(cdp.calls.filter((c) => c.startsWith('navigate:'))).toHaveLength(1)
    expect(cdp.calls).toContain('navigate:t1:https://web.whatsapp.com/send?phone=15550001111&text=Second')
  })

  it('5. compares numbers by digits, so different formatting of the same configured number still matches', async () => {
    const cdp = new FakeCdpClient()
    const tools = whatsappTools({ cdp, saveScreenshot: makeSaveScreenshot().save, allowedNumber: '+1 (555) 000-1111' })

    const result = await runTool(tools.whatsapp_send, { to: '001 555 000 1111', message: 'Hi' })

    expect(result).toMatchObject({ sent: true })
    expect(cdp.calls[0]).toBe('newTab:https://web.whatsapp.com/send?phone=15550001111&text=Hi')
  })

  it('6. gives a "page may have changed" error (not the not-logged-in one) when logged in but the compose box cannot be found', async () => {
    const cdp = new FakeCdpClient()
    cdp.composeBoxMissing = true
    const tools = whatsappTools({ cdp, saveScreenshot: makeSaveScreenshot().save, allowedNumber: ALLOWED_NUMBER })

    await expect(runTool(tools.whatsapp_send, { to: ALLOWED_NUMBER, message: 'Hi' })).rejects.toThrow(/changed its page/i)
    expect(cdp.calls.some((c) => c.startsWith('click:'))).toBe(false)
  })

  it('7. never echoes the number or the message body back in its return value', async () => {
    const cdp = new FakeCdpClient()
    const tools = whatsappTools({ cdp, saveScreenshot: makeSaveScreenshot().save, allowedNumber: ALLOWED_NUMBER })

    const result = await runTool<Record<string, unknown>>(tools.whatsapp_send, { to: ALLOWED_NUMBER, message: 'a very secret message' })

    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('555')
  })
})
