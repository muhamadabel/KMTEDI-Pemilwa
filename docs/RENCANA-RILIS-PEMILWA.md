# Rencana Rilis Pemilwa KMTEDI: Siap 300 sampai 1.000 Pemilih

Dokumen kerja internal Hermes. Bukan untuk dibagikan ke agent pengembang.
Status: perubahan siap di branch lokal, belum di-push, belum dimigrasikan, belum di-deploy.
Commit dasar produksi: 6d4f411. Branch kerja: prep/pemilwa-rilis.

## 1. Ringkasan keputusan yang sudah final

- Hitungan suara dipisah dari identitas pemilih.
- Pengiriman email tetap Gmail SMTP pada rilis ini. Ini batas keras: Gmail sekitar 500 email per hari, sehingga 1.000 pemilih tidak tertampung tanpa pindah provider.
- NIM hanya catatan, tidak pernah menjadi syarat verifikasi.
- Deployment dan uji akhir menjadi tanggung jawab Hermes, bukan agent pengembang.

## 2. Hasil review yang sudah dilakukan

Sudah diverifikasi sendiri, bukan hanya dari laporan agent:

- npm test: 31 lulus.
- npm run test:db: 20 lulus pada PostgreSQL in-memory.
- npm run test:load: 300 pemilih berhasil, 0 error, tally cocok persis 100/100/100, sekitar 46 ms per request.
- Build allowlist menghasilkan tepat 6 entri: admin.html, admin.js, assets, branding.css, index.html, supabase-config.js.
- Fungsi voter_cast_ballot mengonsumsi token dengan DELETE ... RETURNING, sehingga token sekali pakai.
- Presensi memakai ON CONFLICT (email) DO UPDATE ... WHERE has_voted = false, sehingga satu email satu suara atomik.
- Talley diperbarui dalam satu UPDATE dengan kunci terurut dan predikat candidate_id is not null.
- Seluruh RPC dicabut dari anon/authenticated dan hanya diberikan ke service_role.
- Tidak ada fungsi admin yang dapat dipanggil dari browser dengan anon key.

Temuan yang sudah ditutup di branch ini:

- Belum ada tombol rollback yang menjaga data. Ditambahkan supabase/rollback/20261125000000_pemilwa_siap_300_rollback.sql yang mengembalikan voter_verify_otp(p_email, p_nim, p_otp) dan cast_vote_by_nim_and_email tanpa menghapus presensi maupun tally.
- Belum ada pemeriksaan pra-migrasi. Ditambahkan supabase/rollback/preflight_check.sql yang hanya membaca.

## 3. Risiko yang masih terbuka

1. PIN admin kosong setelah migrasi.
   Migrasi memindahkan kredensial ke private.admin_credentials tetapi tidak mengisinya. PIN literal di kode sudah dihapus. Bila migrasi dijalankan tanpa mengatur PIN lebih dulu, panel admin terkunci total.
   Wajib: jalankan select private.set_admin_pin('<PIN_BARU_MIN_12_KARAKTER>'); sebelum atau segera setelah migrasi, sebelum deploy.

2. Kunci akses tidak lagi punya kanal cadangan.
   Satu-satunya jalur adalah /api/admin. Jika ADMIN_SESSION_SECRET berubah, semua sesi lama tidak berlaku, dan itu memang diinginkan.

3. Bukti konkurensi masih in-memory.
   pglite menjalankan PL/pgSQL dan constraint asli, tetapi pada satu koneksi backend. Kontensi lock multi-koneksi sungguhan baru terbukti setelah uji beban ke Supabase.
   Pelaksanaan: scripts/load-test-300.mjs --mode=supabase terhadap proyek Supabase terpisah (bukan geoqhztzaputpuiyheqm), dengan TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY, dan CONFIRM_SANDBOX_LOAD_TEST. Skrip menolak project ref produksi dan menolak TEST_SUPABASE_URL yang sama dengan SUPABASE_URL.

4. Kuota Gmail.
   Gmail SMTP aman untuk sekitar 300 pemilih dalam sehari bila kirim ulang jarang. Untuk 1.000 pemilih, pindah ke provider email via HTTPS API wajib sebelum bilik dibuka. Belum dikerjakan karena keputusan pemilik masih mempertahankan Gmail.

5. Riwayat Git masih memuat PIN lama.
   Penghapusan dari kode tidak mencabut nilai di riwayat. Rotasi PIN wajib, dan repo sebaiknya tetap diperlakukan sebagai publik.

6. Keadaan setempat tidak bisa dipakai untuk migrasi.
   .env.test dan environment Vercel hanya menyimpan placeholder [SENSITIVE], bukan service key asli. Migrasi harus dijalankan dari lingkungan yang memegang service_role key produksi, atau lewat SQL editor Supabase yang sudah login.

