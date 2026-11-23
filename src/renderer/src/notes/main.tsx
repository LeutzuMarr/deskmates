/**
 * The notes app: its own page and bundle, so opening it loads only what writing needs. It works
 * with no internet at all; the service worker keeps every file it uses on the device.
 */
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/newsreader/opsz.css'
import './notes.css'
import { keepDataForGood, restoreDevice } from '../remote/device'
import { NotesApp } from './App'

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register('/sw.js')
  } catch {
    // No worker (an old browser, or a private window): the app still runs, just not offline.
  }
}

void registerServiceWorker()
void keepDataForGood()

const root = createRoot(document.getElementById('root')!)
void restoreDevice()
  .catch(() => null)
  .then((device) => root.render(<NotesApp initialDevice={device} />))
