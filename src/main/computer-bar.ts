import { BrowserWindow, globalShortcut, screen } from 'electron'

export const COMPUTER_STOP_HOTKEY = 'Control+Alt+Q'
const HOTKEY_LABEL = 'Ctrl+Alt+Q'

const BAR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:13px/1 system-ui,'Segoe UI',sans-serif;user-select:none}
.bar{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:10px;padding:0 6px 0 16px;border-radius:22px;background:#1f1e1d;color:#faf9f5}
.dot{width:8px;height:8px;border-radius:50%;background:#d97757;animation:p 1.2s ease-in-out infinite}
@keyframes p{50%{opacity:.35}}
.t{flex:1;white-space:nowrap}.k{color:#b0aea5}
button{font:inherit;border:0;border-radius:16px;padding:8px 14px;background:#d97757;color:#fff;cursor:pointer}
</style></head><body><div class="bar"><span class="dot"></span><span class="t">Deskmates is controlling your computer <span class="k">· ${HOTKEY_LABEL}</span></span><button onclick="window.close()">Stop</button></div></body></html>`

/**
 * The always-on-top "controlling your computer" bar plus the global stop hotkey, shown only while a
 * computer-use session runs. The bar is excluded from screen capture, so the model never sees it.
 */
export class ComputerBar {
  private bar: BrowserWindow | null = null

  constructor(
    private readonly onStop: () => void,
    private readonly getMainWindow: () => BrowserWindow | null
  ) {}

  setActive(active: boolean): void {
    if (active) this.show()
    else this.hide()
  }

  private show(): void {
    if (this.bar) return
    const area = screen.getPrimaryDisplay().workArea
    const width = 440
    const height = 44
    const bar = new BrowserWindow({
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + 8,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    bar.setAlwaysOnTop(true, 'screen-saver')
    bar.setContentProtection(true)
    // The page's Stop button closes the window; a programmatic hide destroys it without a 'close' event.
    bar.on('close', () => this.onStop())
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    bar.webContents.on('will-navigate', (event) => event.preventDefault())
    void bar.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BAR_HTML)}`)
    bar.once('ready-to-show', () => bar.showInactive())
    this.bar = bar

    if (!globalShortcut.isRegistered(COMPUTER_STOP_HOTKEY)) {
      globalShortcut.register(COMPUTER_STOP_HOTKEY, () => this.onStop())
    }
    // The agent needs the desktop, not Deskmates' own window in front of it.
    this.getMainWindow()?.minimize()
  }

  private hide(): void {
    if (globalShortcut.isRegistered(COMPUTER_STOP_HOTKEY)) globalShortcut.unregister(COMPUTER_STOP_HOTKEY)
    const bar = this.bar
    this.bar = null
    if (!bar) return
    bar.destroy()
    const main = this.getMainWindow()
    if (main) {
      if (main.isMinimized()) main.restore()
      main.show()
    }
  }
}
