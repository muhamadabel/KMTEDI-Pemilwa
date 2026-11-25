const { serviceDb, clientIp, rateLimit, str, dbFailure, handler, HttpError } = require('../lib/server');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BALLOT_TOKEN_RE = /^[0-9a-f]{64}$/;

function createCastVoteHandler(deps = {}) {
  const getDb = deps.getDb || serviceDb;

  return handler(async (body, req) => {
    const token = str(body.ballot_token, 128);
    const candidateId = str(body.candidate_id, 64);

    if (!UUID_RE.test(candidateId)) {
      throw new HttpError(400, 'Calon tidak valid.');
    }
    if (!BALLOT_TOKEN_RE.test(token)) {
      throw new HttpError(401, 'Sesi pemilih tidak valid. Verifikasi ulang lewat OTP.');
    }

    const db = getDb();
    // Batas per IP longgar agar ratusan mahasiswa di jaringan Wi-Fi kampus
    // tidak saling memblokir saat voting berlangsung bersamaan.
    await rateLimit(db, 'vote-ip', clientIp(req), 600, 15 * 60);

    // Seluruh validasi token, pengecekan bilik/calon, pencatatan presensi,
    // dan penambahan tally berjalan dalam satu transaksi PostgreSQL atomik.
    const { error } = await db.rpc('voter_cast_ballot', {
      p_token: token,
      p_candidate_id: candidateId
    });
    if (error) throw dbFailure(error);

    return { message: 'Suara kamu sudah tercatat secara sah dan rahasia.' };
  });
}

const castVoteHandler = createCastVoteHandler();
castVoteHandler.createHandler = createCastVoteHandler;
module.exports = castVoteHandler;
