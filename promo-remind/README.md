# Remind Promo (Cloudflare Worker + KV)

Struktur:
- wrangler.jsonc  -> konfigurasi (ganti GANTI_DENGAN_ID_KV dengan ID KV Anda)
- src/worker.js   -> server (API simpan promo & gambar)
- public/         -> halaman web (index.html, script.js, style.css, logo.png)
- public/promos.json -> hanya dipakai SEKALI untuk mengimpor promo lama saat pertama kali jalan

Login awal: admin / admin123  -> segera ganti lewat ikon kunci setelah login.
