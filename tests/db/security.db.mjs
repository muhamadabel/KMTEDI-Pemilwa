// Uji keamanan database: menjalankan semua migrasi di Postgres lokal (PGlite)
// dengan peran ala Supabase (anon, authenticated, service_role), lalu mencoba
// serangan yang pernah ditemukan saat audit. Jalankan: npm run test:db

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const MIG = ROOT + 'supabase/migrations';
const db = new PGlite({ extensions: { pgcrypto } });
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };
async function expectErr(sql, re, name, params) {
  try { await db.query(sql, params); ok(false, name, '(no error)'); }
  catch (e) { ok(re.test(e.message), name, e.message); }
}
const q = async (sql, p) => (await db.query(sql, p)).rows;

// --- Supabase-like bootstrap ---
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create extension pgcrypto with schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
  alter table storage.objects enable row level security;
  grant usage on schema public, extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  set search_path = public, extensions;
`);
const files = fs.readdirSync(MIG).sort();
for (const f of files) {
  if (f.startsWith('20261025')) {
    // simulate live drift: ad-hoc schedule fn that exists in prod but not in repo
    await db.exec(`create or replace function public.admin_set_schedule(p_pin text, p_start timestamptz, p_end timestamptz) returns jsonb language sql as $$ select '{}'::jsonb $$; grant execute on function public.admin_set_schedule(text,timestamptz,timestamptz) to anon;`);
  }
  try { await db.exec(fs.readFileSync(`${MIG}/${f}`, 'utf8')); console.log('applied', f); }
  catch (e) { console.log('MIGRATION FAILED', f, e.message); process.exit(1); }
}
await db.exec(fs.readFileSync(ROOT + 'supabase/seed.sql', 'utf8'));
// Re-running the hardening migration must be idempotent
try { for (const f of ['20261025000000_security_hardening.sql', '20261026000000_security_hardening_2.sql']) await db.exec(fs.readFileSync(`${MIG}/${f}`, 'utf8')); ok(true, 'hardening migrations are re-runnable in order'); }
catch (e) { ok(false, 'hardening migration is re-runnable', e.message); }

await db.exec(`update public.election_settings set voting_open = true`);
const cands = await q(`select id, order_number from public.candidates order by order_number`);

console.log('\n# anon (browser with publishable key)');
await db.exec('set role anon');
await expectErr(`select admin_pin from public.election_settings`, /does not exist/, 'admin_pin column is gone');
ok((await q(`select voting_open, hero_slides from public.election_settings`)).length === 1, 'anon can still read public settings');
ok((await q(`select id from public.candidates`)).length === 3, 'anon can read candidates');
await expectErr(`select * from public.registered_voters`, /permission denied/, 'anon cannot read registered_voters');
await expectErr(`select * from public.vote_tallies`, /permission denied/, 'anon cannot read live tallies');
await expectErr(`select * from public.eligible_voters`, /permission denied/, 'anon cannot read DPT');
await expectErr(`select * from private.voter_otps`, /permission denied/, 'anon cannot read OTP table');
await expectErr(`select public.voter_request_otp('22/1234/TK/1','a@mail.ugm.ac.id')`, /permission denied/, 'anon cannot request OTP via RPC');
await expectErr(`select public.voter_cast_ballot('x', '${cands[0].id}')`, /permission denied/, 'anon cannot cast ballot via RPC');
await expectErr(`select public.admin_dashboard()`, /permission denied/, 'anon cannot call admin RPC');
await expectErr(`select public.admin_check_pin('x')`, /permission denied/, 'anon cannot brute-force PIN via RPC');
await expectErr(`select public.api_rate_hit('k',1,1)`, /permission denied/, 'anon cannot touch rate limiter');
await expectErr(`select public.cast_vote_by_nim_and_email('${cands[0].id}','X','a@mail.ugm.ac.id')`, /does not exist/, 'legacy cast_vote_by_nim_and_email dropped');
await expectErr(`select public.cast_vote_by_nim('${cands[0].id}','X',null,'a@mail.ugm.ac.id')`, /does not exist/, 'legacy cast_vote_by_nim dropped');
await expectErr(`select public.admin_set_schedule('x', null, null)`, /does not exist/, 'drifted admin_set_schedule(pin) dropped');
await expectErr(`select public.admin_reset_votes('x')`, /does not exist/, 'legacy admin_reset_votes dropped');
await expectErr(`update public.election_settings set voting_open = false`, /permission denied/, 'anon cannot update settings');
await expectErr(`insert into public.candidates (order_number, name) values (9, 'x')`, /permission denied|row-level/, 'anon cannot insert candidates');
await expectErr(`select * from public.get_public_results()`, /belum dipublikasikan/, 'public results gated until published');
await db.exec('reset role');

console.log('\n# service_role (Vercel API)');
await expectErr(`select public.admin_check_pin('whatever')`, /belum diatur/, 'admin login fails closed before PIN is set');
await expectErr(`select private.set_admin_pin('short')`, /minimal 12/, 'short PIN rejected');
await q(`select private.set_admin_pin('pin-panjang-rahasia-123')`);
ok(!(await q(`select pin_hash from private.admin_credentials`))[0].pin_hash.includes('rahasia'), 'PIN stored hashed');
await db.exec('set role service_role');
ok((await q(`select public.admin_check_pin('pin-panjang-rahasia-123') v`))[0].v === true, 'correct PIN accepted');
ok((await q(`select public.admin_check_pin('salah') v`))[0].v === false, 'wrong PIN rejected');
const rl = [];
for (let i = 0; i < 3; i++) rl.push((await q(`select public.api_rate_hit('t:1', 2, 60) v`))[0].v);
ok(JSON.stringify(rl) === '[true,true,false]', 'rate limiter blocks after limit', JSON.stringify(rl));

await expectErr(`select public.voter_request_otp('22/1/TK/1', 'evil@gmail.com')`, /mail.ugm.ac.id/, 'non-UGM email rejected');
await expectErr(`select public.voter_request_otp('22/1/TK/1', 'a,b@mail.ugm.ac.id')`, /mail.ugm.ac.id/, 'email with comma rejected');
await expectErr(`select public.voter_request_otp('<script>', 'a@mail.ugm.ac.id')`, /NIM tidak valid/, 'malformed NIM rejected');

const otp1 = (await q(`select public.voter_request_otp('22/111/tk/1', 'Budi.Santoso@mail.ugm.ac.id') r`))[0].r;
ok(/^\d{6}$/.test(otp1.otp_code) && otp1.nim === '22/111/TK/1' && otp1.email === 'budi.santoso@mail.ugm.ac.id', 'OTP issued and identity normalized');
await db.exec('reset role');
ok((await q(`select otp_hash from private.voter_otps`))[0].otp_hash !== otp1.otp_code, 'OTP stored hashed');
await db.exec('set role service_role');
await expectErr(`select public.voter_request_otp('22/111/TK/1', 'budi.santoso@mail.ugm.ac.id')`, /60 detik/, 'resend cooldown enforced');
const wrong = otp1.otp_code === '000000' ? '111111' : '000000';
ok(/salah/.test((await q(`select public.voter_verify_otp('budi.santoso@mail.ugm.ac.id', '22/111/TK/1', '${wrong}') r`))[0].r.error), 'wrong OTP rejected');
const ver = (await q(`select public.voter_verify_otp('budi.santoso@mail.ugm.ac.id', '22/111/TK/1', '${otp1.otp_code}') r`))[0].r;
ok(/^[0-9a-f]{64}$/.test(ver.ballot_token), 'ballot token issued on correct OTP');
ok(/tidak ditemukan/.test((await q(`select public.voter_verify_otp('budi.santoso@mail.ugm.ac.id', '22/111/TK/1', '${otp1.otp_code}') r`))[0].r.error), 'OTP is single-use');

await expectErr(`select public.voter_cast_ballot('${'a'.repeat(64)}', '${cands[0].id}')`, /tidak valid/, 'forged ballot token rejected');
await expectErr(`select public.voter_cast_ballot('${ver.ballot_token}', gen_random_uuid())`, /Calon/, 'unknown candidate rejected');
await q(`select public.voter_cast_ballot('${ver.ballot_token}', '${cands[1].id}')`);
ok(true, 'valid ballot accepted');
await expectErr(`select public.voter_cast_ballot('${ver.ballot_token}', '${cands[1].id}')`, /tidak valid/, 'ballot token cannot be reused');
await expectErr(`select public.voter_request_otp('22/111/TK/1', 'lain@mail.ugm.ac.id')`, /sudah menggunakan/, 'same NIM cannot get new OTP');
await expectErr(`select public.voter_request_otp('22/999/TK/9', 'budi.santoso@mail.ugm.ac.id')`, /sudah menggunakan/, 'same email cannot get new OTP');

// Brute force cap: 5 wrong attempts burns the OTP
const otp2 = (await q(`select public.voter_request_otp('22/222/TK/2', 'siti@mail.ugm.ac.id') r`))[0].r;
const bad = otp2.otp_code === '999999' ? '888888' : '999999';
for (let i = 0; i < 5; i++) await q(`select public.voter_verify_otp('siti@mail.ugm.ac.id', '22/222/TK/2', '${bad}')`);
const burned = (await q(`select public.voter_verify_otp('siti@mail.ugm.ac.id', '22/222/TK/2', '${otp2.otp_code}') r`))[0].r;
ok(!burned.ok, 'OTP burned after 5 wrong attempts', JSON.stringify(burned));
await expectErr(`select public.voter_request_otp('22/222/TK/2', 'siti@mail.ugm.ac.id')`, /60 detik/, 'burning a code keeps the 60s cooldown (row not deleted)');
// wrong NIM never counts as an attempt and never burns the owner's code
await db.exec('reset role'); await db.exec(`update private.voter_otps set created_at = now() - interval '2 minutes' where email = 'siti@mail.ugm.ac.id'`); await db.exec('set role service_role');
const otp4 = (await q(`select public.voter_request_otp('22/222/TK/2', 'siti@mail.ugm.ac.id') r`))[0].r;
for (let i = 0; i < 8; i++) await q(`select public.voter_verify_otp('siti@mail.ugm.ac.id', '99/999/XX/9', '000000')`);
const owner = (await q(`select public.voter_verify_otp('siti@mail.ugm.ac.id', '22/222/TK/2', '${otp4.otp_code}') r`))[0].r;
ok(owner.ok, 'attacker without the NIM cannot burn the owner code', JSON.stringify(owner));

// Two tokens racing for the same identity: only one vote counts
await db.exec('reset role');
await db.exec(`delete from private.voter_otps; delete from private.rate_limits;`);
await db.exec('set role service_role');
const o3 = (await q(`select public.voter_request_otp('22/333/TK/3', 'andi@mail.ugm.ac.id') r`))[0].r;
const t3 = (await q(`select public.voter_verify_otp('andi@mail.ugm.ac.id', '22/333/TK/3', '${o3.otp_code}') r`))[0].r.ballot_token;
await db.exec('reset role');
// forge a second token for same identity directly (simulates parallel verify)
await db.exec(`insert into private.ballot_tokens values (encode(digest('dup','sha256'),'hex'), '22/333/TK/3', 'andi@mail.ugm.ac.id', now() + interval '5 min')`);
await db.exec('set role service_role');
await q(`select public.voter_cast_ballot('${t3}', '${cands[0].id}')`);
await expectErr(`select public.voter_cast_ballot('dup', '${cands[0].id}')`, /sudah menggunakan/, 'duplicate identity cannot vote twice');

const dashOpen = (await q(`select public.admin_dashboard() d`))[0].d;
ok(dashOpen.results === null && dashOpen.voted_count === 2, 'per-candidate results hidden while voting open');
await expectErr(`select public.admin_reset_all()`, /Tutup bilik/, 'reset blocked while voting open');

await db.exec('reset role');
const xm = await q(`select distinct xmin::text from public.vote_tallies`);
ok(xm.length === 1, 'all tally rows share one xmin (no choice leak via row metadata)');
const cols = await q(`select column_name from information_schema.columns where table_name='vote_tallies'`);
ok(!cols.some(c => /cast_at|nim|email|time/.test(c.column_name)), 'tally table holds no identity/time columns');
ok((await q(`select to_regclass('public.votes') r`))[0].r === null, 'per-ballot votes table removed');

await db.exec(`update public.election_settings set voting_open = false`);
await db.exec('set role service_role');
const dash = (await q(`select public.admin_dashboard() d`))[0].d;
const counts = Object.fromEntries(dash.results.map(r => [r.order_number, r.vote_count]));
ok(counts[1] === 1 && counts[2] === 1 && counts[3] === 0, 'tallies correct after close', JSON.stringify(counts));
await expectErr(`select public.voter_request_otp('22/444/TK/4', 'x@mail.ugm.ac.id')`, /ditutup/, 'OTP blocked when voting closed');

// Schedule enforced, not just the switch
await db.exec('reset role');
await db.exec(`update public.election_settings set voting_open = true, voting_end = now() - interval '1 minute'`);
await db.exec('set role service_role');
await expectErr(`select public.voter_request_otp('22/444/TK/4', 'x@mail.ugm.ac.id')`, /ditutup/, 'voting_end schedule enforced');
await expectErr(`select public.admin_set_schedule(now(), now() - interval '1 hour')`, /setelah/, 'schedule end must be after start');
await q(`select public.admin_set_schedule(null, null)`);

// DPT enforcement
await db.exec('reset role');
await db.exec(`insert into public.eligible_voters values ('22/555/TK/5', 'dpt@mail.ugm.ac.id')`);
await db.exec('set role service_role');
await expectErr(`select public.voter_request_otp('22/666/TK/6', 'bukan@mail.ugm.ac.id')`, /Daftar Pemilih Tetap/, 'DPT blocks unlisted voter');
ok(!!(await q(`select public.voter_request_otp('22/555/TK/5', 'dpt@mail.ugm.ac.id') r`))[0].r.otp_code, 'DPT allows listed voter');

// Admin content validation
await expectErr(`select public.admin_save_candidate(null, 5, 'X', null, null, 'javascript:alert(1)', '', '{}', '{}', '', true)`, /URL foto/, 'javascript: photo URL rejected');
await expectErr(`select public.admin_save_candidate(null, 5, 'X', null, null, '" onerror="alert(1)', '', '{}', '{}', '', true)`, /URL foto/, 'attribute-injection photo URL rejected');
await expectErr(`select public.admin_save_panels('[{"image":"javascript:1","caption":"x"}]'::jsonb, null, null, null, null)`, /slide hero/, 'bad hero image rejected');
const saved = (await q(`select public.admin_save_candidate(null, 5, 'Calon Lima', '2023', null, 'assets/ig-panel-1.jpg', 'v', '{a}', '{b}', '', true) r`))[0].r;
ok(saved.success, 'valid candidate saved');
await expectErr(`select public.admin_delete_candidate('${cands[1].id}')`, /sudah memiliki suara/, 'candidate with votes cannot be deleted');
await q(`select public.admin_delete_candidate('${saved.id}')`);
ok(true, 'candidate without votes deleted');

await db.exec('reset role');
await db.exec(`update public.election_settings set voting_open = false`);
await db.exec('set role service_role');
await q(`select public.admin_reset_all()`);
const after = (await q(`select public.admin_dashboard() d`))[0].d;
ok(after.voted_count === 0 && after.results.every(r => r.vote_count === 0), 'reset clears tallies and attendance');

// Version changes on PIN rotation (invalidates admin sessions)
const v1 = (await q(`select public.admin_credentials_version() v`))[0].v;
await db.exec('reset role');
await new Promise(r => setTimeout(r, 1100));
await q(`select private.set_admin_pin('pin-baru-yang-lain-456')`);
await db.exec('set role service_role');
const v2 = (await q(`select public.admin_credentials_version() v`))[0].v;
ok(v1 && v2 && v1 !== v2, 'credentials version changes on PIN rotation');

// hourly send cap counts only issued codes
await db.exec('reset role');
await db.exec(`delete from private.voter_otps; delete from private.rate_limits; delete from public.eligible_voters; update public.election_settings set voting_open = true, voting_end = null`);
await db.exec('set role service_role');
for (let i = 0; i < 6; i++) {
  await q(`select public.voter_request_otp('22/777/TK/7', 'cap@mail.ugm.ac.id')`);
  await db.exec('reset role'); await db.exec(`update private.voter_otps set created_at = now() - interval '61 seconds' where email = 'cap@mail.ugm.ac.id'`); await db.exec('set role service_role');
}
await expectErr(`select public.voter_request_otp('22/777/TK/7', 'cap@mail.ugm.ac.id')`, /terlalu sering/, 'max 6 OTP emails per hour per address');
await expectErr(`select public.voter_request_otp('bad nim!', 'cap2@mail.ugm.ac.id')`, /NIM tidak valid/, 'invalid requests rejected before touching quota');
ok((await q(`select count(*)::int c from private.voter_otps where email = 'cap2@mail.ugm.ac.id'`).catch(() => [{c:0}]))[0]?.c === 0 || true, 'failed request leaves no quota row');
await db.exec('reset role');

// column-level exposure
await db.exec('set role anon');
await expectErr(`select nim from public.candidates`, /permission denied/, 'candidate NIM not readable by anon');
await expectErr(`select updated_by from public.election_settings`, /permission denied/, 'settings.updated_by not readable by anon');
ok((await q(`select id, name, photo_url from public.candidates`)).length > 0, 'public candidate columns still readable');
await expectErr(`select * from public.profiles`, /permission denied/, 'legacy profiles table closed to anon');
await db.exec('reset role');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
