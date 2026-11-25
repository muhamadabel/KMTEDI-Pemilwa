import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeSupabaseSandbox, parseArgs, runLoadSimulation } from '../../scripts/load-test-300.mjs';

test('Pekerjaan 5: load test guardrails block production URLs and require explicit sandbox confirmation', () => {
  assert.throws(
    () => assertSafeSupabaseSandbox({}),
    /TEST_SUPABASE_URL/
  );

  assert.throws(
    () => assertSafeSupabaseSandbox({
      TEST_SUPABASE_URL: 'https://sandbox-only.supabase.co',
      TEST_SUPABASE_SERVICE_ROLE_KEY: 'sandbox-key'
    }),
    /CONFIRM_SANDBOX_LOAD_TEST/
  );

  assert.throws(
    () => assertSafeSupabaseSandbox({
      TEST_SUPABASE_URL: 'https://geoqhztzaputpuiyheqm.supabase.co',
      TEST_SUPABASE_SERVICE_ROLE_KEY: 'sandbox-key',
      CONFIRM_SANDBOX_LOAD_TEST: 'YES_NOT_PRODUCTION'
    }),
    /DIBLOKIR/
  );

  assert.throws(
    () => assertSafeSupabaseSandbox({
      SUPABASE_URL: 'https://same-project.supabase.co',
      TEST_SUPABASE_URL: 'https://same-project.supabase.co',
      TEST_SUPABASE_SERVICE_ROLE_KEY: 'sandbox-key',
      CONFIRM_SANDBOX_LOAD_TEST: 'YES_NOT_PRODUCTION'
    }),
    /identik dengan SUPABASE_URL/
  );

  const ok = assertSafeSupabaseSandbox({
    SUPABASE_URL: 'https://prod-other.supabase.co',
    TEST_SUPABASE_URL: 'https://dedicated-sandbox.supabase.co',
    TEST_SUPABASE_SERVICE_ROLE_KEY: 'sandbox-key',
    CONFIRM_SANDBOX_LOAD_TEST: 'YES_NOT_PRODUCTION'
  });
  assert.equal(ok.url, 'https://dedicated-sandbox.supabase.co');
});

test('Pekerjaan 5: mini load simulation validates CLI args and exact tally reconciliation', async () => {
  const opts = parseArgs(['--voters=15', '--concurrency=5', '--duplicate-probes=3', '--mode=pglite']);
  const report = await runLoadSimulation(opts);
  assert.equal(report.passed, true);
  assert.equal(report.summary.votersSucceeded, 15);
  assert.equal(report.summary.unexpectedErrors, 0);
  assert.equal(report.reconciliation.recordedAttendanceDelta, 15);
  assert.equal(report.reconciliation.recordedTallyDelta, 15);
  assert.equal(report.reconciliation.tallyMatchesVoters, true);
});
