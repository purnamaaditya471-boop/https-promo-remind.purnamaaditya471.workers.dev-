const ADMIN_ACCOUNT = { name: 'Admin Promo' };
const API_BASE = '/api';                 // backend Cloudflare Worker
const TOKEN_KEY = 'admin_token';         // token login (hilang saat tab ditutup)

let promoList = [];
let filteredPromos = [];
let currentSlideIndex = 0;
let deleteTargetId = null;
let editingId = null;
let isLoadingPromos = true;
let listPromos = [];          // isi daftar (kategori + periode + pencarian + filter status)
let previewId = null;         // promo berakhir yang sedang dipratinjau di POP
const selectedIds = new Set(); // baris yang dicentang (pilih banyak)
let filterTimer = null;

/* ===== Menu kategori: '' = Utama (Beranda), lainnya hanya tampil saat menunya dibuka ===== */
const CATEGORY_MENU = [
    { key: '',            label: 'Utama',                 short: 'Beranda', icon: 'i-c-house' },
    { key: 'hobbies',     label: 'Hobbies and Lifestyle', short: 'Hobbies', icon: 'i-c-star' },
    { key: 'living',      label: 'Home Living',           short: 'Living',  icon: 'i-c-sofa' },
    { key: 'improvement', label: 'Home Improvement',      short: 'Improve', icon: 'i-c-wrench' }
];
let activeCategory = '';

/* Alamat: #hobbies  atau  #hobbies/promo-123  atau  #/promo-123 (link langsung ke satu promo) */
function parseHash() {
    const parts = (location.hash || '').replace('#', '').split('/');
    const cat = CATEGORY_MENU.some(c => c.key && c.key === parts[0]) ? parts[0] : '';
    const id = String(parts[1] || '').replace(/[^\w-]/g, '');
    return { cat, id };
}

function categoryFromHash() {
    return parseHash().cat;
}

function renderCategoryMenu() {
    const nav = document.getElementById('catNav');
    const tabs = document.getElementById('catTabs');
    document.body.dataset.cat = activeCategory;
    const make = (c, short) => `<button type="button" class="${c.key === activeCategory ? 'active' : ''}" onclick="window.setCategory('${c.key}')" aria-current="${c.key === activeCategory}">`
        + (short
            ? `<span class="pill"><svg class="icon" aria-hidden="true"><use href="#${c.icon}"/></svg></span>${c.short}`
            : `<svg class="icon" aria-hidden="true"><use href="#${c.icon}"/></svg>${c.label}`)
        + `</button>`;
    if (nav) nav.innerHTML = CATEGORY_MENU.map(c => make(c, true)).join('');
    if (tabs) tabs.innerHTML = CATEGORY_MENU.map(c => make(c, false)).join('');
}

window.setCategory = function (key) {
    if (key === activeCategory) return;
    activeCategory = key;
    // simpan di alamat (#hobbies dst) supaya tombol Kembali & bagikan-link berfungsi
    if (key) history.pushState(null, '', '#' + key);
    else history.pushState(null, '', location.pathname + location.search);
    currentSlideIndex = 0;
    renderCategoryMenu();
    updateDashboard();
    window.scrollTo({ top: 0 });
};

window.addEventListener('hashchange', () => {
    const { cat: k, id } = parseHash();
    if (id) { openPromoById(id); return; }
    if (k === activeCategory) return;
    activeCategory = k;
    currentSlideIndex = 0;
    renderCategoryMenu();
    updateDashboard();
});
window.addEventListener('popstate', () => window.dispatchEvent(new Event('hashchange')));

function isAdminLoggedIn() {
    return !!getToken();
}

document.addEventListener('DOMContentLoaded', async () => {
    // Tampilkan kerangka halaman lebih dulu, data promo menyusul dari server
    activeCategory = categoryFromHash();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    renderCategoryMenu();
    populateDropdowns();
    setupDateInputs();
    setupTouchSwipe();
    setupSlideButtons();
    checkAuthStatus();
    renderCarousel();

    await loadPromoData();
    isLoadingPromos = false;

    checkAuthStatus();
    updateDashboard();
    const deep = parseHash();
    if (deep.id) openPromoById(deep.id);
});

function setupDateInputs() {
    document.querySelectorAll('input[type="date"]').forEach(input => {
        input.addEventListener('click', () => {
            if (typeof input.showPicker === 'function') {
                try { input.showPicker(); } catch (e) {}
            }
        });
    });
}

/* Swipe Gesture untuk layar HP */
/* Tombol slide: samar saat diam, jelas saat ditekan (mouse maupun sentuhan) */
function setupSlideButtons() {
    ['prevBtn', 'nextBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        let timer = null;

        const press = () => {
            clearTimeout(timer);
            btn.classList.add('is-pressed');
        };
        // Setelah dilepas, tombol tetap terlihat sebentar lalu memudar lagi
        const release = (delay) => {
            clearTimeout(timer);
            timer = setTimeout(() => btn.classList.remove('is-pressed'), delay);
        };

        btn.addEventListener('pointerdown', press);
        btn.addEventListener('pointerup', () => release(450));
        btn.addEventListener('pointercancel', () => release(0));
        btn.addEventListener('pointerleave', () => release(150));
        btn.addEventListener('blur', () => release(0));
    });
}

function setupTouchSwipe() {
    const slider = document.getElementById('promoDisplaySection');
    let startX = 0;
    let startY = 0;
    let tracking = false;

    if (!slider) return;

    slider.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { tracking = false; return; }
        startX = e.changedTouches[0].clientX;
        startY = e.changedTouches[0].clientY;
        tracking = true;
    }, { passive: true });

    // Jika browser mulai menggulir halaman (gerak vertikal), batalkan deteksi geser
    slider.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });

    slider.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        const dx = startX - e.changedTouches[0].clientX;
        const dy = startY - e.changedTouches[0].clientY;

        // Hanya geser yang dominan ke samping yang mengganti slide.
        // Gerakan naik/turun dibiarkan menjadi scroll halaman.
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            if (dx > 0) window.nextSlide();
            else window.prevSlide();
        }
    }, { passive: true });
}

const cloneData = (x) => JSON.parse(JSON.stringify(x));

function isSafeImageUrl(u) {
    return /^data:image\/[a-z0-9.+-]+;base64,/i.test(u)
        || /^https?:\/\//i.test(u)
        || /^[\w\-./%]+$/.test(u);
}

/* Validasi data promos.json / data lokal agar aman dipakai */
function sanitizePromos(arr) {
    if (!Array.isArray(arr)) return [];
    const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
    const seen = new Set();

    return arr
        .filter(p => p && typeof p === 'object')
        .map(p => ({
            id: String(p.id || '').replace(/[^\w-]/g, ''),
            title: String(p.title || '').trim(),
            startDate: String(p.startDate || ''),
            endDate: String(p.endDate || ''),
            imageUrl: String(p.imageUrl || ''),
            description: String(p.description || ''),
            claimEndDate: dateOk(String(p.claimEndDate || '')) ? String(p.claimEndDate) : '',
            category: ['hobbies', 'living', 'improvement'].includes(p.category) ? p.category : ''
        }))
        .filter(p => p.title && dateOk(p.startDate) && dateOk(p.endDate) && isSafeImageUrl(p.imageUrl))
        .map(p => {
            if (!p.id || seen.has(p.id)) p.id = 'promo-' + Date.now() + '-' + seen.size;
            seen.add(p.id);
            return p;
        });
}

