const ADMIN_ACCOUNT = { name: 'Admin Promo' };
const API_BASE = '/api';                 // backend Cloudflare Worker
const TOKEN_KEY = 'admin_token';         // token login (hilang saat tab ditutup)

let promoList = [];
let filteredPromos = [];
let currentSlideIndex = 0;
let deleteTargetId = null;

function isAdminLoggedIn() {
    return !!getToken();
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadPromoData();
    checkAuthStatus();
    populateDropdowns();
    updateDashboard();
    setupDateInputs();
    setupTouchSwipe();
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
function setupTouchSwipe() {
    const slider = document.getElementById('promoDisplaySection');
    let startX = 0;
    let endX = 0;

    if (!slider) return;

    slider.addEventListener('touchstart', (e) => {
        startX = e.changedTouches[0].screenX;
    }, { passive: true });

    slider.addEventListener('touchend', (e) => {
        endX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    function handleSwipe() {
        const diff = startX - endX;
        if (Math.abs(diff) > 40) {
            if (diff > 0) {
                window.nextSlide();
            } else {
                window.prevSlide();
            }
        }
    }
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
            description: String(p.description || '')
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
        window.toggleModal(true);
    }
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
    const imageSource = document.querySelector('input[name="imageSource"]:checked').value;

    if (new Date(startDate) > new Date(endDate)) {
        alert('Tanggal mulai tidak boleh melebihi tanggal berakhir!');
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
                body: JSON.stringify({ title, startDate, endDate, description, imageUrl })
            });
        } catch (saveErr) {
            alert('Gagal menyimpan promo: ' + saveErr.message);
            return;
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitLabel; }
        }

        promoList.unshift(saved.promo);

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

function updateDashboard() {
    const selectedYear = parseInt(document.getElementById('selectYear').value);
    const selectedMonth = parseInt(document.getElementById('selectMonth').value);

    filteredPromos = promoList.filter(p => {
        const start = new Date(p.startDate);
        const end = new Date(p.endDate);

        const startMonthYear = start.getFullYear() * 12 + start.getMonth();
        const endMonthYear = end.getFullYear() * 12 + end.getMonth();
        const targetMonthYear = selectedYear * 12 + selectedMonth;

        return targetMonthYear >= startMonthYear && targetMonthYear <= endMonthYear;
    });

    renderCarousel();
    renderTable();
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

    if (filteredPromos.length === 0) {
        if (emptyState) {
            emptyState.classList.remove('hidden');
            emptyState.classList.add('flex');
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
        const slide = document.createElement('div');
        slide.className = 'w-full min-w-full max-w-full h-full relative flex-shrink-0 flex items-center justify-center bg-slate-950 slide-transition';
        slide.style.transform = `translateX(-${currentSlideIndex * 100}%)`;

        slide.innerHTML = `
            <img src="${escapeHtml(promo.imageUrl)}" alt="${escapeHtml(promo.title)}" class="w-full h-full object-contain select-none" draggable="false">
        `;
        sliderContainer.appendChild(slide);

        const dot = document.createElement('button');
        dot.className = `h-2 rounded-full transition-all ${idx === currentSlideIndex ? 'bg-indigo-500 w-5' : 'bg-slate-600 hover:bg-slate-400 w-2'}`;
        dot.onclick = () => window.goToSlide(idx);
        dotsContainer.appendChild(dot);
    });

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

    if (slideCounterText) slideCounterText.textContent = `${currentSlideIndex + 1} dari ${filteredPromos.length}`;
    if (prevBtn) prevBtn.disabled = filteredPromos.length <= 1;
    if (nextBtn) nextBtn.disabled = filteredPromos.length <= 1;
}

window.nextSlide = function () {
    if (filteredPromos.length <= 1) return;
    currentSlideIndex = (currentSlideIndex + 1) % filteredPromos.length;
    renderCarousel();
};

window.prevSlide = function () {
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

    if (filteredPromos.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" class="py-6 text-center text-slate-500">Tidak ada promo pada periode yang dipilih.</td>
            </tr>
        `;
        return;
    }

    const isLogged = isAdminLoggedIn();

    filteredPromos.forEach((promo) => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-900/40 transition';

        const actionCellHtml = isLogged 
            ? `<button onclick="window.askDeletePromo('${promo.id}')" class="text-rose-400 hover:text-rose-300 p-1.5 rounded-lg hover:bg-rose-500/10 transition" title="Hapus Promo">
                    <i class="fa-solid fa-trash-can"></i>
               </button>`
            : `<span class="text-slate-600 text-[11px] flex items-center justify-end gap-1" title="Hanya Admin yang dapat menghapus">
                    <i class="fa-solid fa-lock text-[10px]"></i> Kunci
               </span>`;

        tr.innerHTML = `
            <td class="py-2.5 px-3 sm:px-4">
                <img src="${escapeHtml(promo.imageUrl)}" class="w-8 h-11 sm:w-10 sm:h-14 object-cover rounded-md border border-slate-800" alt="thumb">
            </td>
            <td class="py-2.5 px-3 sm:px-4 font-bold text-white max-w-[160px] sm:max-w-none truncate">${escapeHtml(promo.title)}</td>
            <td class="py-2.5 px-3 sm:px-4 text-slate-400 text-xs whitespace-nowrap">${formatDate(promo.startDate)} - ${formatDate(promo.endDate)}</td>
            <td class="py-2.5 px-3 sm:px-4 whitespace-nowrap">${getStatusBadge(promo.endDate)}</td>
            <td class="py-2.5 px-3 sm:px-4 text-right whitespace-nowrap">${actionCellHtml}</td>
        `;
        tableBody.appendChild(tr);
    });
}

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

    const ended = isPromoEnded(promo.endDate);
    const period = formatPeriodCompact(promo.startDate, promo.endDate);
    const text = ended
        ? `Promo Berakhir ( ${period} )`
        : `Promo Aktif ${calculateDaysLeft(promo.endDate)} ( ${period} )`;

    const item = `<span class="promo-ribbon-item">${text}</span>`;
    const group = `<div class="promo-ribbon-group">${item.repeat(3)}</div>`;

    return `
        <div class="promo-ribbon ${ended ? 'is-ended' : 'is-active'}" role="status" aria-label="${text}">
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

function getStatusBadge(endDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(endDateStr);
    end.setHours(0, 0, 0, 0);

    if (end < today) {
        return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">Kedaluwarsa</span>`;
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
