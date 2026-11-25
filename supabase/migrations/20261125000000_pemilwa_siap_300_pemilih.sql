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
drop function if exists public.admin_verify_pin(text);
drop function if exists public.admin_get_stats_by_pin(text);
drop function if exists public.admin_get_results_by_pin(text);
drop function if exists public.admin_get_voters_by_pin(text);
drop function if exists public.admin_toggle_switch(text, text);
drop function if exists public.admin_save_candidate(text, uuid, integer, text, text, text, text, text, text[], text[], text, boolean);
drop function if exists public.admin_delete_candidate(text, uuid);
drop function if exists public.admin_save_panels(text, jsonb, text, text, text, jsonb);
drop function if exists public.admin_reset_votes(text);
drop function if exists public.admin_set_schedule(text, timestamptz, timestamptz);

-- Hapus kolom PIN plaintext lama jika masih ada di election_settings
alter table public.election_settings drop column if exists admin_pin;

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
  check (email = lower(trim(email)) and email <> '');

-- Validasi domain @mail.ugm.ac.id berlaku untuk seluruh INSERT/UPDATE baru
-- dengan NOT VALID agar migrasi tetap aman bila terdapat baris historis lama.
alter table public.registered_voters
  drop constraint if exists registered_voters_email_domain_chk;
