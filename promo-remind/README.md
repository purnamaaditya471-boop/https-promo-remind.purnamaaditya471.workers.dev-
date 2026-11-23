# Remind Promo (Cloudflare Worker + KV)

Struktur:
- wrangler.jsonc  -> konfigurasi (ganti GANTI_DENGAN_ID_KV dengan ID KV Anda) done
- src/worker.js   -> server (API simpan promo & gambar) done
- public/         -> halaman web (index.html, script.js, style.css, logo.png)
- public/promos.json -> sudah tidak digunakan

Login awal: admin / admin123  

- awalan menggunakan free hosting dari claudeflare dengan domain langsung dari claude
- Hosting berbayar memerlukan bahasa php untuk database

## Menu kategori (baru)
- Promo punya field `category`: kosong = Utama (Beranda), atau `hobbies`, `living`, `improvement`.
- Beranda hanya menampilkan promo utama. Promo kategori hanya tampil saat menunya diklik (alamat `#hobbies`, `#living`, `#improvement`).
- HP: bar menu di bawah layar. Desktop: tab di bawah header.
- Form unggah/edit punya pilihan "Tampil di Menu"; default-nya menu yang sedang dibuka. "Unggah Banyak" menyimpan ke menu yang sedang dibuka.
- Promo lama (tanpa `category`) otomatis tetap di Beranda.

## Fitur tambahan (update November 2026)
- Daftar promo bisa diklik: POP menampilkan promo yang diklik (sinkron).
- Tiga tahap status: Aktif -> Masa Klaim (voucher/cashback, tanggal opsional "berlaku s/d") -> Kedaluwarsa.
- Promo berakhir tidak masuk carousel POP, tetap ada di daftar (redup); diklik = pratinjau dengan pita merah.
- Gambar carousel dimuat seperlunya (slide aktif + tetangga).
- Cari judul, filter status, badge "Sisa N hari" (<= 3 hari).
- Bagikan: Salin Link (#kategori/id-promo) dan Salin Teks WA.
- Edit promo: gambar boleh diganti (opsional).
- Admin: pilih banyak -> pindah menu / hapus (maks. 40 per permintaan server).
- PWA: sw.js + manifest.webmanifest + ikon (bisa dipasang di layar HP).
- API baru: POST /api/promos/bulk; PUT /api/promos/:id menerima imageUrl; field claimEndDate.
