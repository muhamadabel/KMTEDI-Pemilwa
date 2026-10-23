const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

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
  for (const id of ['inputVotingStart', 'inputVotingEnd', 'saveScheduleBtn']) {
    assert.ok(admin.includes(`id="${id}"`));
  }
});
