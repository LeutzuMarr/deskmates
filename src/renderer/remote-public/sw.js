// Shows the short notifications the PC pushes (the brief is ready, something needs approval) and
// opens the app when one is tapped. It caches nothing: the app always comes fresh from the server.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
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