## 4. Urutan rilis yang akan dijalankan

### Tahap A: persiapan lokal (tanpa menyentuh produksi)

1. Selesaikan branch prep/pemilwa-rilis berisi merge siap-300 dan kedua skrip SQL.
2. Jalankan ulang npm test, npm run test:db, dan npm run test:load. Ketiganya harus lulus pada commit yang akan dinaikkan.
3. Uji tampilan lokal pada lebar ponsel: carousel calon, modal OTP, hitung mundur setelah reload, dan halaman admin.
4. Push branch, buka draft pull request. Jangan merge ke main sebelum Tahap B lulus.

### Tahap B: uji pada database terpisah (wajib, bukan opsional)

1. Siapkan proyek Supabase sandbox terpisah dari produksi.
2. Terapkan seluruh migrasi berurutan pada sandbox tersebut.
3. Jalankan scripts/load-test-300.mjs --mode=supabase dengan 300 akun, konkurensi 30.
4. Ulangi dengan --voters=1000 --concurrency=150 untuk melihat titik melambat.
5. Verifikasi manual: token yang sama dua kali ditolak, email beda huruf besar/kecil ditolak pada percobaan kedua, OTP ke-3 dalam satu menit mendapat 429 dengan Retry-After.
6. Cek latensi p95 dan p99. Batas wajar untuk pemilih: p95 di bawah 500 ms.

### Tahap C: cutover produksi

Dilakukan hanya setelah Tahap B bersih, dan idealnya di luar jam ramai.

1. Ambil backup database produksi. Verifikasi restore ke sandbox supaya backup terbukti bisa dipakai.
2. Jalankan preflight_check.sql pada produksi. Simpan keluarannya, terutama total suara dan jumlah presensi.
3. Siapkan PIN admin baru minimal 12 karakter. Jangan menuliskannya di chat, dokumen, atau commit.
4. Jalankan migrasi 20261125000000 pada produksi.
5. Jalankan select private.set_admin_pin(...) dengan PIN baru.
6. Jalankan ulang preflight_check.sql. Bandingkan total suara dan jumlah presensi dengan langkah 2. Angka harus sama persis.
7. Merge ke main, lalu deploy ke Vercel.
8. Pastikan keenam environment variable produksi tetap ada. Tidak ada variable baru yang wajib.

### Tahap D: verifikasi pascadeploy

1. Buka halaman publik, pastikan build baru tersaji dan aset termuat.
2. Login admin dengan PIN baru. Pastikan PIN lama ditolak.
3. Cek dashboard: jumlah calon benar, total suara sama dengan backup, status bilik sesuai jadwal.
4. Coba satu alur pemilih dengan akun yang disetujui panitia untuk uji, lalu hapus jejaknya sesuai kebijakan panitia. Jangan memakai akun mahasiswa sungguhan.
5. Pantau log Vercel untuk error 500 dan log Supabase untuk percobaan RPC yang ditolak.

### Tahap E: rollback bila perlu

Rollback kode dan data dipisah, dan urutannya penting.

- Bila masalah muncul SEBELUM bilik dibuka: rollback aplikasi ke commit sebelumnya, lalu jalankan supabase/rollback/20261125000000_pemilwa_siap_300_rollback.sql, atau pulihkan snapshot pra-migrasi.
- Bila masalah muncul SETELAH ada suara masuk: jangan pulihkan snapshot, karena suara yang masuk setelah snapshot akan hilang. Jalankan skrip rollback fungsi saja. Skrip itulah yang mengembalikan RPC lama tanpa menyentuh registered_voters dan vote_tallies.
- Rollback skrip tidak menghapus presensi maupun tally. Jumlah suara harus tetap sama sebelum dan sesudah rollback.
- Setelah rollback, PIN admin tetap memakai kredensial baru di private.admin_credentials.

## 5. Keputusan yang masih menunggu pemilik

1. Perkiraan jumlah peserta: 300 atau bisa sampai 1.000. Ini menentukan apakah pindah provider email menjadi wajib sebelum hari-H.
2. Kalau perlu pindah: Brevo (gratis 300 email per hari) atau Resend (gratis 100 per hari). Untuk 1.000 pemilih, paket berbayar termurah pada salah satunya.
3. Apakah hasil boleh dipublikasikan otomatis saat bilik ditutup, atau diputuskan panitia. Ini memengaruhi pengaturan results_published.

## 6. Larangan yang tetap berlaku

- Jangan memakai akun mahasiswa sungguhan untuk uji.
- Jangan menjalankan uji beban ke proyek produksi.
- Jangan menaruh PIN, service key, atau isi .env di commit, dokumen, atau jawaban.
- Jangan memigrasikan database tanpa backup yang sudah terbukti bisa dipulihkan.
