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

test('versions, feedback, thinking, guides, artifacts, documents and project knowledge', async () => {
  test.setTimeout(240_000)
  mkdirSync(SCREENS_DIR, { recursive: true })
  const base = mkdtempSync(join(tmpdir(), 'deskmates-e2e-more-'))
  const userDataDir = join(base, 'userData')
  const dataDir = join(base, 'data')
  const projectDir = join(base, 'project')
  for (const d of [userDataDir, dataDir, projectDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(projectDir, 'tea.html'), '<!doctype html><title>Tea page</title><body style="font-family:sans-serif;padding:24px"><h1>All about tea</h1><p>Green, black and oolong.</p></body>')
  const notes = join(base, 'notes.txt')
  writeFileSync(notes, 'Meeting notes: the budget is 4,200 euros.')

  // The chat's own replies, in order; next-message suggestions get their own answer and don't use one.
  const script: FakeReply[] = [
    { text: 'Tea began in China about 5,000 years ago.\n\nWant me to go on?' },
    { text: 'Version two: tea came from Yunnan.' },
    { toolCalls: [{ id: 'call_a', name: 'Artifact', args: { action: 'publish', file_path: 'tea.html', title: 'Tea page' } }] },
    { text: 'The page is open beside the chat.' },
    { text: 'The notes say the budget is 4,200 euros.' }
  ]
  let next = 0
  const answer = (body: unknown): FakeReply => (systemOf(body).includes("predict the user's next message") ? { text: 'NONE' } : (script[next++] ?? { text: 'Done.' }))
  const fake = await startFakeOpenAI(Array.from({ length: 40 }, () => answer))
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

    // Extended thinking: off, from the effort menu.
    const chip = page.getByRole('button', { name: /^Effort: / })
    await clickRobust(chip)
    await clickRobust(page.getByRole('radio', { name: 'Off' }))
    await expect(chip).toHaveAccessibleName(/extended thinking off/)
    await page.screenshot({ path: join(SCREENS_DIR, 'more-01-thinking.png') })
    await page.keyboard.press('Escape')

    // A research request: the research guide goes into the run's instructions.
    await page.getByRole('textbox', { name: 'Message' }).fill('Research the history of tea')
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('Tea began in China about 5,000 years ago.')).toBeVisible({ timeout: 60000 })
    const first = systemOf(fake.requests[0])
    expect(first).toContain('Extended thinking: off')
    if (HAS_RESEARCH_GUIDE) {
      expect(first).toContain('# Guides for this task')
      expect(first).toContain('research_instructions')
    }

    // Thumbs down with a reason.
    await clickRobust(page.getByRole('button', { name: 'Bad reply' }).last())
    await page.getByPlaceholder('Wrong facts, ignored my request, too long…').fill('Too vague')
    await page.screenshot({ path: join(SCREENS_DIR, 'more-02-feedback.png') })
    await clickRobust(page.getByRole('button', { name: 'Send feedback' }))
    await expect(page.getByRole('button', { name: 'Bad reply' }).last()).toHaveAttribute('aria-pressed', 'true')

    // Edit the message: the old one stays as version 1.
    await page.locator('.msg-row').first().hover()
    await clickRobust(page.getByRole('button', { name: 'Edit message' }).first())
    const edit = page.getByLabel('Edit your message')
    await edit.fill('Research where tea comes from')
    await edit.press('Enter')
    await expect(page.getByText('Version two: tea came from Yunnan.')).toBeVisible({ timeout: 60000 })
    // The feedback the user gave reaches the next run.
    expect(fake.requests.some((r) => systemOf(r).includes('"Too vague"'))).toBe(true)
    const versions = page.getByRole('group', { name: 'Version 2 of 2' })
    await expect(versions).toBeVisible()
    await page.screenshot({ path: join(SCREENS_DIR, 'more-03-versions.png') })
    await clickRobust(versions.getByRole('button', { name: 'Previous version' }))
    await expect(page.getByText('Tea began in China about 5,000 years ago.')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Version 1 of 2' })).toBeVisible()
    await clickRobust(page.getByRole('group', { name: 'Version 1 of 2' }).getByRole('button', { name: 'Next version' }))
    await expect(page.getByText('Version two: tea came from Yunnan.')).toBeVisible()

    // An artifact opens in the panel beside the chat.
    await page.getByRole('textbox', { name: 'Message' }).fill('Make me a page about tea')
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('The page is open beside the chat.')).toBeVisible({ timeout: 60000 })
    const panel = page.getByRole('complementary', { name: 'Artifact: Tea page' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(SCREENS_DIR, 'more-04a-before-panel.png') })
    await expect(panel).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SCREENS_DIR, 'more-04-artifact.png') })
    await clickRobust(panel.getByRole('button', { name: 'Close the artifact' }))
    await expect(panel).toBeHidden()
    await clickRobust(page.locator('.artifact-card'))
    await expect(panel).toBeVisible()
    await clickRobust(panel.getByRole('button', { name: 'Close the artifact' }))

    // A document attached to a message: the model reads its text; the chat shows a file chip.
    await page.locator('input[type=file]').first().setInputFiles(notes)
    await expect(page.locator('.attach-file')).toBeVisible()
    await page.getByRole('textbox', { name: 'Message' }).fill('What does this say about the budget?')
    await page.screenshot({ path: join(SCREENS_DIR, 'more-05-attach.png') })
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('The notes say the budget is 4,200 euros.')).toBeVisible({ timeout: 60000 })
    expect(fake.requests.some((r) => lastUserOf(r).includes('notes.txt') && lastUserOf(r).includes('4,200 euros'))).toBe(true)
    await expect(page.locator('.sent-file', { hasText: 'notes.txt' })).toBeVisible()
    await page.screenshot({ path: join(SCREENS_DIR, 'more-06-sent-file.png') })

    // Project knowledge, in the project's settings.
    await page.getByRole('button', { name: `Settings for ${basename(projectDir)}` }).first().click({ force: true })
    await expect(page.getByRole('heading', { name: 'Project knowledge' })).toBeVisible()
    await page.locator('section', { has: page.getByRole('heading', { name: 'Project knowledge' }) }).locator('input[type=file]').setInputFiles(notes)
    await expect(page.getByText('notes.txt')).toBeVisible({ timeout: 15000 })
    await page.screenshot({ path: join(SCREENS_DIR, 'more-07-knowledge.png') })

    // The dictation button is in the message box.
    await page.getByRole('button', { name: /^Back|Open the task/ }).first().click({ timeout: 2000 }).catch(() => undefined)
  } finally {
    await app?.close()
    await fake.close()
  }
})
