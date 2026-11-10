# PANDUAN SETUP & PENGEMBANGAN PROYEK PEMILWA KMTEDI 2026
Dokumen Panduan Lengkap untuk Claude / AI Coding Agent

---

## 1. Ringkasan & Akses Proyek
* **Nama Proyek:** Website Pemilihan Umum Mahasiswa (Pemilwa) KMTEDI 2026
* **Lokasi Lokal:** `/Users/user/Documents/KMTEDI-Pemilwa`
* **Repositori Git:** `https://github.com/muhamadabel/KMTEDI-Pemilwa` (Branch: `main`)
* **Live Production:** [https://kmtedi-pemilwa.vercel.app](https://kmtedi-pemilwa.vercel.app)
* **Panel Admin:** [https://kmtedi-pemilwa.vercel.app/admin](https://kmtedi-pemilwa.vercel.app/admin) (Sengaja tidak ada link di navbar publik demi privasi)
* **Master PIN Admin:** `abelganteng`

---

## 2. Tech Stack & Arsitektur
* **Frontend:** Pure HTML5, CSS3, Vanilla JavaScript (ES6+). Ringan, cepat dimuat, tanpa overhead framework/bundler React atau Next.js.
* **Database & BaaS:** Supabase PostgreSQL (Project ID: `geoqhztzaputpuiyheqm`).
* **Klien Database Browser:** `@supabase/supabase-js@2` dimuat via CDN, konfigurasi di-generate saat build ke `supabase-config.js`.
* **Serverless API (Vercel):**
  * `api/send-otp.js`: Mengirim 6 digit OTP ke inbox mahasiswa via Gmail SMTP panitia.
  * `api/verify-otp.js`: Memverifikasi kode OTP yang diinput mahasiswa.
* **Email Gateway:** Gmail SMTP (`smtp.gmail.com:465` SSL) via `nodemailer` menggunakan akun panitia (`muhamadabelugm@gmail.com`).

---

## 3. Environment Variables (Vercel Production)
* `SUPABASE_URL`: `https://geoqhztzaputpuiyheqm.supabase.co`
* `SUPABASE_ANON_KEY`: `sb_publishable_3pevMC-bvGNU5xPy2SYJjA_ysQUSBxR`
* `SMTP_USER`: `muhamadabelugm@gmail.com`
* `SMTP_PASS`: `zyecrctyadwyfbgp` (Google App Password 16 karakter panitia)

---

## 4. Alur Bisnis & Verifikasi Pemilih (Anti-Curang)
1. **Formulir Pemilih:** Hanya meminta **NIM Mahasiswa** dan **Username Email UGM** (akhiran `@mail.ugm.ac.id` terkunci otomatis). Kolom input nama ditiadakan agar proses verifikasi cepat dan tidak terhambat typo penulisan nama.
2. **Pengiriman OTP:** Kode OTP 6-digit acak dibuat di database via RPC `generate_voter_otp` dan dikirim ke email kampus UGM pemilih.
3. **Verifikasi:** Mahasiswa memasukkan kode OTP 6-digit yang divalidasi via RPC `verify_voter_otp`. Setelah berhasil, status pemilih disimpan di `sessionStorage` (`kmtedi_voter_nim`, `kmtedi_voter_email`).
4. **Pemberian Suara (Voting):**
   * Pemilih mengklik tombol **"Pilih"** pada kartu paslon atau dari dalam modal detail paslon.
   * Muncul modal konfirmasi akhir (*Double Check*).
   * Suara dicatat via RPC `cast_vote_by_nim_and_email`.
5. **Asas Satu Suara & Secret Ballot (Luber Jurdil):**
   * Satu NIM dan satu Email UGM hanya berhak memilih **1 kali**. Percobaan vote ganda otomatis ditolak oleh database.
   * Suara tersimpan secara anonim di tabel `votes (candidate_id)` terpisah dari tabel `registered_voters`, sehingga pilihan pemilih 100% rahasia.

---

## 5. Struktur Berkas Repositori
```
/Users/user/Documents/KMTEDI-Pemilwa/
├── index.html              # Halaman beranda utama publik, modal paslon, alur OTP, countdown timer
├── admin.html              # Dashboard admin ber-PIN untuk kontrol jadwal, paslon, dan hasil
├── branding.css            # Stylesheet tema resmi KMTEDI, layout responsif HP, modal, & animasi
├── build.js                # Skrip build Vercel yang menginjeksi environment variables ke supabase-config.js
├── vercel.json             # Konfigurasi deployment Vercel
├── package.json            # Scripts dan dependensi pengujian
├── api/
│   ├── send-otp.js         # Endpoint pengiriman email OTP via Gmail SMTP
│   └── verify-otp.js       # Endpoint validasi kode OTP
├── assets/
│   ├── kmtedi-logo.png     # Logo transparan resmi KMTEDI
│   ├── favicon.png         # Favicon resmi
│   ├── media-spark.webp    # Elemen grafis resmi KMTEDI
│   ├── media-petals.webp   # Elemen grafis resmi KMTEDI
│   ├── media-lotus.webp    # Aset alternatif KMTEDI
│   └── media-star.webp     # Aset alternatif KMTEDI
├── tests/
│   └── branding.test.cjs   # Test suite otomatis (9 test cases)
└── supabase/migrations/    # Berkas migrasi skema SQL dan RPC functions
```

---

## 6. Pedoman Desain & Aturan Wajib (Brand Rules & Anti-Slop)
Pengguna memiliki standar visual yang sangat ketat:
1. **Palet Warna Resmi KMTEDI:**
   * Burgundy Primer: `#250014`
   * Navy Primer: `#000113`
   * Oranye Sekunder: `#E46527`
   * Amber / Emas Sekunder: `#FFB42B`
   * Warm Cream: `#FFF9EF`
2. **Ritme Kontras Section Beranda:**
   * **Hero:** Latar Burgundy `#250014` (gambar carousel dapat di-swipe touch/mouse drag).
   * **Marquee Ribbon:** Latar pita oranye `#E46527` dengan teks gelap.
   * **Section 01 / INFO:** Latar krem terang `#FFF9EF` dengan tipografi burgundy gelap.
   * **Section 02 / CALON:** Latar oranye `#E46527` dengan kartu kandidat biru navy `#000113`. Di layar HP (`<= 820px`), kartu tersusun horizontal (*swipeable carousel* dengan *scroll-snap* dan indikator navigasi).
   * **Section 03 / TIMELINE:** Latar merah burgundy `#250014` dengan teks krem dan badge status emas terang `#FFB42B`. Di HP, badge status berada di baris judul tanpa teks yang bertumpuk.
   * **Section 04 / STATUS (Bilik Suara):** Latar biru navy `#000113` dengan label `04 / STATUS` rata kiri di atas judul, dan kotak status amber `#FFB42B` berisi **Countdown Real-Time** (Hari : Jam : Menit : Detik).
   * **Footer:** Latar biru navy `#000113`.
3. **Aturan Elemen Latar Gelap:**
   * Semua teks, border, dan badge di atas section berlatar gelap wajib menggunakan warna terang (`#FFF9EF`, `#FFB42B`, atau putih) agar keterbacaan tinggi dan tidak redup/kusam.
4. **Anti-Slop Guidelines:**
   * **DILARANG menggunakan emoji apapun** (seperti 🗳️, ↗, ✅, 🎉) pada teks, tombol, modal, atau navbar.
   * **DILARANG menggunakan em-dash ('—')** pada copy/tulisan (terkesan buatan AI otomatis). Gunakan tanda hubung strip biasa ('-') atau tanda koma.
   * **DILARANG menggunakan `window.alert()` bawaan browser.** Gunakan fungsi modal bawaan `showNotice({...})` yang sudah menyatu dengan tema UI KMTEDI.
   * **Responsivitas Modal di HP:** Modal dialog harus memiliki margin/padding yang cukup dari tepi layar ponsel (`width: min(330px, 84vw)`), jangan biarkan kotak modal atau bayangannya menempel ke batas layar.
   * **Tombol Tutup Modal:** Gunakan tombol lingkaran minimalis transparan dengan ikon silang `×` tipis, bukan kotak persegi hitam pekat.

---

## 7. Perintah Pengujian & Deployment
* **Menjalankan Automated Tests:**
  ```bash
  npm test
  ```
  *(Pastikan seluruh 9 subtest berstatus `ok`)*
* **Mendeploy ke Vercel Production:**
  ```bash
  git add -A
  git commit -m "Deskripsi perubahan"
  git push origin main
  npx vercel --prod --yes
  ```
