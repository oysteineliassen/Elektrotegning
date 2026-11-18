const CACHE = 'elektrotegning-v25';
const FILES = ['./', './index.html', './app.js', './dxf.js', './eq.js', './pdfexport.js', './sync.js', './lists.js', './photos.js', './joists.js', './manifest.webmanifest',
  './vendor/pdf.min.js', './vendor/pdf.worker.min.js', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Nett først (alltid nyeste versjon), hurtigbuffer hvis nettet er tregt eller borte
self.addEventListener('fetch', e => {
  // filer delt til appen fra e-post / Filer (Android «Del»)
  if (e.request.method === 'POST' && new URL(e.request.url).pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const files = fd.getAll('file').filter(f => f && f.size);
      const c = await caches.open('shared-files');
      let i = 0;
      for (const f of files) await c.put('./shared/' + (i++), new Response(f, { headers: { 'X-Name': encodeURIComponent(f.name || 'fil'), 'Content-Type': f.type || 'application/octet-stream' } }));
      return Response.redirect('./?shared=' + files.length, 303);
    })());
    return;
  }
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
