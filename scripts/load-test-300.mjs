#!/usr/bin/env node
/**
 * Skrip Simulasi Beban 300 Pemilih - Pemilwa KMTEDI 2026
 *
 * Fitur:
 * - Membuat N akun uji sintetis (default 300) yang jelas bukan milik orang sungguhan.
 * - Menjalankan alur penuh: /api/send-otp -> /api/verify-otp -> /api/cast-vote
 *   secara paralel dengan tingkat konkurensi yang dapat diatur.
 * - Memakai transport email palsu/mock di memori (TIDAK pernah mengirim email sungguhan).
 * - Mode default: --mode=pglite (PostgreSQL 16 lokal in-memory, nol akses jaringan).
 * - Mode Hermes sandbox: --mode=supabase dengan TEST_SUPABASE_URL,
 *   TEST_SUPABASE_SERVICE_ROLE_KEY, dan CONFIRM_SANDBOX_LOAD_TEST=YES_NOT_PRODUCTION.
 * - Dilindungi pagar keras agar tidak bisa diarahkan ke database produksi.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createTestPg, createSupabaseRpcAdapter, invokeHandler } from '../tests/helpers/pglite-db.mjs';

const require = createRequire(import.meta.url);
const { createClient } = require('@supabase/supabase-js');
const sendOtpMod = require('../api/send-otp.js');
const verifyOtpMod = require('../api/verify-otp.js');
const castVoteMod = require('../api/cast-vote.js');

const BLOCKED_PROD_MARKERS = [
  'geoqhztzaputpuiyheqm',
  'kmtedi-pemilwa.vercel.app'
];

export function parseArgs(argv) {
  const opts = {
    voters: 300,
    concurrency: 30,
    duplicateProbes: 30,
    mode: 'pglite',
    json: false
  };
  for (const raw of argv) {
    if (raw === '--json') {
      opts.json = true;
    } else if (raw.startsWith('--voters=')) {
      opts.voters = Number.parseInt(raw.slice('--voters='.length), 10);
    } else if (raw.startsWith('--concurrency=')) {
      opts.concurrency = Number.parseInt(raw.slice('--concurrency='.length), 10);
    } else if (raw.startsWith('--duplicate-probes=')) {
      opts.duplicateProbes = Number.parseInt(raw.slice('--duplicate-probes='.length), 10);
    } else if (raw.startsWith('--mode=')) {
      opts.mode = raw.slice('--mode='.length).trim().toLowerCase();
    } else if (raw === '--help' || raw === '-h') {
      opts.help = true;
    }
  }
  if (!Number.isInteger(opts.voters) || opts.voters < 1 || opts.voters > 5000) {
    throw new Error('Parameter --voters harus bilangan bulat antara 1 dan 5000.');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 500) {
    throw new Error('Parameter --concurrency harus bilangan bulat antara 1 dan 500.');
  }
  if (!Number.isInteger(opts.duplicateProbes) || opts.duplicateProbes < 0 || opts.duplicateProbes > opts.voters) {
    throw new Error('Parameter --duplicate-probes harus antara 0 dan jumlah --voters.');
  }
  if (!['pglite', 'supabase'].includes(opts.mode)) {
    throw new Error('Parameter --mode hanya mendukung "pglite" atau "supabase".');
  }
  return opts;
}

export function assertSafeSupabaseSandbox(env = process.env) {
  const url = String(env.TEST_SUPABASE_URL || '').trim();
  const key = String(env.TEST_SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const confirm = String(env.CONFIRM_SANDBOX_LOAD_TEST || '').trim();

  if (!url || !key) {
    throw new Error(
      'Mode --mode=supabase membutuhkan TEST_SUPABASE_URL dan TEST_SUPABASE_SERVICE_ROLE_KEY (bukan SUPABASE_URL produksi).'
    );
  }
  if (confirm !== 'YES_NOT_PRODUCTION') {
    throw new Error(
      'Konfirmasi sandbox belum diaktifkan. Set CONFIRM_SANDBOX_LOAD_TEST=YES_NOT_PRODUCTION untuk menjalankan uji beban pada database uji.'
    );
  }
  const lowerUrl = url.toLowerCase();
  for (const marker of BLOCKED_PROD_MARKERS) {
    if (lowerUrl.includes(marker)) {
      throw new Error(`DIBLOKIR: target URL mengarah ke lingkungan produksi (${marker}).`);
    }
  }
  if (env.SUPABASE_URL && env.SUPABASE_URL.trim() === url) {
    throw new Error(
      'DIBLOKIR: TEST_SUPABASE_URL identik dengan SUPABASE_URL di environment aktif. Gunakan database uji terpisah.'
    );
  }
  return { url, key };
}

function summarizeLatencies(samples) {
  if (!samples.length) {
    return { count: 0, minMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(2)),
    avgMs: Number((sum / sorted.length).toFixed(2)),
    p50Ms: Number(pct(50).toFixed(2)),
    p95Ms: Number(pct(95).toFixed(2)),
    p99Ms: Number(pct(99).toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

function extractOtpFromMessage(msg) {
  const match = String(msg?.text || '').match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

export async function runLoadSimulation(opts, env = process.env) {
  // Pastikan secret sesi lokal sintetis selalu tersedia tanpa membaca rahasia produksi
  if (!env.ADMIN_SESSION_SECRET) {
    process.env.ADMIN_SESSION_SECRET = `loadtest-ephemeral-${crypto.randomBytes(24).toString('hex')}`;
  }

  let pg = null;
  let db = null;
  let candidates = [];
  let inspectTotals = null;

  if (opts.mode === 'pglite') {
    pg = await createTestPg({ openVoting: true });
    db = createSupabaseRpcAdapter(pg);
    candidates = (await db.query(
      'select id, order_number, name from public.candidates where is_active = true order by order_number'
    )).rows;
    inspectTotals = async () => {
      const voterCount = (await db.query(
        'select count(*)::int as c from public.registered_voters where has_voted = true'
      )).rows[0].c;
      const tallies = (await db.query(
        `select c.id, c.order_number, c.name, coalesce(t.votes, 0)::int as votes
         from public.candidates c
         left join public.vote_tallies t on t.candidate_id = c.id
         where c.is_active = true
         order by c.order_number`
      )).rows;
      return { voterCount, tallies };
    };
  } else {
    const { url, key } = assertSafeSupabaseSandbox(env);
    db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: candRows, error: candErr } = await db
      .from('candidates')
      .select('id, order_number, name')
      .eq('is_active', true)
      .order('order_number');
    if (candErr) throw new Error(`Gagal membaca calon di database uji: ${candErr.message}`);
    if (!candRows || candRows.length === 0) {
      throw new Error('Tidak ada calon aktif di database uji.');
    }
    candidates = candRows;
    inspectTotals = async () => {
      const { count: voterCount, error: vErr } = await db
        .from('registered_voters')
        .select('email', { count: 'exact', head: true })
        .eq('has_voted', true);
      if (vErr) throw new Error(`Gagal membaca registered_voters: ${vErr.message}`);

      const { data: tallyRows, error: tErr } = await db
        .from('vote_tallies')
        .select('candidate_id, votes');
      if (tErr) throw new Error(`Gagal membaca vote_tallies: ${tErr.message}`);

      const byId = new Map((tallyRows || []).map(r => [r.candidate_id, Number(r.votes || 0)]));
      const tallies = candidates.map(c => ({
        id: c.id,
        order_number: c.order_number,
        name: c.name,
        votes: byId.get(c.id) || 0
      }));
      return { voterCount: voterCount || 0, tallies };
    };
  }

  try {
    const baseline = await inspectTotals();

    // Transport email PALSU (in-memory capture) - nol email sungguhan keluar
    const capturedOtps = new Map();
    let mockEmailsCaptured = 0;
    const mockMailer = {
      async sendMail(msg) {
        mockEmailsCaptured++;
        const code = extractOtpFromMessage(msg);
        if (code && msg.to) {
          capturedOtps.set(String(msg.to).toLowerCase(), code);
        }
        return { messageId: `mock-${mockEmailsCaptured}@sandbox.invalid` };
      }
    };

    const sendOtpHandler = sendOtpMod.createHandler({
      getDb: () => db,
      getMailer: () => mockMailer,
      getFromAddress: () => 'simulasi-panitia@sandbox.invalid'
    });
    const verifyOtpHandler = verifyOtpMod.createHandler({ getDb: () => db });
    const castVoteHandler = castVoteMod.createHandler({ getDb: () => db });

    // Buat N akun uji sintetis dengan prefix jelas bukan milik mahasiswa nyata
    const runTag = opts.mode === 'pglite' ? 'lokal' : `uji${Date.now().toString(36).slice(-5)}`;
    const accounts = Array.from({ length: opts.voters }, (_, i) => {
      const num = String(i + 1).padStart(3, '0');
      const prefix = `simulasi.${runTag}.${num}`;
      const email = `${prefix}@mail.ugm.ac.id`;
      // Variasi NIM opsional: sebagian diisi, sebagian kosong, sebagian tidak dikirim
      const nimMode = i % 3;
      const nim = nimMode === 0 ? `22/99${num}0/SV/99${num}` : (nimMode === 1 ? '' : undefined);
      const candidate = candidates[i % candidates.length];
      // Simulasi beberapa NAT Wi-Fi kampus memakai blok RFC 5737 (TEST-NET-2)
      const ip = `198.51.100.${(i % 4) + 1}`;
      return { index: i, prefix, email, nim, candidate, ip, probeDuplicate: i < opts.duplicateProbes };
    });

    const stats = {
      sendOtp: { succeeded: 0, rejected: 0, errors: 0, latencies: [] },
      verifyOtp: { succeeded: 0, rejected: 0, errors: 0, latencies: [] },
      castVote: { succeeded: 0, rejected: 0, errors: 0, latencies: [] },
      duplicateOtpProbes: { succeeded: 0, rejected: 0, errors: 0, latencies: [] },
      duplicateVoteProbes: { succeeded: 0, rejected: 0, errors: 0, latencies: [] }
    };
    const expectedByCandidate = new Map(candidates.map(c => [c.id, 0]));
    const unexpectedErrors = [];

    const startedAt = performance.now();

    await runPool(accounts, opts.concurrency, async (acct) => {
      // 1. Request OTP
      const sendBody = { email_prefix: acct.prefix };
      if (acct.nim !== undefined) sendBody.nim = acct.nim;

      const t0 = performance.now();
      const sendRes = await invokeHandler(sendOtpHandler, { ip: acct.ip, body: sendBody });
      stats.sendOtp.latencies.push(performance.now() - t0);

      if (sendRes.statusCode === 200 && sendRes.payload?.success) {
        stats.sendOtp.succeeded++;
      } else if (sendRes.statusCode >= 400 && sendRes.statusCode < 500) {
        stats.sendOtp.rejected++;
        return;
      } else {
        stats.sendOtp.errors++;
        unexpectedErrors.push({ stage: 'send-otp', email: acct.email, status: sendRes.statusCode, error: sendRes.payload?.error });
        return;
      }

      // Probe duplikasi OTP (harus ditolak 429 oleh server)
      if (acct.probeDuplicate) {
        const td0 = performance.now();
        const dupOtpRes = await invokeHandler(sendOtpHandler, { ip: acct.ip, body: sendBody });
        stats.duplicateOtpProbes.latencies.push(performance.now() - td0);
        if (dupOtpRes.statusCode === 429) {
          stats.duplicateOtpProbes.rejected++;
        } else if (dupOtpRes.statusCode === 200) {
          stats.duplicateOtpProbes.succeeded++;
          unexpectedErrors.push({ stage: 'duplicate-otp-probe', email: acct.email, status: 200, error: 'Duplicate OTP unexpectedly allowed' });
        } else {
          stats.duplicateOtpProbes.errors++;
          unexpectedErrors.push({ stage: 'duplicate-otp-probe', email: acct.email, status: dupOtpRes.statusCode, error: dupOtpRes.payload?.error });
        }
      }

      const otpCode = capturedOtps.get(acct.email);
      if (!otpCode) {
        stats.verifyOtp.errors++;
        unexpectedErrors.push({ stage: 'capture-otp', email: acct.email, error: 'OTP not captured by mock mailer' });
        return;
      }

      // 2. Verify OTP
      const verifyBody = { email: acct.email, otp: otpCode };
      if (acct.nim !== undefined) verifyBody.nim = acct.nim;

      const t1 = performance.now();
      const verifyRes = await invokeHandler(verifyOtpHandler, { ip: acct.ip, body: verifyBody });
      stats.verifyOtp.latencies.push(performance.now() - t1);

      let ballotToken = null;
      if (verifyRes.statusCode === 200 && verifyRes.payload?.ballot_token) {
        stats.verifyOtp.succeeded++;
        ballotToken = verifyRes.payload.ballot_token;
      } else if (verifyRes.statusCode >= 400 && verifyRes.statusCode < 500) {
        stats.verifyOtp.rejected++;
        return;
      } else {
        stats.verifyOtp.errors++;
        unexpectedErrors.push({ stage: 'verify-otp', email: acct.email, status: verifyRes.statusCode, error: verifyRes.payload?.error });
        return;
      }

      // 3. Cast Vote (untuk probe duplikasi, kirim 2 request paralel sekaligus!)
      if (acct.probeDuplicate) {
        const otherCand = candidates[(acct.index + 1) % candidates.length];
        const t2 = performance.now();
        const [v1, v2] = await Promise.all([
          invokeHandler(castVoteHandler, { ip: acct.ip, body: { ballot_token: ballotToken, candidate_id: acct.candidate.id } }),
          invokeHandler(castVoteHandler, { ip: acct.ip, body: { ballot_token: ballotToken, candidate_id: otherCand.id } })
        ]);
        const elapsed = performance.now() - t2;
        stats.castVote.latencies.push(elapsed);
        stats.duplicateVoteProbes.latencies.push(elapsed);

        const pair = [
          { res: v1, candId: acct.candidate.id },
          { res: v2, candId: otherCand.id }
        ];
        const okPair = pair.filter(p => p.res.statusCode === 200 && p.res.payload?.success);
        const rejPair = pair.filter(p => p.res.statusCode >= 400 && p.res.statusCode < 500);
        const errPair = pair.filter(p => p.res.statusCode >= 500);

        if (okPair.length === 1 && rejPair.length === 1) {
          stats.castVote.succeeded++;
          stats.duplicateVoteProbes.rejected++;
          expectedByCandidate.set(okPair[0].candId, (expectedByCandidate.get(okPair[0].candId) || 0) + 1);
        } else {
          if (okPair.length > 1) {
            stats.duplicateVoteProbes.succeeded += okPair.length - 1;
            unexpectedErrors.push({ stage: 'duplicate-vote-probe', email: acct.email, error: `Double vote accepted (${okPair.length})` });
          }
          if (errPair.length > 0) {
            stats.castVote.errors += errPair.length;
            unexpectedErrors.push({ stage: 'cast-vote-parallel', email: acct.email, error: errPair[0].res.payload?.error });
          }
        }
      } else {
        const t2 = performance.now();
        const voteRes = await invokeHandler(castVoteHandler, {
          ip: acct.ip,
          body: { ballot_token: ballotToken, candidate_id: acct.candidate.id }
        });
        stats.castVote.latencies.push(performance.now() - t2);

        if (voteRes.statusCode === 200 && voteRes.payload?.success) {
          stats.castVote.succeeded++;
          expectedByCandidate.set(acct.candidate.id, (expectedByCandidate.get(acct.candidate.id) || 0) + 1);
        } else if (voteRes.statusCode >= 400 && voteRes.statusCode < 500) {
          stats.castVote.rejected++;
        } else {
          stats.castVote.errors++;
          unexpectedErrors.push({ stage: 'cast-vote', email: acct.email, status: voteRes.statusCode, error: voteRes.payload?.error });
        }
      }
    });

    const totalElapsedMs = Number((performance.now() - startedAt).toFixed(2));
    const after = await inspectTotals();

    const deltaVoters = after.voterCount - baseline.voterCount;
    const baselineByCand = new Map(baseline.tallies.map(t => [t.id, t.votes]));
    const candidateBreakdown = after.tallies.map(t => {
      const deltaVotes = t.votes - (baselineByCand.get(t.id) || 0);
      const expected = expectedByCandidate.get(t.id) || 0;
      return {
        order_number: t.order_number,
        name: t.name,
        expectedVotes: expected,
        recordedDeltaVotes: deltaVotes,
        matched: deltaVotes === expected
      };
    });
    const deltaTotalTallies = candidateBreakdown.reduce((acc, c) => acc + c.recordedDeltaVotes, 0);

    const totalSucceeded = stats.castVote.succeeded;
    const totalRejected =
      stats.sendOtp.rejected +
      stats.verifyOtp.rejected +
      stats.castVote.rejected +
      stats.duplicateOtpProbes.rejected +
      stats.duplicateVoteProbes.rejected;
    const totalErrors =
      stats.sendOtp.errors +
      stats.verifyOtp.errors +
      stats.castVote.errors +
      stats.duplicateOtpProbes.errors +
      stats.duplicateVoteProbes.errors +
      stats.duplicateOtpProbes.succeeded +
      stats.duplicateVoteProbes.succeeded;

    const tallyMatchesVoters =
      deltaVoters === totalSucceeded &&
      deltaTotalTallies === totalSucceeded &&
      candidateBreakdown.every(c => c.matched);

    const passed =
      totalErrors === 0 &&
      totalSucceeded === opts.voters &&
      stats.duplicateOtpProbes.rejected === opts.duplicateProbes &&
      stats.duplicateVoteProbes.rejected === opts.duplicateProbes &&
      tallyMatchesVoters;

    return {
      passed,
      config: {
        mode: opts.mode,
        voters: opts.voters,
        concurrency: opts.concurrency,
        duplicateProbes: opts.duplicateProbes,
        mailTransport: 'in-memory-mock (0 real emails sent)'
      },
      durationMs: totalElapsedMs,
      mockEmailsCaptured,
      summary: {
        votersSucceeded: totalSucceeded,
        requestsRejected: totalRejected,
        unexpectedErrors: totalErrors
      },
      stages: {
        sendOtp: { ...stats.sendOtp, latencies: summarizeLatencies(stats.sendOtp.latencies) },
        verifyOtp: { ...stats.verifyOtp, latencies: summarizeLatencies(stats.verifyOtp.latencies) },
        castVote: { ...stats.castVote, latencies: summarizeLatencies(stats.castVote.latencies) },
        duplicateOtpProbes: { ...stats.duplicateOtpProbes, latencies: summarizeLatencies(stats.duplicateOtpProbes.latencies) },
        duplicateVoteProbes: { ...stats.duplicateVoteProbes, latencies: summarizeLatencies(stats.duplicateVoteProbes.latencies) }
      },
      reconciliation: {
        successfulVoters: totalSucceeded,
        recordedAttendanceDelta: deltaVoters,
        recordedTallyDelta: deltaTotalTallies,
        tallyMatchesVoters,
        candidates: candidateBreakdown
      },
      unexpectedErrors: unexpectedErrors.slice(0, 20)
    };
  } finally {
    if (pg) await pg.close();
  }
}

function printHumanReport(report) {
  console.log('=== SIMULASI BEBAN PEMILWA KMTEDI ===');
  console.log(`Mode target      : ${report.config.mode}`);
  console.log(`Akun uji         : ${report.config.voters} akun sintetis (konkurensi: ${report.config.concurrency})`);
  console.log(`Probe duplikasi  : ${report.config.duplicateProbes} OTP ganda + ${report.config.duplicateProbes} suara ganda paralel`);
  console.log(`Transport email  : ${report.config.mailTransport} (captured: ${report.mockEmailsCaptured})`);
  console.log(`Durasi total     : ${report.durationMs} ms`);
  console.log('');
  console.log('--- Ringkasan Hasil ---');
  console.log(`Pemilih berhasil : ${report.summary.votersSucceeded} / ${report.config.voters}`);
  console.log(`Request ditolak  : ${report.summary.requestsRejected} (expected duplicate/cooldown probes)`);
  console.log(`Error tak terduga: ${report.summary.unexpectedErrors}`);
  console.log('');
  console.log('--- Waktu Respons per Tahap (ms) ---');
  for (const [name, st] of Object.entries(report.stages)) {
    const l = st.latencies;
    console.log(
      `  ${name.padEnd(20)} ok=${String(st.succeeded).padStart(3)} rej=${String(st.rejected).padStart(3)} err=${String(st.errors).padStart(2)} | avg=${l.avgMs}ms p50=${l.p50Ms}ms p95=${l.p95Ms}ms p99=${l.p99Ms}ms max=${l.maxMs}ms`
    );
  }
  console.log('');
  console.log('--- Rekonsiliasi Jumlah Suara ---');
  console.log(`Suara berhasil (klien)  : ${report.reconciliation.successfulVoters}`);
  console.log(`Presensi tercatat (DB)  : ${report.reconciliation.recordedAttendanceDelta}`);
  console.log(`Total tally calon (DB)  : ${report.reconciliation.recordedTallyDelta}`);
  console.log(`Kesesuaian tally vs DB  : ${report.reconciliation.tallyMatchesVoters ? 'SESUAI (EXACT MATCH)' : 'TIDAK SESUAI'}`);
  for (const c of report.reconciliation.candidates) {
    console.log(`  Calon 0${c.order_number} (${c.name}): expected=${c.expectedVotes}, db=${c.recordedDeltaVotes} [${c.matched ? 'OK' : 'MISMATCH'}]`);
  }
  if (report.unexpectedErrors.length) {
    console.log('');
    console.log('--- Contoh Error Tak Terduga ---');
    console.log(JSON.stringify(report.unexpectedErrors, null, 2));
  }
  console.log('');
  console.log(`STATUS AKHIR: ${report.passed ? 'PASS' : 'FAIL'}`);
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: node scripts/load-test-300.mjs [--voters=300] [--concurrency=30] [--duplicate-probes=30] [--mode=pglite|supabase] [--json]');
      process.exit(0);
    }
    const report = await runLoadSimulation(opts);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    console.error('Load test aborted:', err.message);
    process.exit(1);
  }
}
