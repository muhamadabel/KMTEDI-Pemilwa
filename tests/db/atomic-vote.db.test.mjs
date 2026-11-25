import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTestPg, createSupabaseRpcAdapter, invokeHandler } from '../helpers/pglite-db.mjs';

const require = createRequire(import.meta.url);
process.env.ADMIN_SESSION_SECRET = 'local-db-test-secret-do-not-use-in-prod-0123456789';

const verifyOtpMod = require('../../api/verify-otp.js');
const castVoteMod = require('../../api/cast-vote.js');

async function issueBallotToken(db, email, nim = null) {
  const otpRes = await db.rpc('voter_request_otp', { p_nim: nim || '', p_email: email });
  assert.equal(otpRes.error, null, `OTP request failed for ${email}: ${otpRes.error?.message}`);
  assert.equal(otpRes.data.ok, true, `OTP request rejected for ${email}: ${otpRes.data?.error}`);
  const verifyRes = await db.rpc('voter_verify_otp', {
    p_email: email,
    p_nim: nim || '',
    p_otp: otpRes.data.otp_code
  });
  assert.equal(verifyRes.error, null);
  assert.equal(verifyRes.data.ok, true);
  return verifyRes.data.ballot_token;
}

test('Pekerjaan 1: ballot secrecy schema has no voter<->candidate link and migration is idempotent', async () => {
  const pg = await createTestPg({ openVoting: true, reApplyLatest: true });
  try {
    const voterCols = (await pg.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name='registered_voters'`
    )).rows.map(r => r.column_name);
    assert.ok(!voterCols.includes('candidate_id'), 'registered_voters must NOT have candidate_id column');

    const tallyCols = (await pg.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name='vote_tallies'`
    )).rows.map(r => r.column_name);
    assert.ok(!tallyCols.includes('email'), 'vote_tallies must NOT have email column');
    assert.ok(!tallyCols.includes('nim'), 'vote_tallies must NOT have nim column');
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 1: two concurrent cast-vote requests for the same account produce exactly one vote', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const castHandler = castVoteMod.createHandler({ getDb: () => db });

    const token = await issueBallotToken(db, 'pemilih.satu@mail.ugm.ac.id', '22/500001/SV/20001');

    const [r1, r2] = await Promise.all([
      invokeHandler(castHandler, { body: { ballot_token: token, candidate_id: cands[0].id } }),
      invokeHandler(castHandler, { body: { ballot_token: token, candidate_id: cands[1].id } })
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(statuses, [200, 401]);

    const voterCount = (await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c;
    const totalVotes = (await db.query('select coalesce(sum(votes), 0)::int as s from public.vote_tallies')).rows[0].s;
    assert.equal(voterCount, 1);
    assert.equal(totalVotes, 1);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 1: many distinct voters choosing the same candidate produce exact tally match', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const targetCandidate = cands[0].id;
    const castHandler = castVoteMod.createHandler({ getDb: () => db });

    const totalVoters = 40;
    const tokens = [];
    for (let i = 1; i <= totalVoters; i++) {
      const email = `uji.atomik.${String(i).padStart(3, '0')}@mail.ugm.ac.id`;
      const nim = `22/50${String(i).padStart(4, '0')}/SV/21000`;
      tokens.push(await issueBallotToken(db, email, nim));
    }

    const results = await Promise.all(
      tokens.map((t, idx) =>
        invokeHandler(castHandler, {
          ip: `10.10.0.${(idx % 5) + 1}`,
          body: { ballot_token: t, candidate_id: targetCandidate }
        })
      )
    );

    const okCount = results.filter(r => r.statusCode === 200).length;
    assert.equal(okCount, totalVoters);

    const voterCount = (await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c;
    const targetTally = (await db.query('select votes::int as v from public.vote_tallies where candidate_id = $1', [targetCandidate])).rows[0].v;
    const otherTally = (await db.query('select coalesce(sum(votes), 0)::int as v from public.vote_tallies where candidate_id <> $1', [targetCandidate])).rows[0].v;

    assert.equal(voterCount, totalVoters);
    assert.equal(targetTally, totalVoters);
    assert.equal(otherTally, 0);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 1: simulated mid-transaction failure on vote_tallies rolls back registered_voters cleanly', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const castHandler = castVoteMod.createHandler({ getDb: () => db });

    const email = 'uji.rollback@mail.ugm.ac.id';
    const token = await issueBallotToken(db, email, '22/509999/SV/29999');

    // Inject a failure trigger on vote_tallies UPDATE (happens AFTER registered_voters INSERT)
    await db.exec(`
      create or replace function public._test_fail_tally_update()
      returns trigger language plpgsql as $$
      begin
        raise exception 'SIMULATED_MID_TX_TALLY_FAILURE' using errcode = 'XX000';
      end;
      $$;
      create trigger _trg_test_fail_tally
      before update on public.vote_tallies
      for each row execute function public._test_fail_tally_update();
    `);

    const origErr = console.error;
    console.error = () => {};
    const failRes = await invokeHandler(castHandler, {
      body: { ballot_token: token, candidate_id: cands[0].id }
    });
    console.error = origErr;

    assert.equal(failRes.statusCode, 500);
    assert.equal(failRes.payload.success, false);

    // CRITICAL: Neither attendance NOR tally may have changed!
    const voterCount = (await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c;
    const totalVotes = (await db.query('select coalesce(sum(votes), 0)::int as s from public.vote_tallies')).rows[0].s;
    const tokenStillExists = (await db.query('select count(*)::int as c from private.ballot_tokens')).rows[0].c;

    assert.equal(voterCount, 0, 'Attendance must be rolled back when tally update fails');
    assert.equal(totalVotes, 0, 'Tally must remain 0 when update fails');
    assert.equal(tokenStillExists, 1, 'Ballot token deletion must also be rolled back on mid-tx error');

    // Remove injected trigger and verify voter can now cast their vote cleanly
    await db.exec(`drop trigger _trg_test_fail_tally on public.vote_tallies; drop function public._test_fail_tally_update();`);

    const retryRes = await invokeHandler(castHandler, {
      body: { ballot_token: token, candidate_id: cands[0].id }
    });
    assert.equal(retryRes.statusCode, 200);
    assert.equal((await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c, 1);
    assert.equal((await db.query('select coalesce(sum(votes), 0)::int as s from public.vote_tallies')).rows[0].s, 1);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 1: rejected requests (closed booth, inactive candidate, expired/fake token) alter nothing', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const castHandler = castVoteMod.createHandler({ getDb: () => db });

    const token = await issueBallotToken(db, 'uji.ditolak@mail.ugm.ac.id', '22/508888/SV/28888');

    // 1. Fake token
    const fakeRes = await invokeHandler(castHandler, {
      body: { ballot_token: 'b'.repeat(64), candidate_id: cands[0].id }
    });
    assert.equal(fakeRes.statusCode, 401);

    // 2. Inactive candidate
    await db.exec(`update public.candidates set is_active = false where id = '${cands[2].id}'`);
    const inactiveRes = await invokeHandler(castHandler, {
      body: { ballot_token: token, candidate_id: cands[2].id }
    });
    assert.equal(inactiveRes.statusCode, 400);

    // 3. Closed voting booth
    await db.exec(`update public.election_settings set voting_open = false where id = true`);
    const closedRes = await invokeHandler(castHandler, {
      body: { ballot_token: token, candidate_id: cands[0].id }
    });
    assert.equal(closedRes.statusCode, 400);

    // 4. Expired token
    await db.exec(`update public.election_settings set voting_open = true where id = true`);
    await db.exec(`update private.ballot_tokens set expires_at = now() - interval '1 minute'`);
    const expiredRes = await invokeHandler(castHandler, {
      body: { ballot_token: token, candidate_id: cands[0].id }
    });
    assert.equal(expiredRes.statusCode, 401);

    assert.equal((await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c, 0);
    assert.equal((await db.query('select coalesce(sum(votes), 0)::int as s from public.vote_tallies')).rows[0].s, 0);
  } finally {
    await pg.close();
  }
});
