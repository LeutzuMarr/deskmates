// Deskmates' service worker.
// - Keeps every file the notes app uses on the device, so notes open with no internet at all. The
//   build fills in the list (PRECACHE) and a version; a new version is fetched in the background and
//   the previous one is kept, so a page that's open keeps working while the update lands.
// - The rest of Deskmates (the chat, Duo…) always comes fresh from the server; with no internet,
//   opening it shows the notes instead.
// - Shows the short notifications the PC pushes, and opens the app when one is tapped.
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const PREFIX = 'deskmates-notes-'
const CACHE = PREFIX + VERSION
const NOTES_PAGE = '/notes'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // 'reload' skips the HTTP cache, so the files kept are the ones this version lists.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep this version and the one before it (oldest first, as caches.keys() lists them).
      const older = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE)
      await Promise.all(older.slice(0, -1).map((name) => caches.delete(name)))
      await self.clients.claim()
    })()
  )
})

// Some servers answer with "Vary: Origin", and module scripts are fetched with an Origin header the
// precache requests didn't have; the files are the same either way.
const MATCH = { ignoreVary: true }

async function notesPage() {
  const current = await caches.open(CACHE)
  return (await current.match(NOTES_PAGE, MATCH)) || (await caches.match(NOTES_PAGE, MATCH))
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    if (url.pathname === NOTES_PAGE || url.pathname === '/notes.html') {
      event.respondWith(notesPage().then((cached) => cached || fetch(request)))
    } else {
      // Deskmates itself needs the server; with no internet, the notes still open.
      event.respondWith(fetch(request).catch(() => notesPage().then((cached) => cached || Response.error())))
    }
    return
  }
  event.respondWith(caches.match(request, MATCH).then((cached) => cached || fetch(request)))
})

self.addEventListener('push', (event) => {
  let data = { title: 'Deskmates', body: '' }
  try {
    data = { ...data, ...event.data.json() }
  } catch {}
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon-192.png', badge: '/icon-192.png' }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) if ('focus' in client) return client.focus()
      return self.clients.openWindow('/')
    })
  )
})
