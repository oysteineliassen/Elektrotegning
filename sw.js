const CACHE = 'elektrotegning-v16';
const FILES = ['./', './index.html', './app.js', './dxf.js', './eq.js', './pdfexport.js', './sync.js', './manifest.webmanifest',
  './vendor/pdf.min.js', './vendor/pdf.worker.min.js', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Nett først (alltid nyeste versjon), hurtigbuffer hvis nettet er tregt eller borte
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    const slow = new Promise(res => setTimeout(res, 2500, null));
    try {
      const r = await Promise.race([net, slow]);
      if (r) return r;
    } catch (err) { }
    const hit = await c.match(e.request, { ignoreSearch: true });
    return hit || net;
  })());
});
