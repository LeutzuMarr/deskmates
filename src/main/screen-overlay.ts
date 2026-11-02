import { BrowserWindow, screen } from 'electron'
import type { ScreenMark } from '../shared/protocol'

/**
 * Draws the screen guide's marks. Marks arrive in device-independent pixels relative to the
 * overlay's top-left corner. Arrows come in from the lower right, so their tail stays clear of the
 * thing they point at.
 */
const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;font:600 15px/1.3 system-ui,'Segoe UI',sans-serif}
svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.m{animation:pop .28s cubic-bezier(.2,1.4,.4,1) both;transform-box:fill-box;transform-origin:center}
@keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}
.stroke{fill:none;stroke:#d97757;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))}
.tag{position:absolute;max-width:320px;padding:7px 12px;border-radius:14px;background:#1f1e1d;color:#faf9f5;box-shadow:0 4px 14px rgba(0,0,0,.3);animation:pop .28s .08s cubic-bezier(.2,1.4,.4,1) both}
#root{transition:opacity .4s}
</style></head><body><div id="root"></div><script>
const NS='http://www.w3.org/2000/svg'
function el(tag,attrs){const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e}
function tag(text,x,y){const d=document.createElement('div');d.className='tag';d.textContent=text;d.style.left=x+'px';d.style.top=y+'px';return d}
window.draw=function(marks){
  const root=document.getElementById('root');root.style.opacity='1';root.replaceChildren()
  const svg=el('svg',{});root.appendChild(svg)
  for(const m of marks){
    const g=el('g',{class:'m'});svg.appendChild(g)
    if(m.kind==='arrow'){
      const tx=m.x+110,ty=m.y+110
      g.appendChild(el('path',{class:'stroke',d:'M'+tx+' '+ty+' Q'+(m.x+95)+' '+(m.y+30)+' '+(m.x+8)+' '+(m.y+8)}))
      g.appendChild(el('path',{class:'stroke',d:'M'+(m.x+8)+' '+(m.y+30)+' L'+(m.x+8)+' '+(m.y+8)+' L'+(m.x+30)+' '+(m.y+8)}))
      if(m.text)root.appendChild(tag(m.text,tx+6,ty+6))
    }else if(m.kind==='circle'){
      const pad=12
      g.appendChild(el('ellipse',{class:'stroke',cx:m.x+m.width/2,cy:m.y+m.height/2,rx:m.width/2+pad,ry:m.height/2+pad}))
      if(m.text)root.appendChild(tag(m.text,m.x,m.y+m.height+pad+10))
    }else if(m.kind==='box'){
      const pad=6
      g.appendChild(el('rect',{class:'stroke',x:m.x-pad,y:m.y-pad,width:m.width+pad*2,height:m.height+pad*2,rx:10}))
      if(m.text)root.appendChild(tag(m.text,m.x,m.y+m.height+pad+10))
    }else if(m.kind==='label'&&m.text){
      root.appendChild(tag(m.text,m.x,m.y))
    }
  }
}
window.fade=function(){document.getElementById('root').style.opacity='0'}
</script></body></html>`

/**
 * A click-through, always-on-top layer over the primary screen where the screen guide draws its
 * arrows and circles. It is excluded from screen capture, so the agent's next screenshot shows the
 * screen as the user's apps left it, not the agent's own marks.
 */
export class ScreenOverlay {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private hideTimer: ReturnType<typeof setTimeout> | null = null

  /** Shows `marks` (physical screen pixels) for `seconds`; an empty list clears the overlay. */
  show(marks: ScreenMark[], seconds: number): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
    if (marks.length === 0) {
      this.hide()
      return
    }
    const display = screen.getPrimaryDisplay()
    const factor = display.scaleFactor || 1
    // Physical pixels from the screenshot to the overlay's own DIP coordinates.
    const local = marks.map((mark) => ({
      ...mark,
      x: mark.x / factor,
      y: mark.y / factor,
      ...(mark.width !== undefined ? { width: mark.width / factor } : {}),
      ...(mark.height !== undefined ? { height: mark.height / factor } : {})
    }))
    const win = this.ensureWindow(display.bounds)
    void this.ready
      ?.then(() => win.webContents.executeJavaScript(`draw(${JSON.stringify(local)})`))
      .then(() => win.showInactive())
      .catch((error: unknown) => console.error('[main] could not draw the screen overlay', error))
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      this.hide()
    }, seconds * 1000)
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.win?.destroy()
    this.win = null
    this.ready = null
  }

  private hide(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    void win.webContents
      .executeJavaScript('fade()')
      .catch(() => undefined)
      .then(() => new Promise((resolve) => setTimeout(resolve, 400)))
      .then(() => {
        // A new show() during the fade set a fresh timer; leave its marks up.
        if (!win.isDestroyed() && this.hideTimer === null) win.hide()
      })
  }

  private ensureWindow(bounds: Electron.Rectangle): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setBounds(bounds)
      return this.win
    }
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true)
    win.setContentProtection(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    this.ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`)
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.ready = null
      }
    })
    this.win = win
    return win
  }
}
