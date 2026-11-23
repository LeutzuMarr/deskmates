/**
 * Pairing from inside the app: scan the QR code Deskmates shows on the PC (Settings → Phone → Add a
 * phone), say hello to the PC over the relay so it adds this device, and keep the pairing for good.
 */
import { deviceName, pairingFromText, saveDevice } from './device'
import type { RemoteDevice } from './relay'
import { scanQrCode } from './qr-scanner'

const WELCOME_TIMEOUT_MS = 15_000

export type PairOutcome =
  | { status: 'paired'; device: RemoteDevice }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

/** Sends hello and waits for the PC's welcome, which means the PC has added this device. */
export async function confirmPairing(device: RemoteDevice, timeoutMs = WELCOME_TIMEOUT_MS): Promise<boolean> {
  const { RelayConnection } = await import('./relay')
  const connection = new RelayConnection(device)
  try {
    const welcomed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      connection.on((payload) => {
        if (payload.t !== 'welcome') return
        clearTimeout(timer)
        resolve(true)
      })
    })
    await connection.send({ t: 'hello', name: deviceName() })
    return await welcomed
  } finally {
    connection.close()
  }
}

/** Pairs from the "Add a phone" link pasted in (when the camera can't read the code). */
export async function pairByLink(text: string): Promise<PairOutcome> {
  if (!navigator.onLine) return { status: 'failed', message: 'Connect to the internet to pair. After that, notes work without it.' }
  const result = pairingFromText(text)
  if (!result.ok)
    return {
      status: 'failed',
      message: result.reason === 'expired' ? 'That link has expired. Make a new one on your PC (Settings → Phone → Add a phone).' : 'That isn’t a Deskmates pairing link. Copy it from Settings → Phone → Add a phone on your PC.'
    }
  const welcomed = await confirmPairing(result.device).catch(() => false)
  if (!welcomed) return { status: 'failed', message: 'Deskmates on your PC didn’t answer. Keep it open on the Add a phone screen and try again.' }
  await saveDevice(result.device)
  return { status: 'paired', device: result.device }
}

export async function pairByScanning(): Promise<PairOutcome> {
  if (!navigator.onLine) return { status: 'failed', message: 'Connect to the internet to pair. After that, notes work without it.' }
  let found: RemoteDevice | null = null
  const scan = await scanQrCode({
    title: 'Scan the code on your PC',
    hint: 'In Deskmates on your PC: Settings → Phone → Add a phone.',
    accept: (text) => {
      const result = pairingFromText(text)
      if (result.ok) {
        found = result.device
        return true
      }
      return result.reason === 'expired'
        ? 'That code has expired. Make a new one on your PC and scan it again.'
        : 'That isn’t a Deskmates code. Scan the one under Settings → Phone → Add a phone.'
    }
  })
  if (scan.status === 'cancelled') return { status: 'cancelled' }
  if (scan.status === 'no-camera') return { status: 'failed', message: scan.message }
  const device = found as RemoteDevice | null
  if (!device) return { status: 'cancelled' }
  const welcomed = await confirmPairing(device).catch(() => false)
  if (!welcomed)
    return { status: 'failed', message: 'Deskmates on your PC didn’t answer. Keep it open on the Add a phone screen and scan the code again.' }
  await saveDevice(device)
  return { status: 'paired', device }
}
