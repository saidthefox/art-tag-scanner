// sw.js — cache our app shell for offline. Note: OCR CDN will be fetched on demand.
const CACHE = 'arttag-cache-v1';
const ASSETS = ['./','./index.html','./app.js','./manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  e.respondWith(
    caches.match(req).then(res => res || fetch(req).catch(() => caches.match('./index.html')))
  );
});
