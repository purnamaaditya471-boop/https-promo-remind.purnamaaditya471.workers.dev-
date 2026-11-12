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
