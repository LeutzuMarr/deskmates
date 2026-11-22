import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, expect, _electron } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { startFakeOpenAI, type FakeReply } from './fake-openai'

const SCREENS_DIR = join('test-results', 'screens')
const HAS_RESEARCH_GUIDE = existsSync(join('prompts', 'research', 'research_instructions.md'))

async function clickRobust(locator: Locator, timeout = 15000): Promise<void> {
  try {
    await locator.click({ timeout })
  } catch {
    await locator.click({ timeout, force: true })
  }
}

async function configureModel(page: Page, baseUrl: string): Promise<void> {
  await clickRobust(page.getByRole('button', { name: 'Settings', exact: true }))
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  const urlInput = page.locator('#compatible-url')
  await expect(urlInput).toBeVisible()
  await page.waitForTimeout(3000)
  // Settings load in after the page shows; fill until the address sticks.
  for (let attempt = 0; attempt < 3; attempt++) {
    await urlInput.fill(`${baseUrl}/v1`)
    await urlInput.press('Tab')
    await page.waitForTimeout(800)
    if ((await urlInput.inputValue()) === `${baseUrl}/v1`) break
  }
  const keyInput = page.locator('#key-compatible')
  await keyInput.fill('test-key')
  const keyCard = keyInput.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-3xl ")][1]')
  await clickRobust(keyCard.getByRole('button', { name: 'Save key', exact: true }))
  await expect(keyCard.getByText('Saved on this computer', { exact: true })).toBeVisible()
  await page.getByLabel('Provider').selectOption('compatible')
  await clickRobust(page.getByRole('button', { name: 'Load models', exact: true }))
  await expect(page.getByLabel('Model')).toHaveValue('fake-model', { timeout: 15000 })
  await page.getByLabel('Model').selectOption('fake-model')
  await clickRobust(page.getByRole('button', { name: 'Save default model', exact: true }))
  await expect(page.getByText('Default model saved')).toBeVisible()
}

