import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTestPg, createSupabaseRpcAdapter, invokeHandler } from '../helpers/pglite-db.mjs';

const require = createRequire(import.meta.url);
process.env.ADMIN_SESSION_SECRET = 'local-db-test-secret-do-not-use-in-prod-0123456789';

const sendOtpMod = require('../../api/send-otp.js');

function makeSendOtp(db) {
  const outbox = [];
  const handler = sendOtpMod.createHandler({
    getDb: () => db,
    getMailer: () => ({ sendMail: async (msg) => { outbox.push(msg); } }),
    getFromAddress: () => 'sandbox-panitia@example.test'
  });
  return { handler, outbox };
}

test('Pekerjaan 3: repeated OTP requests from one account are blocked by 60s cooldown and hourly cap, then allowed after cooldown', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const { handler, outbox } = makeSendOtp(db);

    // 1st request succeeds
    const r1 = await invokeHandler(handler, { body: { email_prefix: 'uji.cooldown' } });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.payload.cooldown_seconds, 60);
    assert.equal(outbox.length, 1);

    // Immediate 2nd request (even with uppercase variation!) is blocked with 429
    const r2 = await invokeHandler(handler, { body: { email_prefix: 'UJI.COOLDOWN' } });
    assert.equal(r2.statusCode, 429);
    assert.ok(r2.payload.retry_after >= 1 && r2.payload.retry_after <= 60);
    assert.equal(outbox.length, 1);

    // Simulate 61 seconds passing -> allowed again
    await db.exec(`update private.voter_otps set created_at = timezone('utc', now()) - interval '61 seconds' where email = 'uji.cooldown@mail.ugm.ac.id'`);
    const r3 = await invokeHandler(handler, { body: { email_prefix: 'uji.cooldown' } });
    assert.equal(r3.statusCode, 200);
    assert.equal(outbox.length, 2);

    // Exhaust up to 6 sends in 1 hour
    for (let i = 3; i <= 6; i++) {
      await db.exec(`update private.voter_otps set created_at = timezone('utc', now()) - interval '61 seconds' where email = 'uji.cooldown@mail.ugm.ac.id'`);
      const ri = await invokeHandler(handler, { body: { email_prefix: 'uji.cooldown' } });
      assert.equal(ri.statusCode, 200, `Expected send #${i} to succeed`);
    }
    assert.equal(outbox.length, 6);

    // 7th send within 1 hour (even after 61s cooldown) must be rejected with 429
    await db.exec(`update private.voter_otps set created_at = timezone('utc', now()) - interval '61 seconds' where email = 'uji.cooldown@mail.ugm.ac.id'`);
    const r7 = await invokeHandler(handler, { body: { email_prefix: 'uji.cooldown' } });
    assert.equal(r7.statusCode, 429);
    assert.equal(outbox.length, 6);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 3: 30 parallel OTP requests for the same account send at most 1 email', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const { handler, outbox } = makeSendOtp(db);

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        invokeHandler(handler, {
          ip: `10.30.0.${(i % 10) + 1}`,
          body: { email_prefix: i % 2 === 0 ? 'burst.pemilih' : 'BURST.PEMILIH' }
        })
      )
    );

    const okCount = results.filter(r => r.statusCode === 200).length;
    const rateLimited = results.filter(r => r.statusCode === 429).length;

    assert.equal(okCount, 1, `Expected 1 OTP issued, got ${okCount}`);
    assert.equal(rateLimited, 29, `Expected 29 rate-limited responses, got ${rateLimited}`);
    assert.equal(outbox.length, 1);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 3: distinct accounts do not block each other', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const { handler, outbox } = makeSendOtp(db);

    // Lock out account A with a request, then verify accounts B..K all succeed concurrently
    const a1 = await invokeHandler(handler, { ip: '10.40.0.1', body: { email_prefix: 'akun.terbatas' } });
    assert.equal(a1.statusCode, 200);
    const a2 = await invokeHandler(handler, { ip: '10.40.0.1', body: { email_prefix: 'akun.terbatas' } });
    assert.equal(a2.statusCode, 429);

    const others = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        invokeHandler(handler, { ip: '10.40.0.1', body: { email_prefix: `akun.lain.${i + 1}` } })
      )
    );

    assert.equal(others.filter(r => r.statusCode === 200).length, 10);
    assert.equal(outbox.length, 11);
  } finally {
    await pg.close();
  }
});

test('Pekerjaan 3: rejection response does not leak whether an email is registered (DPT) or already voted', async () => {
  const pg = await createTestPg({ openVoting: true });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const { handler, outbox } = makeSendOtp(db);

    // Enable DPT with two eligible emails, and mark one of them as already voted
    await db.exec(`
      insert into public.eligible_voters (nim, email) values
        ('22/500001/SV/20001', 'terdaftar.belum@mail.ugm.ac.id'),
        ('22/500002/SV/20002', 'terdaftar.sudah@mail.ugm.ac.id');
      insert into public.registered_voters (email, nim, has_voted, voted_at)
      values ('terdaftar.sudah@mail.ugm.ac.id', '22/500002/SV/20002', true, timezone('utc', now()));
    `);

    const notInDpt = await invokeHandler(handler, { body: { email_prefix: 'tidak.terdaftar' } });
    const alreadyVoted = await invokeHandler(handler, { body: { email_prefix: 'terdaftar.sudah' } });

    assert.equal(notInDpt.statusCode, 400);
    assert.equal(alreadyVoted.statusCode, 400);
    // Responses must be identical so an attacker cannot distinguish unregistered vs already-voted
    assert.equal(notInDpt.payload.error, alreadyVoted.payload.error);
    assert.doesNotMatch(notInDpt.payload.error, /tidak terdaftar|DPT|Daftar Pemilih/i);
    assert.equal(outbox.length, 0);

    // Second immediate probe on an unregistered email hits the same 429 cooldown as any valid email
    const secondProbe = await invokeHandler(handler, { body: { email_prefix: 'tidak.terdaftar' } });
    assert.equal(secondProbe.statusCode, 429);

    // Eligible voter who has not voted succeeds
    const validVoter = await invokeHandler(handler, { body: { email_prefix: 'terdaftar.belum' } });
    assert.equal(validVoter.statusCode, 200);
    assert.equal(outbox.length, 1);
  } finally {
    await pg.close();
  }
});
