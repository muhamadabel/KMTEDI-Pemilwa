const { serviceDb, clientIp, rateLimit, str, dbFailure, handler, HttpError, verifyBallot } = require('../lib/server');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = handler(async (body, req) => {
  const token = str(body.ballot_token, 500);
  const candidateId = str(body.candidate_id, 64);
  if (!UUID_RE.test(candidateId)) throw new HttpError(400, 'Calon tidak valid.');

  const db = serviceDb();
  await rateLimit(db, 'vote-ip', clientIp(req), 150, 15 * 60);

  // 1. Verifikasi token surat suara (HMAC signed token atau fallback)
  let voter = null;
  if (token.includes('.')) {
    voter = verifyBallot(token);
  } else if (/^[0-9a-f]{64}$/.test(token)) {
    // Coba jalur RPC lama jika format token 64 hex
    const { error: rpcErr } = await db.rpc('voter_cast_ballot', { p_token: token, p_candidate_id: candidateId });
    if (!rpcErr) {
      return { message: 'Suara kamu sudah tercatat secara sah dan rahasia.' };
    }
    if (rpcErr.code === 'P0001') throw new HttpError(400, rpcErr.message);
    throw new HttpError(401, 'Sesi pemilih kedaluwarsa. Silakan verifikasi ulang lewat OTP.');
  } else {
    throw new HttpError(401, 'Sesi pemilih tidak valid. Verifikasi ulang lewat OTP.');
  }

  const { nim, email } = voter;

  // 2. Cek apakah bilik suara terbuka
  const { data: settings } = await db
    .from('election_settings')
    .select('voting_open, voting_start, voting_end')
    .eq('id', true)
    .single();

  const now = new Date();
  const isOpen = settings?.voting_open &&
    (!settings.voting_start || now >= new Date(settings.voting_start)) &&
    (!settings.voting_end || now <= new Date(settings.voting_end));

  if (!isOpen) {
    throw new HttpError(400, 'Bilik suara sedang ditutup.');
  }

  // 3. Cek calon aktif
  const { data: cand } = await db
    .from('candidates')
    .select('id')
    .eq('id', candidateId)
    .eq('is_active', true)
    .single();

  if (!cand) {
    throw new HttpError(400, 'Calon yang dipilih tidak valid.');
  }

  // 4. Catat presensi pemilih (NIM & Email)
  const { error: insErr } = await db.from('registered_voters').insert({
    nim,
    email,
    has_voted: true,
    voted_at: new Date().toISOString()
  });

  if (insErr) {
    if (insErr.code === '23505') {
      throw new HttpError(400, 'NIM atau email ini sudah menggunakan hak suara.');
    }
    console.error('Insert registered_voter error:', insErr);
    throw dbFailure(insErr);
  }

  // 5. Tambah perolehan suara calon di vote_tallies (menggunakan WHERE clause)
  const { data: tally } = await db
    .from('vote_tallies')
    .select('votes')
    .eq('candidate_id', candidateId)
    .single();

  const count = tally ? Number(tally.votes || 0) : 0;
  const { error: updErr } = await db
    .from('vote_tallies')
    .update({ votes: count + 1 })
    .eq('candidate_id', candidateId);

  if (updErr) {
    console.error('Update vote_tallies error:', updErr);
    throw dbFailure(updErr);
  }

  return { message: 'Suara kamu sudah tercatat secara sah dan rahasia.' };
});
