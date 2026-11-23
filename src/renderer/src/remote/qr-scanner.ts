/**
 * A full-screen camera view that reads a QR code, for pairing from inside the home-screen app
 * (whose storage is separate from Safari's, so opening the link in Safari never reaches it).
 * Plain DOM, so both the notes app and the Deskmates start screen can use it.
 */

export interface ScanOptions {
  /** Called with each code read; return true to accept it and close, or a message to show and keep scanning. */
  accept: (text: string) => true | string
  title?: string
  hint?: string
}

export type ScanOutcome = { status: 'scanned' } | { status: 'cancelled' } | { status: 'no-camera'; message: string }

const SCAN_EVERY_MS = 120
/** Codes are read from a frame scaled down to this width: plenty for a code on a monitor, and fast. */
const SCAN_WIDTH = 640

function cameraMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Deskmates isn’t allowed to use the camera. Allow it in Settings → Safari → Camera (or in the site’s settings), then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  return 'The camera couldn’t be started. Close other apps that use it and try again.'
}

export async function scanQrCode(options: ScanOptions): Promise<ScanOutcome> {
  if (!navigator.mediaDevices?.getUserMedia) return { status: 'no-camera', message: 'This browser can’t use the camera.' }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
  } catch (error) {
    return { status: 'no-camera', message: cameraMessage(error) }
  }
  const { default: jsQR } = await import('jsqr')

  return new Promise<ScanOutcome>((resolve) => {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', options.title ?? 'Scan the code')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:1000;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;touch-action:none'

    const video = document.createElement('video')
    video.setAttribute('playsinline', '')
    video.muted = true
    video.autoplay = true
    video.srcObject = stream
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'

    const frame = document.createElement('div')
    frame.style.cssText =
      'position:relative;width:min(64vw,64vh,340px);aspect-ratio:1;border-radius:28px;box-shadow:0 0 0 100vmax rgba(0,0,0,.55);border:2px solid rgba(255,255,255,.85);transition:transform .25s cubic-bezier(.2,.9,.3,1.3),border-color .2s'

    const text = document.createElement('div')
    text.style.cssText = 'position:relative;margin-top:28px;max-width:340px;padding:0 24px;text-align:center'
    const title = document.createElement('div')
    title.textContent = options.title ?? 'Scan the code'
    title.style.cssText = 'font-size:20px;font-weight:600;margin-bottom:6px'
    const hint = document.createElement('div')
    hint.textContent = options.hint ?? ''
    hint.style.cssText = 'font-size:14px;line-height:1.45;opacity:.8;min-height:40px'
    text.append(title, hint)

    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Cancel'
    close.style.cssText =
      'position:absolute;top:calc(16px + env(safe-area-inset-top));right:16px;padding:10px 18px;border-radius:999px;border:0;background:rgba(255,255,255,.18);color:#fff;font:600 15px system-ui,sans-serif;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)'

    overlay.append(video, frame, text, close)
    document.body.append(overlay)

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    let timer = 0
    let done = false
    let lastRejected = ''

    const finish = (outcome: ScanOutcome): void => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      for (const track of stream.getTracks()) track.stop()
      overlay.remove()
      resolve(outcome)
    }
    close.onclick = () => finish({ status: 'cancelled' })

    const tick = (): void => {
      if (done) return
      if (context && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, SCAN_WIDTH / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
        if (code?.data && code.data !== lastRejected) {
          const verdict = options.accept(code.data)
          if (verdict === true) {
            frame.style.borderColor = '#5fcf8a'
            frame.style.transform = 'scale(.94)'
            navigator.vibrate?.(30)
            window.setTimeout(() => finish({ status: 'scanned' }), 220)
            return
          }
          lastRejected = code.data
          hint.textContent = verdict
        }
      }
      timer = window.setTimeout(tick, SCAN_EVERY_MS)
    }
    void video.play().catch(() => undefined)
    tick()
  })
}