/* ===== Komunikasi dengan server (Cloudflare Worker) ===== */
function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function setToken(token) {
    try {
        if (token) sessionStorage.setItem(TOKEN_KEY, token);
        else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* abaikan */ }
}

async function apiFetch(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
        res = await fetch(API_BASE + path, Object.assign({}, options, { headers, cache: 'no-store' }));
    } catch (netErr) {
        const err = new Error('Tidak bisa terhubung ke server. Periksa koneksi internet.');
        err.status = 0;
        throw err;
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* bukan JSON */ }

    if (!res.ok) {
        // Sesi habis (bukan salah password saat login)
        if (res.status === 401 && token && path !== '/login') {
            setToken('');
            checkAuthStatus();
            window.showToast('Sesi login berakhir. Silakan login ulang.');
        }
        const err = new Error((data && data.error) || ('Permintaan gagal (' + res.status + ')'));
        err.status = res.status;
        throw err;
    }
    return data;
}

async function fetchPromos() {
    const data = await apiFetch('/promos');
    return sanitizePromos(data && data.promos);
}

async function loadPromoData() {
    try {
        promoList = await fetchPromos();
    } catch (err) {
        console.error(err);
        promoList = [];
        window.showToast(err.message);
    }
}

/* Ambil ulang daftar promo terbaru dari server */
async function reloadPromos() {
    try {
        promoList = await fetchPromos();
    } catch (err) {
        console.error(err);
    }
    currentSlideIndex = 0;
    updateDashboard();
}

function refreshDataSource() {
    currentSlideIndex = 0;
    updateDashboard();
}

function checkAuthStatus() {
    const isLogged = isAdminLoggedIn();
    document.body.classList.toggle('is-admin', isLogged);
    if (!isLogged) selectedIds.clear();
    const loginBtnNav = document.getElementById('loginBtnNav');
    const userInfoNav = document.getElementById('userInfoNav');
    const usernameDisplay = document.getElementById('usernameDisplay');

    if (isLogged) {
        if (loginBtnNav) loginBtnNav.classList.add('hidden');
        if (userInfoNav) userInfoNav.classList.remove('hidden');
        if (usernameDisplay) usernameDisplay.textContent = ADMIN_ACCOUNT.name;
    } else {
        if (loginBtnNav) loginBtnNav.classList.remove('hidden');
        if (userInfoNav) userInfoNav.classList.add('hidden');
    }

    renderTable();
}

window.toggleLoginModal = function (show) {
    const modal = document.getElementById('loginModal');
    if (!modal) return;
    if (show) {
        modal.classList.remove('opacity-0', 'pointer-events-none');
        modal.classList.add('opacity-100', 'pointer-events-auto');
    } else {
        modal.classList.add('opacity-0', 'pointer-events-none');
        modal.classList.remove('opacity-100', 'pointer-events-auto');
    }
};

window.handleLoginSubmit = async function (event) {
    event.preventDefault();
    const userInput = document.getElementById('loginUsername').value.trim();
    const passInput = document.getElementById('loginPassword').value.trim();

    try {
        const data = await apiFetch('/login', {
            method: 'POST',
            body: JSON.stringify({ username: userInput, password: passInput })
        });
        setToken(data.token);
        window.toggleLoginModal(false);
        await reloadPromos();
        checkAuthStatus();
        window.showToast(`Login berhasil sebagai ${ADMIN_ACCOUNT.name}`);

        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
    } catch (err) {
        alert(err.status === 401 ? 'Username atau password salah!' : err.message);
    }
};

window.toggleChangePasswordModal = function (show) {
    const modal = document.getElementById('passwordModal');
    if (!modal) return;

    if (show) {
        if (!isAdminLoggedIn()) {
            window.showToast('Login dulu untuk mengubah password.');
            window.toggleLoginModal(true);
            return;
        }
        modal.classList.remove('opacity-0', 'pointer-events-none');
        modal.classList.add('opacity-100', 'pointer-events-auto');
        setTimeout(() => {
            const first = document.getElementById('oldPassword');
            if (first) first.focus();
        }, 50);
    } else {
        modal.classList.add('opacity-0', 'pointer-events-none');
        modal.classList.remove('opacity-100', 'pointer-events-auto');
        ['oldPassword', 'newPassword', 'confirmPassword'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.value = ''; el.type = 'password'; }
        });
        const box = document.querySelector('#passwordModal input[type="checkbox"]');
        if (box) box.checked = false;
        showPasswordError('');
    }
};

window.togglePasswordVisibility = function (visible) {
    ['oldPassword', 'newPassword', 'confirmPassword'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.type = visible ? 'text' : 'password';
    });
};

function showPasswordError(message) {
    const el = document.getElementById('passwordError');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('hidden', !message);
}

window.handleChangePasswordSubmit = async function (event) {
    event.preventDefault();

    if (!isAdminLoggedIn()) {
        showPasswordError('Sesi login berakhir. Silakan login ulang.');
        return;
    }

    const oldPass = document.getElementById('oldPassword').value;
    const newPass = document.getElementById('newPassword').value;
    const confirmPass = document.getElementById('confirmPassword').value;

    if (newPass.length < 6) {
        showPasswordError('Password baru minimal 6 karakter.');
        return;
    }
    if (newPass !== confirmPass) {
        showPasswordError('Ulangi password baru tidak sama.');
        return;
    }
    if (newPass === oldPass) {
        showPasswordError('Password baru harus berbeda dari password saat ini.');
        return;
    }

    try {
        const data = await apiFetch('/password', {
            method: 'POST',
            body: JSON.stringify({ oldPassword: oldPass, newPassword: newPass })
        });
        if (data && data.token) setToken(data.token);
    } catch (err) {
        showPasswordError(err.message);
        return;
    }

    window.toggleChangePasswordModal(false);
    window.showToast('Password berhasil diubah.');
};

window.handleLogout = function () {
    setToken('');
    refreshDataSource();
    checkAuthStatus();
    window.showToast('Berhasil keluar dari akun Admin.');
};

window.handleUploadClick = function () {
    if (!isAdminLoggedIn()) {
        window.showToast('Login sebagai Admin untuk menambah promo.');
        window.toggleLoginModal(true);
    } else {
        editingId = null;
        setModalMode(false);
        window.toggleModal(true);
        const catSel = document.getElementById('inputCategory');
        if (catSel) catSel.value = activeCategory;   // default = menu yang sedang dibuka
    }
};

