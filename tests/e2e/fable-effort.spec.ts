import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { startFakeOpenAI } from './fake-openai'

const SCREENS_DIR = join('test-results', 'screens')
const HAS_FABLE = existsSync(join('prompts', 'fable', 'claude-fable-5.2.md'))

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
  await page.waitForTimeout(1500)
  await urlInput.fill(`${baseUrl}/v1`)
  await urlInput.press('Tab')
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

test.skip(!HAS_FABLE, 'needs prompts/fable/claude-fable-5.2.md')

test('the Fable prompt, the effort button and a prompt widget reach a real run', async () => {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const base = mkdtempSync(join(tmpdir(), 'deskmates-e2e-fable-'))
  const userDataDir = join(base, 'userData')
  const dataDir = join(base, 'data')
  const projectDir = join(base, 'project')
  for (const d of [userDataDir, dataDir, projectDir]) mkdirSync(d, { recursive: true })

  const fake = await startFakeOpenAI([
    () => ({ toolCalls: [{ id: 'call_1', name: 'mcp__widgets__chart_display_v0', args: { style: 'bar', title: 'Cups of tea', series: [{ name: 'Cups', values: [2, 3, 5] }], x_axis: { data: ['Mon', 'Tue', 'Wed'] } } }] }),
    () => ({ text: 'Here is the chart.' })
  ])
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

    // The effort chip sits next to the model; pick High.
    const chip = page.getByRole('button', { name: /^Effort: / })
    await expect(chip).toHaveAccessibleName('Effort: Medium')
    await clickRobust(chip)
    await page.screenshot({ path: join(SCREENS_DIR, 'fable-01-effort-menu.png') })
    await clickRobust(page.getByRole('option', { name: /^High/ }))
    await expect(chip).toHaveAccessibleName('Effort: High')

    await page.getByLabel('Message').fill('Chart my tea this week')
    await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    await expect(page.getByText('Here is the chart.')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('iframe[title="Cups of tea"]')).toBeVisible({ timeout: 15000 })
    // The chat's title becomes a short summary after the first reply, not the message itself.
    await expect(page.getByRole('heading', { name: 'Notes on Chart my tea', level: 1 })).toBeVisible({ timeout: 20000 })
    expect(fake.titles).toHaveLength(1)
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SCREENS_DIR, 'fable-02-widget.png') })

    const first = fake.requests[0] as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
    const system = String(first.messages.find((m) => m.role === 'system')?.content ?? '')
    expect(system).toContain('# Claude behavior')
    expect(system).toMatch(/reasoning_effort>30<\//)
    expect(system).not.toMatch(/reasoning_effort>10<\//)
    expect(system).toContain('Effort level: High')
    expect(system).toMatch(/- Agentic behavior — Situation; The work/)
    expect(system).not.toContain('## mcp__widgets__chart_display_v0')
    const names = (first.tools ?? []).map((t) => t.function.name)
    expect(names).toEqual(expect.arrayContaining(['read_chrome_instructions', 'read_research_instructions', 'mcp__widgets__chart_display_v0', 'TaskCreate', 'mcp__claude_ai__launch_extended_search_task', 'browser_batch', 'gif_creator']))
    console.log(`system prompt: ${system.length} chars; tools: ${names.length}`)
  } finally {
    await app?.close()
    await fake.close()
  }
})
