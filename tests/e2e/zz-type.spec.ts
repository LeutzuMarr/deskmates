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

test('typing in the project message box', async () => {
  test.setTimeout(180_000)
  const base = mkdtempSync(join(tmpdir(), 'dm-type-'))
  const userDataDir = join(base, 'userData')
  const dataDir = join(base, 'data')
  const projectDir = join(base, 'project')
  for (const d of [userDataDir, dataDir, projectDir]) mkdirSync(d, { recursive: true })
  const fake = await startFakeOpenAI([])
  const app = await _electron.launch({ args: ['.'], env: { ...process.env, DESKMATES_USER_DATA: userDataDir, DESKMATES_DATA_DIR: dataDir, DESKMATES_NO_HOME_CONFIG: '1' } })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)))
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
    const box = page.getByRole('textbox', { name: 'Message' })
    await box.click()
    await page.keyboard.type('hello there')
    console.log('TYPED (test model):', JSON.stringify(await box.inputValue()))
    // Now the project on Freebuff, as in the screenshot (nothing is sent).
    await page.evaluate(async () => {
      const w = window as unknown as { __core?: unknown }
      void w
    })
    await page.getByRole('button', { name: /^Settings for / }).first().click({ force: true })
    await page.getByRole('checkbox', { name: 'Use default model' }).uncheck()
    await page.locator('#project-model-provider').selectOption('freebuff')
    await page.waitForTimeout(1500)
    console.log('MODELS', JSON.stringify(await page.locator('#project-model-id option').allTextContents()).slice(0, 200))
    const save = page.getByRole('button', { name: /Save model/ })
    if (await save.count()) await save.click()
    await page.waitForTimeout(800)
    await page.getByText('project', { exact: true }).first().click({ force: true })
    await page.waitForTimeout(1500)
    const box2 = page.getByRole('textbox', { name: 'Message' })
    await box2.click()
    await page.keyboard.type('hi freebuff')
    console.log('TYPED (freebuff):', JSON.stringify(await box2.inputValue()))
    await page.screenshot({ path: join(SCREENS_DIR, 'type-01.png') })
  } finally {
    await app.close()
    await fake.close()
  }
})
