import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { startFakeOpenAI } from './fake-openai'

const SCREENS_DIR = join('test-results', 'screens')

const DESIGN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Mountain Coffee</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; color: #2b2b2b; }
      main { max-width: 720px; margin: 0 auto; padding: 96px 24px; text-align: center; }
      h1 { font-size: 48px; margin: 0 0 16px; }
      p { margin: 0 0 24px; color: #6b6b6b; }
      button { padding: 12px 24px; font-size: 16px; border: none; border-radius: 8px; background: #d97757; color: #fff; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="title">Mountain Coffee</h1>
      <p>Small-batch beans, roasted in the mountains.</p>
      <button type="button">Shop now</button>
    </main>
  </body>
</html>
`

function makeTempDirs(label: string): { base: string; userDataDir: string; dataDir: string; projectDir: string } {
  const base = mkdtempSync(join(tmpdir(), `deskmates-e2e-${label}-`))
  const userDataDir = join(base, 'userData')
  const dataDir = join(base, 'data')
  const projectDir = join(base, 'project')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  return { base, userDataDir, dataDir, projectDir }
}

async function launchApp(userDataDir: string, dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      DESKMATES_USER_DATA: userDataDir,
      DESKMATES_DATA_DIR: dataDir
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The window is unstable for a moment right after launch; let it settle before interacting.
  await page.waitForTimeout(4000)
  return { app, page }
}

/** Plain click, falling back to a forced click on retry ("element is not stable" right after launch). */
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

  // Wait for the initial settings.get() round trip to populate the field before overwriting it —
  // otherwise the effect that fills it in from server state can clobber what we just typed.
  const urlInput = page.locator('#compatible-url')
  await expect(urlInput).toHaveValue('https://openrouter.ai/api/v1')
  await urlInput.fill(`${baseUrl}/v1`)
  await urlInput.press('Tab')

  const keyInput = page.locator('#key-compatible')
  await keyInput.fill('test-key')
  const keyCard = keyInput.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-3xl ")][1]'
  )
  await clickRobust(keyCard.getByRole('button', { name: 'Save key', exact: true }))
  await expect(keyCard.getByText('Saved on this computer', { exact: true })).toBeVisible()

  await page.getByLabel('Provider').selectOption('compatible')
  await clickRobust(page.getByRole('button', { name: 'Load models', exact: true }))
  await expect(page.getByLabel('Model')).toHaveValue('fake-model', { timeout: 15000 })
  await page.getByLabel('Model').selectOption('fake-model')
  await clickRobust(page.getByRole('button', { name: 'Save default model', exact: true }))
  await expect(page.getByText('Default model saved')).toBeVisible()
}

/** Forces a frame (a screenshot does) until the preview pane has been measured and mounted its iframe. */
async function waitForIframeMounted(page: Page, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await page.screenshot()
    const count = await page.evaluate(() => document.querySelectorAll('iframe').length)
    if (count > 0) return
    await page.waitForTimeout(200)
  }
  throw new Error('The design preview iframe never mounted.')
}

async function waitForEditorReady(page: Page, timeoutMs = 20000): Promise<void> {
  const frame = page.frameLocator('iframe[title="Design preview"]')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const overlayCount = await frame.locator('dm-editor-overlay').count()
    const idCount = await frame.locator('[data-dm-id]').count()
    if (overlayCount > 0 && idCount > 0) return
    await page.waitForTimeout(200)
  }
  throw new Error('The design editor overlay never became ready.')
}

interface FramePoint {
  x: number
  y: number
  scale: number
}

/**
 * Page-coordinate point for a spot inside the preview iframe's own document (fx/fy fractions of
 * the target element's box, 0.5/0.5 = centre). Playwright's boundingBox() does not apply the
 * iframe's CSS scale transform, so the scale is computed and applied by hand here.
 */
async function pagePointForFrameElement(page: Page, locator: Locator, fx = 0.5, fy = 0.5): Promise<FramePoint> {
  const metrics = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[title="Design preview"]') as HTMLIFrameElement | null
    if (!iframe) throw new Error('Design preview iframe not found')
    const rect = iframe.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, offsetWidth: iframe.offsetWidth }
  })
  const scale = metrics.width / metrics.offsetWidth
  const elRect = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  return {
    x: metrics.x + (elRect.x + elRect.width * fx) * scale,
    y: metrics.y + (elRect.y + elRect.height * fy) * scale,
    scale
  }
}

test('works on a folder end to end', async () => {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const { userDataDir, dataDir, projectDir } = makeTempDirs('work')

  const fake = await startFakeOpenAI([
    () => ({
      toolCalls: [{ id: 'call_1', name: 'write_file', args: { path: 'hello.txt', content: 'Hello from Deskmates' } }]
    }),
    () => ({ text: 'I created hello.txt for you.' })
  ])

  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp(userDataDir, dataDir)
    app = launched.app
    const page = launched.page

    await test.step('configure the model', () => configureModel(page, fake.url))
    await page.screenshot({ path: 'test-results/screens/e2e-01-settings.png' })

    await test.step('add the project through its dialog', async () => {
      await app!.evaluate(({ dialog }, folder) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
      }, projectDir)

      await clickRobust(page.getByRole('button', { name: 'Add project', exact: true }))
      const dialog = page.locator('dialog')
      await expect(dialog).toBeVisible()

      await clickRobust(dialog.getByRole('button', { name: 'Browse…', exact: true }))
      await expect(dialog.getByLabel('Folder')).toHaveValue(projectDir)

      await clickRobust(dialog.getByRole('button', { name: 'Add project', exact: true }))
      await expect(dialog).toBeHidden()
    })

    await test.step('send a message', async () => {
      const message = page.getByLabel('Message')
      await expect(message).toBeVisible()
      await message.fill('Create hello.txt')
      await clickRobust(page.getByRole('button', { name: 'Send', exact: true }))
    })

    await expect(page.getByText('Wrote hello.txt')).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('I created hello.txt for you.')).toBeVisible({ timeout: 30000 })
    await page.screenshot({ path: 'test-results/screens/e2e-02-work-task.png' })

    const helloPath = join(projectDir, 'hello.txt')
    await expect
      .poll(() => (existsSync(helloPath) ? readFileSync(helloPath, 'utf8') : null), { timeout: 10000 })
      .toBe('Hello from Deskmates')

    await test.step('undo all changes', async () => {
      await clickRobust(page.getByRole('button', { name: 'Plan and changes', exact: true }))
      await clickRobust(page.getByRole('button', { name: 'Undo all', exact: true }))
    })
    await expect.poll(() => existsSync(helloPath), { timeout: 10000 }).toBe(false)
    await page.screenshot({ path: 'test-results/screens/e2e-03-work-undone.png' })
  } finally {
    await app?.close().catch(() => undefined)
    await fake.close().catch(() => undefined)
  }
})

test('designs a page and edits it directly', async () => {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const { base, userDataDir, dataDir } = makeTempDirs('design')
  const exportPath = join(base, 'export.html')

  const fake = await startFakeOpenAI([
    () => ({ toolCalls: [{ id: 'call_1', name: 'write_file', args: { path: 'index.html', content: DESIGN_HTML } }] }),
    () => ({ text: 'I designed the page.' })
  ])

  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp(userDataDir, dataDir)
    app = launched.app
    const page = launched.page

    await test.step('configure the model', () => configureModel(page, fake.url))

    await test.step('switch to the Design tab', async () => {
      await page.evaluate(() => (document.getElementById('tab-design') as HTMLElement | null)?.click())
      await expect(page.getByRole('tab', { name: 'Design' })).toHaveAttribute('aria-selected', 'true')
    })

    await test.step('start designing', async () => {
      await page.getByLabel('Describe your design').fill('A landing page for a coffee roaster')
      await clickRobust(page.getByRole('button', { name: 'Start designing', exact: true }))
    })

    await expect(page.getByText('I designed the page.')).toBeVisible({ timeout: 30000 })
    await waitForIframeMounted(page)
    const frame = page.frameLocator('iframe[title="Design preview"]')
    const h1 = frame.locator('h1')
    await expect(h1).toHaveText('Mountain Coffee', { timeout: 15000 })
    await waitForEditorReady(page)
    await page.screenshot({ path: 'test-results/screens/e2e-04-design-generated.png' })

    await expect
      .poll(
        () => {
          const dir = join(dataDir, 'designs')
          return existsSync(dir) ? readdirSync(dir).length : 0
        },
        { timeout: 15000 }
      )
      .toBe(1)
    const designId = readdirSync(join(dataDir, 'designs'))[0]
    const designFile = join(dataDir, 'designs', designId, 'index.html')

    await test.step('select the h1 and resize its font', async () => {
      const point = await pagePointForFrameElement(page, h1)
      await page.mouse.click(point.x, point.y)
      await expect(page.getByText('Corner radius')).toBeVisible()

      const sizeInput = page.locator('input[type="number"][aria-label="Size"]')
      await sizeInput.fill('64')
      await sizeInput.press('Enter')

      await expect
        .poll(() => h1.evaluate((el) => window.getComputedStyle(el).fontSize), { timeout: 10000 })
        .toBe('64px')
    })
    await expect
      .poll(() => (existsSync(designFile) ? readFileSync(designFile, 'utf8') : ''), { timeout: 5000 })
      .toContain('font-size: 64px')
    await page.screenshot({ path: 'test-results/screens/e2e-05-design-selected.png' })

    await test.step('drag the h1', async () => {
      const start = await pagePointForFrameElement(page, h1)
      const dx = 40 * start.scale
      const dy = 20 * start.scale
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 5 })
      await page.mouse.move(start.x + dx, start.y + dy, { steps: 5 })
      await page.mouse.up()
    })
    await expect
      .poll(() => (existsSync(designFile) ? readFileSync(designFile, 'utf8') : ''), { timeout: 5000 })
      .toContain('translate:')
    await page.screenshot({ path: 'test-results/screens/e2e-06-design-moved.png' })

    await test.step('export as HTML', async () => {
      await app!.evaluate(({ dialog }, target) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: target })
      }, exportPath)

      await clickRobust(page.getByRole('button', { name: 'Export', exact: true }))
      await clickRobust(page.getByRole('menuitem', { name: 'HTML file', exact: true }))
    })

    await expect.poll(() => existsSync(exportPath), { timeout: 10000 }).toBe(true)
    const exported = readFileSync(exportPath, 'utf8')
    expect(exported).toContain('Mountain Coffee')
    expect(exported).not.toContain('data-dm-id')

    await test.step('switch device to phone', () => clickRobust(page.getByRole('radio', { name: 'Phone 390', exact: true })))
    await page.screenshot({ path: 'test-results/screens/e2e-07-design-phone.png' })
  } finally {
    await app?.close().catch(() => undefined)
    await fake.close().catch(() => undefined)
  }
})

test('creates a bot, opens its page and deletes it', async () => {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const { userDataDir, dataDir } = makeTempDirs('bots')
  const botName = `Website watcher ${Date.now()}`

  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp(userDataDir, dataDir)
    app = launched.app
    const page = launched.page

    await test.step('open the Bots tab and check the wizard renders', async () => {
      await page.evaluate(() => (document.getElementById('tab-bots') as HTMLElement | null)?.click())
      await expect(page.getByRole('heading', { name: 'Bots', level: 1 })).toBeVisible()
      // The setup wizard derives its screen straight from the engine status — real or reported —
      // so this proves the wizard/status UI renders without blowing up, whatever this machine's
      // WSL/Docker state actually is.
      await expect(page.getByText('Setting up bot PCs', { exact: true })).toBeVisible({ timeout: 30000 })
      await page.screenshot({ path: 'test-results/screens/e2e-08-bots-wizard.png' })
    })

    await test.step('skip the wizard and create a bot', async () => {
      await clickRobust(page.getByRole('button', { name: /Skip for now/ }))
      await clickRobust(page.getByRole('button', { name: 'Create your first bot', exact: true }))
      // The sidebar and the home view each mount a CreateBotDialog; only the one the button opened
      // has the "dialog" role, so this targets that one.
      const dialog = page.getByRole('dialog', { name: 'Name your bot' })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Bot name').fill(botName)
      await clickRobust(dialog.getByRole('button', { name: 'Create bot', exact: true }))
    })

    await test.step('the bot page opens', async () => {
      await expect(page.getByRole('heading', { name: botName })).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole('button', { name: 'Delete bot', exact: true })).toBeVisible()
      await page.screenshot({ path: 'test-results/screens/e2e-09-bot-page.png' })
    })

    await test.step('delete the bot', async () => {
      page.once('dialog', (dialog) => void dialog.accept())
      await clickRobust(page.getByRole('button', { name: 'Delete bot', exact: true }))
    })

    // Deletion navigates back to the Bots home; the bot must be gone from the whole app.
    await expect(page.getByRole('heading', { name: 'Bots', level: 1 })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(botName)).toHaveCount(0)
    await page.screenshot({ path: 'test-results/screens/e2e-10-bots-after-delete.png' })
  } finally {
    await app?.close().catch(() => undefined)
  }
})

test('Extras tab shows skills, plugins and connectors sections', async () => {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const { userDataDir, dataDir } = makeTempDirs('extras')

  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp(userDataDir, dataDir)
    app = launched.app
    const page = launched.page

    await test.step('open the Extras tab', async () => {
      await page.evaluate(() => (document.getElementById('tab-extras') as HTMLElement | null)?.click())
      await expect(page.getByRole('heading', { name: 'Extras', level: 1 })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible()
      await page.screenshot({ path: 'test-results/screens/e2e-12-extras-empty.png' })
    })

    await test.step('add a connector and see it listed', async () => {
      await clickRobust(page.getByRole('button', { name: 'Add a connector', exact: true }))
      const dialog = page.getByRole('dialog', { name: 'Add a connector' })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Name').fill('demo-files')
      await dialog.getByLabel('Command').fill('definitely-not-a-real-command-xyz')
      await clickRobust(dialog.getByRole('button', { name: 'Add', exact: true }))
      await expect(dialog).not.toBeVisible()
      await expect(page.getByText('demo-files', { exact: true })).toBeVisible()
      await page.screenshot({ path: 'test-results/screens/e2e-13-extras-connector.png' })
    })

    await test.step('edit and remove the connector', async () => {
      await clickRobust(page.getByRole('button', { name: 'Edit', exact: true }))
      const dialog = page.getByRole('dialog', { name: 'Edit connector' })
      await expect(dialog).toBeVisible()
      await clickRobust(dialog.getByRole('button', { name: 'Save', exact: true }))
      await expect(dialog).not.toBeVisible()

      page.once('dialog', (dialogEvent) => void dialogEvent.accept())
      await clickRobust(page.getByRole('button', { name: 'Remove', exact: true }))
      await expect(page.getByText('demo-files', { exact: true })).toHaveCount(0)
      await page.screenshot({ path: 'test-results/screens/e2e-14-extras-after-remove.png' })
    })
  } finally {
    await app?.close().catch(() => undefined)
  }
})

test('Agents tab renders and lists detected sessions', async () => {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const { userDataDir, dataDir } = makeTempDirs('agents')

  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp(userDataDir, dataDir)
    app = launched.app
    const page = launched.page

    await test.step('open the Agents tab', async () => {
      await page.evaluate(() => (document.getElementById('tab-agents') as HTMLElement | null)?.click())
      await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Running on this computer' })).toBeVisible()
      // "Managed sessions" also appears as a sidebar caption (a div); the main view's is the h2.
      await expect(page.getByRole('heading', { name: 'Managed sessions' })).toBeVisible()
    })

    // Detection is a real process listing: it either finds OpenCode/agy sessions or honestly says
    // none are running. Both are acceptable proof that the tab renders and lists what it found.
    await test.step('detection results or an honest empty state', async () => {
      const detected = page.getByText(/pid \d+/)
      const emptyNote = page.getByText('No OpenCode or Antigravity processes found right now.', { exact: true })
      await expect
        .poll(async () => ((await detected.count()) > 0 || (await emptyNote.count()) > 0), { timeout: 15000 })
        .toBe(true)
      await page.screenshot({ path: 'test-results/screens/e2e-11-agents.png' })
    })
  } finally {
    await app?.close().catch(() => undefined)
  }
})
