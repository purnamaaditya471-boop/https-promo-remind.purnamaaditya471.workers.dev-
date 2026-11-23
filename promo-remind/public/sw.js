/* Remind Promo - service worker: aplikasi bisa dipasang & tetap terbuka saat sinyal buruk */
const VER = 'promo-remind-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== VER).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

async function put(req, res) {
    if (res && res.ok) { const c = await caches.open(VER); await c.put(req, res.clone()); }
    return res;
}
async function networkFirst(req) {
    try { return await put(req, await fetch(req)); }
    catch (e) {
        const hit = await caches.match(req, { ignoreSearch: false });
        if (hit) return hit;
        if (req.mode === 'navigate') { const home = await caches.match('/'); if (home) return home; }
        throw e;
    }
}
async function cacheFirst(req) {
    const hit = await caches.match(req);
    if (hit) return hit;
    return put(req, await fetch(req));
}
async function staleWhileRevalidate(req) {
    const hit = await caches.match(req);
    const fresh = fetch(req).then(res => put(req, res)).catch(() => hit);
    return hit || fresh;
}

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;
    const p = url.pathname;
    if (p === '/sw.js') return;
    if (p === '/api/promos') { e.respondWith(networkFirst(req)); return; }   // daftar promo: data terbaru, cadangan saat offline
    if (p.startsWith('/api/')) return;                                          // login, simpan, dll: tidak pernah di-cache
    if (p.startsWith('/img/')) { e.respondWith(cacheFirst(req)); return; }     // gambar tidak berubah (id unik)
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
    e.respondWith(staleWhileRevalidate(req));
});
