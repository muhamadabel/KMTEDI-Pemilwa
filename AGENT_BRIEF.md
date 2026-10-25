# KMTEDI Pemilwa - Agent Handoff & Architecture Brief

Dokumen operasional resmi untuk AI coding agent yang melanjutkan pengembangan sistem Pemilwa KMTEDI. Baca dokumen ini sebelum memodifikasi kode.

---

## 1. Project Overview & Environments
- **Project Name:** Website Pemilwa KMTEDI 2026 (Pemilihan Ketua KMTEDI)
- **Local Path:** `/Users/user/Documents/KMTEDI-Pemilwa`
- **Git Repo:** `https://github.com/muhamadabel/KMTEDI-Pemilwa` (Branch: `main`)
- **Live Production:** `https://kmtedi-pemilwa.vercel.app`
- **Admin Panel URL:** `https://kmtedi-pemilwa.vercel.app/admin` (Sengaja tidak ditampilkan di navigasi navbar beranda untuk privasi panitia)
- **Backend / Database:** Supabase PostgreSQL (`geoqhztzaputpuiyheqm.supabase.co`)
- **Hosting / Serverless:** Vercel

---

## 2. Tech Stack & Architecture
- **Frontend:** Pure HTML5, CSS3, Vanilla JavaScript (ES6+). Cepat, ringan, tanpa kompilasi bundler React/Next.js.
- **Supabase Integration:** Menggunakan `@supabase/supabase-js@2` via CDN.
- **Backend APIs:** Vercel Serverless Functions (`/api/send-otp`, `/api/verify-otp`, `/api/cast-vote`, `/api/admin`). Helper bersama di `lib/server.js`.
- **Akses Database:** Browser hanya membaca data publik (`candidates`, `election_settings`) lewat REST dengan publishable key. Semua operasi tulis dan semua RPC pemilih/admin hanya bisa dipanggil `service_role` dari `/api/*`.
- **Email Gateway:** Gmail SMTP via `nodemailer` (port 465 SSL). Kredensial hanya dari env `SMTP_USER` / `SMTP_PASS`.
- **Configuration:** `build.js` menyalin file publik saja ke `dist/` dan membuat `dist/supabase-config.js` dari env. Hanya file di `PUBLIC_FILES` / `PUBLIC_DIRS` yang ter-deploy.
- **Environment Variables (Vercel):** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_USER`, `SMTP_PASS`, `ADMIN_SESSION_SECRET`, opsional `ALLOWED_ORIGINS`. Lihat `.env.example`.

---

## 3. Voter Verification & Anti-Curang Flow
- **Input Form:** Hanya meminta **NIM Mahasiswa** dan **Username Email UGM** (domain `@mail.ugm.ac.id` terkunci otomatis).
- **Tidak Memerlukan Input Nama:** Input nama ditiadakan agar alur cepat dan menghindari typo pencocokan nama.
- **OTP Verification:**
  1. Mahasiswa input NIM dan email UGM.
  2. `/api/send-otp` memanggil RPC `voter_request_otp`: OTP 6 digit dari `gen_random_bytes`, disimpan sebagai hash SHA-256 di `private.voter_otps`, berlaku 10 menit. Jeda kirim ulang 60 detik dan maksimal 6 email per jam per alamat dihitung di database (hanya OTP yang benar-benar terbit).
  3. `/api/verify-otp` mengirim email + **NIM yang sama** + kode ke `voter_verify_otp` (maks. 5 percobaan per kode; tebakan dengan NIM berbeda tidak dihitung, jadi orang yang hanya tahu email korban tidak bisa membakar kodenya). Jika benar, server menerbitkan **token surat suara sekali pakai** (berlaku 30 menit, disimpan sebagai hash di `private.ballot_tokens`).
  4. Browser menyimpan token di `sessionStorage` (`kmtedi_ballot_token`). NIM/email di sessionStorage hanya untuk tampilan.
  5. `/api/cast-vote` mengirim token + `candidate_id` ke `voter_cast_ballot`, yang secara atomik menghapus token, mencatat pemilih di `registered_voters`, dan menambah `vote_tallies`.
- **Rate limit per IP sengaja longgar** (OTP 60, verifikasi 150, vote 150 per 15 menit) karena ratusan mahasiswa bisa berbagi satu IP wifi kampus. Pengaman utama ada di batas per email/per kode di database. Login admin: 5 per 15 menit per IP (tanpa batas global agar panitia tidak bisa dikunci orang lain).
- **DPT opsional:** jika tabel `public.eligible_voters (nim, email)` berisi data, hanya pasangan NIM + email terdaftar yang bisa meminta OTP. Isi lewat Supabase Table Editor (import CSV).
- **Aturan Satu Suara (Anti-Duplikasi):**
  - Satu NIM dan satu email hanya dapat memilih 1 kali.
  - Dijamin oleh constraint unik `registered_voters.nim` dan `registered_voters.email` di dalam transaksi `voter_cast_ballot`.
  - Kerahasiaan suara: tidak ada baris suara per pemilih. Suara hanya menambah penghitung `vote_tallies`, dan setiap suara meng-update semua baris penghitung sekaligus agar metadata baris tidak membocorkan pilihan. Rekap per calon di dashboard admin disembunyikan selama bilik suara terbuka.

---

## 4. Admin Panel & Master PIN
- **Route:** `/admin`
- **PIN Admin:** disimpan sebagai hash bcrypt di `private.admin_credentials`, tidak pernah ditulis di repo atau dokumen. Ganti lewat SQL Editor: `select private.set_admin_pin('PIN-BARU-MIN-12-KARAKTER');` (otomatis mengakhiri semua sesi admin lama).
- **Login Admin:** `/api/admin` action `login` (rate limit 5x / 15 menit per IP) mengembalikan token sesi HMAC berlaku 2 jam, disimpan di `sessionStorage` (`kmtedi_admin_session`) dan dikirim sebagai `Authorization: Bearer`.
- **Fitur Admin:**
  1. Saklar Bilik Suara (`voting_open` true/false).
  2. Kontrol Countdown Jadwal (`voting_start` dan `voting_end`).
  3. CRUD Paslon (Foto, Nomor Urut, Nama, Angkatan, Biodata, Visi Misi, Proker).
  4. Pengaturan Teks Beranda (Hero slides, Marquee, Info).
  5. Monitoring Presensi Pemilih (Daftar NIM, Email UGM, Waktu Memilih).
  6. Rekapitulasi Suara (hanya saat bilik suara tertutup) & Reset Kotak Suara (wajib ketik RESET, hanya saat bilik suara tertutup).

---

## 5. Visual Identity & Brand System (KMTEDI)
Palet warna resmi media KMTEDI:
- **Burgundy Primer:** `#250014`
- **Navy Primer:** `#000113`
- **Oranye Sekunder:** `#E46527`
- **Amber / Emas Sekunder:** `#FFB42B`
- **Krem Terang:** `#FFF9EF`
- **Red / Accent:** `#963611`

