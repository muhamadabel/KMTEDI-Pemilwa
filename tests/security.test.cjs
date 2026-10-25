const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// --- Static guards against regressions ------------------------------------

test('no secrets or hardcoded fallbacks in server code, docs, or pages', () => {
  const files = ['api/send-otp.js', 'api/verify-otp.js', 'api/cast-vote.js', 'api/admin.js', 'lib/server.js',
    'AGENT_BRIEF.md', 'README.md', 'index.html', 'admin.html', 'build.js'];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /process\.env\.\w+\s*\|\|\s*['"`][^'"`]/, `${file} has an env fallback literal`);
    assert.doesNotMatch(src, /sb_secret_[A-Za-z0-9]|service_role\s*[:=]\s*['"]ey/i, `${file} contains a secret key`);
    assert.doesNotMatch(src, /Master PIN Aktif|kmtedi_admin_pin/, `${file} exposes or stores the admin PIN`);
  }
});

test('browser never calls Supabase RPCs directly', () => {
  for (const page of ['index.html', 'admin.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /\.rpc\(/, `${page} calls an RPC from the browser`);
    assert.doesNotMatch(html, /supabase-js/, `${page} still loads supabase-js`);
  }
});

test('hardening migration grants nothing new to anon except public results', () => {
  const sql = read('supabase/migrations/20261025000000_security_hardening.sql');
  const grants = sql.match(/grant execute on function [^;]+ to [^;]*anon[^;]*;/gi) || [];
  assert.deepEqual(grants, ['grant execute on function public.get_public_results() to anon, authenticated;']);
  assert.match(sql, /drop column if exists admin_pin/);
  assert.match(sql, /drop policy if exists voters_anon_read/);
});

test('deploy publishes only whitelisted files with security headers', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.outputDirectory, 'dist');
  const headers = Object.fromEntries(vercel.headers[0].headers.map(h => [h.key, h.value]));
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  const build = read('build.js');
  assert.match(build, /PUBLIC_FILES = \['index\.html', 'admin\.html', 'branding\.css'\]/);
  assert.match(build, /PUBLIC_DIRS = \['assets'\]/);
});

test('database values are escaped before innerHTML on the public page', () => {
  const html = read('index.html');
  assert.ok(html.includes('function escapeHtml'));
  assert.ok(html.includes('function safeImage'));
  assert.doesNotMatch(html, /innerHTML = settings\.about_/);
  assert.doesNotMatch(html, /<li>\$\{(m|p)\}<\/li>/);
  assert.doesNotMatch(html, /heroCaption\.innerHTML = heroSlides/);
});

// --- API handlers with mocked Supabase and SMTP ---------------------------

const rpcCalls = [];
let rpcImpl = () => ({ data: null, error: null });
const sentMail = [];

function loadApi(file) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret-0123456789';
  process.env.SMTP_USER = 'panitia@example.com';
  process.env.SMTP_PASS = 'test-pass';
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') {
      return { createClient: () => ({ rpc: async (fn, args) => { rpcCalls.push({ fn, args }); return rpcImpl(fn, args); } }) };
    }
    if (request === 'nodemailer') {
      return { createTransport: () => ({ sendMail: async msg => { sentMail.push(msg); } }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(path.join(root, 'api')) || key.startsWith(path.join(root, 'lib'))) delete require.cache[key];
    }
    return require(path.join(root, file));
  } finally {
    Module._load = originalLoad;
  }
}

async function invoke(handler, { method = 'POST', body = {}, headers = {} } = {}) {
  const req = {
    method,
    body,
    headers: { host: 'kmtedi-pemilwa.vercel.app', 'content-type': 'application/json', 'x-real-ip': '1.2.3.4', ...headers },
    socket: {}
  };
  const res = {
    statusCode: 200, headers: {}, payload: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; }
  };
  await handler(req, res);
  return res;
}

function reset(impl) {
  rpcCalls.length = 0;
  sentMail.length = 0;
  rpcImpl = impl || ((fn) => fn === 'api_rate_hit' ? { data: true, error: null } : { data: null, error: null });
}

