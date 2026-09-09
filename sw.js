// sw.js — cache the app shell for offline use only.
// API calls (api.rescued.art) and uploads (POST) always hit the network and are
// never intercepted.
const CACHE = 'rescued-studio-v5';
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
  // Only the app's own GET requests are served from cache; everything else
  // (POST uploads, cross-origin API) falls through to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then(res => res || fetch(req).catch(() => caches.match('./index.html')))
  );
});
