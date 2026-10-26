const C = 'ht-v16';
const SHELL = ['/', '/app.js', '/summary.js', '/rosterimport.js', '/style.css', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// Cache-first so the app opens instantly and never waits on a weak rink signal;
// a background fetch refreshes the cache and the new version loads on the next launch.
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/mcp') return;
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(caches.open(C).then(async (c) => {
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(key, r.clone()); return r; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});
