import { randomInt } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { EventBus } from '../events'
import { startRpcServer, type Handlers, type Www } from '../server/rpc-server'
import { SignInGuard } from '../server/sign-in-guard'
import type { PhoneInfo, Settings } from '../../shared/protocol'

/** How many digits a pairing code has. */
export const PAIRING_CODE_DIGITS = 6
/** Port the phone server listens on unless DESKMATES_PHONE_PORT overrides it. */
export const DEFAULT_PHONE_PORT = 8642

/** A fresh six-digit code ('000123' included — leading zeros are part of the code). */
export function generatePairingCode(): string {
  return randomInt(0, 10 ** PAIRING_CODE_DIGITS).toString().padStart(PAIRING_CODE_DIGITS, '0')
}

export function isValidPairingCode(code: string): boolean {
  return new RegExp(`^\\d{${PAIRING_CODE_DIGITS}}$`).test(code)
}

/** The phone server binds all interfaces; this is how the rest of the app finds out it's alive. */
export interface PhoneServer {
  /** Starts/stops/restarts the listener so it matches `settings`; resolves with the new state. */
  sync(settings: Settings): Promise<PhoneInfo>
  /** The current state, as last applied by `sync` (or the disabled default before the first sync). */
  info(): PhoneInfo
  stop(): Promise<void>
}

export interface PhoneServerOptions {
  /** The built renderer folder to serve. Without it, enabling phone access reports an error. */
  rendererDir?: string
  /** Returns the RPC handlers shared with the desktop server; the phone's code signs into that same app surface. */
  handlers: () => Handlers
  bus: EventBus
  /** Port to bind; 0 picks a free one. Defaults to DEFAULT_PHONE_PORT. */
  port?: number
}

const DISABLED: PhoneInfo = { enabled: false, port: null, urls: [], error: null }

/** LAN-only: reachable links for the main interface the phone machine can actually use. */
function lanUrls(port: number): string[] {
  const urls: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}`)
    }
  }
  return urls
}

/** The phone app keeps the desktop CSP's shape but lets the page reach its own origin and the phone
 *  WebSocket it connects to over the LAN. Its `script-src` also allows the injected bootstrap. */
const PHONE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src deskmates-preview:; connect-src 'self' ws: wss:"

/** The baked CSP (electron.vite.config.ts) points connect-src and script-src at the desktop's own
 *  shapes; the served copy relaxes just those two so the phone's origin and its ws:// work. */
function patchIndexForPhone(html: string): string {
  return html
    .replace('connect-src ws://127.0.0.1:*', "connect-src 'self' ws: wss:")
    .replace(/script-src 'self';/g, "script-src 'self' 'unsafe-inline';")
}

/** Defines `window.deskmates` before the app bundle runs, so the shared store boots against the
 *  phone's own socket. The code the device signed in with doubles as the WebSocket token. */
const PHONE_BOOTSTRAP =
  '<script>' +
  ';(function(){' +
  "var KEY='deskmates:phone-token';" +
  "var token=sessionStorage.getItem(KEY);" +
  "if(!token){location.replace('/login');return;}" +
  'var port=Number(location.port)||80;' +
  'window.deskmates={' +
  "getCoreConnection:function(){return fetch('/auth',{method:'POST',body:token,cache:'no-store'}).then(function(r){" +
  'if(r.ok)return {port:port,token:token};' +
  "sessionStorage.removeItem(KEY);location.replace('/login?e='+(r.status===429?'locked':'wrong'));" +
  'return new Promise(function(){});});},' +
  'onCoreRestarted:function(){return function(){};},' +
  'secrets:{' +
  'status:function(){return Promise.resolve([]);},' +
  'set:function(){return Promise.resolve([]);}' +
  '},' +
  'pickFolder:function(){return Promise.resolve(null);},' +
  'openPath:function(){return Promise.resolve();},' +
  'autoStart:{' +
  'get:function(){return Promise.resolve(false);},' +
  'set:function(){return Promise.resolve(false);}' +
  '},' +
  'appearance:{' +
  'pickImage:function(){return Promise.resolve(null);},' +
  'pickFont:function(){return Promise.resolve(null);},' +
  'pickAnimation:function(){return Promise.resolve(null);},' +
  'setWindowIcon:function(){return Promise.resolve();}' +
  '},' +
  'design:{' +
  'export:function(){return Promise.resolve(null);},' +
  'systemFonts:function(){return Promise.resolve([]);}' +
  '},' +
  'engine:{' +
  "installWsl:function(){return Promise.resolve({outcome:'error',message:'Setting up the bot engine only works in the desktop app.'});}" +
  '}' +
  '};})()' +
  '</script>'

/** Inserts the bootstrap just before the bundle runs, then lets the existing head close. */
function injectPhoneBootstrap(html: string): string {
  const tag = '</head>'
  const index = html.toLowerCase().lastIndexOf(tag)
  if (index === -1) return html + PHONE_BOOTSTRAP
  return html.slice(0, index) + PHONE_BOOTSTRAP + html.slice(index)
}

const PHONE_LOGIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in to Deskmates</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: system-ui, sans-serif; background: #f0eee6; color: #141413;
        display: grid; place-items: center; min-height: 100vh; }
      @media (prefers-color-scheme: dark) {
        body { background: #1f1e1d; color: #faf9f5; }
        input { background: #141413; color: #faf9f5; border-color: #45433f; }
      }
      main { width: min(92vw, 360px); text-align: center; }
      h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 400; margin: 0 0 12px; }
      p { font-size: 14px; line-height: 1.5; color: #6b6b6b; margin: 0 0 24px; }
      input { width: 100%; padding: 14px; font-size: 22px; letter-spacing: 8px; text-align: center;
        border-radius: 14px; border: 1px solid #c9c5b9; outline: none; }
      input:focus { border-color: #141413; }
      button { margin-top: 14px; width: 100%; padding: 13px; font-size: 15px; border: none;
        border-radius: 14px; background: #141413; color: #faf9f5; cursor: pointer; }
      .error { color: #a33; font-size: 13px; margin-top: 10px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Deskmates</h1>
      <p>Enter the six-digit code shown under Phone access in the app on your computer.</p>
      <form id="form" novalidate>
        <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="Pairing code" />
        <button type="submit">Sign in</button>
        <p class="error" id="error" hidden></p>
      </form>
    </main>
    <script>
      (function () {
        var KEY = 'deskmates:phone-token'
        var form = document.getElementById('form')
        var code = document.getElementById('code')
        var error = document.getElementById('error')
        var button = form.querySelector('button')
        var show = function (text) { error.textContent = text; error.hidden = false }
        var locked = function (seconds) {
          var minutes = Math.max(1, Math.ceil(seconds / 60))
          show('Too many wrong codes. Try again in ' + minutes + (minutes === 1 ? ' minute' : ' minutes') + ', or make a new code in Settings on your computer.')
        }
        var reason = new URLSearchParams(location.search).get('e')
        if (reason === 'wrong') show('That code no longer works. Enter the current code from your computer.')
        if (reason === 'locked') show('Too many wrong codes. Wait a while, or make a new code in Settings on your computer.')
        code.focus()
        form.addEventListener('submit', function (event) {
          event.preventDefault()
          var value = code.value.trim()
          if (!/^\\d{6}$/.test(value)) {
            show('Enter the 6-digit code.')
            return
          }
          button.disabled = true
          fetch('/auth', { method: 'POST', body: value, cache: 'no-store' })
            .then(function (response) {
              return response.json().then(function (body) {
                if (response.ok) {
                  sessionStorage.setItem(KEY, value)
                  location.replace('/')
                  return
                }
                if (response.status === 429) locked(body.retryAfterSeconds || 900)
                else show('Wrong code. ' + body.triesLeft + (body.triesLeft === 1 ? ' try' : ' tries') + ' left before this device is blocked.')
                code.value = ''
                code.focus()
              })
            })
            .catch(function () { show("Couldn't reach your computer. Check that it's on and on the same network.") })
            .then(function () { button.disabled = false })
        })
      })()
    </script>
  </body>
</html>`