/* Mode kotak isian: tambah promo baru, atau edit promo yang sudah ada */
function setModalMode(editing) {
    const title = document.getElementById('modalTitleText');
    const submit = document.getElementById('modalSubmitBtn');
    const imageBlock = document.getElementById('imageFieldBlock');
    const note = document.getElementById('editImageNote');
    if (title) title.textContent = editing ? 'Edit Promo' : 'Unggah Promo Baru';
    if (submit) submit.textContent = editing ? 'Simpan Perubahan' : 'Simpan Promo';
    if (imageBlock) {
        const lbl = imageBlock.querySelector('label');
        if (lbl) lbl.textContent = editing ? 'Ganti Gambar Poster (opsional)' : 'Gambar Poster A4 *';
    }
    if (note) note.classList.toggle('hidden', !editing);

    // Saat edit, kolom gambar disembunyikan sehingga tidak boleh diwajibkan
    const fileInput = document.getElementById('inputFile');
    const urlInput = document.getElementById('inputUrl');
    if (editing) {
        if (fileInput) fileInput.required = false;
        if (urlInput) urlInput.required = false;
    }
}

window.askEditPromo = function (id) {
    if (!isAdminLoggedIn()) {
        window.showToast('Login sebagai Admin untuk mengedit promo.');
        window.toggleLoginModal(true);
        return;
    }
    const promo = promoList.find(p => p.id === id);
    if (!promo) return;

    editingId = id;
    setModalMode(true);
    document.getElementById('inputTitle').value = promo.title;
    document.getElementById('inputStartDate').value = promo.startDate;
    document.getElementById('inputEndDate').value = promo.endDate;
    document.getElementById('inputDescription').value = promo.description || '';
    const claimEl = document.getElementById('inputClaimEndDate');
    if (claimEl) claimEl.value = promo.claimEndDate || '';
    window.toggleModal(true);
    const catSelEdit = document.getElementById('inputCategory');
    if (catSelEdit) catSelEdit.value = promo.category || '';
};

window.toggleModal = function (show) {
    const modal = document.getElementById('uploadModal');
    const content = document.getElementById('modalContent');
    if (!modal) return;

    if (show) {
        modal.classList.remove('opacity-0', 'pointer-events-none');
        modal.classList.add('opacity-100', 'pointer-events-auto');
        if (content) content.classList.remove('scale-95');
        document.body.style.overflow = 'hidden';
        const scrollBody = document.getElementById('modalScrollBody');
        if (scrollBody) scrollBody.scrollTop = 0;
    } else {
        document.body.style.overflow = '';
        modal.classList.add('opacity-0', 'pointer-events-none');
        modal.classList.remove('opacity-100', 'pointer-events-auto');
        if (content) content.classList.add('scale-95');

        editingId = null;
        setModalMode(false);
        const form = document.getElementById('promoForm');
        if (form) form.reset();
        window.toggleImageType('file');
    }
};

window.toggleImageType = function (type) {
    const fileContainer = document.getElementById('fileInputContainer');
    const urlContainer = document.getElementById('urlInputContainer');
    const inputFile = document.getElementById('inputFile');
    const inputUrl = document.getElementById('inputUrl');

    if (type === 'file') {
        fileContainer.classList.remove('hidden');
        urlContainer.classList.add('hidden');
        if (inputFile) inputFile.required = true;
        if (inputUrl) inputUrl.required = false;
    } else {
        fileContainer.classList.add('hidden');
        urlContainer.classList.remove('hidden');
        if (inputFile) inputFile.required = false;
        if (inputUrl) inputUrl.required = true;
    }
    // Saat edit, mengganti gambar bersifat opsional
    if (editingId) {
        if (inputFile) inputFile.required = false;
        if (inputUrl) inputUrl.required = false;
    }
};

window.handleFormSubmit = async function (event) {
    event.preventDefault();

    if (!isAdminLoggedIn()) {
        alert('Hanya User Admin yang dapat menambahkan promo!');
        return;
    }

    const title = document.getElementById('inputTitle').value.trim();
    const startDate = document.getElementById('inputStartDate').value;
    const endDate = document.getElementById('inputEndDate').value;
    const description = document.getElementById('inputDescription').value.trim();
    const category = (document.getElementById('inputCategory') || { value: '' }).value;
    const imageSource = document.querySelector('input[name="imageSource"]:checked').value;

    const claimEndDate = (document.getElementById('inputClaimEndDate') || { value: '' }).value;

    if (new Date(startDate) > new Date(endDate)) {
        alert('Tanggal mulai tidak boleh melebihi tanggal berakhir!');
        return;
    }
    if (claimEndDate && new Date(claimEndDate) < new Date(endDate)) {
        alert('Tanggal voucher berlaku tidak boleh sebelum tanggal promo berakhir!');
        return;
    }

    // ----- Mode edit: kirim hanya judul, tanggal, dan deskripsi (gambar tidak berubah) -----
    if (editingId) {
        const id = editingId;
        const submitBtn = document.getElementById('modalSubmitBtn');
        const submitLabel = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Menyimpan...'; }
        try {
            // Gambar baru (opsional): kosongkan jika gambar tidak diganti
            let newImage = '';
            if (imageSource === 'file') {
                const f = document.getElementById('inputFile');
                if (f && f.files && f.files[0]) newImage = await readFileAsBase64(f.files[0]);
            } else {
                newImage = (document.getElementById('inputUrl').value || '').trim();
            }
            const autoA4Edit = document.getElementById('inputAutoA4');
            if (newImage && autoA4Edit && autoA4Edit.checked) {
                try { newImage = (await convertToA4(newImage, imageSource === 'url')).url; }
                catch (convErr) { console.warn('Konversi A4 gagal, memakai gambar asli:', convErr); }
            }
            const payload = { title, startDate, endDate, description, category, claimEndDate };
            if (newImage) payload.imageUrl = newImage;
            const saved = await apiFetch('/promos/' + encodeURIComponent(id), {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            const idx = promoList.findIndex(p => p.id === id);
            if (idx >= 0) promoList[idx] = saved.promo;
            if ((saved.promo.category || '') !== activeCategory) { activeCategory = saved.promo.category || ''; history.pushState(null, '', activeCategory ? '#' + activeCategory : location.pathname + location.search); renderCategoryMenu(); }
            updateDashboard();
            window.toggleModal(false);
            window.showToast('Perubahan promo disimpan.');
        } catch (saveErr) {
            alert('Gagal menyimpan perubahan: ' + saveErr.message);
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitLabel; }
        }
        return;
    }

    let imageUrl = '';

    try {
        if (imageSource === 'file') {
            const fileInput = document.getElementById('inputFile');
            if (fileInput.files && fileInput.files[0]) {
                imageUrl = await readFileAsBase64(fileInput.files[0]);
            }
        } else {
            imageUrl = document.getElementById('inputUrl').value.trim();
        }

        if (!imageUrl) {
            alert('Silakan pilih berkas gambar terlebih dahulu.');
            return;
        }

        let a4Status = 'off';
        const autoA4 = document.getElementById('inputAutoA4');
        if (autoA4 && autoA4.checked) {
            try {
                const result = await convertToA4(imageUrl, imageSource === 'url');
                imageUrl = result.url;
                a4Status = result.converted ? 'converted' : 'already';
            } catch (convErr) {
                console.warn('Konversi A4 gagal, memakai gambar asli:', convErr);
                a4Status = 'failed';
            }
        }

        const submitBtn = document.querySelector('#promoForm button[type="submit"]');
        const submitLabel = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Menyimpan...'; }

        let saved;
        try {
            saved = await apiFetch('/promos', {
                method: 'POST',
                body: JSON.stringify({ title, startDate, endDate, description, category, claimEndDate, imageUrl })
            });
        } catch (saveErr) {
            alert('Gagal menyimpan promo: ' + saveErr.message);
            return;
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitLabel; }
        }

        promoList.unshift(saved.promo);
        const sBox = document.getElementById('searchPromo'); if (sBox) sBox.value = '';
        const fBox = document.getElementById('filterStatus'); if (fBox) fBox.value = 'all';

        // pindah ke menu tempat promo baru disimpan
        const savedCat = (saved.promo && saved.promo.category) || '';
        if (savedCat !== activeCategory) {
            activeCategory = savedCat;
            history.pushState(null, '', savedCat ? '#' + savedCat : location.pathname + location.search);
            renderCategoryMenu();
        }
        const startObj = new Date(startDate);
        document.getElementById('selectYear').value = startObj.getFullYear();
        document.getElementById('selectMonth').value = startObj.getMonth();

        updateDashboard();
        window.toggleModal(false);
        const toastText = {
            converted: 'Promo ditambahkan. Gambar disesuaikan ke A4.',
            already: 'Promo ditambahkan. Gambar sudah berukuran A4.',
            failed: 'Promo ditambahkan, tapi gambar tidak bisa diubah ke A4 (dipakai ukuran asli).',
            off: 'Poster promo berhasil ditambahkan!'
        }[a4Status];
        window.showToast(toastText);

    } catch (err) {
        console.error(err);
        alert('Gagal memproses gambar. Pastikan ukuran berkas tidak terlalu besar.');
    }
};

