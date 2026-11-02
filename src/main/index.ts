import { app, BrowserWindow, Notification, nativeTheme, safeStorage, shell } from 'electron'
import type { Tray } from 'electron'
import { join } from 'node:path'
import iconPath from '../../resources/icon.png?asset'
import windowIconPath from '../../resources/icon.ico?asset'
import editorPath from '../preview/editor.js?asset'
import dcSupportPath from '../preview/dc-support.js?asset'
import bridgeScript from '../bridge/cli?modulePath'
import { installAgentCommand } from './agent-kit'
import { CoreHost } from './core-host'
import { ComputerBar } from './computer-bar'
import { ScreenOverlay } from './screen-overlay'
import { SecretStore } from './secrets'
import { createSecretCipher } from './secret-cipher'
import { registerIpc } from './ipc'
import { handlePreviewProtocol, registerPreviewScheme } from './preview-protocol'
import { RenderService } from './render-service'
import { recordForCore } from './video-export'
import { createTray } from './tray'

// Portable mode (also used by tests): redirect Electron's userData folder before anything else runs.
if (process.env.DESKMATES_USER_DATA) {
  app.setPath('userData', process.env.DESKMATES_USER_DATA)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  main()
}

function themeColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1f1e1d', symbolColor: '#faf9f5' }
    : { color: '#f0eee6', symbolColor: '#141413' }
}

const IS_WINDOWS = process.platform === 'win32'

/**
 * How this OS wants the window framed.
 *
 * Windows draws the app's 40px header controls itself, via `titleBarOverlay` on top of the hidden
 * title bar. macOS keeps its traffic lights with the same hidden title bar. Linux honours
 * `titleBarStyle` only alongside `frame: false`, so there we drop the frame entirely and the app
 * draws its own minimize/maximize/close in the header (`WindowControls` in TitleBar.tsx). Leaving
 * Linux framed would stack the WM's title bar on top of the app's and double the chrome.
 */
function windowFrameOptions(colors: { color: string; symbolColor: string }): Electron.BrowserWindowConstructorOptions {
  if (IS_WINDOWS) {
    return { titleBarStyle: 'hidden', titleBarOverlay: { color: colors.color, symbolColor: colors.symbolColor, height: 40 } }
  }
  if (process.platform === 'darwin') return { titleBarStyle: 'hidden' }
  return { frame: false, titleBarStyle: 'hidden' }
}

function main(): void {
  registerPreviewScheme()
  const startHidden = process.argv.includes('--hidden')
  const dataDir = process.env.DESKMATES_DATA_DIR ?? app.getPath('userData')
  // The prompt directories live in the app folder in development, and ship next to the binary in
  // the packaged app (electron-builder copies `prompts/**` to resources/prompts).
  const promptsDir = app.isPackaged ? join(process.resourcesPath, 'prompts') : join(app.getAppPath(), 'prompts')
  const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'), {
    cipher: createSecretCipher(),
    legacyDecrypt: (base64) => safeStorage.decryptString(Buffer.from(base64, 'base64'))
  })

  let win: BrowserWindow | null = null
  let tray: Tray | null = null
  let isQuitting = false

  const renderService = new RenderService()
  const core = new CoreHost({
    dataDir,
    rendererDir: join(import.meta.dirname, '../renderer'),
    version: app.getVersion(),
    promptsDir,
    getKeys: () => secrets.all(),
    onNotify: (title, body) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body, icon: iconPath })
      notification.on('click', () => {
        win?.show()
        win?.focus()
      })
      notification.show()
    },
    onRestart: () => {
      win?.webContents.send('core:restarted')
    },
    onComputerUse: (active) => computerBar.setActive(active),
    onOverlay: (marks, seconds) => screenOverlay.show(marks, seconds),
    onRenderRequest: (request) => renderService.render(request),
    onVideoRequest: (request) => recordForCore(dataDir, request)
  })
  const screenOverlay = new ScreenOverlay()
  const computerBar = new ComputerBar(
    () => core.stopComputerUse(),
    () => win
  )

  app.setAppUserModelId(app.isPackaged ? 'com.deskmates.app' : process.execPath)

  app.on('second-instance', () => {
    win?.show()
    win?.focus()
  })

  app.on('before-quit', () => {
    isQuitting = true
    core.stop()
    renderService.dispose()
    screenOverlay.dispose()
  })

  app.whenReady().then(() => {
    handlePreviewProtocol(dataDir, editorPath, dcSupportPath)
    // Decrypting takes about a second; start now so the keys are ready when the core first asks.
    void secrets.all().catch((error: unknown) => console.error('[main] could not load the saved API keys', error))
    win = createWindow()
    core.start()
    tray = createTray({
      iconPath,
      show: () => {
        win?.show()
        win?.focus()
      },
      quit: () => app.quit()
    })
    registerIpc({ core, secrets, getWindow: () => win, dataDir })
    try {
      installAgentCommand({ dataDir, bridgeScript })
    } catch (error) {
      console.error('[deskmates] failed to install the agent command', error)
    }
  })

  function createWindow(): BrowserWindow {
    const colors = themeColors()
    const window = new BrowserWindow({
      width: 1480,
      height: 900,
      minWidth: 1024,
      minHeight: 640,
      show: false,
      ...windowFrameOptions(colors),
      backgroundColor: colors.color,
      // Without this the taskbar shows Electron's own icon until the renderer applies the appearance.
      icon: IS_WINDOWS ? windowIconPath : iconPath,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true
      }
    })

    if (IS_WINDOWS) {
      // The taskbar takes its button icon from the window's app identity, not the window icon. In
      // development that identity is electron.exe's (and any pinned "Electron"), so give the window
      // one of its own with the Deskmates icon.
      window.setAppDetails({
        appId: app.isPackaged ? 'com.deskmates.app' : 'com.deskmates.app.dev',
        appIconPath: windowIconPath,
        appIconIndex: 0,
        relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
        relaunchDisplayName: 'Deskmates'
      })
    }

    // 'ready-to-show' alone isn't enough: in the built app (not in dev) it never fired on a fresh
    // start, leaving the app running with no window until a second launch showed it. The page
    // finishing its load, or a few seconds passing, shows it too; whichever comes first.
    let shown = false
    const showOnce = (): void => {
      if (shown || startHidden || window.isDestroyed()) return
      shown = true
      window.show()
    }
    window.once('ready-to-show', showOnce)
    window.webContents.once('did-finish-load', showOnce)
    setTimeout(showOnce, 4000)

    window.on('close', (event) => {
      if (isQuitting) return
      event.preventDefault()
      window.hide()
    })

    nativeTheme.on('updated', () => {
      const c = themeColors()
      // Only Windows has a title-bar overlay to recolour. Elsewhere the header is drawn by the app
      // and the window has no frame, so calling this would be a no-op at best and a warning at worst.
      if (IS_WINDOWS) window.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: 40 })
      window.setBackgroundColor(c.color)
    })

    // Only the app-drawn controls (Linux) care about this; Windows ignores its own title-bar glyphs.
    const announceMaximize = (): void => {
      if (window.isDestroyed()) return
      window.webContents.send('window:maximizeChange', window.isMaximized())
    }
    window.on('maximize', announceMaximize)
    window.on('unmaximize', announceMaximize)

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    })

    window.webContents.on('will-frame-navigate', (details) => {
      if (
        details.isMainFrame ||
        details.url.startsWith('deskmates-preview://') ||
        /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(details.url)
      ) {
        return
      }
      details.preventDefault()
      if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
    }

    return window
  }
}
