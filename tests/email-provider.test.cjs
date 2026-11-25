const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Pengujian pemilihan provider email lewat EMAIL_PROVIDER.
// Gmail SMTP tetap default, tetapi pemilihan 1000 peserta membutuhkan provider
// berbasis HTTPS API karena kuota harian Gmail sekitar 500 email.

// Handler membaca process.env saat dijalankan, bukan saat modul dimuat.
// Karena itu provider dan kredensial harus tetap terpasang selama handler dipanggil.
function withProvider(provider, env, fn) {
  const original = { ...process.env };
  process.env.EMAIL_PROVIDER = provider;
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret-not-real';
  process.env.SUPABASE_URL = 'https://sandbox.invalid.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-not-real';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  for (const [k, v] of Object.entries(env || {})) process.env[k] = v;
  for (const mod of Object.keys(require.cache)) {
    if (mod.includes('api/send-otp.js') || mod.includes('lib/server.js')) delete require.cache[mod];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in original)) delete process.env[key];
      }
      Object.assign(process.env, original);
      for (const mod of Object.keys(require.cache)) {
        if (mod.includes('api/send-otp.js') || mod.includes('lib/server.js')) delete require.cache[mod];
      }
    });
}

process.env.ADMIN_SESSION_SECRET = 'test-session-secret-not-real';
process.env.SUPABASE_URL = 'https://sandbox.invalid.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-not-real';

async function invoke(handler, body) {
  let statusCode = 200;
  let payload = null;
  const headers = {};
  const req = { method: 'POST', body, headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '10.9.9.9' } };
  const res = {
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; }
  };
  await handler(req, res);
  return { statusCode, headers, payload };
}

function stubDb(otpCode) {
  return {
    rpc: async (fn) => {
      if (fn === 'api_rate_hit') return { data: true, error: null };
      if (fn === 'voter_request_otp') {
        return {
          data: { ok: true, email: 'uji@mail.ugm.ac.id', nim: null, otp_code: otpCode, cooldown_seconds: 60 },
          error: null
        };
      }
      return { data: null, error: null };
    }
  };
}

test('EMAIL_PROVIDER defaults to Gmail SMTP when unset', () => {
  const original = process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_PROVIDER;
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'send-otp.js'), 'utf8');
  assert.match(src, /process\.env\.EMAIL_PROVIDER \|\| 'gmail'/);
  if (original !== undefined) process.env.EMAIL_PROVIDER = original;
});

test('Brevo provider posts to the HTTPS API and never to SMTP ports', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 201, text: async () => '' };
  };

  try {
    await withProvider('brevo', {
      BREVO_API_KEY: 'test-key-not-real',
      MAIL_FROM_ADDRESS: 'otp@example.test'
    }, async () => {
      const sendOtp = require('../api/send-otp.js');
      const handler = sendOtp.createHandler({ getDb: () => stubDb('123456') });
      const res = await invoke(handler, { email_prefix: 'budi.santoso' });

      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /^https:\/\/api\.brevo\.com\/v3\/smtp\/email$/);
      const sent = JSON.parse(calls[0].options.body);
      assert.equal(sent.to[0].email, 'uji@mail.ugm.ac.id');
      assert.ok(sent.htmlContent.includes('123456'));
      assert.ok(!JSON.stringify(sent).includes('test-key-not-real'));
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Resend provider uses bearer auth against the HTTPS API', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, text: async () => '' };
  };

  try {
    await withProvider('resend', {
      RESEND_API_KEY: 'test-key-not-real',
      MAIL_FROM_ADDRESS: 'otp@example.test'
    }, async () => {
      const sendOtp = require('../api/send-otp.js');
      const handler = sendOtp.createHandler({ getDb: () => stubDb('654321') });
      const res = await invoke(handler, { email_prefix: 'budi.santoso' });

      assert.equal(res.statusCode, 200);
      assert.match(calls[0].url, /^https:\/\/api\.resend\.com\/emails$/);
      assert.match(calls[0].options.headers.authorization, /^Bearer /);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('provider failure surfaces 503 without leaking the OTP or the API key', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized: bad api key' });

  try {
    await withProvider('brevo', {
      BREVO_API_KEY: 'secret-value-should-not-leak',
      MAIL_FROM_ADDRESS: 'otp@example.test'
    }, async () => {
      const sendOtp = require('../api/send-otp.js');
      const handler = sendOtp.createHandler({ getDb: () => stubDb('999888') });
      const res = await invoke(handler, { email_prefix: 'budi.santoso' });

      assert.equal(res.statusCode, 503);
      const serialized = JSON.stringify(res.payload);
      assert.ok(!serialized.includes('999888'));
      assert.ok(!serialized.includes('secret-value-should-not-leak'));
      assert.ok(!serialized.includes('unauthorized: bad api key'));
    });
  } finally {
    global.fetch = originalFetch;
  }
});
