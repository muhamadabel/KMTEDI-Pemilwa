# Pemilwa KMTEDI

Website Pemilwa KMTEDI 2026: halaman publik, verifikasi pemilih via OTP email UGM, dan panel admin panitia.

Dokumentasi lengkap arsitektur, alur keamanan, dan aturan pengembangan ada di `AGENT_BRIEF.md`.

## Setup singkat

1. Jalankan semua file di `supabase/migrations/` secara berurutan di Supabase SQL Editor.
2. Atur PIN admin: `select private.set_admin_pin('PIN-BARU-MIN-12-KARAKTER');`
3. Isi environment variables di Vercel sesuai `.env.example`.
4. Deploy: `npm test && npx vercel --prod`.

Jangan pernah memasukkan service role key, app password, atau PIN ke repo ini.
