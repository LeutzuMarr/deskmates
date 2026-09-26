import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron, chromium, type Browser, type ElectronApplication, type Locator, type Page } from '@playwright/test'

function makeTempDirs(label: string): { base: string; userDataDir: string; dataDir: string } {
  const base = mkdtempSync(join(tmpdir(), `deskmates-e2e-${label}-`))
  const userDataDir = join(base, 'userData')
  const dataDir = join(base, 'data')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  return { base, userDataDir, dataDir }
}

async function launchApp(userDataDir: string, dataDir: string, phonePort: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, DESKMATES_USER_DATA: userDataDir, DESKMATES_DATA_DIR: dataDir, DESKMATES_PHONE_PORT: String(phonePort) }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
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

/** Resolves 'open' or 'rejected' for a raw WebSocket to the phone server with the given token. */
async function probeSocket(port: number, token: string): Promise<'open' | 'rejected'> {
  const probe = await chromium.launch()
  try {
    const p = await probe.newPage()
    return (await p.evaluate(
      ({ port, token }) =>
        new Promise<'open' | 'rejected'>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
          ws.onopen = () => {
            ws.close()
            resolve('open')
          }
          ws.onerror = () => resolve('rejected')
        }),
      { port, token }
    )) as 'open' | 'rejected'
  } finally {
    await probe.close().catch(() => undefined)
  }
}

test('phone access: off by default, a browser signs in with the pairing code, losing the code loses the door', async () => {
  mkdirSync('test-results/screens', { recursive: true })
  // A high port that nothing else is listening on, so "off by default" is provable.
  const phonePort = 19000 + Math.floor(Math.random() * 1000)
  const { userDataDir, dataDir } = makeTempDirs('phone')

  let app: ElectronApplication | undefined
  let browser: Browser | undefined
  let pairingCode = ''
  try {
    // The phone server is off until the checkbox is ticked: before enabling, the port refuses.
    browser = await chromium.launch()
    const phonePage = await browser.newPage()
    await expect(phonePage.goto(`http://127.0.0.1:${phonePort}/`)).rejects.toThrow()

    const launched = await launchApp(userDataDir, dataDir, phonePort)
    app = launched.app
    const page = launched.page

    await test.step('enable phone access in Settings and read the pairing code', async () => {
      await clickRobust(page.getByRole('button', { name: 'Settings', exact: true }))
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

      const toggle = page.getByRole('checkbox', { name: 'Allow another device on this network' })
      // Exactly one click: this input is a controlled React component, so a second "recovery" click
      // (reading isChecked while the server round-trip is still in flight) would toggle it back off.
      await clickRobust(toggle)
      const code = page.locator('[aria-label="Pairing code"]')
      await expect(code).toHaveText(/^\d{6}$/, { timeout: 15000 })
      pairingCode = (await code.textContent()) ?? ''
      expect(pairingCode.length).toBe(6)
    })

    await test.step('the phone now finds the app and signs in', async () => {
      await phonePage.goto(`http://127.0.0.1:${phonePort}/`)
      // The bootstrap bounced us to the sign-in page; "Sign in to Deskmates" is its <title>,
      // the visible heading is "Deskmates".
      await expect(phonePage.getByRole('heading', { name: 'Deskmates', level: 1 })).toBeVisible({ timeout: 15000 })

      await phonePage.getByLabel('Pairing code').fill(pairingCode)
      await phonePage.getByRole('button', { name: 'Sign in', exact: true }).click()

      // The shell appears only once the store has loaded from core over the token'd websocket.
      await expect(phonePage.getByRole('tab', { name: 'Work' })).toBeVisible({ timeout: 30000 })
      const tabCount = await phonePage.locator('[role="tab"]').count()
      expect(tabCount).toBeGreaterThanOrEqual(4)
      await phonePage.screenshot({ path: 'test-results/screens/e2e-15-phone-app.png' })
    })

    await test.step('the websocket opens with the right code and is rejected with a wrong one', async () => {
      expect(await probeSocket(phonePort, pairingCode)).toBe('open')
      const wrong = pairingCode === '000000' ? '111111' : '000000'
      expect(await probeSocket(phonePort, wrong)).toBe('rejected')
    })

    await test.step('turning phone access off closes the door again', async () => {
      await clickRobust(page.getByRole('checkbox', { name: 'Allow another device on this network' }))
      await expect(page.locator('[aria-label="Pairing code"]')).toHaveCount(0, { timeout: 15000 })
      await expect(phonePage.goto(`http://127.0.0.1:${phonePort}/`)).rejects.toThrow()
    })

    await page.screenshot({ path: 'test-results/screens/e2e-16-phone-off.png' })
  } finally {
    await browser?.close().catch(() => undefined)
    await app?.close().catch(() => undefined)
  }
})