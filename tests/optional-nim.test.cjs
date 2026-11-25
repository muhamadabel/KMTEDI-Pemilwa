const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_SESSION_SECRET = 'local-unit-test-secret-do-not-use-in-prod-0123456789';

const { normalizeOptionalNim, normalizeNim, normalizeEmail } = require('../lib/server');
const verifyOtp = require('../api/verify-otp');
const sendOtp = require('../api/send-otp');

async function invoke(fn, { body = {}, headers = {} } = {}) {
  let statusCode = 200;
  let payload = null;
  const req = {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json', 'x-real-ip': '10.0.0.8', ...headers },
    socket: { remoteAddress: '10.0.0.8' },
    body
  };
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; }
  };
  await fn(req, res);
  return { statusCode, payload };
}

test('Pekerjaan 6: normalizeOptionalNim never derives UGM/ prefix from email and never rejects blank or arbitrary input', () => {
  assert.equal(normalizeOptionalNim(''), null);
  assert.equal(normalizeOptionalNim(null), null);
  assert.equal(normalizeOptionalNim(undefined), null);
  assert.equal(normalizeOptionalNim('   '), null);
  assert.equal(normalizeOptionalNim('!!!'), null);
  assert.equal(normalizeOptionalNim('22/505123/SV/21456'), '22/505123/SV/21456');
  assert.equal(normalizeOptionalNim(' 22/505123/sv/21456 '), '22/505123/SV/21456');
  assert.equal(normalizeNim('', 'muhammad.abdullah.pratama.2023@mail.ugm.ac.id'), null);
});

test('Pekerjaan 6: two long emails with identical 30+ char prefix produce distinct normalized email identities', () => {
  const e1 = normalizeEmail('muhammad.abdullah.pratama.kmt2023a');
  const e2 = normalizeEmail('muhammad.abdullah.pratama.kmt2023b');
  assert.notEqual(e1, e2);
  assert.equal(e1, 'muhammad.abdullah.pratama.kmt2023a@mail.ugm.ac.id');
  assert.equal(e2, 'muhammad.abdullah.pratama.kmt2023b@mail.ugm.ac.id');
});

test('Pekerjaan 6: api/verify-otp does not depend on client NIM (omitted, empty, or different NIM all succeed)', async () => {
  const calls = [];
  const token = 'c'.repeat(64);
  const handler = verifyOtp.createHandler({
    getDb: () => ({
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'voter_verify_otp') {
          return { data: { ok: true, email: args.p_email, nim: null, ballot_token: token }, error: null };
        }
        return { data: null, error: null };
      }
    })
  });

  for (const body of [
    { email: 'uji.nim@mail.ugm.ac.id', otp: '123456' },
    { email: 'uji.nim@mail.ugm.ac.id', nim: '', otp: '123456' },
    { email: 'uji.nim@mail.ugm.ac.id', nim: 'NIM-BERBEDA-999', otp: '123456' }
  ]) {
    const res = await invoke(handler, { body });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.ballot_token, token);
    assert.equal(res.payload.voter.email, 'uji.nim@mail.ugm.ac.id');
  }

  for (const c of calls.filter(x => x.fn === 'voter_verify_otp')) {
    assert.deepEqual(Object.keys(c.args).sort(), ['p_email', 'p_otp']);
  }
});

test('Pekerjaan 6: api/send-otp accepts missing/empty NIM and omits synthetic NIM line in email', async () => {
  const sent = [];
  const rpcCalls = [];
  const handler = sendOtp.createHandler({
    getDb: () => ({
      rpc: async (fn, args) => {
        rpcCalls.push({ fn, args });
        if (fn === 'api_rate_hit') return { data: true, error: null };
        if (fn === 'voter_request_otp') {
          return {
            data: { ok: true, email: args.p_email, nim: args.p_nim, otp_code: '246810', cooldown_seconds: 60 },
            error: null
          };
        }
        return { data: null, error: null };
      }
    }),
    getMailer: () => ({ sendMail: async (msg) => { sent.push(msg); } }),
    getFromAddress: () => 'sandbox@example.test'
  });

  const res = await invoke(handler, { body: { email_prefix: 'tanpa.nim' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.nim, null);
  assert.equal(rpcCalls.find(c => c.fn === 'voter_request_otp').args.p_nim, null);
  assert.ok(!sent[0].text.includes('UGM/'), 'Email must not contain synthetic UGM/ prefix');
  assert.ok(!sent[0].text.includes('NIM:'), 'Email should omit blank NIM line');
});
