const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_SESSION_SECRET = 'local-unit-test-secret-do-not-use-in-prod-0123456789';

const adminApi = require('../api/admin');

async function invoke(fn, { body = {}, headers = {}, ip = '10.0.0.5' } = {}) {
  let statusCode = 200;
  const resHeaders = {};
  let payload = null;
  const req = {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json', 'x-real-ip': ip, ...headers },
    socket: { remoteAddress: ip },
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

test('Pekerjaan 4: no hardcoded fallback PIN arrays or literal PINs remain in active code or docs', () => {
  const root = path.resolve(__dirname, '..');
  const adminSrc = fs.readFileSync(path.join(root, 'api/admin.js'), 'utf8');
  assert.doesNotMatch(adminSrc, /validPins/i, 'Fallback PIN array must be removed from api/admin.js');
  assert.doesNotMatch(adminSrc, /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/, 'Rate-limit catch swallow must be removed');
  assert.doesNotMatch(adminSrc, /\.catch\(\s*\(\)\s*=>\s*['"]1['"]\s*\)/, 'Version fallback must be removed');

  const filesToScan = [
    'api/admin.js', 'api/send-otp.js', 'api/verify-otp.js', 'api/cast-vote.js',
    'lib/server.js', 'index.html', 'admin.html', 'admin.js',
    'AGENT_BRIEF.md', 'CLAUDE_SETUP.md', 'README.md'
  ];
  // Construct patterns indirectly so no literal credential string exists in tests either
  const forbiddenDocPatterns = [
    /Master PIN Aktif:\s*`[^`]+`/i,
    /Master PIN Admin:\s*`[^`]+`/i
  ];
  for (const rel of filesToScan) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    for (const pat of forbiddenDocPatterns) {
      assert.doesNotMatch(content, pat, `${rel} still contains an active literal PIN entry`);
    }
  }
});

test('Pekerjaan 4: invalid PIN is rejected and valid DB PIN issues verifiable session token', async () => {
  const secretPin = 'unit-test-only-pin-9876543210';
  const handler = adminApi.createHandler({
    getDb: () => ({
      rpc: async (fn, args) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'admin_check_pin') return { data: args.p_pin === secretPin, error: null };
        if (fn === 'admin_credentials_version') return { data: 'v-100', error: null };
        if (fn === 'admin_dashboard') return { data: { voted_count: 0 }, error: null };
        return { data: null, error: null };
      }
    })
  });

  const wrong = await invoke(handler, { body: { action: 'login', pin: 'wrong-pin-value' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.payload.success, false);

  const empty = await invoke(handler, { body: { action: 'login', pin: '' } });
  assert.equal(empty.statusCode, 401);

  const right = await invoke(handler, { body: { action: 'login', pin: secretPin } });
  assert.equal(right.statusCode, 200);
  assert.equal(right.payload.success, true);
  assert.ok(right.payload.token);

  const dash = await invoke(handler, {
    body: { action: 'dashboard' },
    headers: { authorization: `Bearer ${right.payload.token}` }
  });
  assert.equal(dash.statusCode, 200);
  assert.deepEqual(dash.payload.dashboard, { voted_count: 0 });
});

test('Pekerjaan 4: simulated rate-limiter failure fails CLOSED and matches wrong-PIN error response', async () => {
  const origErr = console.error;
  console.error = () => {};

  const wrongPinHandler = adminApi.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'admin_check_pin') return { data: false, error: null };
        return { data: null, error: null };
      }
    })
  });

  let checkPinCalledWhenRateLimiterBroke = false;
  const brokenRateLimitHandler = adminApi.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: null, error: { code: '08006', message: 'db connection refused' } };
        if (fn === 'admin_check_pin') {
          checkPinCalledWhenRateLimiterBroke = true;
          return { data: true, error: null };
        }
        return { data: 'v-100', error: null };
      }
    })
  });

  const brokenCheckPinHandler = adminApi.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'admin_check_pin') return { data: null, error: { code: 'XX000', message: 'relation missing' } };
        return { data: null, error: null };
      }
    })
  });

  const brokenVersionHandler = adminApi.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'admin_check_pin') return { data: true, error: null };
        if (fn === 'admin_credentials_version') return { data: null, error: { code: 'XX000', message: 'db down' } };
        return { data: null, error: null };
      }
    })
  });

  const rWrong = await invoke(wrongPinHandler, { body: { action: 'login', pin: 'incorrect' } });
  const rRateErr = await invoke(brokenRateLimitHandler, { body: { action: 'login', pin: 'any-pin' } });
  const rCheckErr = await invoke(brokenCheckPinHandler, { body: { action: 'login', pin: 'any-pin' } });
  const rVerErr = await invoke(brokenVersionHandler, { body: { action: 'login', pin: 'any-pin' } });
  console.error = origErr;

  assert.equal(checkPinCalledWhenRateLimiterBroke, false, 'Must not verify PIN when rate limiter fails');
  assert.equal(rWrong.statusCode, 401);
  assert.equal(rRateErr.statusCode, 401);
  assert.equal(rCheckErr.statusCode, 401);
  assert.equal(rVerErr.statusCode, 401);

  // Error responses must not leak whether PIN was wrong vs system error
  assert.equal(rRateErr.payload.error, rWrong.payload.error);
  assert.equal(rCheckErr.payload.error, rWrong.payload.error);
  assert.equal(rVerErr.payload.error, rWrong.payload.error);
});

test('Pekerjaan 4: repeated failed attempts trigger HTTP 429 rate limit', async () => {
  const handler = adminApi.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: false, error: null };
        throw new Error('admin_check_pin must not be called when rate-limited');
      }
    })
  });

  const res = await invoke(handler, { body: { action: 'login', pin: 'attempt' } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.payload.success, false);
});
