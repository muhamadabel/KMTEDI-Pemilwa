import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { REPO_ROOT } from '../helpers/pglite-db.mjs';

test('Migration upgrade: safely upgrades a pre-existing hardened production-like DB without losing voters, tallies, or admin PIN', async () => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  try {
    await pg.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema extensions;
      create extension pgcrypto with schema extensions;
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
      alter table storage.objects enable row level security;
      grant usage on schema public, extensions to anon, authenticated, service_role;
      set search_path = public, extensions;
    `);

    // Apply initial 4 migrations + seed
    const migDir = path.join(REPO_ROOT, 'supabase/migrations');
    for (const f of [
      '20261022000000_initial_schema.sql',
      '20261022000001_nim_and_pin_auth.sql',
      '20261022000002_nim_nama_kapital_vote.sql',
      '20261022000003_email_otp_auth.sql'
    ]) {
      await pg.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    await pg.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/seed.sql'), 'utf8'));

    // Simulate existing hardened production state (strict NOT NULL nim in private tables,
    // registered_voters PK on nim, existing voter attendance, existing tallies, existing admin PIN hash)
    await pg.exec(`
      create schema if not exists private;
      create table private.admin_credentials (
        id boolean primary key default true check (id = true),
        pin_hash text not null,
        updated_at timestamptz not null default timezone('utc', now())
      );
      insert into private.admin_credentials (id, pin_hash)
      values (true, crypt('existing-prod-like-pin-1234', gen_salt('bf', 10)));

      create table private.voter_otps (
        email text primary key,
        nim text not null,
        otp_hash text not null,
        expires_at timestamptz not null,
        attempts int not null default 0,
        created_at timestamptz not null default timezone('utc', now())
      );
      create table private.ballot_tokens (
        token_hash text primary key,
        nim text not null,
        email text not null,
        expires_at timestamptz not null
      );
      create table public.vote_tallies (
        candidate_id uuid primary key references public.candidates(id) on delete restrict,
        votes bigint not null default 0 check (votes >= 0)
      );
      insert into public.vote_tallies (candidate_id, votes)
      select id, 5 from public.candidates;

      insert into public.registered_voters (nim, email, has_voted, voted_at)
      values
        ('22/500001/SV/20001', 'Pemilih.Lama@MAIL.UGM.AC.ID', true, timezone('utc', now())),
        ('UGM/PREEXISTING', 'pemilih.lama.dua@mail.ugm.ac.id', true, timezone('utc', now()));
    `);

    // Apply our new migration TWICE (upgrade + idempotency check)
    const migrationSql = fs.readFileSync(path.join(migDir, '20261125000000_pemilwa_siap_300_pemilih.sql'), 'utf8');
    await pg.exec(migrationSql);
    await pg.exec(migrationSql);

    // 1. Existing voters preserved & emails normalized to lowercase
    const voters = (await pg.query('select email, nim, has_voted from public.registered_voters order by email')).rows;
    assert.deepEqual(voters, [
      { email: 'pemilih.lama.dua@mail.ugm.ac.id', nim: 'UGM/PREEXISTING', has_voted: true },
      { email: 'pemilih.lama@mail.ugm.ac.id', nim: '22/500001/SV/20001', has_voted: true }
    ]);

    // 2. Existing tallies preserved (3 candidates x 5 votes = 15)
    const tallySum = (await pg.query('select sum(votes)::int as s from public.vote_tallies')).rows[0].s;
    assert.equal(tallySum, 15);

    // 3. Existing admin PIN hash preserved and still verifies
    const pinOk = (await pg.query(`select public.admin_check_pin('existing-prod-like-pin-1234') as ok`)).rows[0].ok;
    assert.equal(pinOk, true);

    // 4. Optional NULL NIM now allowed in voter_otps, ballot_tokens, and registered_voters
    await pg.query(`
      insert into public.registered_voters (email, nim, has_voted, voted_at)
      values ('pemilih.baru.tanpa.nim@mail.ugm.ac.id', null, true, timezone('utc', now()))
    `);
    assert.equal((await pg.query('select count(*)::int as c from public.registered_voters')).rows[0].c, 3);
  } finally {
    await pg.close();
  }
});
