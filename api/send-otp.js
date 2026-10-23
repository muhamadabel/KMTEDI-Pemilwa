const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { nim, name, email_prefix } = req.body || {};

    if (!nim || !name || !email_prefix) {
      return res.status(400).json({ success: false, error: 'NIM, Nama Lengkap, dan Email UGM wajib diisi!' });
    }

    let cleanPrefix = email_prefix.trim().toLowerCase();
    cleanPrefix = cleanPrefix.replace(/@.*$/, ''); // Ambil hanya username jika user mengetik @mail.ugm.ac.id

    const fullEmail = `${cleanPrefix}@mail.ugm.ac.id`;

    // Hubungkan ke Supabase
    const supabaseUrl = process.env.SUPABASE_URL || 'https://geoqhztzaputpuiyheqm.supabase.co';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_3pevMC-bvGNU5xPy2SYJjA_ysQUSBxR';
    const db = createClient(supabaseUrl, supabaseAnonKey);

    // Generate OTP di database
    const { data, error } = await db.rpc('generate_voter_otp', {
      p_nim: nim.trim(),
      p_name: name.trim(),
      p_email: fullEmail
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const otpCode = data.otp_code;

    // Kirim email via Nodemailer (Gmail SMTP)
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER || 'muhamadabelugm@gmail.com',
        pass: process.env.SMTP_PASS || 'zyecrctyadwyfbgp'
      }
    });

    const mailOptions = {
      from: `"Pemilwa KMTEDI 2026" <${process.env.SMTP_USER || 'muhamadabelugm@gmail.com'}>`,
      to: fullEmail,
      subject: `Kode OTP Pemilwa KMTEDI: ${otpCode}`,
      html: `
        <div style="font-family:sans-serif;background:#240a17;color:#fff0d2;padding:32px 24px;border-radius:8px;max-width:500px;margin:auto">
          <div style="font-size:11px;font-weight:bold;letter-spacing:0.15em;color:#ffc857;margin-bottom:8px">PEMILWA KMTEDI 2026</div>
          <h2 style="margin:0 0 16px;color:#fff0d2;font-size:22px;text-transform:uppercase">Kode Verifikasi Hak Suara</h2>
          <p style="color:#d8a99c;font-size:14px;line-height:1.5">Halo <strong>${name}</strong> (NIM: ${nim}),</p>
          <p style="color:#d8a99c;font-size:14px;line-height:1.5">Berikut adalah 6 digit kode OTP rahasia Anda untuk membuka bilik suara pemilihan Ketua KMTEDI 2026:</p>
          <div style="background:#4a1021;border:2px solid #ffc857;color:#ffc857;font-size:36px;font-weight:bold;letter-spacing:0.25em;text-align:center;padding:16px;border-radius:6px;margin:20px 0">
            ${otpCode}
          </div>
          <p style="color:#d8a99c;font-size:12px;line-height:1.4">Kode ini berlaku selama 5 menit. Jangan berikan kode ini kepada siapa pun untuk menjaga keaslian suara Anda.</p>
          <hr style="border:0;border-top:1px solid rgba(255,240,210,0.15);margin:20px 0">
          <small style="color:#99727a">Panitia Pemilwa KMTEDI 2026</small>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({
      success: true,
      email: fullEmail,
      message: `Kode OTP 6 angka telah dikirim ke ${fullEmail}. Silakan cek kotak masuk email Anda.`
    });

  } catch (err) {
    console.error('Error in send-otp:', err);
    return res.status(500).json({ success: false, error: err.message || 'Gagal mengirim OTP' });
  }
};
