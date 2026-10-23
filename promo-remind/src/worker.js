/*
  Remind Promo - backend Cloudflare Worker
  - Data promo (judul, tanggal, deskripsi) : KV key "promos"
  - Gambar                                 : KV key "img:<id>" (dilayani di /img/<id>)
  - Login admin                            : token bertanda tangan (HMAC), berlaku 12 jam
*/

const ADMIN_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin123';          // dipakai sampai password diubah / ADMIN_PASSWORD diset
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;      // 5 MB per gambar
const MAX_PROMOS = 300;

const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        try {
            if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
            if (url.pathname.startsWith('/img/')) return await handleImage(env, url);
            return env.ASSETS.fetch(request);
        } catch (err) {
            console.error('Worker error:', err && err.stack || err);
            return json({ error: 'Terjadi kesalahan di server.' }, 500);
        }
    }
};

/* ---------- helpers umum ---------- */

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}
function b64u(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function safeEqual(a, b) {
    const [ha, hb] = await Promise.all([a, b].map(async s =>
        new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))))));
    let diff = 0;
    for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
    return diff === 0;
}

/* ---------- password & sesi ---------- */

async function pbkdf2(password, salt) {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
    return new Uint8Array(bits);
}

async function checkPassword(env, password) {
    const record = await env.PROMOS.get('admin_password');   // "saltHex:hashHex"
    if (record) {
        const [saltHex, hashHex] = record.split(':');
        const hash = await pbkdf2(password, hexToBytes(saltHex));
        return safeEqual(bytesToHex(hash), hashHex);
    }
    return safeEqual(password, env.ADMIN_PASSWORD || DEFAULT_PASSWORD);
}

async function savePassword(env, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(password, salt);
    await env.PROMOS.put('admin_password', bytesToHex(salt) + ':' + bytesToHex(hash));
    // ganti kunci sesi -> semua sesi lama otomatis keluar
    await env.PROMOS.put('session_secret', bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
}

async function getSessionSecret(env) {
    let secret = await env.PROMOS.get('session_secret');
    if (!secret) {
        secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
        await env.PROMOS.put('session_secret', secret);
    }
    return secret;
}

async function hmacKey(secret, usages) {
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

async function signToken(env) {
    const payload = b64u(enc.encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })));
    const key = await hmacKey(await getSessionSecret(env), ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
    return payload + '.' + b64u(sig);
}

async function isAdmin(request, env) {
    try {
        const header = request.headers.get('Authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const [payload, sig] = token.split('.');
        if (!payload || !sig) return false;
        const key = await hmacKey(await getSessionSecret(env), ['verify']);
        const ok = await crypto.subtle.verify('HMAC', key, fromB64u(sig), enc.encode(payload));
        if (!ok) return false;
        const { exp } = JSON.parse(dec.decode(fromB64u(payload)));
        return typeof exp === 'number' && exp > Date.now();
    } catch (e) {
        return false;
    }
}

/* ---------- gambar ---------- */

function parseDataUrl(str) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(str);
    if (!m) return null;
    const bin = atob(m[2].replace(/\s/g, ''));
    if (bin.length > MAX_IMAGE_BYTES) return { tooBig: true };
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { type: m[1].toLowerCase(), bytes };
}

async function storeImage(env, id, dataUrl) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { error: 'Format gambar tidak didukung (pakai JPG, PNG, WEBP atau GIF).' };
    if (parsed.tooBig) return { error: 'Gambar terlalu besar (maksimal 5 MB).' };
    await env.PROMOS.put('img:' + id, parsed.bytes, { metadata: { type: parsed.type } });
    return { url: '/img/' + id };
}

