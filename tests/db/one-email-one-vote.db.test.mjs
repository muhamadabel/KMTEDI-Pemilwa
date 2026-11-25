import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createTestPg, createSupabaseRpcAdapter, invokeHandler } from '../helpers/pglite-db.mjs';

const require = createRequire(import.meta.url);
process.env.ADMIN_SESSION_SECRET = 'local-db-test-secret-do-not-use-in-prod-0123456789';

const castVoteMod = require('../../api/cast-vote.js');

async function insertRawBallotToken(db, email, nim = null) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await db.query(
    `insert into private.ballot_tokens (token_hash, nim, email, expires_at)
     values ($1, $2, $3, timezone('utc', now()) + interval '30 minutes')`,
    [tokenHash, nim, email]
  );
  return rawToken;
}

test('Pekerjaan 2: DB constraint rejects duplicate normalized email even with mixed case on direct SQL insert', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    await pg.query(
      `insert into public.registered_voters (email, nim, has_voted, voted_at)
       values ($1, null, true, timezone('utc', now()))`,
      ['  Budi.Santoso@MAIL.UGM.AC.ID  ']
    );

    const stored = (await pg.query(`select email from public.registered_voters`)).rows;
    assert.deepEqual(stored.map(r => r.email), ['budi.santoso@mail.ugm.ac.id']);

    // Second direct insert with different case must fail with unique_violation (23505)
    await assert.rejects(
      pg.query(
        `insert into public.registered_voters (email, nim, has_voted, voted_at)
         values ($1, '22/500111/SV/21111', true, timezone('utc', now()))`,
        ['BUDI.santoso@mail.ugm.ac.id']
      ),
      err => err.code === '23505'
    );
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 2: second vote attempt with mixed-case email variant is rejected cleanly without changing tally', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const castHandler = castVoteMod.createHandler({ getDb: () => db });

    // Simulate two separate valid tokens for the same person with different casing
    const tokenLower = await insertRawBallotToken(db, 'siti.rahma@mail.ugm.ac.id', null);
    const tokenUpper = await insertRawBallotToken(db, 'Siti.Rahma@MAIL.UGM.AC.ID', '22/501234/SV/21234');

    const res1 = await invokeHandler(castHandler, {
      body: { ballot_token: tokenLower, candidate_id: cands[0].id }
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.payload.success, true);

    const res2 = await invokeHandler(castHandler, {
      body: { ballot_token: tokenUpper, candidate_id: cands[1].id }
    });
    assert.equal(res2.statusCode, 400);
    assert.equal(res2.payload.success, false);
    assert.match(res2.payload.error, /sudah menggunakan hak suara/i);

    const voterCount = (await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c;
    const totalVotes = (await db.query('select coalesce(sum(votes), 0)::int as s from public.vote_tallies')).rows[0].s;
    const cand1Votes = (await db.query('select votes::int as v from public.vote_tallies where candidate_id = $1', [cands[0].id])).rows[0].v;
    const cand2Votes = (await db.query('select votes::int as v from public.vote_tallies where candidate_id = $1', [cands[1].id])).rows[0].v;

    assert.equal(voterCount, 1);
    assert.equal(totalVotes, 1);
    assert.equal(cand1Votes, 1);
    assert.equal(cand2Votes, 0);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 2: 30 parallel cast-vote requests for the same email (mixed case & multiple tokens) yield exactly 1 vote', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const cands = (await db.query('select id from public.candidates order by order_number')).rows;
    const castHandler = castVoteMod.createHandler({ getDb: () => db });

    const caseVariants = [
      'konkurensi.uji@mail.ugm.ac.id',
      'KONKURENSI.UJI@MAIL.UGM.AC.ID',
      'Konkurensi.Uji@mail.ugm.ac.id',
      'konkurensi.UJI@Mail.UGM.ac.id'
    ];

    const tokens = [];
    for (let i = 0; i < 30; i++) {
      // Half share the first token, half have distinct tokens with case variations
      if (i > 0 && i < 15) {
        tokens.push(tokens[0]);
      } else {
        tokens.push(await insertRawBallotToken(db, caseVariants[i % caseVariants.length], null));
      }
    }

    const responses = await Promise.all(
      tokens.map((tok, i) =>
        invokeHandler(castHandler, {
          ip: `10.20.0.${(i % 10) + 1}`,
          body: { ballot_token: tok, candidate_id: cands[i % cands.length].id }
        })
      )
    );

    const succeeded = responses.filter(r => r.statusCode === 200);
    const rejected = responses.filter(r => r.statusCode === 400 || r.statusCode === 401);

    assert.equal(succeeded.length, 1, `Expected exactly 1 success, got ${succeeded.length}`);
    assert.equal(rejected.length, 29, `Expected 29 rejections, got ${rejected.length}`);

    const voterCount = (await db.query('select count(*)::int as c from public.registered_voters')).rows[0].c;
    const totalVotes = (await db.query('select coalesce(sum(votes), 0)::int as s from public.vote_tallies')).rows[0].s;
    assert.equal(voterCount, 1);
    assert.equal(totalVotes, 1);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 2: legacy fallback voting RPCs are dropped and inaccessible from anon or service_role', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const anonDb = createSupabaseRpcAdapter(pg, { role: 'anon' });
    const cands = (await pg.query('select id from public.candidates order by order_number')).rows;

    const legacyCalls = [
      anonDb.rpc('cast_vote_by_nim_and_email', { p_candidate_id: cands[0].id, p_nim: '22/5001/SV/1', p_email: 'x@mail.ugm.ac.id' }),
      anonDb.rpc('cast_vote_by_nim_and_name', { p_candidate_id: cands[0].id, p_nim: '22/5001/SV/1', p_name: 'X', p_email: 'x@mail.ugm.ac.id' }),
      anonDb.rpc('cast_vote', { p_candidate_id: cands[0].id }),
      anonDb.rpc('generate_voter_otp', { p_nim: '22/5001/SV/1', p_email: 'x@mail.ugm.ac.id' }),
      anonDb.rpc('verify_voter_otp', { p_email: 'x@mail.ugm.ac.id', p_otp: '123456' })
    ];

    const results = await Promise.all(legacyCalls);
    for (const r of results) {
      assert.ok(r.error, 'Legacy RPC must fail');
      assert.equal(r.error.code, '42883', `Expected undefined_function (42883), got ${r.error.code}: ${r.error.message}`);
    }

    assert.equal((await pg.query('select count(*)::int as c from public.registered_voters')).rows[0].c, 0);
    assert.equal((await pg.query('select coalesce(sum(votes), 0)::int as s from public.vote_tallies')).rows[0].s, 0);
  } finally {
    await pg.close();
  }
});
