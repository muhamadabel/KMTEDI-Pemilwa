import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTestPg, createSupabaseRpcAdapter, invokeHandler } from '../helpers/pglite-db.mjs';

const require = createRequire(import.meta.url);
process.env.ADMIN_SESSION_SECRET = 'local-db-test-secret-do-not-use-in-prod-0123456789';

const adminMod = require('../../api/admin.js');

test('Pekerjaan 4 (DB): bcrypt single-source admin auth, rate limit, session invalidation, and anon isolation', async () => {
  const pg = await createTestPg({ openVoting: false });
  try {
    const db = createSupabaseRpcAdapter(pg);
    const anonDb = createSupabaseRpcAdapter(pg, { role: 'anon' });
    const adminHandler = adminMod.createHandler({ getDb: () => db });

    // 1. Legacy plaintext admin_pin column must be gone
    await assert.rejects(pg.query('select admin_pin from public.election_settings'), /does not exist/);

    // 2. Anon must not be able to call admin RPCs or read private credentials
    const anonCheck = await anonDb.rpc('admin_check_pin', { p_pin: 'anything' });
    assert.ok(anonCheck.error);
    assert.equal(anonCheck.error.code, '42501');

    // 3. Before any PIN is set, login must fail closed with 401
    const beforeSet = await invokeHandler(adminHandler, {
      ip: '10.50.0.1',
      body: { action: 'login', pin: 'unconfigured-attempt' }
    });
    assert.equal(beforeSet.statusCode, 401);

    // 4. Configure a test-only bcrypt PIN (>=12 chars)
    const testPin1 = 'sandbox-only-pin-alpha-2026';
    const testPin2 = 'sandbox-only-pin-bravo-2026';
    await db.query('select private.set_admin_pin($1)', [testPin1]);

    // 5. Wrong PIN fails 10 times from one IP, then 11th hits 429 rate limit
    for (let i = 1; i <= 10; i++) {
      const bad = await invokeHandler(adminHandler, {
        ip: '10.50.0.99',
        body: { action: 'login', pin: `wrong-pin-${i}` }
      });
      assert.equal(bad.statusCode, 401, `Attempt ${i} should be 401`);
    }
    const blocked = await invokeHandler(adminHandler, {
      ip: '10.50.0.99',
      body: { action: 'login', pin: testPin1 }
    });
    assert.equal(blocked.statusCode, 429, '11th attempt from same IP must be rate-limited');

    // 6. Correct PIN from clean IP succeeds and accesses dashboard
    const okLogin = await invokeHandler(adminHandler, {
      ip: '10.50.0.2',
      body: { action: 'login', pin: testPin1 }
    });
    assert.equal(okLogin.statusCode, 200);
    assert.ok(okLogin.payload.token);

    const dashRes = await invokeHandler(adminHandler, {
      ip: '10.50.0.2',
      headers: { authorization: `Bearer ${okLogin.payload.token}` },
      body: { action: 'dashboard' }
    });
    assert.equal(dashRes.statusCode, 200);
    assert.equal(dashRes.payload.dashboard.voted_count, 0);

    // 7. Rotating PIN invalidates previously issued session token
    await new Promise(r => setTimeout(r, 1100));
    await db.query('select private.set_admin_pin($1)', [testPin2]);

    const afterRotate = await invokeHandler(adminHandler, {
      ip: '10.50.0.2',
      headers: { authorization: `Bearer ${okLogin.payload.token}` },
      body: { action: 'dashboard' }
    });
    assert.equal(afterRotate.statusCode, 401, 'Old token must be rejected after PIN rotation');
  } finally {
    await pg.close();
  }
});
