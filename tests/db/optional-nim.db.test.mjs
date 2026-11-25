import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTestPg, createSupabaseRpcAdapter, invokeHandler } from '../helpers/pglite-db.mjs';

const require = createRequire(import.meta.url);
process.env.ADMIN_SESSION_SECRET = 'local-db-test-secret-do-not-use-in-prod-0123456789';

const sendOtpMod = require('../../api/send-otp.js');
const verifyOtpMod = require('../../api/verify-otp.js');
const castVoteMod = require('../../api/cast-vote.js');

function makeHandlers(db) {
  const otps = new Map();
  const sendOtp = sendOtpMod.createHandler({
    getDb: () => db,
    getMailer: () => ({
      sendMail: async (msg) => {
        const m = String(msg.text || '').match(/\b(\d{6})\b/);
        if (m) otps.set(String(msg.to).toLowerCase(), m[1]);
      }
    }),
    getFromAddress: () => 'sandbox@example.test'
  });
  const verifyOtp = verifyOtpMod.createHandler({ getDb: () => db });
  const castVote = castVoteMod.createHandler({ getDb: () => db });
  return { sendOtp, verifyOtp, castVote, otps };
}

test('Pekerjaan 6 (DB): verification and voting succeed with filled NIM, empty NIM, omitted NIM, or mismatched client NIM at verify', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const { sendOtp, verifyOtp, castVote, otps } = makeHandlers(db);

    const cases = [
      {
        prefix: 'nim.diisi',
        sendNim: '22/505123/SV/21456',
        verifyNim: '99/DIFFERENT/SV/00000', // mismatched client NIM at verify must NOT reject!
        expectedStoredNim: '22/505123/SV/21456'
      },
      {
        prefix: 'nim.kosong',
        sendNim: '',
        verifyNim: '',
        expectedStoredNim: null
      },
      {
        prefix: 'nim.tidak.dikirim',
        sendNim: undefined,
        verifyNim: undefined,
        expectedStoredNim: null
      }
    ];

    for (const tc of cases) {
      const email = `${tc.prefix}@mail.ugm.ac.id`;
      const sendBody = { email_prefix: tc.prefix };
      if (tc.sendNim !== undefined) sendBody.nim = tc.sendNim;

      const sRes = await invokeHandler(sendOtp, { body: sendBody });
      assert.equal(sRes.statusCode, 200, `send-otp failed for ${tc.prefix}: ${sRes.payload?.error}`);

      const otp = otps.get(email);
      assert.ok(otp, `OTP not captured for ${email}`);

      const verifyBody = { email, otp };
      if (tc.verifyNim !== undefined) verifyBody.nim = tc.verifyNim;
      const vRes = await invokeHandler(verifyOtp, { body: verifyBody });
      assert.equal(vRes.statusCode, 200, `verify-otp failed for ${tc.prefix}: ${vRes.payload?.error}`);
      assert.equal(vRes.payload.voter.nim, tc.expectedStoredNim);

      const cRes = await invokeHandler(castVote, {
        body: { ballot_token: vRes.payload.ballot_token, candidate_id: cands[0].id }
      });
      assert.equal(cRes.statusCode, 200, `cast-vote failed for ${tc.prefix}: ${cRes.payload?.error}`);
    }

    const rows = (await db.query('select email, nim from public.registered_voters order by email')).rows;
    assert.deepEqual(rows, [
      { email: 'nim.diisi@mail.ugm.ac.id', nim: '22/505123/SV/21456' },
      { email: 'nim.kosong@mail.ugm.ac.id', nim: null },
      { email: 'nim.tidak.dikirim@mail.ugm.ac.id', nim: null }
    ]);
    const votes = (await db.query('select votes::int as v from public.vote_tallies where candidate_id = $1', [cands[0].id])).rows[0].v;
    assert.equal(votes, 3);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 6 (DB): two distinct long emails with identical >30-char prefix never collide and both can vote', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const { sendOtp, verifyOtp, castVote, otps } = makeHandlers(db);

    const p1 = 'muhammad.abdullah.pratama.kmt2023.satu';
    const p2 = 'muhammad.abdullah.pratama.kmt2023.dua';
    assert.equal(p1.slice(0, 30), p2.slice(0, 30), 'Test emails must share identical 30-char prefix');

    for (const prefix of [p1, p2]) {
      const email = `${prefix}@mail.ugm.ac.id`;
      const sRes = await invokeHandler(sendOtp, { body: { email_prefix: prefix } });
      assert.equal(sRes.statusCode, 200);
      const vRes = await invokeHandler(verifyOtp, { body: { email, otp: otps.get(email) } });
      assert.equal(vRes.statusCode, 200);
      const cRes = await invokeHandler(castVote, {
        body: { ballot_token: vRes.payload.ballot_token, candidate_id: cands[1].id }
      });
      assert.equal(cRes.statusCode, 200);
    }

    const rows = (await db.query('select email, nim from public.registered_voters order by email')).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].nim, null);
    assert.equal(rows[1].nim, null);
    const votes = (await db.query('select votes::int as v from public.vote_tallies where candidate_id = $1', [cands[1].id])).rows[0].v;
    assert.equal(votes, 2);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 6 (DB): two distinct voters supplying the same optional NIM note do not collide because email is the sole identity key', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const { sendOtp, verifyOtp, castVote, otps } = makeHandlers(db);

    for (const prefix of ['pemilih.catatan.a', 'pemilih.catatan.b']) {
      const email = `${prefix}@mail.ugm.ac.id`;
      const sRes = await invokeHandler(sendOtp, { body: { email_prefix: prefix, nim: '22/500000/SV/20000' } });
      assert.equal(sRes.statusCode, 200);
      const vRes = await invokeHandler(verifyOtp, { body: { email, otp: otps.get(email) } });
      assert.equal(vRes.statusCode, 200);
      const cRes = await invokeHandler(castVote, {
        body: { ballot_token: vRes.payload.ballot_token, candidate_id: cands[2].id }
      });
      assert.equal(cRes.statusCode, 200);
    }

    const count = (await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c;
    assert.equal(count, 2);
  } finally {
    await pg.close();
  }
});
