-- =========================================================================
-- MIGRATION: PEMILWA KMTEDI SIAP 300 PEMILIH (NON-DESTRUCTIVE, IDEMPOTENT)
-- =========================================================================
-- Dirancang aman untuk dijalankan baik pada database yang sudah memiliki
-- migrasi hardening sebelumnya maupun pada database uji yang baru menerapkan
-- migrasi awal (20261022000000..20261022000003).
-- Tidak ada DROP TABLE pada tabel data utama (candidates, election_settings,
-- registered_voters, vote_tallies, eligible_voters).
-- =========================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- -------------------------------------------------------------------------
-- 0. Hapus fungsi fallback lama yang dapat melewati alur token & DB lock
-- -------------------------------------------------------------------------
drop function if exists public.cast_vote_by_nim_and_email(uuid, text, text);
drop function if exists public.cast_vote_by_nim_and_name(uuid, text, text);
drop function if exists public.cast_vote_by_nim_and_name(uuid, text, text, text);
drop function if exists public.cast_vote_by_nim(uuid, text, text, text);
drop function if exists public.cast_vote(uuid);
drop function if exists public.generate_voter_otp(text, text);
drop function if exists public.generate_voter_otp(text, text, text);
drop function if exists public.verify_voter_otp(text, text);
drop function if exists public.verify_voter(text, text);

-- -------------------------------------------------------------------------
-- 1. Pastikan tabel internal, vote_tallies, dan constraint email unik aktif
-- -------------------------------------------------------------------------
-- Pekerjaan 2: Satu email satu suara di level database (case-insensitive)
-- Normalisasi data eksisting secara aman tanpa menghapus baris pemilih.
drop policy if exists voters_anon_read on public.registered_voters;

update public.registered_voters
set email = lower(trim(email))
where email is not null and email <> lower(trim(email));

do $$
declare
  pk_cols text;
begin
  select string_agg(a.attname, ',' order by k.ord) into pk_cols
  from pg_constraint c
  join unnest(c.conkey) with ordinality as k(attnum, ord) on true
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.registered_voters'::regclass and c.contype = 'p';

  if pk_cols is distinct from 'email' then
    if pk_cols is not null then
      execute 'alter table public.registered_voters drop constraint registered_voters_pkey';
    end if;
    alter table public.registered_voters alter column nim drop not null;
    alter table public.registered_voters add constraint registered_voters_pkey primary key (email);
  else
    alter table public.registered_voters alter column nim drop not null;
  end if;
end $$;

create unique index if not exists registered_voters_email_lower_uidx
  on public.registered_voters (lower(trim(email)));

alter table public.registered_voters
  drop constraint if exists registered_voters_email_normalized_chk;
alter table public.registered_voters
  add constraint registered_voters_email_normalized_chk
  check (
    email = lower(trim(email))
    and email ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@mail[.]ugm[.]ac[.]id$'
  );

create or replace function private.normalize_email_trigger()
returns trigger
language plpgsql
security definer set search_path = public, private
as $$
begin
  new.email := lower(trim(coalesce(new.email, '')));
  return new;
end;
$$;

drop trigger if exists trg_registered_voters_normalize_email on public.registered_voters;
create trigger trg_registered_voters_normalize_email
before insert or update on public.registered_voters
for each row execute function private.normalize_email_trigger();
create table if not exists private.admin_credentials (
  id boolean primary key default true check (id = true),
  pin_hash text not null,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists private.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);

create table if not exists private.voter_otps (
  email text primary key,
  nim text,
  otp_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  window_start timestamptz,
  sends int not null default 0
);

alter table private.voter_otps add column if not exists window_start timestamptz;
alter table private.voter_otps add column if not exists sends int not null default 0;

create table if not exists private.ballot_tokens (
  token_hash text primary key,
  nim text,
  email text not null,
  expires_at timestamptz not null
);

