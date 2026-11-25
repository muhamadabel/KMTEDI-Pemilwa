const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_SESSION_SECRET = 'local-unit-test-secret-do-not-use-in-prod-0123456789';

const castVote = require('../api/cast-vote');
const verifyOtp = require('../api/verify-otp');

async function invoke(fn, { method = 'POST', body = {}, headers = {} } = {}) {
  let statusCode = 200;
  const resHeaders = {};
  let payload = null;
  const req = {
    method,
    headers: { host: 'localhost', 'content-type': 'application/json', 'x-real-ip': '10.0.0.1', ...headers },
    socket: { remoteAddress: '10.0.0.1' },
    body
  };
  const res = {
    setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; },
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; }
  };
  await fn(req, res);
  return { statusCode, headers: resHeaders, payload };
}

test('api/cast-vote.js uses single atomic RPC and has no multi-step REST tally logic', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'cast-vote.js'), 'utf8');
  assert.match(src, /voter_cast_ballot/);
  assert.doesNotMatch(src, /\.from\(['"]registered_voters['"]\)/);
  assert.doesNotMatch(src, /\.from\(['"]vote_tallies['"]\)/);
  assert.doesNotMatch(src, /verifyBallot/);
  assert.doesNotMatch(src, /count\s*\+\s*1/);
});

test('api/cast-vote rejects malformed candidate id or non-64-hex token without calling DB', async () => {
  let called = 0;
  const handler = castVote.createHandler({
    getDb: () => ({
      rpc: async () => { called++; return { data: true, error: null }; },
      from: () => { throw new Error('must not call .from()'); }
    })
  });

  const badCand = await invoke(handler, { body: { ballot_token: 'a'.repeat(64), candidate_id: 'invalid-id' } });
  assert.equal(badCand.statusCode, 400);
  assert.equal(badCand.payload.success, false);

  // Legacy HMAC dotted tokens must be rejected
  const hmacToken = await invoke(handler, { body: { ballot_token: 'payload.signature', candidate_id: 'b1061e68-13e2-4fbe-888c-19b0aecbabbd' } });
  assert.equal(hmacToken.statusCode, 401);
  assert.equal(hmacToken.payload.success, false);
  assert.equal(called, 0);
});

test('api/cast-vote forwards valid token and candidate to atomic voter_cast_ballot RPC', async () => {
  const calls = [];
  const handler = castVote.createHandler({
    getDb: () => ({
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'voter_cast_ballot') return { data: { success: true }, error: null };
        return { data: null, error: null };
      },
      from: () => { throw new Error('must not call .from()'); }
    })
  });

  const token = 'f'.repeat(64);
  const candidateId = 'b1061e68-13e2-4fbe-888c-19b0aecbabbd';
  const res = await invoke(handler, { body: { ballot_token: token, candidate_id: candidateId } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(calls.filter(c => c.fn === 'voter_cast_ballot').length, 1);
  assert.deepEqual(calls.find(c => c.fn === 'voter_cast_ballot').args, {
    p_token: token,
    p_candidate_id: candidateId
  });
});

test('api/cast-vote maps P0001 to 400, P0401 to 401, and hides raw DB errors as 500', async () => {
  const cand = 'b1061e68-13e2-4fbe-888c-19b0aecbabbd';
  const token = 'a'.repeat(64);

  const h400 = castVote.createHandler({
    getDb: () => ({
      rpc: async (fn) => fn === 'api_rate_hit'
        ? { data: true, error: null }
        : { data: null, error: { code: 'P0001', message: 'Bilik suara sedang ditutup.' } }
    })
  });
  const r400 = await invoke(h400, { body: { ballot_token: token, candidate_id: cand } });
  assert.equal(r400.statusCode, 400);
  assert.equal(r400.payload.error, 'Bilik suara sedang ditutup.');

  const h401 = castVote.createHandler({
    getDb: () => ({
      rpc: async (fn) => fn === 'api_rate_hit'
        ? { data: true, error: null }
        : { data: null, error: { code: 'P0401', message: 'Sesi pemilih tidak valid atau kedaluwarsa. Verifikasi ulang lewat OTP.' } }
    })
  });
  const r401 = await invoke(h401, { body: { ballot_token: token, candidate_id: cand } });
  assert.equal(r401.statusCode, 401);

  const origErr = console.error;
  console.error = () => {};
  const h500 = castVote.createHandler({
    getDb: () => ({
      rpc: async (fn) => fn === 'api_rate_hit'
        ? { data: true, error: null }
        : { data: null, error: { code: 'XX000', message: 'internal secret table error' } }
    })
  });
  const r500 = await invoke(h500, { body: { ballot_token: token, candidate_id: cand } });
  console.error = origErr;
  assert.equal(r500.statusCode, 500);
  assert.ok(!r500.payload.error.includes('internal secret'));
});

test('api/verify-otp returns DB single-use 64-hex ballot_token instead of HMAC token', async () => {
  const expectedToken = '0123456789abcdef'.repeat(4);
  const handler = verifyOtp.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'voter_verify_otp') {
          return { data: { ok: true, nim: '22/123456/SV/12345', email: 'budi@mail.ugm.ac.id', ballot_token: expectedToken }, error: null };
        }
        return { data: null, error: null };
      }
    })
  });

  const res = await invoke(handler, { body: { email: 'budi@mail.ugm.ac.id', nim: '22/123456/SV/12345', otp: '123456' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ballot_token, expectedToken);
  assert.ok(!res.payload.ballot_token.includes('.'));
});