/* ===== Ubah gambar ke ukuran A4 (tanpa memotong) ===== */
const A4_RATIO = 1.414;          // tinggi / lebar
const A4_OUT_W = 1050;           // piksel hasil
const A4_OUT_H = Math.round(A4_OUT_W * A4_RATIO);

function loadImageElement(src, useCors) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        if (useCors) img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Gambar gagal dimuat'));
        img.src = src;
    });
}

/* Warna rata-rata tepi gambar, dipakai untuk mengisi sisi kosong */
function getEdgeColor(img) {
    const size = 40;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
                const i = (y * size + x) * 4;
                r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
            }
        }
    }
    return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

async function convertToA4(src, isRemote) {
    const img = await loadImageElement(src, isRemote);
    const ratio = img.naturalHeight / img.naturalWidth;

    // Sudah A4 (toleransi 1,5%) -> pakai apa adanya
    if (Math.abs(ratio - A4_RATIO) / A4_RATIO < 0.015) {
        return { url: src, converted: false };
    }

    const canvas = document.createElement('canvas');
    canvas.width = A4_OUT_W;
    canvas.height = A4_OUT_H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = getEdgeColor(img);
    ctx.fillRect(0, 0, A4_OUT_W, A4_OUT_H);

    const scale = Math.min(A4_OUT_W / img.naturalWidth, A4_OUT_H / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (A4_OUT_W - w) / 2, (A4_OUT_H - h) / 2, w, h);

    return { url: canvas.toDataURL('image/jpeg', 0.88), converted: true };
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
}

function populateDropdowns() {
    const selectYear = document.getElementById('selectYear');
    const selectMonth = document.getElementById('selectMonth');
    if (!selectYear || !selectMonth) return;

    const currentYear = new Date().getFullYear();
    selectYear.innerHTML = '';
    for (let y = currentYear - 2; y <= currentYear + 2; y++) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        if (y === currentYear) opt.selected = true;
        selectYear.appendChild(opt);
    }

    const monthNames = [
        'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ];
    selectMonth.innerHTML = '';
    monthNames.forEach((month, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = month;
        if (idx === new Date().getMonth()) opt.selected = true;
        selectMonth.appendChild(opt);
    });
}

window.handleDropdownChange = function () {
    currentSlideIndex = 0;
    updateDashboard();
};

function isListFiltered() {
    const q = (document.getElementById('searchPromo') || { value: '' }).value.trim();
    const st = (document.getElementById('filterStatus') || { value: 'all' }).value;
    return !!q || st !== 'all';
}

window.handleListFilter = function () {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { currentSlideIndex = 0; updateDashboard(); }, 180);
};

/* Slide POP = promo aktif + masa klaim. Promo berakhir hanya muncul saat barisnya diklik (pratinjau). */
function computeSlides() {
    if (previewId) {
        const pv = listPromos.find(x => x.id === previewId);
        if (pv) { filteredPromos = [pv]; return; }
        previewId = null;
    }
    filteredPromos = listPromos.filter(p => promoPhase(p) !== 'ended');
}

function updateDashboard() {
    const selectedYear = parseInt(document.getElementById('selectYear').value);
    const selectedMonth = parseInt(document.getElementById('selectMonth').value);

    const cat = CATEGORY_MENU.find(c => c.key === activeCategory) || CATEGORY_MENU[0];
    const titleEl = document.getElementById('activeMonthTitle');
    if (titleEl) titleEl.textContent = activeCategory ? 'Promo ' + cat.label : 'Katalog Promo';

    const q = (document.getElementById('searchPromo') || { value: '' }).value.trim().toLowerCase();
    const st = (document.getElementById('filterStatus') || { value: 'all' }).value;
    const target = selectedYear * 12 + selectedMonth;

    const matched = promoList.filter(p => {
        // Promo utama hanya di Beranda; promo kategori hanya di menu kategorinya
        if ((p.category || '') !== activeCategory) return false;
        const start = parseLocalDate(p.startDate);
        const end = parseLocalDate(p.claimEndDate || p.endDate);   // masa klaim ikut memperpanjang tampil
        if (target < start.getFullYear() * 12 + start.getMonth()) return false;
        if (target > end.getFullYear() * 12 + end.getMonth()) return false;
        if (q && !((p.title + ' ' + (p.description || '')).toLowerCase().includes(q))) return false;
        if (st !== 'all') {
            const ph = promoPhase(p);
            if (st === 'soon') { if (!isSoonEnding(p)) return false; }
            else if (ph !== st) return false;
        }
        return true;
    });
    // Promo berakhir di urutan bawah daftar
    listPromos = matched.filter(p => promoPhase(p) !== 'ended').concat(matched.filter(p => promoPhase(p) === 'ended'));

    previewId = null;
    for (const id of Array.from(selectedIds)) if (!listPromos.some(p => p.id === id)) selectedIds.delete(id);
    computeSlides();

    renderCarousel();
    renderTable();
}

