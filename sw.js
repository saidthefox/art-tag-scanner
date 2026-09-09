// sw.js — cache the app shell for offline use only.
// API calls (api.rescued.art) and uploads (POST) always hit the network and are
// never intercepted.
const CACHE = 'rescued-studio-v6';
const ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const scopePath = new URL(self.registration.scope).pathname;
  // Only the app's own GET requests are served from cache; everything else
  // (POST uploads and API calls) falls through to the network. The pathname
  // check matters when Studio is hosted at api.rescued.art/studio/: its API is
  // same-origin but deliberately outside this service worker's scope.
  if (req.method !== 'GET' || url.origin !== self.location.origin ||
      !url.pathname.startsWith(scopePath)) return;
  e.respondWith(
    caches.match(req).then(res => res || fetch(req).catch(() => caches.match('./index.html')))
  );
});
