const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
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
    const { email, otp } = req.body || {};

    if (!email || !otp) {
      return res.status(400).json({ success: false, error: 'Email dan Kode OTP wajib diisi!' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://geoqhztzaputpuiyheqm.supabase.co';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_3pevMC-bvGNU5xPy2SYJjA_ysQUSBxR';
    const db = createClient(supabaseUrl, supabaseAnonKey);

    const { data, error } = await db.rpc('verify_voter_otp', {
      p_email: email.trim().toLowerCase(),
      p_otp: otp.trim()
    });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      voter: data,
      message: 'Verifikasi berhasil!'
    });

  } catch (err) {
    console.error('Error in verify-otp:', err);
    return res.status(500).json({ success: false, error: err.message || 'Gagal memverifikasi OTP' });
  }
};