/* Titik indikator ringkas: maksimal 5 titik (jendela di sekitar slide aktif).
   Titik di ujung jendela dikecilkan sebagai tanda masih ada slide lain. Jika hanya 1 slide, tidak ada titik. */
function buildDots(container) {
    const total = filteredPromos.length;
    container.classList.toggle('hidden', total <= 1);
    if (total <= 1) return;
    const MAX = 5;
    const size = Math.min(MAX, total);
    const start = Math.max(0, Math.min(currentSlideIndex - Math.floor(size / 2), total - size));
    for (let idx = start; idx < start + size; idx++) {
        const active = idx === currentSlideIndex;
        const edgeMore = total > MAX && ((idx === start && start > 0) || (idx === start + size - 1 && start + size < total));
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-label', 'Promo ' + (idx + 1));
        dot.className = 'rounded-full transition-all ' + (active
            ? 'h-2 w-5 bg-indigo-500'
            : (edgeMore ? 'h-1 w-1 bg-slate-600' : 'h-1.5 w-1.5 bg-slate-500 hover:bg-slate-300'));
        dot.onclick = () => window.goToSlide(idx);
        container.appendChild(dot);
    }
}

function renderCarousel() {
    const sliderContainer = document.getElementById('sliderContainer');
    const dotsContainer = document.getElementById('dotsContainer');
    const emptyState = document.getElementById('emptyState');
    const slideCounterText = document.getElementById('slideCounterText');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');

    if (!sliderContainer || !dotsContainer) return;

    sliderContainer.innerHTML = '';
    dotsContainer.innerHTML = '';

    const loadingState = document.getElementById('loadingState');
    if (loadingState) loadingState.classList.toggle('hidden', !isLoadingPromos);

    if (filteredPromos.length === 0) {
        if (emptyState) {
            const eh = emptyState.querySelector('h3');
            const ep = emptyState.querySelector('p');
            if (listPromos.length > 0) {
                if (eh) eh.textContent = 'Tidak Ada Promo Aktif';
                if (ep) ep.textContent = 'Promo yang sudah berakhir ada di daftar. Klik barisnya untuk melihat posternya.';
            } else if (isListFiltered()) {
                if (eh) eh.textContent = 'Tidak Ada Hasil';
                if (ep) ep.textContent = 'Tidak ada promo yang cocok dengan pencarian atau filter status.';
            } else {
                if (eh) eh.textContent = 'Tidak Ada Promo A4';
                if (ep) ep.textContent = 'Pilih tahun/bulan lain pada filter di atas.';
            }
            const showEmpty = !isLoadingPromos;
            emptyState.classList.toggle('hidden', !showEmpty);
            emptyState.classList.toggle('flex', showEmpty);
        }
        const emptyCaption = document.getElementById('promoCaption');
        if (emptyCaption) emptyCaption.classList.add('hidden');
        const emptyAlert = document.getElementById('promoAlertBar');
        if (emptyAlert) {
            emptyAlert.classList.add('hidden');
            emptyAlert.innerHTML = '';
        }
        if (slideCounterText) slideCounterText.textContent = '0 dari 0';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        highlightActiveRow();
        return;
    }

    if (emptyState) {
        emptyState.classList.add('hidden');
        emptyState.classList.remove('flex');
    }

    if (currentSlideIndex >= filteredPromos.length) {
        currentSlideIndex = 0;
    }

    filteredPromos.forEach((promo, idx) => {
        // Muat gambar hanya untuk slide aktif + tetangganya; sisanya menyusul saat digeser
        const nSlides = filteredPromos.length;
        const dist = Math.abs(idx - currentSlideIndex);
        const near = dist <= 1 || dist >= nSlides - 1;
        const slide = document.createElement('div');
        slide.className = 'w-full min-w-full max-w-full h-full relative flex-shrink-0 flex items-center justify-center bg-slate-950 slide-transition';
        slide.style.transform = `translateX(-${currentSlideIndex * 100}%)`;

        slide.innerHTML = `
            <img ${near ? `src="${escapeHtml(promo.imageUrl)}"` : ''} alt="${escapeHtml(promo.title)}" class="w-full h-full object-contain select-none" draggable="false" decoding="async" fetchpriority="${idx === currentSlideIndex ? 'high' : 'low'}">
        `;
        sliderContainer.appendChild(slide);
    });
    buildDots(dotsContainer);

    const caption = document.getElementById('promoCaption');
    const captionTitle = document.getElementById('captionTitle');
    const captionDesc = document.getElementById('captionDesc');
    const activePromo = filteredPromos[currentSlideIndex];

    const alertBar = document.getElementById('promoAlertBar');
    if (alertBar && activePromo) {
        alertBar.innerHTML = buildRibbonHtml(activePromo);
        alertBar.classList.remove('hidden');
    }
    if (caption && captionTitle && captionDesc && activePromo) {
        captionTitle.textContent = activePromo.title;
        captionDesc.innerHTML = formatDescription(activePromo.description || '');
        captionDesc.classList.toggle('hidden', !(activePromo.description || '').trim());
        caption.classList.remove('hidden');
    }

    if (slideCounterText) slideCounterText.textContent = previewId ? 'Pratinjau promo berakhir' : `${currentSlideIndex + 1} dari ${filteredPromos.length}`;
    const navOff = !previewId && filteredPromos.length <= 1;
    if (prevBtn) prevBtn.disabled = navOff;
    if (nextBtn) nextBtn.disabled = navOff;
    highlightActiveRow();
}

/* Keluar dari pratinjau promo berakhir, kembali ke promo aktif */
function leavePreview(toLast) {
    previewId = null;
    computeSlides();
    currentSlideIndex = toLast ? Math.max(0, filteredPromos.length - 1) : 0;
    renderCarousel();
}

window.nextSlide = function () {
    if (previewId) { leavePreview(false); return; }
    if (filteredPromos.length <= 1) return;
    currentSlideIndex = (currentSlideIndex + 1) % filteredPromos.length;
    renderCarousel();
};

window.prevSlide = function () {
    if (previewId) { leavePreview(true); return; }
    if (filteredPromos.length <= 1) return;
    currentSlideIndex = (currentSlideIndex - 1 + filteredPromos.length) % filteredPromos.length;
    renderCarousel();
};

window.goToSlide = function (index) {
    currentSlideIndex = index;
    renderCarousel();
};

