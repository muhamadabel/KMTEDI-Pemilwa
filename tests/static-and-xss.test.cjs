const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const { buildSite } = require('../build');

test('Pekerjaan 7: vercel.json restricts outputDirectory to dist with security headers', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(vercel.outputDirectory, 'dist');
  assert.equal(vercel.buildCommand, 'node build.js');
  assert.equal(vercel.cleanUrls, true);

  const globalHeaders = Object.fromEntries(vercel.headers[0].headers.map(h => [h.key, h.value]));
  assert.equal(globalHeaders['X-Frame-Options'], 'DENY');
  assert.equal(globalHeaders['X-Content-Type-Options'], 'nosniff');
  assert.match(globalHeaders['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(globalHeaders['Content-Security-Policy'], /object-src 'none'/);
});

test('Pekerjaan 7: build.js rejects missing env or service_role keys and serves ONLY allowlisted public files', async () => {
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'kmtedi-dist-test-'));

  try {
    assert.throws(
      () => buildSite({ root, outDir: tmpOut, env: {} }),
      /SUPABASE_URL and SUPABASE_ANON_KEY must be set/
    );
    assert.throws(
      () => buildSite({
        root,
        outDir: tmpOut,
        env: { SUPABASE_URL: 'https://sandbox.supabase.co', SUPABASE_ANON_KEY: 'sb_secret_not_allowed' }
      }),
      /secret\/service_role/i
    );

    buildSite({
      root,
      outDir: tmpOut,
      env: { SUPABASE_URL: 'https://sandbox.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_sandbox_anon_key' }
    });

    // Spin up a static loopback server strictly rooted at tmpOut (simulating outputDirectory)
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const safeRel = path.posix.normalize(urlPath).replace(/^\/+/, '');
      const fullPath = path.resolve(tmpOut, safeRel || 'index.html');
      if (!fullPath.startsWith(tmpOut + path.sep) && fullPath !== tmpOut) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200);
      res.end(fs.readFileSync(fullPath));
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const publicPaths = [
        '/index.html',
        '/admin.html',
        '/branding.css',
        '/admin.js',
        '/supabase-config.js',
        '/assets/kmtedi-logo.png'
      ];
      for (const p of publicPaths) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        assert.equal(res.status, 200, `Public asset ${p} should return 200`);
      }

      const internalPaths = [
        '/package.json',
        '/vercel.json',
        '/build.js',
        '/lib/server.js',
        '/api/admin.js',
        '/api/cast-vote.js',
        '/api/send-otp.js',
        '/api/verify-otp.js',
        '/.env',
        '/.env.example',
        '/AGENT_BRIEF.md',
        '/CLAUDE_SETUP.md',
        '/README.md',
        '/supabase/migrations/20261125000000_pemilwa_siap_300_pemilih.sql',
        '/tests/branding.test.cjs',
        '/scripts/load-test-300.mjs',
        '/assets/kmtedi-collage.jpg',
        '/assets/kmtedi-reference.jpg',
        '/assets/ig/ig-1.jpg',
        '/../package.json'
      ];
      for (const p of internalPaths) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        assert.equal(res.status, 404, `Internal path ${p} must return 404, got ${res.status}`);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
});

test('Pekerjaan 7: legacy dual voting RPC fallback is removed from frontend', () => {
  for (const file of ['index.html', 'admin.html', 'admin.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /cast_vote_by_nim_and_email/, `${file} must not reference legacy cast_vote_by_nim_and_email`);
    assert.doesNotMatch(src, /\.rpc\(/, `${file} must not call Supabase RPCs directly from the browser`);
  }
});

test('Pekerjaan 7: dynamic server data is safely encoded and cannot inject HTML markup or unsafe URLs', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  // Static guards against raw innerHTML sinks of DB/server strings
  assert.doesNotMatch(html, /stmt\.innerHTML\s*=\s*settings\.about_statement/);
  assert.doesNotMatch(html, /info\.innerHTML\s*=\s*settings\.about_info/);
  assert.doesNotMatch(html, /heroCaption\.innerHTML\s*=\s*heroSlides/);
  assert.doesNotMatch(html, /<li>\$\{(m|p)\}<\/li>/);
  assert.doesNotMatch(html, /msgEl\.innerHTML\s*=\s*String\(message\)/);
  assert.match(html, /function escapeHtml\(/);
  assert.match(html, /function safeImage\(/);
  assert.match(html, /function setMultilineText\(/);

  // Extract and behaviorally test escapeHtml & safeImage from index.html
  const escMatch = html.match(/function escapeHtml\([\s\S]*?\n\}/);
  const imgMatch = html.match(/function safeImage\([\s\S]*?\n\}/);
  assert.ok(escMatch && imgMatch, 'Helpers must exist in index.html');

  const sandbox = {};
  vm.runInNewContext(`${escMatch[0]}\n${imgMatch[0]}`, sandbox);

  const payload = `<img src=x onerror="alert('xss')"><script>evil()</script>`;
  const encoded = sandbox.escapeHtml(payload);
  assert.ok(!encoded.includes('<img'));
  assert.ok(!encoded.includes('<script'));
  assert.equal(
    encoded,
    '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&lt;script&gt;evil()&lt;/script&gt;'
  );

  assert.equal(sandbox.safeImage('javascript:alert(1)', 'assets/ig-panel-1.jpg'), 'assets/ig-panel-1.jpg');
  assert.equal(sandbox.safeImage('https://evil.test/" onerror="alert(1)', 'assets/ig-panel-1.jpg'), 'assets/ig-panel-1.jpg');
  assert.equal(sandbox.safeImage('assets/ig-panel-2.jpg', 'assets/ig-panel-1.jpg'), 'assets/ig-panel-2.jpg');
  assert.equal(sandbox.safeImage('https://example.com/photo.jpg', 'assets/ig-panel-1.jpg'), 'https://example.com/photo.jpg');
});

test('Standar tampilan: no em dash or emoji in UI copy of index.html', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('\u2014'), 'index.html must not contain em dash');
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u, 'index.html must not contain emoji');
});
