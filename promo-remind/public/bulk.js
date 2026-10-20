/*
  Unggah banyak promo sekaligus (+ isi data dari spreadsheet .ods / .xlsx / .csv).
  Dimuat SETELAH script.js (memakai apiFetch, convertToA4, readFileAsBase64, dll).
  Tombol "Unggah Banyak" muncul otomatis di kartu "Daftar Promo Terdaftar" saat admin login.
*/
(function () {
    const MAX_FILES = 50;
    let rows = [];          // { id, file, title, start, end, desc, status, applied, sheetIdx, ... }
    let sheet = [];         // baris spreadsheet: { image, title, start, end, desc }
    let sheetUsed = new Set();
    let busy = false;
    let seq = 0;

    const $ = (id) => document.getElementById(id);

    function titleFromName(name) {
        return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Urut berdasarkan nama, angka dibaca sebagai angka (2 sebelum 10), "-" dan "_" dianggap sama
    const naturalSort = (a, b) => titleFromName(a.name).localeCompare(titleFromName(b.name), undefined, { numeric: true, sensitivity: 'base' });

    /* =====================================================================
       PEMBACA SPREADSHEET (tanpa pustaka luar)
       ===================================================================== */
    const NS = {
        table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
        office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
        text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
    };

    const ALIASES = {
        image: ['gambar', 'file', 'namafile', 'namagambar', 'image', 'foto', 'poster', 'namaposter'],
        title: ['judul', 'judulpromo', 'title', 'namapromo', 'promo', 'nama'],
        start: ['mulai', 'tanggalmulai', 'start', 'startdate', 'awal', 'tanggalawal', 'dari'],
        end:   ['berakhir', 'tanggalberakhir', 'akhir', 'tanggalakhir', 'end', 'enddate', 'selesai', 'sampai', 'hingga'],
        desc:  ['deskripsi', 'keterangan', 'description', 'desc', 'detail', 'syaratdanketentuan', 'syaratketentuan']
    };

    const MONTHS = {
        januari: 1, jan: 1, january: 1, februari: 2, feb: 2, february: 2, pebruari: 2,
        maret: 3, mar: 3, march: 3, april: 4, apr: 4, mei: 5, may: 5,
        juni: 6, jun: 6, june: 6, juli: 7, jul: 7, july: 7,
        agustus: 8, agu: 8, agt: 8, aug: 8, august: 8,
        september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, oct: 10, october: 10,
        november: 11, nov: 11, nopember: 11, desember: 12, des: 12, dec: 12, december: 12
    };

    async function openZip(buf) {
        const u8 = new Uint8Array(buf);
        const dv = new DataView(buf);
        let eocd = -1;
        for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('File tidak bisa dibaca sebagai .ods atau .xlsx.');
        const count = dv.getUint16(eocd + 10, true);
        let off = dv.getUint32(eocd + 16, true);
        const files = {};
        const td = new TextDecoder();
        for (let n = 0; n < count; n++) {
            if (dv.getUint32(off, true) !== 0x02014b50) break;
            const method = dv.getUint16(off + 10, true);
            const csize = dv.getUint32(off + 20, true);
            const nameLen = dv.getUint16(off + 28, true);
            const extraLen = dv.getUint16(off + 30, true);
            const commLen = dv.getUint16(off + 32, true);
            const lho = dv.getUint32(off + 42, true);
            const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
            files[name] = { method, csize, lho };
            off += 46 + nameLen + extraLen + commLen;
        }
        return {
            has: (name) => !!files[name],
            async read(name) {
                const f = files[name];
                if (!f) return null;
                const nlen = dv.getUint16(f.lho + 26, true);
                const elen = dv.getUint16(f.lho + 28, true);
                const start = f.lho + 30 + nlen + elen;
                const data = u8.subarray(start, start + f.csize);
                if (f.method === 0) return data;
                if (f.method === 8) {
                    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
                    return new Uint8Array(await new Response(stream).arrayBuffer());
                }
                throw new Error('Jenis kompresi file tidak didukung.');
            }
        };
    }

    function parseXml(bytes) {
        const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(bytes), 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('Isi file tidak bisa dibaca.');
        return doc;
    }

    /* ----- .ods ----- */
    function odsText(node) {
        let out = '';
        node.childNodes.forEach((ch) => {
            if (ch.nodeType === 3) { out += ch.nodeValue; return; }
            if (ch.nodeType !== 1) return;
            if (ch.namespaceURI === NS.text && ch.localName === 's') {
                out += ' '.repeat(parseInt(ch.getAttributeNS(NS.text, 'c') || '1', 10));
            } else if (ch.namespaceURI === NS.text && ch.localName === 'tab') {
                out += '\t';
            } else if (ch.namespaceURI === NS.text && ch.localName === 'line-break') {
                out += '\n';
            } else {
                out += odsText(ch);
            }
        });
        return out;
    }

    function odsCellText(cell) {
        const paras = Array.from(cell.childNodes).filter(n => n.nodeType === 1 && n.namespaceURI === NS.text && (n.localName === 'p' || n.localName === 'h'));
        return paras.map(odsText).join('\n');
    }

    async function parseODS(zip) {
        const doc = parseXml(await zip.read('content.xml'));
        const table = doc.getElementsByTagNameNS(NS.table, 'table')[0];
        if (!table) throw new Error('Sheet tidak ditemukan di file.');
        const out = [];
        for (const row of Array.from(table.getElementsByTagNameNS(NS.table, 'table-row'))) {
            const rowRep = Math.min(parseInt(row.getAttributeNS(NS.table, 'number-rows-repeated') || '1', 10), 200);
            const cells = [];
            row.childNodes.forEach((cell) => {
                if (cell.nodeType !== 1 || cell.namespaceURI !== NS.table) return;
                if (cell.localName !== 'table-cell' && cell.localName !== 'covered-table-cell') return;
                const colRep = Math.min(parseInt(cell.getAttributeNS(NS.table, 'number-columns-repeated') || '1', 10), 50);
                const type = cell.getAttributeNS(NS.office, 'value-type');
                let val;
                if (type === 'date') val = (cell.getAttributeNS(NS.office, 'date-value') || '').slice(0, 10);
                else if (type === 'float' || type === 'percentage' || type === 'currency') val = cell.getAttributeNS(NS.office, 'value') || odsCellText(cell);
                else if (type === 'boolean') val = (cell.getAttributeNS(NS.office, 'boolean-value') || '').toUpperCase();
                else val = odsCellText(cell);
                for (let i = 0; i < colRep; i++) cells.push(val);
            });
            while (cells.length && cells[cells.length - 1] === '') cells.pop();
            const reps = cells.length ? rowRep : 1;
            for (let i = 0; i < reps; i++) out.push(cells.slice());
        }
        return out;
    }

    /* ----- .xlsx ----- */
    function colIndex(ref) {
        const letters = (ref.match(/^[A-Z]+/i) || ['A'])[0].toUpperCase();
        let n = 0;
        for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n - 1;
    }

    function serialToISO(num) {
        const ms = Date.UTC(1899, 11, 30) + Math.floor(num) * 86400000;
        return new Date(ms).toISOString().slice(0, 10);
    }

    const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

    function isDateFormat(id, code) {
        if (BUILTIN_DATE_FMT.has(id)) return true;
        if (!code) return false;
        const cleaned = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
        return /[dmyhs]/i.test(cleaned);
    }

    async function parseXLSX(zip) {
        const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        const wb = parseXml(await zip.read('xl/workbook.xml'));
        const sheetEl = wb.getElementsByTagName('sheet')[0];
        if (!sheetEl) throw new Error('Sheet tidak ditemukan di file.');
        const rid = sheetEl.getAttributeNS(relNS, 'id') || sheetEl.getAttribute('r:id');

        let sheetPath = 'xl/worksheets/sheet1.xml';
        const relsBytes = await zip.read('xl/_rels/workbook.xml.rels');
        if (relsBytes && rid) {
            for (const rel of Array.from(parseXml(relsBytes).getElementsByTagName('Relationship'))) {
                if (rel.getAttribute('Id') === rid) {
                    const t = rel.getAttribute('Target') || '';
                    sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t;
                }
            }
        }
        const sheetBytes = await zip.read(sheetPath);
        if (!sheetBytes) throw new Error('Isi sheet tidak ditemukan di file.');

        const sst = [];
        const ssBytes = await zip.read('xl/sharedStrings.xml');
        if (ssBytes) {
            for (const si of Array.from(parseXml(ssBytes).getElementsByTagName('si'))) {
                let s = '';
                for (const t of Array.from(si.getElementsByTagName('t'))) {
                    if (t.parentNode.nodeName === 'rPh') continue;
                    s += t.textContent;
                }
                sst.push(s);
            }
        }

        const dateXf = [];
        const stBytes = await zip.read('xl/styles.xml');
        if (stBytes) {
            const st = parseXml(stBytes);
            const custom = {};
            for (const nf of Array.from(st.getElementsByTagName('numFmt'))) {
                custom[parseInt(nf.getAttribute('numFmtId'), 10)] = nf.getAttribute('formatCode');
            }
            const xfs = st.getElementsByTagName('cellXfs')[0];
            if (xfs) {
                for (const xf of Array.from(xfs.getElementsByTagName('xf'))) {
                    const id = parseInt(xf.getAttribute('numFmtId') || '0', 10);
                    dateXf.push(isDateFormat(id, custom[id]));
                }
            }
        }

        const sh = parseXml(sheetBytes);
        const out = [];
        let rowCounter = 0;
        for (const row of Array.from(sh.getElementsByTagName('row'))) {
            rowCounter = row.getAttribute('r') ? parseInt(row.getAttribute('r'), 10) : rowCounter + 1;
            const cells = [];
            for (const c of Array.from(row.getElementsByTagName('c'))) {
                const ref = c.getAttribute('r');
                const idx = ref ? colIndex(ref) : cells.length;
                const t = c.getAttribute('t');
                const s = c.getAttribute('s');
                const v = c.getElementsByTagName('v')[0];
                let val = '';
                if (t === 's') val = v ? (sst[parseInt(v.textContent, 10)] || '') : '';
                else if (t === 'inlineStr') val = Array.from(c.getElementsByTagName('t')).map(x => x.textContent).join('');
                else if (t === 'str') val = v ? v.textContent : '';
                else if (t === 'd') val = v ? v.textContent.slice(0, 10) : '';
                else if (t === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
                else if (t === 'e') val = '';
                else if (v && v.textContent !== '') {
                    val = (s !== null && dateXf[parseInt(s, 10)]) ? serialToISO(parseFloat(v.textContent)) : v.textContent;
                }
                while (cells.length < idx) cells.push('');
                cells[idx] = val;
            }
            while (out.length < rowCounter - 1) out.push([]);
            out[rowCounter - 1] = cells;
        }
        return out;
    }

    /* ----- .csv ----- */
    function parseCSV(text) {
        text = text.replace(/^﻿/, '');
        const firstLine = text.split(/\r?\n/, 1)[0] || '';
        const counts = { ';': 0, ',': 0, '\t': 0 };
        let inQ = false;
        for (const ch of firstLine) {
            if (ch === '"') inQ = !inQ;
            else if (!inQ && ch in counts) counts[ch]++;
        }
        const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];

        const out = [];
        let row = [], cell = '', q = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (q) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
                } else cell += ch;
            } else if (ch === '"') q = true;
            else if (ch === delim) { row.push(cell); cell = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); cell = '';
                out.push(row); row = [];
            } else cell += ch;
        }
        if (cell !== '' || row.length) { row.push(cell); out.push(row); }
        return out;
    }

    async function readTable(file) {
        const buf = await file.arrayBuffer();
        const u8 = new Uint8Array(buf);
        if (u8[0] === 0x50 && u8[1] === 0x4b) {
            if (typeof DecompressionStream === 'undefined') {
                throw new Error('Browser ini belum bisa membaca .ods/.xlsx. Simpan file sebagai .csv atau perbarui browser.');
            }
            const zip = await openZip(buf);
            if (zip.has('content.xml')) return parseODS(zip);
            if (zip.has('xl/workbook.xml')) return parseXLSX(zip);
            throw new Error('Format file tidak dikenali. Pakai .ods, .xlsx, atau .csv.');
        }
        if (/\.xls$/i.test(file.name) || (u8[0] === 0xD0 && u8[1] === 0xCF)) {
            throw new Error('Format .xls (lama) tidak didukung. Simpan ulang sebagai .ods, .xlsx, atau .csv.');
        }
        return parseCSV(new TextDecoder('utf-8').decode(buf));
    }

    function tableToEntries(table) {
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
        let headerIdx = -1;
        let map = {};
        for (let i = 0; i < Math.min(table.length, 10); i++) {
            const m = {};
            (table[i] || []).forEach((cell, ci) => {
                const k = norm(cell);
                for (const field of Object.keys(ALIASES)) {
                    if (m[field] === undefined && ALIASES[field].includes(k)) m[field] = ci;
                }
            });
            if (m.title !== undefined) { headerIdx = i; map = m; break; }
        }
        if (headerIdx < 0) {
            throw new Error('Baris judul kolom tidak ditemukan. Pakai kolom: Gambar, Judul, Mulai, Berakhir, Deskripsi.');
        }
        const get = (row, f) => (map[f] === undefined ? '' : String(row[map[f]] == null ? '' : row[map[f]]).replace(/\r/g, '').trim());
        const entries = table.slice(headerIdx + 1)
            .map(row => ({
                image: get(row, 'image'),
                title: get(row, 'title'),
                start: get(row, 'start'),
                end: get(row, 'end'),
                desc: get(row, 'desc')
            }))
            .filter(e => e.image || e.title || e.desc || e.start || e.end);
        if (!entries.length) throw new Error('Tidak ada baris data di bawah judul kolom.');
        return entries;
    }

    function parseDate(str) {
        const s = String(str || '').trim();
        if (!s) return '';
        let y, m, d, x;
        if ((x = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) { y = +x[1]; m = +x[2]; d = +x[3]; }
        else if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) { d = +x[1]; m = +x[2]; y = +x[3]; if (y < 100) y += 2000; }
        else if ((x = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{2,4})$/.exec(s))) {
            d = +x[1]; m = MONTHS[x[2].toLowerCase()]; y = +x[3]; if (y < 100) y += 2000;
        } else if (/^\d{5}$/.test(s)) {
            return serialToISO(parseInt(s, 10));
        } else return '';
        if (!m || m < 1 || m > 12 || d < 1 || d > 31) return '';
        const iso = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const chk = new Date(iso + 'T00:00:00Z');
        return (!isNaN(chk) && chk.toISOString().slice(0, 10) === iso) ? iso : '';
    }

    /* =====================================================================
       TAMPILAN
       ===================================================================== */
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
                        <label class="block text-[11px] font-bold uppercase text-slate-300 mb-1">1. Pilih Gambar Poster (bisa banyak sekaligus)</label>
                        <input type="file" id="bulkFiles" accept="image/*" multiple class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-400 file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-500 cursor-pointer transition">
                        <p class="mt-1 text-[11px] text-slate-500">Maksimal ${MAX_FILES} gambar sekali unggah. Tanpa spreadsheet, urutan mengikuti nama file dan judul diambil dari nama file.</p>
                    </div>

                    <div class="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-2">
                        <label class="block text-[11px] font-bold uppercase text-slate-300">2. Isi data dari spreadsheet (opsional)</label>
                        <input type="file" id="bulkSheet" accept=".ods,.xlsx,.csv,.tsv,.txt" class="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-400 file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-700 file:text-white hover:file:bg-slate-600 cursor-pointer transition">
                        <p class="text-[11px] text-slate-500">Kolom: <b class="text-slate-300">Gambar</b> (nama file), <b class="text-slate-300">Judul</b>, <b class="text-slate-300">Mulai</b>, <b class="text-slate-300">Berakhir</b>, <b class="text-slate-300">Deskripsi</b>. Format .ods, .xlsx, atau .csv. Urutan baris menjadi urutan katalog.
                            <a href="template-promo.ods" download class="text-indigo-400 underline hover:text-indigo-300">Unduh contoh file (.ods)</a></p>
                        <p id="bulkSheetInfo" class="hidden text-[11px] whitespace-pre-line"></p>
                    </div>

                    <div>
                        <label class="block text-[11px] font-bold uppercase text-slate-300 mb-1">Tanggal untuk semua (jika di spreadsheet kosong)</label>
                        <div class="grid grid-cols-2 gap-2.5">
                            <div>
                                <label for="bulkStart" class="block text-[11px] text-slate-400 mb-1">Mulai</label>
                                <input type="date" id="bulkStart" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-indigo-500 transition cursor-pointer">
                            </div>
                            <div>
                                <label for="bulkEnd" class="block text-[11px] text-slate-400 mb-1">Berakhir</label>
                                <input type="date" id="bulkEnd" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-indigo-500 transition cursor-pointer">
                            </div>
                        </div>
                    </div>

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
        $('bulkSheet').addEventListener('change', onSheetChosen);
        $('bulkStart').addEventListener('change', () => applySharedDate('start'));
        $('bulkEnd').addEventListener('change', () => applySharedDate('end'));
        $('bulkSave').addEventListener('click', saveAll);
        $('bulkCancel').addEventListener('click', () => closeModal());
        $('bulkCloseX').addEventListener('click', () => closeModal());

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

            const fileName = document.createElement('p');
            fileName.className = 'text-[10px] text-slate-500 truncate';
            fileName.textContent = r.file.name;

            const dates = document.createElement('div');
            dates.className = 'grid grid-cols-2 gap-2';
            const start = document.createElement('input');
            start.type = 'date'; start.value = r.start; start.className = inputClass() + ' cursor-pointer';
            start.addEventListener('input', () => { r.start = start.value; r.startFromSheet = true; });
            const end = document.createElement('input');
            end.type = 'date'; end.value = r.end; end.className = inputClass() + ' cursor-pointer';
            end.addEventListener('input', () => { r.end = end.value; r.endFromSheet = true; });
            attachPicker(start); attachPicker(end);
            dates.append(start, end);

            const desc = document.createElement('textarea');
            desc.rows = r.desc && r.desc.split('\n').length > 2 ? 4 : 2;
            desc.placeholder = 'Deskripsi (opsional)';
            desc.value = r.desc;
            desc.className = inputClass();
            desc.addEventListener('input', () => { r.desc = desc.value; });

            const status = document.createElement('p');
            status.className = 'text-[11px] hidden';

            col.append(top, fileName, dates, desc, status);
            el.append(img, col);
            list.appendChild(el);

            r.el = el; r.statusEl = status; r.startEl = start; r.endEl = end;
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
        $('bulkSheet').disabled = busy;
    }

    function showSheetInfo(kind, text) {
        const el = $('bulkSheetInfo');
        if (!el) return;
        if (!text) { el.className = 'hidden text-[11px] whitespace-pre-line'; el.textContent = ''; return; }
        const color = kind === 'error' ? 'text-rose-400' : (kind === 'warn' ? 'text-amber-400' : 'text-emerald-400');
        el.className = 'text-[11px] whitespace-pre-line ' + color;
        el.textContent = text;
    }

    /* =====================================================================
       AKSI
       ===================================================================== */
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
                applied: false,
                startFromSheet: false,
                endFromSheet: false,
                thumb: URL.createObjectURL(file)
            });
        });
        applySheet();      // mencocokkan dengan spreadsheet (jika sudah dipilih), lalu menampilkan baris
    }

    async function onSheetChosen(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const entries = tableToEntries(await readTable(file));
            sheet = entries;
            sheetUsed = new Set();
            rows.forEach((r) => { r.applied = false; r.startFromSheet = false; r.endFromSheet = false; });
            applySheet();
        } catch (err) {
            console.error(err);
            sheet = [];
            sheetUsed = new Set();
            showSheetInfo('error', err.message || 'File spreadsheet tidak bisa dibaca.');
        }
    }

    function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }

    function findRowFor(imageName, free) {
        const key = imageName.trim().replace(/^.*[\\/]/, '').toLowerCase();
        return free.find(r => r.file.name.toLowerCase() === key)
            || free.find(r => stripExt(r.file.name).toLowerCase() === stripExt(key))
            || null;
    }

    function applySheet() {
        if (!sheet.length) { renderRows(); return; }

        const hasNameCol = sheet.some(s => s.image);
        const badDates = [];

        sheet.forEach((s, idx) => {
            if (sheetUsed.has(idx)) return;
            const free = rows.filter(r => !r.applied);
            if (!free.length) return;
            let row = null;
            if (hasNameCol) {
                if (!s.image) return;
                row = findRowFor(s.image, free);
            } else {
                row = free[0];      // tanpa kolom Gambar: cocokkan berdasarkan urutan
            }
            if (!row) return;

            row.applied = true;
            row.sheetIdx = idx;
            sheetUsed.add(idx);
            if (s.title) row.title = s.title;
            if (s.desc) row.desc = s.desc;
            if (s.start) {
                const d = parseDate(s.start);
                if (d) { row.start = d; row.startFromSheet = true; } else badDates.push((s.image || s.title) + ' (mulai: ' + s.start + ')');
            }
            if (s.end) {
                const d = parseDate(s.end);
                if (d) { row.end = d; row.endFromSheet = true; } else badDates.push((s.image || s.title) + ' (berakhir: ' + s.end + ')');
            }
        });

        // Urutan: yang cocok mengikuti urutan baris spreadsheet, sisanya di belakang
        const applied = rows.filter(r => r.applied).sort((a, b) => a.sheetIdx - b.sheetIdx);
        rows = applied.concat(rows.filter(r => !r.applied));
        renderRows();

        const lines = [];
        const matched = sheetUsed.size;
        const unmatchedSheet = sheet.filter((s, i) => !sheetUsed.has(i) && (s.image || s.title));
        const noSheetRows = rows.filter(r => !r.applied && r.status !== 'done').length;
        let kind = 'ok';

        if (!rows.length) {
            lines.push(sheet.length + ' baris spreadsheet terbaca. Sekarang pilih gambar-gambarnya di langkah 1.');
        } else {
            lines.push(matched + ' dari ' + sheet.length + ' baris spreadsheet cocok dengan gambar.');
            if (!hasNameCol) lines.push('Kolom Gambar tidak ada, jadi dicocokkan berdasarkan urutan.');
        }
        if (rows.length && unmatchedSheet.length) {
            kind = 'warn';
            const names = unmatchedSheet.map(s => s.image || s.title);
            lines.push('Belum ada gambar untuk: ' + names.slice(0, 8).join(', ') + (names.length > 8 ? ', dan ' + (names.length - 8) + ' lainnya' : '') + '.');
        }
        if (rows.length && noSheetRows) {
            kind = 'warn';
            lines.push(noSheetRows + ' gambar tidak ada di spreadsheet (judul dari nama file, tanggal dari isian "untuk semua").');
        }
        if (badDates.length) {
            kind = 'warn';
            lines.push('Tanggal tidak dikenali: ' + badDates.slice(0, 5).join('; ') + '. Perbaiki di baris terkait.');
        }
        showSheetInfo(kind, lines.join('\n'));
    }

    function applySharedDate(which) {
        const value = $(which === 'start' ? 'bulkStart' : 'bulkEnd').value;
        rows.forEach((r) => {
            if (r.status === 'done') return;
            if (which === 'start' ? r.startFromSheet : r.endFromSheet) return;   // jangan timpa tanggal dari spreadsheet
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
        // Diproses dari belakang agar urutan di katalog sama dengan urutan baris
        const order = rows.slice().reverse();
        let ok = 0, processed = 0, firstSavedPromo = null;

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
        sheet = [];
        sheetUsed = new Set();
        $('bulkStart').value = '';
        $('bulkEnd').value = '';
        showSheetInfo('', '');
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
