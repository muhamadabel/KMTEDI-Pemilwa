const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const readCss = () => ['branding.css', 'motifs.css', 'index.html'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const readPublicPage = () => ['index.html', 'app.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');

for (const page of ['index.html', 'admin.html']) {
  test(`${page} uses the supplied logo and shared branding`, () => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.ok(/<link[^>]+href="branding\.css"/.test(html), 'Missing shared branding stylesheet');
    assert.match(html, /<img[^>]+src="assets\/kmtedi-logo\.png"/);
    assert.match(html, /<link[^>]+rel="icon"[^>]+href="assets\/favicon\.png"/);
    assert.doesNotMatch(html, /<i class="brand-mark"/);
  });
}

test('media palette has the exact four approved colors', () => {
  const css = fs.readFileSync(path.join(root, 'branding.css'), 'utf8').toUpperCase();
  for (const color of ['#250014', '#000113', '#FFB42B', '#E46527']) {
    assert.ok(css.includes(color), `Missing ${color}`);
  }
});

test('all decorative assets have empty alternative text', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const art = html.match(/<img[^>]+src="assets\/media-[^"]+"[^>]*>/g) || [];
  assert.ok(art.length >= 2);
  for (const img of art) assert.match(img, /alt=""/);
});

test('existing voter flow and scheduling controls remain present', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  for (const id of ['inputNim', 'inputEmailPrefix', 'inputOtp', 'votingStatusMain', 'confirmVoteModal']) {
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.ok(!html.includes('id="inputName"'));
  assert.ok(!html.includes('href="/admin"'), 'Admin link should be removed from public navigation');
  for (const id of ['inputVotingStart', 'inputVotingEnd', 'saveScheduleBtn']) {
    assert.ok(admin.includes(`id="${id}"`));
  }
  assert.ok(!admin.includes('Default: KMTEDI2026'), 'Old default PIN should not be exposed in placeholder');
});

test('candidate section has mobile horizontal carousel with scroll-snap and navigation dots', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = readCss();
  assert.ok(html.includes('class="candidate-carousel-nav"'));
  assert.ok(html.includes('class="cand-dot'));
  assert.ok(html.includes('Para calon kandidat dengan visi misi, dan program kerja masing masing'));
  assert.match(css, /scroll-snap-type:\s*x mandatory/);
  assert.match(css, /scroll-snap-align:\s*start/);
});

test('status bilik suara displays countdown grid with days, hours, minutes, seconds', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('class="countdown-grid"'));
  for (const tag of ['HARI', 'JAM', 'MENIT', 'DETIK']) {
    assert.ok(html.includes(`>${tag}</span>`), `Missing countdown tag ${tag}`);
  }
});

test('custom on-brand notice popup replaces browser alerts', () => {
  const html = readPublicPage();
  assert.ok(html.includes('id="noticeModal"'));
  assert.ok(html.includes('id="noticeTitle"'));
  assert.ok(html.includes('id="noticeMessage"'));
  assert.ok(html.includes('function showNotice'));
  assert.ok(html.includes('window.alert = function'));
});

test('hero carousel supports direct swipe gestures and modals maintain edge padding', () => {
  const html = readPublicPage();
  const css = readCss();
  assert.ok(html.includes('heroCard.addEventListener(\'touchstart\''), 'Missing hero touchstart');
  assert.ok(html.includes('heroCard.addEventListener(\'touchend\''), 'Missing hero touchend');
  assert.match(css, /84vw/, 'Missing modal screen-edge clearance');
});


test('copy follows anti-slop rules: no emoji and no em-dash in UI files', () => {
  for (const file of ['index.html', 'admin.html', 'app.js', 'admin.js', 'motifs.css']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /\u2014/, `${file} contains an em-dash`);
    assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u, `${file} contains emoji`);
  }
});

test('animations respect prefers-reduced-motion', () => {
  assert.match(readCss(), /prefers-reduced-motion:\s*reduce/);
});
