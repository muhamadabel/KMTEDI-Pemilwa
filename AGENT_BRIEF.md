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
- **Backend APIs:** Vercel Serverless Functions (`/api/send-otp.js`, `/api/verify-otp.js`).
- **Email Gateway:** Gmail SMTP via `nodemailer` (port 465 SSL) menggunakan akun panitia `muhamadabelugm@gmail.com` dan Google App Password.
- **Configuration:** `build.js` membuat `supabase-config.js` dari environment variable saat deployment Vercel.

---

## 3. Voter Verification & Anti-Curang Flow
- **Input Form:** Hanya meminta **NIM Mahasiswa** dan **Username Email UGM** (domain `@mail.ugm.ac.id` terkunci otomatis).
- **Tidak Memerlukan Input Nama:** Input nama ditiadakan agar alur cepat dan menghindari typo pencocokan nama.
- **OTP Verification:**
  1. Mahasiswa input NIM dan email UGM.
  2. Endpoint `/api/send-otp` memanggil RPC `public.generate_voter_otp`, membuat 6-digit OTP acak (berlaku 10 menit), lalu mengirimkannya ke email UGM mahasiswa via Gmail SMTP.
  3. Mahasiswa memasukkan 6 digit OTP. Endpoint `/api/verify-otp` memvalidasi kecocokan kode.
  4. Setelah lolos, status pemilih aktif disimpan di `sessionStorage` (`kmtedi_voter`).
- **Aturan Satu Suara (Anti-Duplikasi):**
  - Satu NIM dan satu email hanya dapat memilih 1 kali.
  - Percobaan vote ulang langsung ditolak oleh RPC database `public.cast_vote_by_nim_and_email`.
  - Pilihan suara bersifat rahasia dan anonim (suara tersimpan tanpa relasi identitas pemilih).

---

## 4. Admin Panel & Master PIN
- **Route:** `/admin`
- **Master PIN Aktif:** `abelganteng` (PIN lama `KMTEDI2026` sudah tidak berlaku).
- **Fitur Admin:**
  1. Saklar Bilik Suara (`voting_open` true/false).
  2. Kontrol Countdown Jadwal (`voting_start` dan `voting_end`).
  3. CRUD Paslon (Foto, Nomor Urut, Nama, Angkatan, Biodata, Visi Misi, Proker).
  4. Pengaturan Teks Beranda (Hero slides, Marquee, Info).
  5. Monitoring Presensi Pemilih (Daftar NIM, Email UGM, Waktu Memilih).
  6. Rekapitulasi Suara & Reset Kotak Suara.

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

### Anti-Slop & Quality Rules (Wajib Dipatuhi):
- **DILARANG menggunakan emoji apapun** pada tombol, badge, modal, teks, atau navbar.
- **DILARANG menggunakan em-dash ('—')** pada copy/tulisan UI. Gunakan tanda minus biasa ('-') atau koma.
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
├── package.json            # Scripts build dan test runner
├── vercel.json             # Konfigurasi Vercel deployment
├── build.js                # Injeksi env var Supabase ke supabase-config.js
├── api/
│   ├── send-otp.js         # API Vercel pengiriman OTP email UGM via Gmail SMTP
│   └── verify-otp.js       # API Vercel verifikasi OTP 6 digit
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
  Seluruh 9 subtest harus berstatus `ok` sebelum melakukan commit.
- **Deploy ke Production Vercel:**
  ```bash
  npm test && git add -A && git commit -m "deskripsi perbaikan" && git push origin main && npx vercel --prod --yes
  ```
- **Aturan Keamanan Kredensial:**
  Jangan pernah melakukan hardcode token Supabase service role, app password Gmail, atau session tokens ke dalam repositori git.
