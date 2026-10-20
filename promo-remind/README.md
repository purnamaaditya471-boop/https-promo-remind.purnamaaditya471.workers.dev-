# Remind Promo (Cloudflare Worker + KV)

Struktur:
- wrangler.jsonc  -> konfigurasi (ganti GANTI_DENGAN_ID_KV dengan ID KV Anda) done
- src/worker.js   -> server (API simpan promo & gambar) done
- public/         -> halaman web (index.html, script.js, style.css, logo.png)
- public/promos.json -> sudah tidak digunakan

Login awal: admin / admin123  

- awalan menggunakan free hosting dari claudeflare dengan domain langsung dari claude
- Hosting berbayar memerlukan bahasa php untuk database