async function handleImage(env, url) {
    const id = decodeURIComponent(url.pathname.slice('/img/'.length)).replace(/[^\w-]/g, '');
    if (!id) return new Response('Not found', { status: 404 });
    const { value, metadata } = await env.PROMOS.getWithMetadata('img:' + id, 'arrayBuffer');
    if (!value) return new Response('Not found', { status: 404 });
    return new Response(value, {
        headers: {
            'Content-Type': (metadata && metadata.type) || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}

/* ---------- data promo ---------- */

async function loadPromos(env, request) {
    const existing = await env.PROMOS.get('promos', 'json');
    if (Array.isArray(existing)) return existing;

    // Pertama kali jalan: impor promo lama dari public/promos.json (jika ada)
    const list = [];
    try {
        const res = await env.ASSETS.fetch(new Request(new URL('/promos.json', request.url)));
        if (res.ok) {
            const raw = await res.json();
            const arr = Array.isArray(raw) ? raw : (raw && raw.promos) || [];
            for (const p of arr) {
                const promo = cleanPromo(p);
                if (!promo) continue;
                const img = String(p.imageUrl || '');
                if (img.startsWith('data:')) {
                    const stored = await storeImage(env, promo.id, img);
                    if (stored.error) continue;
                    promo.imageUrl = stored.url;
                } else if (/^https?:\/\//i.test(img)) {
                    promo.imageUrl = img;
                } else {
                    continue;
                }
                list.push(promo);
            }
        }
    } catch (e) {
        console.error('Impor promos.json gagal:', e);
    }
    await env.PROMOS.put('promos', JSON.stringify(list));
    return list;
}

function validDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function cleanPromo(p) {
    if (!p || typeof p !== 'object') return null;
    const id = String(p.id || '').replace(/[^\w-]/g, '');
    const title = String(p.title || '').trim().slice(0, 200);
    const startDate = String(p.startDate || '');
    const endDate = String(p.endDate || '');
    if (!id || !title || !validDate(startDate) || !validDate(endDate) || startDate > endDate) return null;
    return {
        id, title, startDate, endDate,
        imageUrl: '',
        description: String(p.description || '').slice(0, 5000)
    };
}

/* ---------- routing API ---------- */

async function handleApi(request, env, url) {
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    if (path === '/api/promos' && method === 'GET') {
        return json({ promos: await loadPromos(env, request) });
    }

    if (path === '/api/login' && method === 'POST') {
        const body = await readJson(request);
        const okUser = await safeEqual(String(body.username || '').trim().toLowerCase(), ADMIN_USERNAME);
        const okPass = await checkPassword(env, String(body.password || ''));
        if (!(okUser && okPass)) {
            await sleep(700);
            return json({ error: 'Username atau password salah.' }, 401);
        }
        return json({ token: await signToken(env) });
    }

    // Semua di bawah ini khusus admin
    if (!(await isAdmin(request, env))) {
        return json({ error: 'Sesi login berakhir. Silakan login ulang.' }, 401);
    }

    if (path === '/api/promos' && method === 'POST') {
        const body = await readJson(request);
        const list = await loadPromos(env, request);
        if (list.length >= MAX_PROMOS) return json({ error: 'Jumlah promo sudah mencapai batas.' }, 400);

        const id = 'promo-' + Date.now() + '-' + bytesToHex(crypto.getRandomValues(new Uint8Array(2)));
        const promo = cleanPromo({ ...body, id });
        if (!promo) return json({ error: 'Data promo tidak valid (cek judul dan tanggal).' }, 400);

        const img = String(body.imageUrl || '');
        if (img.startsWith('data:')) {
            const stored = await storeImage(env, id, img);
            if (stored.error) return json({ error: stored.error }, 400);
            promo.imageUrl = stored.url;
        } else if (/^https?:\/\/\S{1,2000}$/i.test(img)) {
            promo.imageUrl = img;
        } else {
            return json({ error: 'Gambar tidak valid.' }, 400);
        }

        list.unshift(promo);
        await env.PROMOS.put('promos', JSON.stringify(list));
        return json({ promo }, 201);
    }

    const del = /^\/api\/promos\/([\w-]+)$/.exec(path);

    // Ubah judul, tanggal, dan deskripsi (gambar tidak berubah)
    if (del && method === 'PUT') {
        const id = del[1];
        const body = await readJson(request);
        const list = await loadPromos(env, request);
        const idx = list.findIndex(p => p.id === id);
        if (idx < 0) return json({ error: 'Promo tidak ditemukan.' }, 404);

        const updated = cleanPromo({ ...body, id });
        if (!updated) return json({ error: 'Data promo tidak valid (cek judul dan tanggal).' }, 400);

        updated.imageUrl = list[idx].imageUrl;
        list[idx] = updated;
        await env.PROMOS.put('promos', JSON.stringify(list));
        return json({ promo: updated });
    }

    if (del && method === 'DELETE') {
        const id = del[1];
        const list = await loadPromos(env, request);
        const target = list.find(p => p.id === id);
        if (!target) return json({ error: 'Promo tidak ditemukan.' }, 404);
        await env.PROMOS.put('promos', JSON.stringify(list.filter(p => p.id !== id)));
        if (String(target.imageUrl).startsWith('/img/')) await env.PROMOS.delete('img:' + id);
        return json({ ok: true });
    }

    if (path === '/api/password' && method === 'POST') {
        const body = await readJson(request);
        const oldPassword = String(body.oldPassword || '');
        const newPassword = String(body.newPassword || '');
        if (!(await checkPassword(env, oldPassword))) return json({ error: 'Password saat ini salah.' }, 400);
        if (newPassword.length < 6) return json({ error: 'Password baru minimal 6 karakter.' }, 400);
        if (newPassword === oldPassword) return json({ error: 'Password baru harus berbeda dari password saat ini.' }, 400);
        await savePassword(env, newPassword);
        return json({ ok: true, token: await signToken(env) });
    }

    return json({ error: 'Tidak ditemukan.' }, 404);
}

async function readJson(request) {
    try {
        const data = await request.json();
        return data && typeof data === 'object' ? data : {};
    } catch (e) {
        return {};
    }
}
