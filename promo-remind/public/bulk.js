/*
  Unggah banyak promo sekaligus.
  Dimuat SETELAH script.js (memakai fungsi apiFetch, convertToA4, readFileAsBase64, dll).
  Tombol "Unggah Banyak" muncul otomatis di kartu "Daftar Promo Terdaftar" saat admin login.
*/
(function () {
    const MAX_FILES = 50;
    let rows = [];          // { id, file, title, start, end, desc, status, el, statusEl, thumb }
    let busy = false;
    let seq = 0;

    const $ = (id) => document.getElementById(id);
    function titleFromName(name) {
        return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Urut berdasarkan nama, angka dibaca sebagai angka (2 sebelum 10), "-" dan "_" dianggap sama
    const naturalSort = (a, b) => titleFromName(a.name).localeCompare(titleFromName(b.name), undefined, { numeric: true, sensitivity: 'base' });

    /* ---------- tampilan ---------- */
    function buildModal() {
        if ($('bulkModal')) return;
        const modal = document.createElement('div');
        modal.id = 'bulkModal';
        modal.className = 'fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 opacity-0 pointer-events-none transition-all duration-300';
        modal.innerHTML = `
            <div class="bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl max-w-2xl w-full shadow-2xl flex flex-col overflow-hidden" style="max-height:92vh;max-height:92dvh">
                <div class="flex items-center justify-between border-b border-slate-800 px-5 sm:px-6 py-4 shrink-0">
                    <h3 class="text-base sm:text-lg font-extrabold text-white flex items-center gap-2">
                        <i class="fa-solid fa-images text-indigo-400"></i>
                        Unggah Banyak Promo
                    </h3>
                    <button type="button" id="bulkCloseX" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition">
                        <i class="fa-solid fa-xmark text-lg"></i>
                    </button>
                </div>

                <div id="bulkBody" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 sm:px-6 py-4 space-y-3.5 text-xs sm:text-sm">
                    <div>
                        <label class="block text-[11px] font-bold uppercase text-slate-300 mb-1">Pilih Gambar Poster (bisa banyak sekaligus)</label>
                        <input type="file" id="bulkFiles" accept="image/*" multiple class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-400 file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-500 cursor-pointer transition">
                        <p class="mt-1 text-[11px] text-slate-500">Maksimal ${MAX_FILES} gambar sekali unggah. Urutan mengikuti nama file. Judul diambil dari nama file dan bisa diubah.</p>
                    </div>

                    <div class="grid grid-cols-2 gap-2.5">
                        <div>
                            <label for="bulkStart" class="block text-[11px] font-bold uppercase text-slate-300 mb-1">Mulai (semua)</label>
                            <input type="date" id="bulkStart" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-indigo-500 transition cursor-pointer">
                        </div>
                        <div>
                            <label for="bulkEnd" class="block text-[11px] font-bold uppercase text-slate-300 mb-1">Berakhir (semua)</label>
                            <input type="date" id="bulkEnd" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-indigo-500 transition cursor-pointer">
                        </div>
                    </div>
                    <p class="-mt-2 text-[11px] text-slate-500">Mengisi tanggal di atas otomatis mengisi semua baris. Tiap baris tetap bisa diubah sendiri.</p>

                    <label class="flex items-center gap-2 cursor-pointer bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5">
                        <input type="checkbox" id="bulkAutoA4" checked class="rounded text-indigo-600 focus:ring-0">
                        <span class="text-xs text-slate-300 font-semibold">Sesuaikan otomatis ke ukuran A4</span>
                    </label>

                    <div id="bulkList" class="space-y-2.5"></div>
                    <p id="bulkEmpty" class="text-center text-slate-500 py-4">Belum ada gambar dipilih.</p>
                </div>

                <div class="shrink-0 border-t border-slate-800 bg-slate-900 px-5 sm:px-6 py-3 flex items-center justify-between gap-2" style="padding-bottom:max(.75rem, env(safe-area-inset-bottom))">
                    <span id="bulkCounter" class="text-[11px] text-slate-400"></span>
                    <div class="flex gap-2">
                        <button type="button" id="bulkCancel" class="px-4 py-2 rounded-xl border border-slate-800 text-slate-300 hover:bg-slate-800 font-semibold transition">Batal</button>
                        <button type="button" id="bulkSave" class="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition shadow-lg shadow-indigo-600/30 disabled:opacity-40 disabled:cursor-not-allowed">Simpan Semua</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);

        $('bulkFiles').addEventListener('change', onFilesChosen);
        $('bulkStart').addEventListener('change', () => applySharedDate('start'));
        $('bulkEnd').addEventListener('change', () => applySharedDate('end'));
        $('bulkSave').addEventListener('click', saveAll);
        $('bulkCancel').addEventListener('click', closeModal);
        $('bulkCloseX').addEventListener('click', closeModal);

        modal.querySelectorAll('input[type="date"]').forEach(attachPicker);
    }

    function attachPicker(input) {
        input.addEventListener('click', () => {
            if (typeof input.showPicker === 'function') {
                try { input.showPicker(); } catch (e) { /* abaikan */ }
            }
        });
    }

    function inputClass() {
        return 'w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-indigo-500 transition';
    }

    function renderRows() {
        const list = $('bulkList');
        list.innerHTML = '';
        $('bulkEmpty').classList.toggle('hidden', rows.length > 0);

        rows.forEach((r) => {
            const el = document.createElement('div');
            el.className = 'rounded-xl border border-slate-800 bg-slate-950 p-3 flex gap-3';

            const img = document.createElement('img');
            img.src = r.thumb;
            img.alt = 'pratinjau';
            img.className = 'w-14 h-20 object-cover rounded-md border border-slate-800 shrink-0 bg-slate-900';

            const col = document.createElement('div');
            col.className = 'flex-1 min-w-0 space-y-2';

            const top = document.createElement('div');
            top.className = 'flex items-center gap-2';
            const title = document.createElement('input');
            title.type = 'text';
            title.placeholder = 'Judul promo *';
            title.value = r.title;
            title.className = inputClass();
            title.addEventListener('input', () => { r.title = title.value; });
            const del = document.createElement('button');
            del.type = 'button';
            del.title = 'Buang dari daftar';
            del.className = 'text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 transition shrink-0';
            del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            del.addEventListener('click', () => removeRow(r.id));
            top.append(title, del);

            const dates = document.createElement('div');
            dates.className = 'grid grid-cols-2 gap-2';
            const start = document.createElement('input');
            start.type = 'date'; start.value = r.start; start.className = inputClass() + ' cursor-pointer';
            start.addEventListener('input', () => { r.start = start.value; });
            const end = document.createElement('input');
            end.type = 'date'; end.value = r.end; end.className = inputClass() + ' cursor-pointer';
            end.addEventListener('input', () => { r.end = end.value; });
            attachPicker(start); attachPicker(end);
            dates.append(start, end);

            const desc = document.createElement('textarea');
            desc.rows = 2;
            desc.placeholder = 'Deskripsi (opsional)';
            desc.value = r.desc;
            desc.className = inputClass();
            desc.addEventListener('input', () => { r.desc = desc.value; });

            const status = document.createElement('p');
            status.className = 'text-[11px] hidden';

            col.append(top, dates, desc, status);
            el.append(img, col);
            list.appendChild(el);

            r.el = el; r.statusEl = status; r.startEl = start; r.endEl = end; r.titleEl = title;
            setStatus(r, r.status, r.message);
        });
        updateFooter();
    }

    function setStatus(r, status, message) {
        r.status = status;
        r.message = message || '';
        if (!r.statusEl) return;
        const map = {
            idle:   ['hidden', ''],
            saving: ['text-indigo-300', 'Menyimpan...'],
            done:   ['text-emerald-400', 'Tersimpan'],
            error:  ['text-rose-400', message || 'Gagal']
        };
        const [cls, text] = map[status] || map.idle;
        r.statusEl.className = 'text-[11px] ' + cls;
        r.statusEl.textContent = status === 'error' ? (message || text) : text;
        if (r.el) {
            r.el.classList.toggle('border-rose-500/50', status === 'error');
            r.el.classList.toggle('border-slate-800', status !== 'error');
        }
    }

    function updateFooter(progressText) {
        const n = rows.length;
        $('bulkCounter').textContent = progressText || (n ? n + ' gambar siap disimpan' : '');
        const save = $('bulkSave');
        save.disabled = busy || n === 0;
        save.textContent = busy ? 'Menyimpan...' : (n ? 'Simpan Semua (' + n + ')' : 'Simpan Semua');
        $('bulkCancel').disabled = busy;
        $('bulkCloseX').disabled = busy;
        $('bulkFiles').disabled = busy;
    }

    /* ---------- aksi ---------- */
    function onFilesChosen(e) {
        const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name));
        e.target.value = '';
        if (!files.length) return;
        files.sort(naturalSort);

        const room = MAX_FILES - rows.length;
        if (files.length > room) {
            window.showToast('Maksimal ' + MAX_FILES + ' gambar sekali unggah. Sisanya diabaikan.');
        }
        files.slice(0, Math.max(room, 0)).forEach((file) => {
            rows.push({
                id: ++seq,
                file,
                title: titleFromName(file.name),
                start: $('bulkStart').value,
                end: $('bulkEnd').value,
                desc: '',
                status: 'idle',
                message: '',
                thumb: URL.createObjectURL(file)
            });
        });
        renderRows();
    }

    function applySharedDate(which) {
        const value = $(which === 'start' ? 'bulkStart' : 'bulkEnd').value;
        rows.forEach((r) => {
            if (r.status === 'done') return;
            r[which] = value;
            const input = which === 'start' ? r.startEl : r.endEl;
            if (input) input.value = value;
        });
    }

    function removeRow(id) {
        if (busy) return;
        const r = rows.find(x => x.id === id);
        if (r) URL.revokeObjectURL(r.thumb);
        rows = rows.filter(x => x.id !== id);
        renderRows();
    }

    function validate(r) {
        if (!r.title.trim()) return 'Judul wajib diisi.';
        if (!r.start || !r.end) return 'Tanggal mulai dan berakhir wajib diisi.';
        if (r.start > r.end) return 'Tanggal mulai tidak boleh melebihi tanggal berakhir.';
        return '';
    }

    async function saveAll() {
        if (busy || !rows.length) return;
        if (!isAdminLoggedIn()) {
            window.showToast('Login sebagai Admin untuk menambah promo.');
            window.toggleLoginModal(true);
            return;
        }

        let invalid = 0;
        rows.forEach((r) => {
            const msg = validate(r);
            setStatus(r, msg ? 'error' : 'idle', msg);
            if (msg) invalid++;
        });
        if (invalid) {
            window.showToast('Lengkapi baris yang bertanda merah dulu.');
            const first = rows.find(r => r.status === 'error');
            if (first && first.el) first.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }

        busy = true;
        updateFooter();
        const autoA4 = $('bulkAutoA4').checked;
        const total = rows.length;
        // Diproses dari belakang agar urutan di katalog sama dengan urutan file
        const order = rows.slice().reverse();
        let ok = 0, fail = 0, processed = 0, firstSavedPromo = null;

        for (const r of order) {
            processed++;
            updateFooter('Menyimpan ' + processed + ' dari ' + total + '...');
            setStatus(r, 'saving');
            try {
                let dataUrl = await readFileAsBase64(r.file);
                if (autoA4) {
                    try {
                        dataUrl = (await convertToA4(dataUrl, false)).url;
                    } catch (convErr) {
                        console.warn('Konversi A4 gagal, memakai gambar asli:', convErr);
                    }
                }
                const saved = await apiFetch('/promos', {
                    method: 'POST',
                    body: JSON.stringify({
                        title: r.title.trim(),
                        startDate: r.start,
                        endDate: r.end,
                        description: r.desc.trim(),
                        imageUrl: dataUrl
                    })
                });
                promoList.unshift(saved.promo);
                firstSavedPromo = saved.promo;      // yang terakhir tersimpan = urutan pertama di katalog
                setStatus(r, 'done');
                ok++;
            } catch (err) {
                fail++;
                setStatus(r, 'error', err.message);
                if (err.status === 401) break;      // sesi habis: hentikan, sisanya belum diproses
            }
        }

        busy = false;

        // Buang baris yang sudah tersimpan, sisakan yang gagal / belum diproses
        rows.filter(r => r.status === 'done').forEach(r => URL.revokeObjectURL(r.thumb));
        rows = rows.filter(r => r.status !== 'done');

        if (ok > 0 && firstSavedPromo) {
            const d = new Date(firstSavedPromo.startDate);
            const y = $('selectYear'), m = $('selectMonth');
            if (y && m) { y.value = d.getFullYear(); m.value = d.getMonth(); }
            currentSlideIndex = 0;
            updateDashboard();
        }

        if (!rows.length) {
            closeModal(true);
            window.showToast(ok + ' promo berhasil ditambahkan!');
        } else {
            renderRows();
            updateFooter(ok + ' tersimpan, ' + rows.length + ' belum. Perbaiki lalu klik Simpan lagi.');
            window.showToast(ok + ' promo tersimpan, ' + rows.length + ' gagal atau belum diproses.');
        }
    }

    function openModal() {
        if (!isAdminLoggedIn()) {
            window.showToast('Login sebagai Admin untuk menambah promo.');
            window.toggleLoginModal(true);
            return;
        }
        buildModal();
        const modal = $('bulkModal');
        modal.classList.remove('opacity-0', 'pointer-events-none');
        modal.classList.add('opacity-100', 'pointer-events-auto');
        document.body.style.overflow = 'hidden';
        renderRows();
    }

    function closeModal(force) {
        if (busy && force !== true) return;
        const modal = $('bulkModal');
        if (!modal) return;
        modal.classList.add('opacity-0', 'pointer-events-none');
        modal.classList.remove('opacity-100', 'pointer-events-auto');
        document.body.style.overflow = '';
        rows.forEach(r => URL.revokeObjectURL(r.thumb));
        rows = [];
        $('bulkStart').value = '';
        $('bulkEnd').value = '';
        renderRows();
    }

    /* ---------- tombol di halaman ---------- */
    function installButton() {
        if ($('bulkUploadBtn')) return;
        const btn = document.createElement('button');
        btn.id = 'bulkUploadBtn';
        btn.type = 'button';
        btn.className = 'hidden px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition items-center gap-1.5 shadow-lg shadow-indigo-600/20';
        btn.innerHTML = '<i class="fa-solid fa-images"></i> Unggah Banyak';
        btn.addEventListener('click', openModal);

        const table = $('promoTableBody');
        const header = table && table.closest('section') && table.closest('section').firstElementChild;
        if (header) header.appendChild(btn);
        else document.body.appendChild(btn);

        // Tampil hanya saat admin login (mengikuti tampilan info admin di header)
        const userInfo = $('userInfoNav');
        const sync = () => {
            const loggedIn = isAdminLoggedIn();
            btn.classList.toggle('hidden', !loggedIn);
            btn.classList.toggle('inline-flex', loggedIn);
        };
        sync();
        if (userInfo) new MutationObserver(sync).observe(userInfo, { attributes: true, attributeFilter: ['class'] });
    }

    document.addEventListener('DOMContentLoaded', installButton);
})();
