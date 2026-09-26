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
import { SecretStore } from './secrets'
import { windowsDpapi } from './dpapi'
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

function main(): void {
  registerPreviewScheme()
  const startHidden = process.argv.includes('--hidden')
  const dataDir = process.env.DESKMATES_DATA_DIR ?? app.getPath('userData')
  // The prompt directories live in the app folder in development, and ship next to the binary in
  // the packaged app (electron-builder copies `prompts/**` to resources/prompts).
  const promptsDir = app.isPackaged ? join(process.resourcesPath, 'prompts') : join(app.getAppPath(), 'prompts')
  const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'), {
    dpapi: windowsDpapi,
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
    onRenderRequest: (request) => renderService.render(request),
    onVideoRequest: (request) => recordForCore(dataDir, request)
  })
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
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: colors.color, symbolColor: colors.symbolColor, height: 40 },
      backgroundColor: colors.color,
      // Without this the taskbar shows Electron's own icon until the renderer applies the appearance.
      icon: process.platform === 'win32' ? windowIconPath : iconPath,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true
      }
    })

    if (process.platform === 'win32') {
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

    window.once('ready-to-show', () => {
      if (!startHidden) window.show()
    })

    window.on('close', (event) => {
      if (isQuitting) return
      event.preventDefault()
      window.hide()
    })

    nativeTheme.on('updated', () => {
      const c = themeColors()
      window.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: 40 })
      window.setBackgroundColor(c.color)
    })

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