function renderTable() {
    const tableBody = document.getElementById('promoTableBody');
    if (!tableBody) return;
    tableBody.innerHTML = '';

    // Lebih dari 10 promo: daftar diperkecil (baris rapat) dan bisa di-scroll
    const LIST_LIMIT = 10;
    const wrap = document.getElementById('promoTableWrap');
    const many = listPromos.length > LIST_LIMIT;
    if (wrap) { wrap.classList.toggle('promo-scroll', many); wrap.classList.toggle('promo-compact', many); if (!many) wrap.scrollTop = 0; }
    const countEl = document.getElementById('promoListCount');
    if (countEl) {
        const soon = listPromos.filter(isSoonEnding).length;
        countEl.textContent = listPromos.length
            ? (listPromos.length + ' promo' + (soon ? ' · ' + soon + ' segera berakhir' : '') + (many ? ' · geser untuk melihat semua' : ''))
            : '';
    }

    if (listPromos.length === 0) {
        const message = isLoadingPromos ? 'Memuat promo...'
            : (isListFiltered() ? 'Tidak ada promo yang cocok dengan pencarian atau filter.' : 'Tidak ada promo pada periode yang dipilih.');
        tableBody.innerHTML = `
            <tr>
                <td colspan="6" class="py-6 text-center text-slate-500">${message}</td>
            </tr>
        `;
        updateBulkBar();
        return;
    }

    const isLogged = isAdminLoggedIn();

    listPromos.forEach((promo) => {
        const tr = document.createElement('tr');
        const phase = promoPhase(promo);
        tr.className = 'promo-row transition' + (phase === 'ended' ? ' is-ended' : '') + (selectedIds.has(promo.id) ? ' is-selected' : '');
        tr.dataset.id = promo.id;
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-label', 'Tampilkan poster: ' + promo.title);
        tr.addEventListener('click', () => window.selectPromoFromList(promo.id));
        tr.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === tr) {
                e.preventDefault();
                window.selectPromoFromList(promo.id);
            }
        });

        const actionCellHtml = isLogged
            ? `<button onclick="event.stopPropagation(); window.askEditPromo('${promo.id}')" class="text-indigo-400 hover:text-indigo-300 p-1.5 rounded-lg hover:bg-indigo-500/10 transition" title="Edit Promo">
                    <svg class="icon" aria-hidden="true"><use href="#i-s-pen-to-square"/></svg>
               </button>
               <button onclick="event.stopPropagation(); window.askDeletePromo('${promo.id}')" class="text-rose-400 hover:text-rose-300 p-1.5 rounded-lg hover:bg-rose-500/10 transition" title="Hapus Promo">
                    <svg class="icon" aria-hidden="true"><use href="#i-s-trash-can"/></svg>
               </button>`
            : `<span class="text-slate-600 text-[11px] flex items-center justify-end gap-1" title="Hanya Admin yang dapat mengubah">
                    <svg class="icon text-[10px]" aria-hidden="true"><use href="#i-s-lock"/></svg> Kunci
               </span>`;

        const claimNote = promo.claimEndDate
            ? `<div class="promo-claim-note">Voucher s/d ${escapeHtml(formatDate(promo.claimEndDate))}</div>` : '';

        tr.innerHTML = `
            <td class="col-select py-2.5 px-3 sm:px-4">
                <input type="checkbox" class="row-check" aria-label="Pilih ${escapeHtml(promo.title)}" ${selectedIds.has(promo.id) ? 'checked' : ''}>
            </td>
            <td class="py-2.5 px-3 sm:px-4">
                <img src="${escapeHtml(promo.imageUrl)}" class="w-8 h-11 sm:w-10 sm:h-14 object-cover rounded-md border border-slate-800" alt="thumb" loading="lazy" decoding="async" fetchpriority="low">
            </td>
            <td class="py-2.5 px-3 sm:px-4 font-bold text-white max-w-[160px] sm:max-w-none truncate">${escapeHtml(promo.title)}${claimNote}</td>
            <td class="py-2.5 px-3 sm:px-4 text-slate-400 text-xs whitespace-nowrap">${formatDate(promo.startDate)} - ${formatDate(promo.endDate)}</td>
            <td class="py-2.5 px-3 sm:px-4 whitespace-nowrap">${getStatusBadge(promo)}</td>
            <td class="py-2.5 px-3 sm:px-4 text-right whitespace-nowrap">${actionCellHtml}</td>
        `;
        const cell = tr.querySelector('.col-select');
        cell.addEventListener('click', (e) => e.stopPropagation());
        tr.querySelector('.row-check').addEventListener('change', (e) => {
            if (e.target.checked) selectedIds.add(promo.id); else selectedIds.delete(promo.id);
            tr.classList.toggle('is-selected', e.target.checked);
            updateBulkBar();
        });
        tableBody.appendChild(tr);
    });
    highlightActiveRow();
    updateBulkBar();
}

/* Klik baris daftar -> POP menampilkan promo yang sama.
   Promo yang sudah berakhir tampil sebagai pratinjau dengan pita "Promo Berakhir". */
window.selectPromoFromList = function (id) {
    const promo = listPromos.find(p => p.id === id);
    if (!promo) return;
    previewId = promoPhase(promo) === 'ended' ? id : null;
    computeSlides();
    currentSlideIndex = Math.max(0, filteredPromos.findIndex(p => p.id === id));
    renderCarousel();
    // Di HP poster ada di atas daftar: gulir ke poster supaya langsung terlihat
    const section = document.getElementById('promoDisplaySection');
    if (section) {
        const top = section.getBoundingClientRect().top;
        if (top < 0 || top > window.innerHeight - 200) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
};

/* Tandai baris yang sedang tampil di POP (dipanggil juga saat geser/panah/titik) */
function highlightActiveRow() {
    const body = document.getElementById('promoTableBody');
    if (!body) return;
    const current = filteredPromos[currentSlideIndex];
    const activeId = current ? current.id : null;
    let activeRow = null;
    body.querySelectorAll('tr.promo-row').forEach((tr) => {
        const on = tr.dataset.id === activeId;
        tr.classList.toggle('is-active', on);
        if (on) { tr.setAttribute('aria-current', 'true'); activeRow = tr; }
        else tr.removeAttribute('aria-current');
    });
    // Jika daftar bisa di-scroll, pastikan baris aktif tidak tersembunyi (hanya di dalam daftar)
    const wrap = document.getElementById('promoTableWrap');
    if (activeRow && wrap && wrap.classList.contains('promo-scroll')) {
        const wr = wrap.getBoundingClientRect();
        const rr = activeRow.getBoundingClientRect();
        const head = wrap.querySelector('thead');
        const hh = head ? head.offsetHeight : 0;
        if (rr.top < wr.top + hh) wrap.scrollTop -= (wr.top + hh - rr.top);
        else if (rr.bottom > wr.bottom) wrap.scrollTop += (rr.bottom - wr.bottom);
    }
}

/* ===== Buka promo lewat link (#kategori/id-promo) ===== */
function openPromoById(id) {
    const promo = promoList.find(p => p.id === id);
    if (!promo) { window.showToast('Promo tidak ditemukan atau sudah dihapus.'); return; }
    activeCategory = promo.category || '';
    renderCategoryMenu();
    const sBox = document.getElementById('searchPromo'); if (sBox) sBox.value = '';
    const fBox = document.getElementById('filterStatus'); if (fBox) fBox.value = 'all';

    const today = todayStart();
    const s = parseLocalDate(promo.startDate);
    const e = parseLocalDate(promo.claimEndDate || promo.endDate);
    const ref = (today >= s && today <= e) ? today : (today > e ? e : s);
    const ySel = document.getElementById('selectYear');
    const mSel = document.getElementById('selectMonth');
    if (!Array.from(ySel.options).some(o => Number(o.value) === ref.getFullYear())) {
        const opt = document.createElement('option');
        opt.value = ref.getFullYear(); opt.textContent = ref.getFullYear();
        ySel.appendChild(opt);
    }
    ySel.value = ref.getFullYear();
    mSel.value = ref.getMonth();
    currentSlideIndex = 0;
    updateDashboard();
    window.selectPromoFromList(id);
}

/* ===== Bagikan promo ===== */
function promoLink(p) {
    return location.origin + location.pathname + '#' + (p.category || '') + '/' + p.id;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (err) { /* abaikan */ }
        ta.remove();
        return ok;
    }
}

