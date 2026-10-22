# Pemilwa KMTEDI

Website Pemilwa KMTEDI dengan frontend interaktif dan backend Supabase.

## Fitur

- Google SSO khusus akun `@mail.ugm.ac.id`
- Kandidat dibaca dari database
- Profil calon dengan 3 slide: data diri, visi-misi, program kerja
- Voting atomic satu akun satu suara
- Ballot tidak menyimpan email atau user ID di tabel suara
- Kontrol buka/tutup voting dari `admin.html`
- Rekap suara admin
- Publikasi hasil setelah panitia mengaktifkan hasil
- Candidate media bucket dengan RLS

## Struktur

- `index.html`: halaman publik
- `admin.html`: panel panitia
- `supabase/migrations/20261022000000_initial_schema.sql`: schema, RLS, RPC, trigger, dan storage policy
- `supabase/seed.sql`: tiga data calon placeholder
- `supabase-config.example.js`: template konfigurasi browser
- `docs/SUPABASE-SETUP.md`: setup Supabase dan deploy
- `assets/`: asset visual KMTEDI

## Quick start

1. Buat project Supabase baru.
2. Jalankan migration di `supabase/migrations/20261022000000_initial_schema.sql` melalui Supabase SQL Editor.
3. Jalankan `supabase/seed.sql`.
4. Aktifkan Google provider di Supabase Authentication.
5. Tambahkan redirect URL untuk URL deployment dan `/admin.html`.
6. Salin `supabase-config.example.js` menjadi `supabase-config.js`, lalu isi URL project dan anon key.
7. Ganti data calon melalui SQL Editor atau panel admin.
8. Deploy repository ini ke Vercel, Netlify, atau GitHub Pages.

Jangan pernah memasukkan `service_role` key ke `supabase-config.js`, frontend, atau GitHub.
