const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_SESSION_SECRET = 'local-unit-test-secret-do-not-use-in-prod-0123456789';

const sendOtp = require('../api/send-otp');

async function invoke(fn, { body = {}, headers = {} } = {}) {
  let statusCode = 200;
  const resHeaders = {};
  let payload = null;
  const req = {
    method: 'POST',
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

test('api/send-otp retains Gmail SMTP (Decision 2) and does not add alternative email providers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'send-otp.js'), 'utf8');
  assert.match(src, /smtp\.gmail\.com/);
  assert.doesNotMatch(src, /resend|sendgrid|brevo|mailgun/i);
});

test('api/send-otp returns 429 with Retry-After header when server-side cooldown blocks request', async () => {
  let mailSent = 0;
  const handler = sendOtp.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'voter_request_otp') {
          return {
            data: {
              ok: false,
              status: 429,
              retry_after: 42,
              error: 'Permintaan kode OTP terlalu cepat. Tunggu 42 detik sebelum meminta kode baru.'
            },
            error: null
          };
        }
        return { data: null, error: null };
      }
    }),
    getMailer: () => ({ sendMail: async () => { mailSent++; } }),
    getFromAddress: () => 'sandbox@example.test'
  });

  const res = await invoke(handler, { body: { email_prefix: 'budi.uji' } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '42');
  assert.equal(res.payload.retry_after, 42);
  assert.equal(mailSent, 0);
});

test('api/send-otp hides SMTP error internals and never leaks OTP code in response', async () => {
  const sent = [];
  const okHandler = sendOtp.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'voter_request_otp') {
          return {
            data: { ok: true, email: 'budi.uji@mail.ugm.ac.id', nim: null, otp_code: '654321', cooldown_seconds: 60 },
            error: null
          };
        }
        return { data: null, error: null };
      }
    }),
    getMailer: () => ({ sendMail: async (msg) => { sent.push(msg); } }),
    getFromAddress: () => 'sandbox@example.test'
  });

  const okRes = await invoke(okHandler, { body: { email_prefix: 'budi.uji' } });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.payload.cooldown_seconds, 60);
  assert.ok(!JSON.stringify(okRes.payload).includes('654321'), 'OTP must never be returned in HTTP response');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].subject.includes('654321'), 'OTP must not appear in email subject');

  const origErr = console.error;
  console.error = () => {};
  const failHandler = sendOtp.createHandler({
    getDb: () => ({
      rpc: async (fn) => {
        if (fn === 'api_rate_hit') return { data: true, error: null };
        return {
          data: { ok: true, email: 'budi.uji@mail.ugm.ac.id', nim: null, otp_code: '999888', cooldown_seconds: 60 },
          error: null
        };
      }
    }),
    getMailer: () => ({
      sendMail: async () => {
        const e = new Error('AUTH failed with secret-password-xyz');
        e.code = 'EAUTH';
        e.responseCode = 535;
        throw e;
      }
    }),
    getFromAddress: () => 'sandbox@example.test'
  });

  const failRes = await invoke(failHandler, { body: { email_prefix: 'budi.uji' } });
  console.error = origErr;
  assert.equal(failRes.statusCode, 503);
  assert.equal(failRes.payload.success, false);
  assert.ok(!failRes.payload.error.includes('secret-password-xyz'));
  assert.ok(!failRes.payload.error.includes('999888'));
});

test('index.html persists 60s OTP cooldown in localStorage across reloads and tabs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('kmtedi_otp_cooldown_until:'));
  assert.ok(html.includes('localStorage.setItem(otpCooldownKey'));
  assert.ok(html.includes('getOtpCooldownRemaining'));
  assert.ok(html.includes("window.addEventListener('storage'"));
});