function buildWaText(p) {
    const lines = ['*' + p.title + '*', 'Periode: ' + formatPeriodCompact(p.startDate, p.endDate)];
    if (p.claimEndDate) lines.push('Voucher berlaku s/d ' + formatDateFull(p.claimEndDate));
    const desc = (p.description || '').trim();
    if (desc) lines.push('', desc.length > 700 ? desc.slice(0, 700).trimEnd() + '...' : desc);
    lines.push('', 'Lihat poster: ' + promoLink(p));
    return lines.join('\n');
}

window.copyPromoLink = async function () {
    const p = filteredPromos[currentSlideIndex];
    if (!p) return;
    window.showToast(await copyText(promoLink(p)) ? 'Link promo disalin.' : 'Gagal menyalin link.');
};

window.copyPromoWa = async function () {
    const p = filteredPromos[currentSlideIndex];
    if (!p) return;
    window.showToast(await copyText(buildWaText(p)) ? 'Teks WhatsApp disalin. Tinggal tempel.' : 'Gagal menyalin teks.');
};

/* ===== Pilih banyak: pindah menu / hapus ===== */
let bulkBusy = false;

function updateBulkBar() {
    const bar = document.getElementById('bulkBar');
    const n = selectedIds.size;
    if (bar) {
        bar.classList.toggle('show', n > 0 && isAdminLoggedIn());
        const c = document.getElementById('bulkCount');
        if (c) c.textContent = n + ' dipilih';
    }
    const all = document.getElementById('selectAllRows');
    if (all) {
        const every = listPromos.length > 0 && listPromos.every(p => selectedIds.has(p.id));
        all.checked = every;
        all.indeterminate = !every && listPromos.some(p => selectedIds.has(p.id));
    }
}

window.toggleSelectAll = function (checked) {
    listPromos.forEach(p => { if (checked) selectedIds.add(p.id); else selectedIds.delete(p.id); });
    renderTable();
};

window.bulkClear = function () {
    selectedIds.clear();
    renderTable();
};

async function bulkRequest(payload, ids) {
    // Server memproses maksimal 40 promo per permintaan
    for (let i = 0; i < ids.length; i += 40) {
        await apiFetch('/promos/bulk', {
            method: 'POST',
            body: JSON.stringify(Object.assign({}, payload, { ids: ids.slice(i, i + 40) }))
        });
    }
}

window.bulkMove = async function () {
    if (bulkBusy || !selectedIds.size || !isAdminLoggedIn()) return;
    const category = document.getElementById('bulkCategory').value;
    const ids = Array.from(selectedIds);
    bulkBusy = true;
    try {
        await bulkRequest({ action: 'move', category }, ids);
        promoList.forEach(p => { if (selectedIds.has(p.id)) p.category = category; });
        selectedIds.clear();
        updateDashboard();
        const label = (CATEGORY_MENU.find(c => c.key === category) || CATEGORY_MENU[0]).label;
        window.showToast(ids.length + ' promo dipindah ke menu ' + label + '.');
    } catch (err) {
        window.showToast('Gagal memindahkan: ' + err.message);
        await reloadPromos();
    } finally {
        bulkBusy = false;
    }
};

window.bulkDelete = async function () {
    if (bulkBusy || !selectedIds.size || !isAdminLoggedIn()) return;
    const ids = Array.from(selectedIds);
    if (!confirm('Hapus ' + ids.length + ' promo terpilih? Tindakan ini tidak bisa dibatalkan.')) return;
    bulkBusy = true;
    try {
        await bulkRequest({ action: 'delete' }, ids);
        promoList = promoList.filter(p => !selectedIds.has(p.id));
        selectedIds.clear();
        updateDashboard();
        window.showToast(ids.length + ' promo dihapus.');
    } catch (err) {
        window.showToast('Gagal menghapus: ' + err.message);
        await reloadPromos();
    } finally {
        bulkBusy = false;
    }
};

window.askDeletePromo = function (id) {
    if (!isAdminLoggedIn()) {
        window.showToast('Login sebagai Admin untuk menghapus promo!');
        window.toggleLoginModal(true);
        return;
    }

    deleteTargetId = id;
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.classList.remove('opacity-0', 'pointer-events-none');
        modal.classList.add('opacity-100', 'pointer-events-auto');
        const confirmBtn = document.getElementById('confirmBtn');
        if (confirmBtn) confirmBtn.onclick = window.executeDeletePromo;
    }
};

window.closeConfirmModal = function () {
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.classList.add('opacity-0', 'pointer-events-none');
        modal.classList.remove('opacity-100', 'pointer-events-auto');
    }
    deleteTargetId = null;
};

window.executeDeletePromo = async function () {
    if (!isAdminLoggedIn()) {
        alert('Aksi ditolak. Silakan login sebagai admin.');
        return;
    }

    if (!deleteTargetId) return;
    const id = deleteTargetId;
    try {
        await apiFetch('/promos/' + encodeURIComponent(id), { method: 'DELETE' });
        promoList = promoList.filter(p => p.id !== id);
        selectedIds.delete(id);
        updateDashboard();
        window.closeConfirmModal();
        window.showToast('Promo berhasil dihapus!');
    } catch (err) {
        window.showToast('Gagal menghapus: ' + err.message);
    }
};


function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* Ubah URL menjadi link yang bisa diklik (teks sudah di-escape lebih dulu) */
function linkifyEscaped(escaped) {
    return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
        const trailing = (url.match(/[.,;:!?)\]]+$/) || [''])[0];
        const clean = trailing ? url.slice(0, -trailing.length) : url;
        return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 underline hover:text-indigo-300 break-all">${clean}</a>${trailing}`;
    });
}

