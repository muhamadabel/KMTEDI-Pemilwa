const { serviceDb, clientIp, rateLimit, normalizeEmail, str, dbFailure, handler, HttpError } = require('../lib/server');

const BALLOT_TOKEN_RE = /^[0-9a-f]{64}$/;

function createVerifyOtpHandler(deps = {}) {
  const getDb = deps.getDb || serviceDb;

  return handler(async (body, req) => {
    const email = normalizeEmail(body.email);
    const otp = str(body.otp, 12);
    if (!/^\d{6}$/.test(otp)) throw new HttpError(400, 'Kode OTP harus 6 digit angka.');

    const db = getDb();
    await rateLimit(db, 'verify-ip', clientIp(req), 600, 15 * 60);

    // Verifikasi OTP murni berdasarkan email ternormalisasi + kode OTP.
    // Nilai NIM dari klien sengaja tidak menjadi syarat verifikasi.
    const { data, error } = await db.rpc('voter_verify_otp', {
      p_email: email,
      p_otp: otp
    });
    if (error) throw dbFailure(error);
    if (!data || !data.ok) {
      throw new HttpError(400, (data && data.error) || 'Kode OTP tidak valid atau kedaluwarsa.');
    }
    if (!BALLOT_TOKEN_RE.test(String(data.ballot_token || ''))) {
      throw new HttpError(500, 'Terjadi gangguan pada server. Coba lagi.');
    }

    return {
      voter: { nim: data.nim || null, email: data.email },
      ballot_token: data.ballot_token,
      message: 'Verifikasi berhasil.'
    };
  });
}

const verifyOtpHandler = createVerifyOtpHandler();
verifyOtpHandler.createHandler = createVerifyOtpHandler;
module.exports = verifyOtpHandler;