alter table public.registered_voters
  add constraint registered_voters_email_domain_chk
  check (email ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@mail[.]ugm[.]ac[.]id$') not valid;

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
alter table private.voter_otps alter column nim drop not null;

create table if not exists private.ballot_tokens (
  token_hash text primary key,
  nim text,
  email text not null,
  expires_at timestamptz not null
);

alter table private.ballot_tokens alter column nim drop not null;

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
  select nullif(left(upper(regexp_replace(coalesce(p_nim, ''), '[^0-9A-Za-z/.-]+', '', 'g')), 32), '');
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

drop trigger if exists trg_voter_otps_normalize_email on private.voter_otps;
create trigger trg_voter_otps_normalize_email
before insert or update on private.voter_otps
for each row execute function private.normalize_email_trigger();

create or replace function public.voter_request_otp(p_nim text, p_email text)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  clean_nim text := nullif(private.normalize_nim(p_nim), '');
  clean_email text := lower(trim(coalesce(p_email, '')));
  now_ts timestamptz := timezone('utc', now());
  code text;
  prev private.voter_otps%rowtype;
  new_window timestamptz;
  new_sends int;
  retry_after int;
  is_ineligible boolean := false;
  already_voted boolean := false;
begin
  if clean_email !~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@mail[.]ugm[.]ac[.]id$' then
    return jsonb_build_object(
      'ok', false,
      'status', 400,
      'error', 'Email harus akun resmi @mail.ugm.ac.id.'
    );
  end if;

  if not private.voting_is_open() then
    return jsonb_build_object(
      'ok', false,
      'status', 400,
      'error', 'Bilik suara sedang ditutup.'
    );
  end if;

  -- Kunci transaksi per email agar request paralel pertama maupun ulangan
  -- untuk akun yang sama diserialisasi secara atomik, tanpa memblokir akun lain.
  perform pg_advisory_xact_lock(hashtext('voter_otp:' || clean_email));

  select * into prev from private.voter_otps where email = clean_email for update;
  if found then
    if prev.created_at > now_ts - interval '60 seconds' then
      retry_after := greatest(1, ceil(extract(epoch from (prev.created_at + interval '60 seconds' - now_ts)))::int);
      return jsonb_build_object(
        'ok', false,
        'status', 429,
        'retry_after', retry_after,
        'error', format('Permintaan kode OTP terlalu cepat. Tunggu %s detik sebelum meminta kode baru.', retry_after)
      );
    end if;

    if prev.window_start is not null and prev.window_start > now_ts - interval '1 hour' and prev.sends >= 6 then
      retry_after := greatest(1, ceil(extract(epoch from (prev.window_start + interval '1 hour' - now_ts)))::int);
      return jsonb_build_object(
        'ok', false,
        'status', 429,
        'retry_after', retry_after,
        'error', 'Permintaan kode OTP sudah mencapai batas sementara. Coba lagi dalam beberapa saat.'
      );
    end if;
  end if;

  if not found or prev.window_start is null or prev.window_start <= now_ts - interval '1 hour' then
    new_window := now_ts;
    new_sends := 1;
  else
    new_window := prev.window_start;
    new_sends := prev.sends + 1;
  end if;

  -- Cek kelayakan DPT (jika tabel DPT diisi) dan status sudah memilih.
  -- Keduanya menghasilkan respons penolakan identik agar tidak membocorkan
  -- apakah sebuah alamat email terdaftar atau tidak.
  if exists (select 1 from public.eligible_voters)
     and not exists (select 1 from public.eligible_voters where lower(trim(email)) = clean_email) then
    is_ineligible := true;
  end if;

  if exists (select 1 from public.registered_voters where lower(trim(email)) = clean_email and has_voted = true) then
    already_voted := true;
  end if;

  if is_ineligible or already_voted then
    insert into private.voter_otps (email, nim, otp_hash, expires_at, attempts, created_at, window_start, sends)
    values (clean_email, null, '', now_ts, 0, now_ts, new_window, new_sends)
    on conflict (email) do update set
      otp_hash = '',
      expires_at = excluded.expires_at,
      attempts = 0,
      created_at = excluded.created_at,
      window_start = excluded.window_start,
      sends = excluded.sends;

    return jsonb_build_object(
      'ok', false,
      'status', 400,
      'error', 'Permintaan kode OTP tidak dapat diproses untuk alamat email ini. Pastikan email @mail.ugm.ac.id memenuhi syarat dan belum memilih.'
    );
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

  return jsonb_build_object(
    'ok', true,
    'nim', clean_nim,
    'email', clean_email,
    'otp_code', code,
    'cooldown_seconds', 60
  );
end;
$$;

-- Pekerjaan 6: Verifikasi OTP tidak bergantung pada nilai NIM dari klien.
-- Drop seluruh overload lama agar tidak ada konflik signature saat dipanggil
-- dengan { p_email, p_otp } maupun { p_email, p_otp, p_nim }.
drop function if exists public.voter_verify_otp(text, text);
drop function if exists public.voter_verify_otp(text, text, text);

create or replace function public.voter_verify_otp(
  p_email text,
  p_otp text,
  p_nim text default null
)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  clean_email text := lower(trim(coalesce(p_email, '')));
  rec private.voter_otps%rowtype;
  raw_token text;
begin
  -- Parameter p_nim sengaja tidak diperiksa agar NIM opsional tidak pernah
  -- menggagalkan verifikasi OTP yang sah.
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
-- 4. Pekerjaan 4: Satu sumber kredensial admin (bcrypt di schema private)
--    beserta RPC panel admin yang aman pg_safeupdate
-- -------------------------------------------------------------------------
create or replace function private.set_admin_pin(p_pin text)
returns text
language plpgsql
security definer set search_path = private, public, extensions
as $$
begin
  if length(coalesce(p_pin, '')) < 12 then
    raise exception 'PIN admin minimal 12 karakter.' using errcode = 'P0001';
  end if;
  insert into private.admin_credentials (id, pin_hash, updated_at)
  values (true, crypt(p_pin, gen_salt('bf', 10)), timezone('utc', now()))
  on conflict (id) do update set
    pin_hash = excluded.pin_hash,
    updated_at = excluded.updated_at;
  return 'PIN admin berhasil diperbarui.';
end;
$$;

create or replace function public.admin_check_pin(p_pin text)
returns boolean
language plpgsql
security definer set search_path = private, public, extensions
as $$
declare
  stored text;
begin
  select pin_hash into stored from private.admin_credentials where id = true;
  if stored is null then
    return false;
  end if;
  return crypt(coalesce(p_pin, ''), stored) = stored;
end;
$$;

create or replace function public.admin_credentials_version()
returns text
language sql
stable
security definer set search_path = private
as $$
  select extract(epoch from updated_at)::bigint::text
  from private.admin_credentials
  where id = true;
$$;

create or replace function private.safe_media_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url is null
      or p_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
      or p_url ~ '^https://[^\s"''<>]+$'
      or p_url ~ '^assets/[A-Za-z0-9_./-]+$';
$$;

create or replace function public.admin_dashboard()
returns jsonb
language plpgsql
security definer set search_path = public, private
as $$
declare
  s public.election_settings%rowtype;
  open_now boolean := private.voting_is_open();
begin
  select * into s from public.election_settings where id = true;
  return jsonb_build_object(
    'settings', to_jsonb(s),
    'voting_open_now', open_now,
    'voted_count', (select count(*) from public.registered_voters where has_voted = true),
    'eligible_count', (select count(*) from public.eligible_voters),
    'results', case when open_now then null else (
      select coalesce(jsonb_agg(jsonb_build_object(
        'candidate_id', c.id, 'order_number', c.order_number,
        'candidate_name', c.name, 'vote_count', coalesce(t.votes, 0)
      ) order by c.order_number), '[]'::jsonb)
      from public.candidates c left join public.vote_tallies t on t.candidate_id = c.id
    ) end,
    'voters', (
      select coalesce(jsonb_agg(jsonb_build_object('nim', r.nim, 'email', r.email, 'voted_at', r.voted_at)
        order by r.voted_at desc), '[]'::jsonb)
      from public.registered_voters r
      where r.has_voted = true
    ),
    'candidates', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.order_number), '[]'::jsonb)
      from public.candidates c
    )
  );