/*
  Aturan format:
  - Baris kosong        -> jarak antar paragraf
  - "- teks" / "• teks" -> poin
  - "1. teks" / "1) teks" -> daftar bernomor
  - Baris berakhir ":"  -> subjudul tebal
  - Lainnya             -> paragraf biasa
*/
function formatDescription(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    let list = null;      // { type: 'ul' | 'ol', start: number, items: [] }
    let gap = false;      // ada baris kosong sebelum blok berikutnya

    const gapClass = () => {
        const c = gap && out.length ? 'mt-3' : '';
        gap = false;
        return c;
    };

    const flushList = () => {
        if (!list) return;
        const cls = list.type === 'ul'
            ? 'list-disc pl-5 space-y-1 marker:text-indigo-400'
            : 'list-decimal pl-5 space-y-1 marker:text-indigo-400 marker:font-semibold';
        const startAttr = list.type === 'ol' && list.start > 1 ? ` start="${list.start}"` : '';
        const items = list.items.map(i => `<li>${linkifyEscaped(escapeHtml(i))}</li>`).join('');
        out.push(`<${list.type}${startAttr} class="${gapClass()} ${cls}">${items}</${list.type}>`);
        list = null;
    };

    lines.forEach((raw) => {
        const t = raw.trim();
        if (!t) {
            flushList();
            gap = true;
            return;
        }

        const bullet = t.match(/^[-*\u2022\u2013]\s+(.+)$/);
        const numbered = t.match(/^(\d+)[.)]\s+(.+)$/);

        if (bullet) {
            if (!list || list.type !== 'ul') {
                flushList();
                list = { type: 'ul', start: 1, items: [] };
            }
            list.items.push(bullet[1]);
        } else if (numbered) {
            if (!list || list.type !== 'ol') {
                flushList();
                list = { type: 'ol', start: parseInt(numbered[1], 10), items: [] };
            }
            list.items.push(numbered[2]);
        } else {
            flushList();
            const safe = linkifyEscaped(escapeHtml(t));
            const isHeading = t.endsWith(':') && t.length <= 70;
            const cls = isHeading ? 'font-bold text-slate-100' : '';
            out.push(`<p class="${gapClass()} ${cls}">${safe}</p>`);
        }
    });
    flushList();

    return `<div class="space-y-1.5">${out.join('')}</div>`;
}

function parseLocalDate(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

function formatDateFull(dateStr) {
    if (!dateStr) return '';
    return parseLocalDate(dateStr).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* Gaya pita berjalan ditanam di sini agar tidak bergantung pada style.css */
function ensureRibbonStyles() {
    if (document.getElementById('promo-ribbon-style')) return;
    const style = document.createElement('style');
    style.id = 'promo-ribbon-style';
    style.textContent = `
        .promo-ribbon { position:relative; overflow:hidden; white-space:nowrap; pointer-events:none; padding:.4rem 0; color:#fff; font-size:10px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; line-height:1.3; }
        .promo-ribbon.is-active { background:#059669; }
        .promo-ribbon.is-ended { background:#e11d48; }
        .promo-ribbon.is-claim { background:#d97706; }
        .promo-ribbon-track { display:inline-flex; width:max-content; animation:ribbon-scroll 22s linear infinite; }
        .promo-ribbon-group { display:inline-flex; flex-shrink:0; }
        .promo-ribbon-item { display:inline-block; padding-right:2.5rem; }
        @keyframes ribbon-scroll { from { transform:translateX(0); } to { transform:translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) { .promo-ribbon-track { animation:none; } }
    `;
    document.head.appendChild(style);
}

/* Contoh hasil: "07 - 22 Okt 2026", "20 Sep - 07 Okt 2026" */
function formatPeriodCompact(startStr, endStr) {
    const start = parseLocalDate(startStr);
    const end = parseLocalDate(endStr);
    const pad = (n) => String(n).padStart(2, '0');
    const mon = (d) => d.toLocaleDateString('id-ID', { month: 'short' });

    if (start.getFullYear() !== end.getFullYear()) {
        return `${pad(start.getDate())} ${mon(start)} ${start.getFullYear()} - ${pad(end.getDate())} ${mon(end)} ${end.getFullYear()}`;
    }
    if (start.getMonth() !== end.getMonth()) {
        return `${pad(start.getDate())} ${mon(start)} - ${pad(end.getDate())} ${mon(end)} ${end.getFullYear()}`;
    }
    return `${pad(start.getDate())} - ${pad(end.getDate())} ${mon(end)} ${end.getFullYear()}`;
}

/* Pita menempel di tepi atas POP: "Promo Aktif Sisa 5 Hari ( 07 - 22 Okt 2026 )" */
function buildRibbonHtml(promo) {
    ensureRibbonStyles();

    const phase = promoPhase(promo);
    const period = formatPeriodCompact(promo.startDate, promo.endDate);
    let text;
    if (phase === 'active') text = `Promo Aktif ${calculateDaysLeft(promo.endDate)} ( ${period} )`;
    else if (phase === 'claim') text = `Masa Klaim Voucher ${calculateDaysLeft(promo.claimEndDate)} ( s/d ${formatDateFull(promo.claimEndDate)} )`;
    else text = `Promo Berakhir ( ${period} )`;

    const item = `<span class="promo-ribbon-item">${text}</span>`;
    const group = `<div class="promo-ribbon-group">${item.repeat(3)}</div>`;

    return `
        <div class="promo-ribbon ${phase === 'active' ? 'is-active' : (phase === 'claim' ? 'is-claim' : 'is-ended')}" role="status" aria-label="${text}">
            <div class="promo-ribbon-track" aria-hidden="true">${group}${group}</div>
        </div>`;
}

function isPromoEnded(endDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(endDateStr);
    end.setHours(0, 0, 0, 0);
    return end < today;
}

function calculateDaysLeft(endDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(endDateStr);
    end.setHours(0, 0, 0, 0);

    const diffTime = end - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return 'Berakhir';
    if (diffDays === 0) return 'Hari Terakhir!';
    return `Sisa ${diffDays} Hari`;
}

function todayStart() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
}

/* Tiga tahap: active (periode promo) -> claim (masa klaim voucher) -> ended */
function promoPhase(p) {
    const t = todayStart();
    if (parseLocalDate(p.endDate) >= t) return 'active';
    if (p.claimEndDate && parseLocalDate(p.claimEndDate) >= t) return 'claim';
    return 'ended';
}

function daysLeftNum(dateStr) {
    return Math.ceil((parseLocalDate(dateStr) - todayStart()) / 86400000);
}

function isSoonEnding(p) {
    return promoPhase(p) === 'active' && daysLeftNum(p.endDate) <= 3;
}

function getStatusBadge(p) {
    const phase = promoPhase(p);
    if (phase === 'ended') {
        return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">Kedaluwarsa</span>`;
    }
    if (phase === 'claim') {
        return `<span class="badge-claim">Masa Klaim</span>`;
    }
    const n = daysLeftNum(p.endDate);
    if (n <= 3) {
        return `<span class="badge-soon">${n <= 0 ? 'Hari terakhir' : 'Sisa ' + n + ' hari'}</span>`;
    }
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Aktif</span>`;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

window.showToast = function (message) {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    if (!toast || !toastMessage) return;

    toastMessage.textContent = message;
    toast.classList.remove('translate-y-20', 'opacity-0');

    setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
};