test('API rejects non-POST, cross-origin, and non-JSON requests without CORS', async () => {
  const handler = loadApi('api/send-otp.js');
  reset();
  assert.equal((await invoke(handler, { method: 'GET' })).statusCode, 405);
  assert.equal((await invoke(handler, { method: 'OPTIONS' })).statusCode, 405);
  const cross = await invoke(handler, { headers: { origin: 'https://evil.example' }, body: { nim: '22/1/TK/1', email_prefix: 'a' } });
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.headers['access-control-allow-origin'], undefined);
  assert.equal((await invoke(handler, { headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal(rpcCalls.length, 0);
});

test('send-otp validates input before touching the database', async () => {
  const handler = loadApi('api/send-otp.js');
  for (const prefix of ['a,b', 'x@gmail.com', '../a', '', 'a b']) {
    reset();
    const res = await invoke(handler, { body: { nim: '22/1/TK/1', email_prefix: prefix } });
    assert.equal(res.statusCode, 400, `prefix ${prefix}`);
    assert.equal(rpcCalls.length, 0);
  }
  reset();
  assert.equal((await invoke(handler, { body: { nim: '<img>', email_prefix: 'budi' } })).statusCode, 400);
});

test('send-otp never returns the OTP and escapes the email body', async () => {
  const handler = loadApi('api/send-otp.js');
  reset((fn) => fn === 'api_rate_hit'
    ? { data: true, error: null }
    : { data: { nim: '22/1/TK/1', email: 'budi@mail.ugm.ac.id', otp_code: '123456' }, error: null });
  const res = await invoke(handler, { body: { nim: '22/1/tk/1', email_prefix: 'Budi@mail.ugm.ac.id' } });
  assert.equal(res.statusCode, 200);
  assert.ok(!JSON.stringify(res.payload).includes('123456'), 'OTP leaked in API response');
  assert.equal(sentMail[0].to, 'budi@mail.ugm.ac.id');
  assert.ok(!sentMail[0].subject.includes('123456'), 'OTP should not appear in the subject line');
  const otpCall = rpcCalls.find(c => c.fn === 'voter_request_otp');
  assert.deepEqual(otpCall.args, { p_nim: '22/1/TK/1', p_email: 'budi@mail.ugm.ac.id' });
});

test('rate limit returns 429 and internal DB errors are hidden', async () => {
  const handler = loadApi('api/send-otp.js');
  reset((fn) => fn === 'api_rate_hit' ? { data: false, error: null } : { data: null, error: null });
  assert.equal((await invoke(handler, { body: { nim: '22/1/TK/1', email_prefix: 'budi' } })).statusCode, 429);

  reset((fn) => fn === 'api_rate_hit' ? { data: true, error: null } : { data: null, error: { code: '42501', message: 'permission denied for table secret_stuff' } });
  const origError = console.error; console.error = () => {};
  const res = await invoke(handler, { body: { nim: '22/1/TK/1', email_prefix: 'budi' } });
  console.error = origError;
  assert.equal(res.statusCode, 500);
  assert.ok(!res.payload.error.includes('secret_stuff'));
});

test('cast-vote requires a well-formed ballot token and candidate id', async () => {
  const handler = loadApi('api/cast-vote.js');
  reset();
  assert.equal((await invoke(handler, { body: { ballot_token: 'abc', candidate_id: '00000000-0000-0000-0000-000000000000' } })).statusCode, 401);
  assert.equal((await invoke(handler, { body: { ballot_token: 'a'.repeat(64), candidate_id: 'not-a-uuid' } })).statusCode, 400);
  assert.equal(rpcCalls.length, 0);
});

test('admin actions require a valid, untampered session token', async () => {
  const handler = loadApi('api/admin.js');
  reset((fn) => {
    if (fn === 'api_rate_hit') return { data: true, error: null };
    if (fn === 'admin_check_pin') return { data: true, error: null };
    if (fn === 'admin_credentials_version') return { data: '111', error: null };
    if (fn === 'admin_dashboard') return { data: { ok: 1 }, error: null };
    return { data: null, error: null };
  });

  assert.equal((await invoke(handler, { body: { action: 'dashboard' } })).statusCode, 401);
  assert.ok(!rpcCalls.some(c => c.fn === 'admin_dashboard'));

  const login = await invoke(handler, { body: { action: 'login', pin: 'correct-pin' } });
  assert.equal(login.statusCode, 200);
  const token = login.payload.token;

  const okRes = await invoke(handler, { body: { action: 'dashboard' }, headers: { authorization: `Bearer ${token}` } });
  assert.equal(okRes.statusCode, 200);

  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: 9999999999, v: '111' })).toString('base64url');
  assert.equal((await invoke(handler, { body: { action: 'dashboard' }, headers: { authorization: `Bearer ${forged}.${sig}` } })).statusCode, 401);
  assert.equal((await invoke(handler, { body: { action: 'dashboard' }, headers: { authorization: `Bearer ${payload}.AAAA` } })).statusCode, 401);

  // PIN rotation invalidates the existing session
  const prev = rpcImpl;
  rpcImpl = (fn, args) => fn === 'admin_credentials_version' ? { data: '222', error: null } : prev(fn, args);
  assert.equal((await invoke(handler, { body: { action: 'dashboard' }, headers: { authorization: `Bearer ${token}` } })).statusCode, 401);

  assert.equal((await invoke(handler, { body: { action: '__proto__' }, headers: { authorization: `Bearer ${token}` } })).statusCode, 400);
});

test('admin login is rate limited and wrong PIN is rejected', async () => {
  const handler = loadApi('api/admin.js');
  reset((fn) => fn === 'api_rate_hit' ? { data: true, error: null } : fn === 'admin_check_pin' ? { data: false, error: null } : { data: null, error: null });
  assert.equal((await invoke(handler, { body: { action: 'login', pin: 'nope' } })).statusCode, 401);
  assert.ok(rpcCalls.some(c => c.fn === 'api_rate_hit' && c.args.p_key.startsWith('admin-login-ip:')));

  reset((fn) => fn === 'api_rate_hit' ? { data: false, error: null } : { data: true, error: null });
  assert.equal((await invoke(handler, { body: { action: 'login', pin: 'x' } })).statusCode, 429);
  assert.ok(!rpcCalls.some(c => c.fn === 'admin_check_pin'));
});
