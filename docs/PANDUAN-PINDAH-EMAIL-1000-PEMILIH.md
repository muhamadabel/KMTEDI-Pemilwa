# Panduan Pindah Email untuk 1000 Pemilih

Untuk dibaca panitia, bukan agent. Dokumen ini menjelaskan kenapa Gmail tidak cukup dan cara pindahnya tanpa mengubah kode lagi.

## Kenapa Gmail tidak cukup

Akun Gmail gratis dibatasi sekitar 500 email per hari. Untuk pemilihan dengan 1000 peserta, kebutuhan email kira-kira:

| Skenario | Email terkirim | Status |
| --- | --- | --- |
| Semua orang meminta kode sekali | 1000 | Melebihi batas Gmail |
| Ditambah kirim ulang karena salah ketik atau kode telat | 1200 sampai 1500 | Jauh melebihi |
| Email masuk spam lalu diminta ulang | Bisa 1800 | Tidak mungkin dengan Gmail |

Kalau tetap memakai Gmail, sekitar 500 peserta terakhir tidak akan menerima kode dan tidak bisa memilih.

## Pilihan provider

Keduanya sudah didukung kode sejak commit terakhir. Yang perlu dilakukan hanya membuat akun dan mengisi nama setting di Vercel.

| Provider | Kuota gratis | Kuota berbayar termurah | Catatan |
| --- | --- | --- | --- |
| Brevo | 300 email per hari | sekitar 9 USD per bulan untuk 5000 email | Pengirim harus memakai alamat yang diverifikasi |
| Resend | 100 email per hari | sekitar 20 USD per bulan untuk 50000 email | Perlu verifikasi domain untuk pengirim sendiri |

Rekomendasi: Brevo, karena kuota gratis lebih besar dan verifikasi pengirim lebih longgar untuk alamat Gmail.

## Langkah pindah dengan Brevo

1. Daftar di brevo.com memakai email panitia.
2. Masuk ke menu SMTP dan API, lalu buat API key baru. Simpan, jangan kirim ke chat.
3. Verifikasi alamat pengirim. Bisa berupa alamat email yang kamu kuasai. Setuju dengan email konfirmasi yang dikirim Brevo.
4. Buka Vercel, masuk ke project kmtedi-pemilwa, menu Settings, Environment Variables. Tambahkan empat nilai berikut untuk environment Production:
   - EMAIL_PROVIDER dengan nilai brevo
   - BREVO_API_KEY dengan API key dari langkah 2
   - MAIL_FROM_ADDRESS dengan alamat pengirim yang sudah diverifikasi
5. Simpan, lalu lakukan redeploy supaya setting baru terbaca.
6. Uji dengan satu alamat email milikmu sendiri. Pastikan kode OTP sampai.

Kalau langkah 6 berhasil, pemilihan siap untuk 1000 peserta.

## Cara kembali ke Gmail

Hapus atau kosongkan EMAIL_PROVIDER. Kode akan otomatis memakai Gmail lagi, dan SMTP_USER serta SMTP_PASS yang lama tetap dipakai.

## Kalau ingin memakai Resend

Sama, tetapi variable yang diperlukan RESEND_API_KEY, nilai EMAIL_PROVIDER diisi resend, dan MAIL_FROM_ADDRESS wajib memakai domain yang sudah diverifikasi di Resend. Resend tidak mengizinkan pengirim dari alamat Gmail biasa untuk volume besar.

## Yang tidak boleh dilakukan

- Jangan memakai lebih dari satu provider sekaligus sebagai cadangan otomatis. Kalau provider utama gagal, lebih baik tampilkan pesan ke pemilih daripada mengirim lewat jalur yang tidak teruji.
- Jangan mengunggah API key ke repositori GitHub.
- Jangan menguji dengan alamat email mahasiswa sungguhan. Pakai alamat milik panitia.

## Batas lain yang perlu dipantau

Supabase free tier membatasi sekitar 30 permintaan OTP per jam untuk fitur bawaan. Karena kode mengirim email sendiri, batas itu tidak berlaku. Yang membatasi hanya provider email dan kuota hariannya.

Untuk pemilihan satu hari dengan 1000 peserta, siapkan paket yang menampung minimal 2000 email supaya kirim ulang tidak menghentikan pemungutan.
