// Minimal service worker — satisfies Chrome PWA installability (standalone
// display, no address bar on Android) without requiring offline complexity.
// Strategy: network-first with runtime caching. Assets are cached as they
// are fetched; stale caches from old versions are purged on activate.

const CACHE = 'palimpsest-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
)

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const copy = r.clone()
          caches.open(CACHE).then(c => c.put(e.request, copy))
        }
        return r
      })
      .catch(() => caches.match(e.request))
  )
})