function makePhoneWww(rendererDir: string): Www {
  return {
    root: rendererDir,
    routes: { '/login': PHONE_LOGIN_HTML },
    transformIndex: (html) => injectPhoneBootstrap(patchIndexForPhone(html)),
    htmlCsp: PHONE_CSP
  }
}

/**
 * Owns the phone access listener (spec 5.12): a second RPC server bound to 0.0.0.0 that also
 * serves the built app over HTTP. It only exists while `settings.phoneAccess` is on, and only
 * accepts WebSocket connections that present the current pairing code.
 */
export function createPhoneServer(options: PhoneServerOptions): PhoneServer {
  const { rendererDir, bus } = options
  const desiredPort = options.port ?? DEFAULT_PHONE_PORT
  let state: PhoneInfo = { ...DISABLED }
  let running: { code: string; port: number; close(): Promise<void> } | null = null
  // All lifecycle work serially, so rapid settings.updated events can't double-start the listener.
  let chain: Promise<unknown> = Promise.resolve()

  const stopRunning = async (): Promise<void> => {
    if (!running) return
    const current = running
    running = null
    await current.close().catch(() => undefined)
  }

  const apply = async (settings: Settings): Promise<PhoneInfo> => {
    if (!settings.phoneAccess) {
      await stopRunning()
      state = { ...DISABLED }
      return state
    }
    if (!rendererDir) {
      await stopRunning()
      state = { ...DISABLED, error: "This copy of Deskmates doesn't have app files to serve to a phone. Reinstall and try again." }
      return state
    }
    if (!isValidPairingCode(settings.pairingCode)) {
      await stopRunning()
      state = { ...DISABLED, error: 'No valid pairing code is set. Turn phone access off and on again.' }
      return state
    }
    if (running && running.code === settings.pairingCode) {
      state = { enabled: true, port: running.port, urls: lanUrls(running.port), error: null }
      return state
    }
    await stopRunning()
    try {
      const server = await startRpcServer({
        handlers: options.handlers(),
        bus,
        port: desiredPort,
        host: '0.0.0.0',
        token: settings.pairingCode,
        www: makePhoneWww(rendererDir),
        guard: new SignInGuard()
      })
      running = { code: settings.pairingCode, port: server.port, close: server.close }
      state = { enabled: true, port: server.port, urls: lanUrls(server.port), error: null }
    } catch (error) {
      state = { ...DISABLED, error: `Couldn't start phone access: ${error instanceof Error ? error.message : String(error)}` }
    }
    return state
  }

  const sync = (settings: Settings): Promise<PhoneInfo> => {
    const run = chain.then(() => apply(settings))
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    sync,
    info: () => state,
    stop: () => {
      const run = chain.then(() => stopRunning())
      chain = run.then(() => undefined, () => undefined)
      return run
    }
  }
}