const systemOf = (request: unknown): string => String((request as { messages: Array<{ role: string; content: unknown }> }).messages.find((m) => m.role === 'system')?.content ?? '')
const lastUserOf = (request: unknown): string => {
  const messages = (request as { messages: Array<{ role: string; content: unknown }> }).messages.filter((m) => m.role === 'user')
  const content = messages.at(-1)?.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

test('incognito, research and web switches, quotes, long pastes and chat search', async () => {
  test.setTimeout(240_000)
  mkdirSync(SCREENS_DIR, { recursive: true })
  const base = mkdtempSync(join(tmpdir(), 'deskmates-e2e-three-'))
  const userDataDir = join(base, 'userData')
  const dataDir = join(base, 'data')
  const projectDir = join(base, 'project')
  for (const d of [userDataDir, dataDir, projectDir]) mkdirSync(d, { recursive: true })

  const script: FakeReply[] = [
    { text: 'Hello from an incognito chat.' },
    { text: 'The Riese & Müller Charger is a strong pick under 2000 euros, with a Bosch motor.' },
    { text: 'Without the web, I would still pick a Bosch-motor bike.' },
    { text: 'Quoted and answered.' }
  ]
  let next = 0
  const answer = (body: unknown): FakeReply => (systemOf(body).includes("predict the user's next message") ? { text: 'NONE' } : (script[next++] ?? { text: 'Done.' }))
  const fake = await startFakeOpenAI(Array.from({ length: 40 }, () => answer))
  const toolNames = (request: unknown): string[] => ((request as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((t) => t.function.name)
  const message = (page: Page) => page.getByRole('textbox', { name: 'Message' })
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ args: ['.'], env: { ...process.env, DESKMATES_USER_DATA: userDataDir, DESKMATES_DATA_DIR: dataDir, DESKMATES_NO_HOME_CONFIG: '1' } })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(4000)
    await configureModel(page, fake.url)
    await app.evaluate(({ dialog }, folder) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, projectDir)
    await clickRobust(page.getByRole('button', { name: 'Add project', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Add a project' })
    await clickRobust(dialog.getByRole('button', { name: 'Browse…', exact: true }))
    await clickRobust(dialog.getByRole('button', { name: 'Add project', exact: true }))
    await expect(dialog).toBeHidden()

    // An incognito chat: marked, kept out of memory, and gone once the user leaves it.
    await clickRobust(page.getByRole('button', { name: 'Incognito' }))
    await expect(page.getByRole('heading', { name: 'Incognito chat' })).toBeVisible()
    await page.screenshot({ path: join(SCREENS_DIR, 'three-01-incognito-home.png') })
    await message(page).fill('Hello there')
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('Hello from an incognito chat.')).toBeVisible({ timeout: 60000 })
    await expect(page.getByRole('note').filter({ hasText: 'Incognito chat' })).toBeVisible()
    // A short message stays on one line (it used to wrap after every word, even inside one).
    await page.waitForTimeout(400)
    const bubble = await page.locator('.user-bubble', { hasText: 'Hello there' }).boundingBox()
    expect(bubble!.height).toBeLessThan(52)
    expect(systemOf(fake.requests[0])).toContain('Incognito chat')
    expect(toolNames(fake.requests[0])).not.toContain('conversation_search')
    await page.screenshot({ path: join(SCREENS_DIR, 'three-02-incognito-chat.png') })
    await clickRobust(page.getByRole('button', { name: 'New task' }).first())
    await expect(page.locator('aside, nav').getByText('Incognito', { exact: true })).toHaveCount(0, { timeout: 10000 })

    // Research on, from the tools menu.
    await clickRobust(page.getByRole('button', { name: 'Tools' }))
    await page.getByRole('switch', { name: /Research/ }).check()
    await page.screenshot({ path: join(SCREENS_DIR, 'three-03-tools-menu.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Research', exact: true })).toBeVisible()
    await message(page).fill('Best e-bike under 2000 euros?')
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('The Riese & Müller Charger')).toBeVisible({ timeout: 60000 })
    expect(fake.requests.some((r) => systemOf(r).includes('Research is on for this message'))).toBe(true)

    // Research off again, web search off: the web tools are gone from the next run.
    await clickRobust(page.getByRole('button', { name: 'Research', exact: true }))
    await clickRobust(page.getByRole('button', { name: 'Tools' }))
    await page.getByRole('switch', { name: /Web search/ }).uncheck()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'No web' })).toBeVisible()
    await message(page).fill('And without the web?')
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('Without the web, I would still pick')).toBeVisible({ timeout: 60000 })
    const offline = fake.requests.find((r) => systemOf(r).includes('Web search is off'))
    expect(offline).toBeDefined()
    expect(toolNames(offline)).not.toContain('WebSearch')
    await page.screenshot({ path: join(SCREENS_DIR, 'three-04-switch-chips.png') })

    // Quote a few words of a reply.
    await page.getByText('The Riese & Müller Charger').evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    const quote = page.getByRole('button', { name: 'Quote' })
    await expect(quote).toBeVisible()
    await page.screenshot({ path: join(SCREENS_DIR, 'three-05-quote.png') })
    await clickRobust(quote)
    await expect(message(page)).toHaveValue(/^> The Riese & Müller Charger/)

    // A long paste becomes an attachment.
    await message(page).evaluate((el) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'log line\n'.repeat(800))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await expect(page.locator('.attach-file', { hasText: 'Pasted text (801 lines)' })).toBeVisible()
    await page.screenshot({ path: join(SCREENS_DIR, 'three-06-long-paste.png') })
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('Quoted and answered.')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('.sent-file', { hasText: 'Pasted text' })).toBeVisible()

    // Search what the chats say from the palette.
    await page.keyboard.press('Control+k')
    await page.getByPlaceholder(/Search chats/).fill('Bosch motor')
    await expect(page.getByText('In chats')).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: join(SCREENS_DIR, 'three-07-chat-search.png') })
  } finally {
    await app?.close()
    await fake.close()
  }
})
