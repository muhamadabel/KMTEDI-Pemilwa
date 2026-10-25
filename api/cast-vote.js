const { serviceDb, clientIp, rateLimit, str, dbFailure, handler, HttpError } = require('../lib/server');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = handler(async (body, req) => {
  const token = str(body.ballot_token, 128);
  const candidateId = str(body.candidate_id, 64);
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, 'Sesi pemilih tidak valid. Verifikasi ulang lewat OTP.');
  if (!UUID_RE.test(candidateId)) throw new HttpError(400, 'Calon tidak valid.');

  const db = serviceDb();
  await rateLimit(db, 'vote-ip', clientIp(req), 150, 15 * 60);

  const { error } = await db.rpc('voter_cast_ballot', { p_token: token, p_candidate_id: candidateId });
  if (error) throw dbFailure(error);

  return { message: 'Suara kamu sudah tercatat secara sah dan rahasia.' };
});