### Ritme Warna Section Beranda:
1. **Top Navbar:** Background Navy (`#000113`), logo KMTEDI transparan, menu `Acara`, `Calon`, `Alur`, dan tombol `Verifikasi Pemilih (NIM)`.
2. **Hero:** Background Burgundy (`#250014`) dengan carousel foto geser (swipeable di HP dan mouse drag di desktop).
3. **Marquee:** Pita oranye menyala (`#E46527`) dengan teks gelap.
4. **Section 01 / INFO (Kenali Acaranya):** Background Krem Terang (`#FFF9EF`) dengan tipografi marun gelap untuk variasi kontras.
5. **Section 02 / CALON (Kenali Calonmu):** Background Oranye (`#E46527`) dengan kartu paslon biru navy (`#000113`). Di mobile (<= 820px), kartu menjadi carousel horizontal yang bisa di-swipe ke samping dengan indikator dots.
6. **Section 03 / TIMELINE (Alur Pemilwa):** Background Merah Burgundy (`#250014`) dengan nomor dan badge emas terang (`#FFB42B`). Di mobile, badge status berada di pojok kanan utuh tanpa pecah baris.
7. **Section 04 / STATUS (Bilik Suara):** Background Biru Navy (`#000113`) dengan label `04 / STATUS` rata kiri di atas judul, dan kotak countdown real-time (Hari, Jam, Menit, Detik) berwarna amber (`#FFB42B`).
8. **Footer:** Background Biru Navy (`#000113`).

### Motif Media KMTEDI (`motifs.css`)
Lapisan di atas desain utama, mengikuti feed Instagram @kmtedi.sv.ugm. Font dan warna section tetap seperti di atas.
- **Sambungan antar section:** setiap section memudar ke warna section berikutnya (krem > oranye > burgundy > navy) agar halaman terasa satu alur, tidak patah per blok.
- **Cahaya latar (`.bg-glow`):** sinar radial berputar pelan + orb cahaya bernapas di hero, calon, timeline, dan bilik suara. Dimasking memudar di tepi atas/bawah agar tidak terpotong.
- **Lanyard:** kartu hero dan kartu calon tergantung di tali lanyard, berayun halus; kartu calon berayun saat hover.
- **Kotak surat:** tiket jadwal (tanggal/waktu dari `voting_start`/`voting_end`) keluar dari amplop oranye di section Info.
- **Animasi masuk:** elemen `.reveal` muncul saat digulir. Semua animasi mati otomatis saat `prefers-reduced-motion`.

