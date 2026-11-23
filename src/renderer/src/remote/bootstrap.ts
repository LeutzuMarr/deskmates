/**
 * The phone web app's start: pairs from the "Add a phone" link (#pair=…, read here and never sent
 * anywhere), keeps the pairing on this phone, stands in for the desktop API, and then starts the
 * same app the PC shows, connected through the encrypted relay.
 */
import { fromBase64Url } from '../../../shared/remote-crypto'
import { deviceName, keepDataForGood, pairingFromText, restoreDevice, saveDevice } from './device'
import { RelayConnection, RelaySocket } from './relay'
import '../styles.css'
import '../styles/glass.css'
import '../styles/sidebar.css'
import '../styles/marks.css'

function message(title: string, body: string, action?: { label: string; run: () => void }): void {
  document.body.innerHTML = ''
  const main = document.createElement('main')
  main.style.cssText = 'max-width:380px;margin:18vh auto;padding:0 24px;font-family:system-ui,sans-serif;text-align:center;color:inherit'
  const h = document.createElement('h1')
  h.textContent = title
  h.style.cssText = 'font-family:Georgia,serif;font-weight:400;font-size:28px;margin:0 0 12px'
  const p = document.createElement('p')
  p.textContent = body
  p.style.cssText = 'font-size:14px;line-height:1.5;opacity:.75'
  main.append(h, p)
  if (action) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = action.label
    button.style.cssText = 'margin-top:20px;padding:12px 22px;border-radius:999px;border:0;background:#c96442;color:#fff;font:600 15px system-ui,sans-serif'
    button.onclick = action.run
    main.append(button)
  }
  document.body.append(main)
}

/** Not paired yet: offer to scan the PC's code from right here (the home-screen app can't use Safari's pairing), or to paste its link. */
function askToPair(body: string): void {
  message('Deskmates', body, {
    label: 'Scan the code',
    run: () => {
      void import('./pair').then(async ({ pairByScanning }) => {
        const outcome = await pairByScanning()
        if (outcome.status === 'paired') location.reload()
        else if (outcome.status === 'failed') askToPair(outcome.message)
      })
    }
  })
  const main = document.querySelector('main')
  if (!main) return
  const field = document.createElement('textarea')
  field.placeholder = 'Or paste the link from your PC here'
  field.rows = 3
  field.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:18px;padding:10px 12px;border-radius:12px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:13px ui-monospace,monospace;word-break:break-all'
  const go = document.createElement('button')
  go.type = 'button'
  go.textContent = 'Pair with the link'
  go.style.cssText = 'margin-top:10px;padding:10px 20px;border-radius:999px;border:0;background:rgba(128,128,128,.25);color:inherit;font:600 14px system-ui,sans-serif'
  go.onclick = () => {
    const text = field.value.trim()
    if (!text) return
    go.textContent = 'Pairing…'
    void import('./pair').then(async ({ pairByLink }) => {
      const outcome = await pairByLink(text)
      if (outcome.status === 'paired') location.reload()
      else if (outcome.status === 'failed') askToPair(outcome.message)
    })
  }
  main.append(field, go)
}

/** Web push: shown as a small button until the user allows notifications (browsers need a tap). */
async function offerNotifications(connection: RelayConnection): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  const registration = await navigator.serviceWorker.register('/sw.js')
  const subscribe = async (): Promise<void> => {
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(connection.device.vapid) }))
    await connection.send({ t: 'push', sub: subscription.toJSON() })
  }
  if (Notification.permission === 'granted') {
    await subscribe().catch(() => undefined)
    return
  }
  if (Notification.permission === 'denied') return
  const button = document.createElement('button')
  button.textContent = 'Turn on notifications'
  button.style.cssText =
    'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:60;padding:10px 18px;border-radius:999px;border:0;background:#c96442;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25)'
  button.onclick = async () => {
    if ((await Notification.requestPermission()) === 'granted') await subscribe().catch(() => undefined)
    button.remove()
  }
  document.body.append(button)
}

async function start(): Promise<void> {
  let pairedNow = false
  if (new URLSearchParams(location.hash.slice(1)).get('pair')) {
    const pairing = pairingFromText(location.hash)
    history.replaceState(null, '', location.pathname)
    if (!pairing.ok) {
      askToPair('That link has expired. Make a new code in Deskmates on your PC (Settings → Phone → Add a phone) and scan it.')
      return
    }
    await saveDevice(pairing.device)
    pairedNow = true
  }
  const device = await restoreDevice()
  if (!device) {
    askToPair('Scan the code in Deskmates on your PC: Settings → Phone → Add a phone.')
    return
  }
  void keepDataForGood()
  const connection = new RelayConnection(device)
  await connection.send({ t: 'hello', name: deviceName() })
  if (pairedNow) localStorage.setItem('deskmates:tab', 'duo')

  const none = (): Promise<null> => Promise.resolve(null)
  window.deskmates = {
    platform: 'other',
    getCoreConnection: () => Promise.resolve({ port: 0, token: '' }),
    onCoreRestarted: () => () => undefined,
    openSocket: () => new RelaySocket(connection) as unknown as WebSocket,
    secrets: { status: () => Promise.resolve([]), set: () => Promise.resolve([]) },
    pickFolder: none,
    pathForFile: () => '',
    openPath: () => Promise.resolve(),
    autoStart: { get: () => Promise.resolve(false), set: () => Promise.resolve(false) },
    appearance: { pickImage: none, pickFont: none, pickAnimation: none, setWindowIcon: () => Promise.resolve(), setTheme: () => Promise.resolve() },
    design: { export: none, exportVideo: none, cancelVideo: () => Promise.resolve(), onVideoProgress: () => () => undefined, systemFonts: () => Promise.resolve([]) },
    engine: { installWsl: () => Promise.resolve({ outcome: 'error', message: 'Setting up the bot engine only works in the desktop app.' }) }
  } as unknown as typeof window.deskmates
  await import('../main')
  void offerNotifications(connection).catch(() => undefined)
}

void start()
