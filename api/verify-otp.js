const { serviceDb, clientIp, rateLimit, normalizeEmail, normalizeNim, str, dbFailure, handler, HttpError, signBallot } = require('../lib/server');

module.exports = handler(async (body, req) => {
  const email = normalizeEmail(body.email);
  if (!body.nim) {
    throw new HttpError(400, 'Sesi verifikasi belum tersinkron. Silakan refresh halaman atau klik Ubah NIM / Email lalu coba lagi.');
  }
  const nim = normalizeNim(body.nim);
  const otp = str(body.otp, 12);
  if (!/^\d{6}$/.test(otp)) throw new HttpError(400, 'Kode OTP harus 6 digit angka.');

  const db = serviceDb();
  await rateLimit(db, 'verify-ip', clientIp(req), 150, 15 * 60);

  const { data, error } = await db.rpc('voter_verify_otp', {
    p_email: email,
    p_nim: nim,
    p_otp: otp
  });
  if (error) throw dbFailure(error);
  if (!data.ok) throw new HttpError(400, data.error);

  const ballotToken = signBallot(data.nim, data.email);

  return {
    voter: { nim: data.nim, email: data.email },
    ballot_token: ballotToken,
    message: 'Verifikasi berhasil.'
  };
});