### Anti-Slop & Quality Rules (Wajib Dipatuhi):
- **DILARANG menggunakan emoji apapun** pada tombol, badge, modal, teks, atau navbar.
- **DILARANG menggunakan em-dash ('—')** pada copy/tulisan UI. Gunakan tanda minus biasa ('-') atau koma.
- **Tanpa inline script / `onclick`:** CSP produksi `script-src 'self'`. Tambahkan logika di `app.js`/`admin.js` dan pakai atribut `data-action`.
- **Gunakan popup modal internal (`showNotice`):** Jangan pernah memakai `window.alert()` browser native yang terlihat kaku. Semua alert sistem sudah di-override ke modal bertema KMTEDI.
- **Responsif Mobile:** Modal pop-up harus memiliki padding aman dari border layar HP (`max-width: 84vw`) agar tidak menempel ke tepi layar.
- **Teks Latar Gelap Harus Terang:** Setiap teks atau badge di atas background burgundy/navy wajib memakai warna terang (`#FFF9EF`, `#FFB42B`) dengan rasio kontras tinggi.

---

## 6. Project Structure & Key Files
```
├── AGENT_BRIEF.md          # Dokumen panduan handoff agent ini
├── index.html              # Halaman publik beranda, modal paslon 3 slide, countdown timer, alur OTP
├── admin.html              # Dashboard admin ber-PIN
├── branding.css            # Stylesheet tema resmi KMTEDI, responsivitas mobile & modal
├── motifs.css              # Cahaya latar, lanyard, kotak surat, animasi masuk
├── boot.js                 # Menandai html.js sedini mungkin (anti kedip animasi)
├── app.js                  # Seluruh logika halaman publik (tanpa inline script, CSP ketat)
├── admin.js                # Seluruh logika panel admin
├── package.json            # Scripts build dan test runner
├── vercel.json             # Konfigurasi Vercel deployment
├── build.js                # Injeksi env var Supabase ke supabase-config.js
├── api/
│   ├── send-otp.js         # Kirim OTP email UGM via Gmail SMTP
│   ├── verify-otp.js       # Verifikasi OTP, terbitkan token surat suara
│   ├── cast-vote.js        # Kirim suara dengan token sekali pakai
│   └── admin.js            # Semua aksi admin (login PIN + sesi HMAC)
├── lib/
│   └── server.js           # Helper API: service client, rate limit, validasi, sesi
├── assets/
│   ├── kmtedi-logo.png     # Logo resmi KMTEDI transparan
│   ├── favicon.png         # Favicon resmi berlatar navy
│   ├── media-spark.webp    # Artwork resmi KMTEDI
│   └── media-petals.webp   # Artwork resmi KMTEDI
├── tests/
│   └── branding.test.cjs   # Automated test suite (9 subtests)
└── supabase/migrations/    # Riwayat skema SQL dan RPC functions
```

---

## 7. Testing & Deployment Commands
- **Jalankan Automated Tests:**
  ```bash
  npm test
  ```
  Seluruh subtest harus berstatus `ok` sebelum melakukan commit.
- **Uji keamanan database (wajib jika mengubah migrasi):**
  ```bash
  npm run test:db
  ```
  Menjalankan semua migrasi di Postgres lokal (PGlite) dengan peran ala Supabase lalu mencoba serangan yang pernah ditemukan.
- **Urutan migrasi di Supabase SQL Editor:** jalankan file di `supabase/migrations/` berurutan nama. `20261025000000_security_hardening.sql` lalu `20261026000000_security_hardening_2.sql` (jika menjalankan ulang, jalankan keduanya berurutan).
- **Deploy ke Production Vercel:**
  ```bash
  npm test && git add -A && git commit -m "deskripsi perbaikan" && git push origin main && npx vercel --prod --yes
  ```
- **Aturan Keamanan (Wajib):**
  - Jangan pernah hardcode service role key, app password Gmail, PIN admin, atau session secret di repo atau dokumen. Repo GitHub ini publik.
  - Jangan pernah `grant execute ... to anon` untuk RPC baru. Semua RPC baru wajib `service_role` saja dan dipanggil dari `/api/*`.
  - Semua data dari database wajib lewat `escapeHtml()` / `richText()` / `safeImage()` sebelum masuk `innerHTML` atau atribut.
  - File baru yang perlu dipublikasikan wajib ditambahkan ke `PUBLIC_FILES` / `PUBLIC_DIRS` di `build.js`.