create table if not exists public.eligible_voters (
  nim text primary key,
  email text not null unique
);
alter table public.eligible_voters enable row level security;

-- Tabel tally terpisah dari identitas pemilih (tanpa email, NIM, atau timestamp)
create table if not exists public.vote_tallies (
  candidate_id uuid primary key references public.candidates(id) on delete restrict,
  votes bigint not null default 0 check (votes >= 0)
);
alter table public.vote_tallies enable row level security;

-- Pastikan setiap calon sudah memiliki baris tally awal
insert into public.vote_tallies (candidate_id, votes)
select id, 0 from public.candidates
on conflict (candidate_id) do nothing;

-- -------------------------------------------------------------------------
-- 2. Helper dasar untuk jadwal bilik suara, rate limit, dan OTP/ballot
-- -------------------------------------------------------------------------
create or replace function private.voting_is_open()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.election_settings
    where id = true
      and voting_open = true
      and (voting_start is null or timezone('utc', now()) >= voting_start)
      and (voting_end is null or timezone('utc', now()) <= voting_end)
  );
$$;

create or replace function public.api_rate_hit(p_key text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
security definer set search_path = private, public
as $$
declare
  now_ts timestamptz := timezone('utc', now());
  current_hits int;
begin
  insert into private.rate_limits as r (key, window_start, hits)
  values (p_key, now_ts, 1)
  on conflict (key) do update set
    hits = case when r.window_start < now_ts - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now_ts - make_interval(secs => p_window_seconds) then now_ts else r.window_start end
  returning hits into current_hits;

  if random() < 0.02 then
    delete from private.rate_limits where window_start < now_ts - interval '1 day';
  end if;

  return current_hits <= p_limit;
end;
$$;

create or replace function private.normalize_nim(p_nim text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g'));
$$;

create or replace function private.check_voter_identity(p_nim text, p_email text)
returns void
language plpgsql
security definer set search_path = public, private
as $$
begin
  if p_email !~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@mail[.]ugm[.]ac[.]id$' then
    raise exception 'Email harus akun resmi @mail.ugm.ac.id.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.eligible_voters)
     and not exists (select 1 from public.eligible_voters where lower(trim(email)) = p_email) then
    raise exception 'Email tidak terdaftar di Daftar Pemilih Tetap.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.registered_voters where lower(trim(email)) = p_email and has_voted = true) then
    raise exception 'Akun email ini sudah menggunakan hak suara.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.voter_request_otp(p_nim text, p_email text)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  clean_nim text := private.normalize_nim(p_nim);
  clean_email text := lower(trim(coalesce(p_email, '')));
  now_ts timestamptz := timezone('utc', now());
  code text;
  prev private.voter_otps%rowtype;
  new_window timestamptz;
  new_sends int;
begin
  if not private.voting_is_open() then
    raise exception 'Bilik suara sedang ditutup.' using errcode = 'P0001';
  end if;

  perform private.check_voter_identity(clean_nim, clean_email);

  select * into prev from private.voter_otps where email = clean_email for update;
  if found then
    if prev.created_at > now_ts - interval '60 seconds' then
      raise exception 'Tunggu 60 detik sebelum meminta kode baru.' using errcode = 'P0429';
    end if;
    if prev.window_start is not null and prev.window_start > now_ts - interval '1 hour' and prev.sends >= 6 then
      raise exception 'Kode OTP sudah diminta terlalu sering. Coba lagi dalam 1 jam.' using errcode = 'P0429';
    end if;
  end if;

  if prev.window_start is null or prev.window_start <= now_ts - interval '1 hour' then
    new_window := now_ts;
    new_sends := 1;
  else
    new_window := prev.window_start;
    new_sends := prev.sends + 1;
  end if;

  code := lpad((abs(('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');

  insert into private.voter_otps (email, nim, otp_hash, expires_at, attempts, created_at, window_start, sends)
  values (clean_email, clean_nim, encode(digest(code, 'sha256'), 'hex'),
          now_ts + interval '10 minutes', 0, now_ts, new_window, new_sends)
  on conflict (email) do update set
    nim = excluded.nim,
    otp_hash = excluded.otp_hash,
    expires_at = excluded.expires_at,
    attempts = 0,
    created_at = excluded.created_at,
    window_start = excluded.window_start,
    sends = excluded.sends;

  return jsonb_build_object('nim', clean_nim, 'email', clean_email, 'otp_code', code);
end;
$$;

create or replace function public.voter_verify_otp(p_email text, p_nim text, p_otp text)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  clean_email text := lower(trim(coalesce(p_email, '')));
  rec private.voter_otps%rowtype;
  raw_token text;
begin
  select * into rec from private.voter_otps where email = clean_email for update;
  if not found or rec.otp_hash = '' then
    return jsonb_build_object('ok', false, 'error', 'Kode OTP tidak ditemukan. Silakan minta kode baru.');
  end if;

  if rec.expires_at < timezone('utc', now()) or rec.attempts >= 5 then
    update private.voter_otps set otp_hash = '' where email = clean_email;
    return jsonb_build_object('ok', false, 'error', 'Kode OTP kedaluwarsa atau terlalu banyak percobaan. Minta kode baru.');
  end if;

  if rec.otp_hash <> encode(digest(trim(coalesce(p_otp, '')), 'sha256'), 'hex') then
    update private.voter_otps
    set attempts = attempts + 1,
        otp_hash = case when attempts + 1 >= 5 then '' else otp_hash end
    where email = clean_email;
    return jsonb_build_object('ok', false, 'error',
      case when rec.attempts + 1 >= 5
        then 'Kode OTP salah 5 kali dan sudah dinonaktifkan. Minta kode baru.'
        else format('Kode OTP salah. Sisa percobaan: %s.', 4 - rec.attempts) end);
  end if;

  update private.voter_otps set otp_hash = '' where email = clean_email;
  delete from private.ballot_tokens where email = clean_email or expires_at < timezone('utc', now());

  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into private.ballot_tokens (token_hash, nim, email, expires_at)
  values (encode(digest(raw_token, 'sha256'), 'hex'), rec.nim, rec.email,
          timezone('utc', now()) + interval '30 minutes');

  return jsonb_build_object('ok', true, 'nim', rec.nim, 'email', rec.email, 'ballot_token', raw_token);
end;
$$;

-- -------------------------------------------------------------------------
-- 3. Pekerjaan 1: Transaksi suara atomik (tanpa tautan email <-> calon)
-- -------------------------------------------------------------------------
-- Satu fungsi PL/pgSQL berjalan dalam satu transaksi PostgreSQL:
-- 1) Mengonsumsi token sekali pakai (DELETE ... RETURNING)
-- 2) Memvalidasi status bilik suara dan calon aktif
-- 3) Mencatat presensi pemilih di public.registered_voters (tanpa candidate_id)
-- 4) Menambah tally calon di public.vote_tallies secara atomik (tanpa email)
--    dengan penguncian deterministik (ORDER BY candidate_id FOR UPDATE) dan
--    klausa WHERE eksplisit (kompatibel pg_safeupdate Supabase).
-- Jika salah satu langkah gagal, seluruh transaksi otomatis di-rollback.
create or replace function public.voter_cast_ballot(p_token text, p_candidate_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  tok private.ballot_tokens%rowtype;
  clean_email text;
  now_ts timestamptz := timezone('utc', now());
  updated_tally_rows int := 0;
begin
  if p_candidate_id is null then
    raise exception 'Calon yang dipilih tidak valid.' using errcode = 'P0001';
  end if;

  -- Konsumsi token secara atomik; dua request paralel dengan token sama
  -- hanya akan mengembalikan baris untuk tepat satu transaksi.
  delete from private.ballot_tokens
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  returning * into tok;

  if not found or tok.expires_at < now_ts then
    raise exception 'Sesi pemilih tidak valid atau kedaluwarsa. Verifikasi ulang lewat OTP.' using errcode = 'P0401';
  end if;

  if not private.voting_is_open() then
    raise exception 'Bilik suara sedang ditutup.' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.candidates
    where id = p_candidate_id and is_active = true
  ) then
    raise exception 'Calon yang dipilih tidak valid.' using errcode = 'P0001';
  end if;

  clean_email := lower(trim(coalesce(tok.email, '')));
  if clean_email = '' then
    raise exception 'Sesi pemilih tidak valid. Verifikasi ulang lewat OTP.' using errcode = 'P0401';
  end if;

  -- Catat presensi pemilih tanpa kolom candidate_id (Keputusan 1).
  -- Menggunakan ON CONFLICT (email) DO UPDATE ... WHERE has_voted = false
  -- agar jaminan 1 email 1 suara berlaku atomik di level database baik untuk
  -- baris baru maupun baris legacy dengan has_voted = false.
  declare
    recorded_voter_rows int := 0;
  begin
    insert into public.registered_voters (email, nim, has_voted, voted_at)
    values (clean_email, nullif(trim(coalesce(tok.nim, '')), ''), true, now_ts)
    on conflict (email) do update
      set has_voted = true,
          voted_at = now_ts,
          nim = coalesce(excluded.nim, public.registered_voters.nim)
      where public.registered_voters.has_voted = false;
    get diagnostics recorded_voter_rows = row_count;
    if recorded_voter_rows <> 1 then
      raise exception 'Akun email ini sudah menggunakan hak suara.' using errcode = 'P0001';
    end if;
  exception when unique_violation then
    raise exception 'Akun email ini sudah menggunakan hak suara.' using errcode = 'P0001';
  end;

  -- Pastikan seluruh calon aktif memiliki baris tally dalam urutan deterministik.
  insert into public.vote_tallies (candidate_id, votes)
  select id, 0 from public.candidates
  where is_active = true
  order by id
  on conflict (candidate_id) do nothing;

  -- Kunci baris tally dalam urutan candidate_id yang konsisten untuk mencegah
  -- deadlock, lalu sentuh seluruh baris tally dalam satu statement agar xmin
  -- tidak membocorkan calon pilihan, sambil memakai WHERE agar aman pg_safeupdate.
  perform 1 from public.vote_tallies
  where candidate_id is not null
  order by candidate_id
  for update;

  update public.vote_tallies
  set votes = votes + case when candidate_id = p_candidate_id then 1 else 0 end
  where candidate_id is not null;

  select count(*) into updated_tally_rows
  from public.vote_tallies
  where candidate_id = p_candidate_id;

  if updated_tally_rows <> 1 then
    raise exception 'Calon yang dipilih tidak valid.' using errcode = 'P0001';
  end if;

  return jsonb_build_object('success', true);
end;
$$;

-- -------------------------------------------------------------------------
-- 4. Hak akses: semua RPC pemilih & rate limit hanya untuk service_role
-- -------------------------------------------------------------------------
grant usage on schema private to service_role;
revoke all on all tables in schema private from public, anon, authenticated;

revoke all on function public.api_rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.api_rate_hit(text, int, int) to service_role;

revoke all on function public.voter_request_otp(text, text) from public, anon, authenticated;
grant execute on function public.voter_request_otp(text, text) to service_role;

revoke all on function public.voter_verify_otp(text, text, text) from public, anon, authenticated;
grant execute on function public.voter_verify_otp(text, text, text) to service_role;

revoke all on function public.voter_cast_ballot(text, uuid) from public, anon, authenticated;
grant execute on function public.voter_cast_ballot(text, uuid) to service_role;

revoke all on public.registered_voters from anon, authenticated;
revoke all on public.eligible_voters from anon, authenticated;
revoke all on public.vote_tallies from anon, authenticated;
