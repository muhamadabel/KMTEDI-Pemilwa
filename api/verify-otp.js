const { serviceDb, clientIp, rateLimit, normalizeEmail, str, dbFailure, handler, HttpError } = require('../lib/server');

module.exports = handler(async (body, req) => {
  const email = normalizeEmail(body.email);
  const otp = str(body.otp, 12);
  if (!/^\d{6}$/.test(otp)) throw new HttpError(400, 'Kode OTP harus 6 digit angka.');

  const db = serviceDb();
  await rateLimit(db, 'verify-ip', clientIp(req), 20, 15 * 60);

  const { data, error } = await db.rpc('voter_verify_otp', { p_email: email, p_otp: otp });
  if (error) throw dbFailure(error);
  if (!data.ok) throw new HttpError(400, data.error);

  return {
    voter: { nim: data.nim, email: data.email },
    ballot_token: data.ballot_token,
    message: 'Verifikasi berhasil.'
  };
});