end;
$$;

create or replace function public.admin_toggle(p_field text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare new_state boolean;
begin
  if p_field = 'voting_open' then
    update public.election_settings set voting_open = not voting_open where id = true returning voting_open into new_state;
  elsif p_field = 'results_published' then
    update public.election_settings set results_published = not results_published where id = true returning results_published into new_state;
  else
    raise exception 'Field tidak dikenal.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('field', p_field, 'new_state', new_state);
end;
$$;

create or replace function public.admin_set_schedule(p_start timestamptz, p_end timestamptz)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  if p_start is not null and p_end is not null and p_end <= p_start then
    raise exception 'Waktu penutupan harus setelah waktu pembukaan.' using errcode = 'P0001';
  end if;
  update public.election_settings set voting_start = p_start, voting_end = p_end where id = true;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.admin_save_candidate(
  p_id uuid,
  p_order_number integer,
  p_name text,
  p_batch text,
  p_nim text,
  p_photo_url text,
  p_vision text,
  p_mission text[],
  p_programs text[],
  p_organization_history text,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer set search_path = public, private
as $$
declare saved_id uuid;
begin
  if p_order_number is null or p_order_number < 1 then
    raise exception 'Nomor urut harus angka positif.' using errcode = 'P0001';
  end if;
  if trim(coalesce(p_name, '')) = '' or length(p_name) > 120 then
    raise exception 'Nama calon wajib diisi (maks. 120 karakter).' using errcode = 'P0001';
  end if;
  if not private.safe_media_url(nullif(trim(p_photo_url), '')) then
    raise exception 'URL foto tidak valid. Gunakan unggahan gambar, https://, atau assets/.' using errcode = 'P0001';
  end if;
  if length(coalesce(p_photo_url, '')) > 1500000 then
    raise exception 'Ukuran foto terlalu besar.' using errcode = 'P0001';
  end if;

  if p_id is not null then
    update public.candidates set
      order_number = p_order_number,
      name = trim(p_name),
      batch = nullif(trim(p_batch), ''),
      nim = nullif(trim(p_nim), ''),
      photo_url = nullif(trim(p_photo_url), ''),
      vision = coalesce(trim(p_vision), ''),
      mission = coalesce(p_mission, '{}'),
      programs = coalesce(p_programs, '{}'),
      organization_history = coalesce(trim(p_organization_history), ''),
      is_active = coalesce(p_is_active, true)
    where id = p_id
    returning id into saved_id;
    if saved_id is null then
      raise exception 'Calon tidak ditemukan.' using errcode = 'P0001';
    end if;
  else
    insert into public.candidates (order_number, name, batch, nim, photo_url, vision, mission, programs, organization_history, is_active)
    values (p_order_number, trim(p_name), nullif(trim(p_batch), ''), nullif(trim(p_nim), ''),
            nullif(trim(p_photo_url), ''), coalesce(trim(p_vision), ''), coalesce(p_mission, '{}'),
            coalesce(p_programs, '{}'), coalesce(trim(p_organization_history), ''), coalesce(p_is_active, true))
    returning id into saved_id;
    insert into public.vote_tallies (candidate_id, votes) values (saved_id, 0) on conflict do nothing;
  end if;

  return jsonb_build_object('success', true, 'id', saved_id);
end;
$$;

create or replace function public.admin_delete_candidate(p_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (select 1 from public.vote_tallies where candidate_id = p_id and votes > 0) then
    raise exception 'Calon sudah memiliki suara dan tidak bisa dihapus. Nonaktifkan saja.' using errcode = 'P0001';
  end if;
  delete from public.vote_tallies where candidate_id = p_id;
  delete from public.candidates where id = p_id;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.admin_save_panels(
  p_hero_slides jsonb,
  p_marquee_text text,
  p_about_statement text,
  p_about_info text,
  p_timeline_items jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public, private
as $$
declare slide jsonb;
begin
  if p_hero_slides is not null then
    if jsonb_typeof(p_hero_slides) <> 'array' or jsonb_array_length(p_hero_slides) > 6 then
      raise exception 'Format slide hero tidak valid.' using errcode = 'P0001';
    end if;
    for slide in select * from jsonb_array_elements(p_hero_slides) loop
      if not private.safe_media_url(nullif(slide ->> 'image', '')) then
        raise exception 'Gambar slide hero tidak valid.' using errcode = 'P0001';
      end if;
    end loop;
  end if;
  if p_timeline_items is not null and (jsonb_typeof(p_timeline_items) <> 'array' or jsonb_array_length(p_timeline_items) > 8) then
    raise exception 'Format timeline tidak valid.' using errcode = 'P0001';
  end if;

  update public.election_settings set
    hero_slides = coalesce(p_hero_slides, hero_slides),
    marquee_text = coalesce(nullif(trim(p_marquee_text), ''), marquee_text),
    about_statement = coalesce(nullif(trim(p_about_statement), ''), about_statement),
    about_info = coalesce(nullif(trim(p_about_info), ''), about_info),
    timeline_items = coalesce(p_timeline_items, timeline_items)
  where id = true;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.admin_reset_all()
returns jsonb
language plpgsql
security definer set search_path = public, private
as $$
begin
  if private.voting_is_open() then
    raise exception 'Tutup bilik suara terlebih dahulu sebelum reset.' using errcode = 'P0001';
  end if;
  update public.vote_tallies set votes = 0 where candidate_id is not null;
  delete from public.registered_voters where email is not null;
  delete from private.voter_otps where email is not null;
  delete from private.ballot_tokens where token_hash is not null;
  return jsonb_build_object('success', true);
end;
$$;

-- -------------------------------------------------------------------------
-- 5. Hak akses: semua RPC pemilih, admin, & rate limit hanya untuk service_role
-- -------------------------------------------------------------------------
grant usage on schema private to service_role;
revoke all on all tables in schema private from public, anon, authenticated;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and p.proname in (
        'api_rate_hit', 'voter_request_otp', 'voter_verify_otp', 'voter_cast_ballot',
        'admin_check_pin', 'admin_credentials_version', 'admin_dashboard', 'admin_toggle',
        'admin_set_schedule', 'admin_save_candidate', 'admin_delete_candidate',
        'admin_save_panels', 'admin_reset_all', 'voting_is_open', 'normalize_nim',
        'check_voter_identity', 'safe_media_url', 'set_admin_pin', 'normalize_email_trigger'
      )
  loop
    execute 'revoke all on function ' || f.sig || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f.sig || ' to service_role';
  end loop;
end $$;

revoke all on public.registered_voters from anon, authenticated;
revoke all on public.eligible_voters from anon, authenticated;
revoke all on public.vote_tallies from anon, authenticated;
