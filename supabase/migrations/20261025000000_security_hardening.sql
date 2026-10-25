-- =========================================================================
-- MIGRATION: SECURITY HARDENING (PHASE 1)
-- =========================================================================
-- Ringkasan perubahan:
-- 1. PIN admin tidak lagi disimpan plaintext di election_settings (sebelumnya
--    terbaca publik lewat REST). PIN kini di-hash bcrypt di schema private.
-- 2. Semua RPC pemilih dan admin hanya bisa dipanggil service_role, yaitu
--    lewat Vercel API (/api/*). Browser tidak bisa lagi memanggilnya langsung.
-- 3. Alur suara: OTP (di-hash) -> token surat suara sekali pakai -> cast.
-- 4. Suara disimpan sebagai penghitung per calon (vote_tallies), tanpa baris
--    per pemilih dan tanpa timestamp, sehingga tidak bisa dicocokkan dengan
--    daftar hadir pemilih.
-- 5. Daftar pemilih tidak lagi bisa dibaca publik.
-- 6. Opsional: DPT (eligible_voters). Jika tabel berisi data, hanya pasangan
--    NIM + email yang terdaftar yang boleh memilih.
--
-- SETELAH MENJALANKAN MIGRASI INI, atur PIN admin baru (min. 12 karakter):
--   select private.set_admin_pin('PIN-BARU-YANG-PANJANG');
-- =========================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- -------------------------------------------------------------------------
-- 0. Bersihkan fungsi lama yang bisa dipanggil anon
-- -------------------------------------------------------------------------
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
drop function if exists public.cast_vote_by_nim(uuid, text, text, text);
drop function if exists public.cast_vote_by_nim_and_name(uuid, text, text);
drop function if exists public.cast_vote_by_nim_and_name(uuid, text, text, text);
drop function if exists public.cast_vote_by_nim_and_email(uuid, text, text);
drop function if exists public.verify_voter(text, text);
drop function if exists public.generate_voter_otp(text, text);
drop function if exists public.generate_voter_otp(text, text, text);
drop function if exists public.verify_voter_otp(text, text);
-- Sisa alur Google SSO lama yang tidak dipakai lagi
drop function if exists public.cast_vote(uuid);
drop function if exists public.get_admin_results();
drop function if exists public.get_admin_stats();

-- Hapus sisa overload admin_set_schedule dengan signature apa pun
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_set_schedule'
  loop
    execute 'drop function if exists ' || f.sig;
  end loop;
end $$;

-- -------------------------------------------------------------------------
-- 1. Kredensial admin (bcrypt) di schema private
-- -------------------------------------------------------------------------
create table if not exists private.admin_credentials (
  id boolean primary key default true check (id = true),
  pin_hash text not null,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.election_settings drop column if exists admin_pin;

create or replace function private.set_admin_pin(p_pin text)
returns text
language plpgsql
security definer set search_path = private, public, extensions
as $$
begin
  if length(coalesce(p_pin, '')) < 12 then
    raise exception 'PIN admin minimal 12 karakter.';
  end if;
  insert into private.admin_credentials (id, pin_hash, updated_at)
  values (true, crypt(p_pin, gen_salt('bf', 10)), timezone('utc', now()))
  on conflict (id) do update set pin_hash = excluded.pin_hash, updated_at = excluded.updated_at;
  return 'PIN admin berhasil diperbarui.';
end;
$$;
revoke all on function private.set_admin_pin(text) from public, anon, authenticated;

-- -------------------------------------------------------------------------
-- 2. Rate limiter (fixed window), dipakai oleh Vercel API
-- -------------------------------------------------------------------------
create table if not exists private.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);

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

  -- Bersihkan baris kedaluwarsa sesekali
  if random() < 0.02 then
    delete from private.rate_limits where window_start < now_ts - interval '1 day';
  end if;

  return current_hits <= p_limit;
end;
$$;

-- -------------------------------------------------------------------------
-- 3. Tabel pemilih, OTP, token surat suara, DPT
-- -------------------------------------------------------------------------
drop policy if exists voters_anon_read on public.registered_voters;
-- Tidak ada policy = tidak bisa dibaca anon/authenticated. Hanya service_role.

alter table public.registered_voters drop column if exists name;
create unique index if not exists registered_voters_email_key on public.registered_voters (email);

drop table if exists public.voter_otps cascade;
create table if not exists private.voter_otps (
  email text primary key,
  nim text not null,
  otp_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists private.ballot_tokens (
  token_hash text primary key,
  nim text not null,
  email text not null,
  expires_at timestamptz not null
);

create table if not exists public.eligible_voters (
  nim text primary key,
  email text not null unique
);
alter table public.eligible_voters enable row level security;

-- -------------------------------------------------------------------------
-- 4. Kotak suara: penghitung per calon (tanpa identitas, tanpa waktu)
-- -------------------------------------------------------------------------
create table if not exists public.vote_tallies (
  candidate_id uuid primary key references public.candidates(id) on delete restrict,
  votes bigint not null default 0 check (votes >= 0)
);
alter table public.vote_tallies enable row level security;

do $$
begin
  if to_regclass('public.votes') is not null then
    insert into public.vote_tallies (candidate_id, votes)
    select candidate_id, count(*) from public.votes group by candidate_id
    on conflict (candidate_id) do update set votes = excluded.votes;
    drop table public.votes;
  end if;
end $$;

insert into public.vote_tallies (candidate_id, votes)
select id, 0 from public.candidates
on conflict (candidate_id) do nothing;

-- -------------------------------------------------------------------------
-- 5. Helper internal
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
  if p_nim !~ '^[0-9A-Z/.-]{4,32}$' then
    raise exception 'NIM tidak valid.' using errcode = 'P0001';
  end if;
  if p_email !~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@mail[.]ugm[.]ac[.]id$' then
    raise exception 'Email harus akun resmi @mail.ugm.ac.id.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.eligible_voters)
     and not exists (select 1 from public.eligible_voters where nim = p_nim and lower(email) = p_email) then
    raise exception 'NIM dan email tidak terdaftar di Daftar Pemilih Tetap.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.registered_voters where nim = p_nim or email = p_email) then
    raise exception 'NIM atau email ini sudah menggunakan hak suara.' using errcode = 'P0001';
  end if;
end;
$$;

-- -------------------------------------------------------------------------
-- 6. RPC pemilih (service_role saja)
-- -------------------------------------------------------------------------
create or replace function public.voter_request_otp(p_nim text, p_email text)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  clean_nim text := private.normalize_nim(p_nim);
  clean_email text := lower(trim(coalesce(p_email, '')));
  code text;
  last_sent timestamptz;
begin
  if not private.voting_is_open() then
    raise exception 'Bilik suara sedang ditutup.' using errcode = 'P0001';
  end if;

  perform private.check_voter_identity(clean_nim, clean_email);

  select created_at into last_sent from private.voter_otps where email = clean_email;
  if last_sent is not null and last_sent > timezone('utc', now()) - interval '60 seconds' then
    raise exception 'Tunggu 60 detik sebelum meminta kode baru.' using errcode = 'P0001';
  end if;

  code := lpad((abs(('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');

  insert into private.voter_otps (email, nim, otp_hash, expires_at, attempts, created_at)
  values (clean_email, clean_nim, encode(digest(code, 'sha256'), 'hex'),
          timezone('utc', now()) + interval '10 minutes', 0, timezone('utc', now()))
  on conflict (email) do update set
    nim = excluded.nim,
    otp_hash = excluded.otp_hash,
    expires_at = excluded.expires_at,
    attempts = 0,
    created_at = excluded.created_at;

  return jsonb_build_object('nim', clean_nim, 'email', clean_email, 'otp_code', code);
end;
$$;

create or replace function public.voter_verify_otp(p_email text, p_otp text)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  clean_email text := lower(trim(coalesce(p_email, '')));
  rec private.voter_otps%rowtype;
  raw_token text;
begin
  -- Kegagalan dikembalikan sebagai {ok:false}, BUKAN raise exception, karena
  -- raise akan me-rollback penambahan attempts dan membuka brute force.
  select * into rec from private.voter_otps where email = clean_email for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Kode OTP tidak ditemukan. Silakan minta kode baru.');
  end if;

  if rec.expires_at < timezone('utc', now()) or rec.attempts >= 5 then
    delete from private.voter_otps where email = clean_email;
    return jsonb_build_object('ok', false, 'error', 'Kode OTP kedaluwarsa atau terlalu banyak percobaan. Minta kode baru.');
  end if;

  if rec.otp_hash <> encode(digest(trim(coalesce(p_otp, '')), 'sha256'), 'hex') then
    update private.voter_otps set attempts = attempts + 1 where email = clean_email;
    return jsonb_build_object('ok', false, 'error',
      format('Kode OTP salah. Sisa percobaan: %s.', 4 - rec.attempts));
  end if;

  delete from private.voter_otps where email = clean_email;
  delete from private.ballot_tokens where email = clean_email or expires_at < timezone('utc', now());

  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into private.ballot_tokens (token_hash, nim, email, expires_at)
  values (encode(digest(raw_token, 'sha256'), 'hex'), rec.nim, rec.email,
          timezone('utc', now()) + interval '30 minutes');

  return jsonb_build_object('ok', true, 'nim', rec.nim, 'email', rec.email, 'ballot_token', raw_token);
end;
$$;

create or replace function public.voter_cast_ballot(p_token text, p_candidate_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, private, extensions
as $$
declare
  tok private.ballot_tokens%rowtype;
  inserted int;
begin
  delete from private.ballot_tokens
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  returning * into tok;

  if not found or tok.expires_at < timezone('utc', now()) then
    raise exception 'Sesi pemilih tidak valid atau kedaluwarsa. Verifikasi ulang lewat OTP.' using errcode = 'P0001';
  end if;

  if not private.voting_is_open() then
    raise exception 'Bilik suara sedang ditutup.' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.candidates where id = p_candidate_id and is_active = true) then
    raise exception 'Calon yang dipilih tidak valid.' using errcode = 'P0001';
  end if;

  insert into public.registered_voters (nim, email, has_voted, voted_at)
  values (tok.nim, tok.email, true, timezone('utc', now()))
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted <> 1 then
    raise exception 'NIM atau email ini sudah menggunakan hak suara.' using errcode = 'P0001';
  end if;

  -- Pastikan semua calon aktif punya baris, lalu sentuh SEMUA baris dalam satu
  -- statement agar xmin tiap baris sama dan tidak membocorkan calon pilihan.
  insert into public.vote_tallies (candidate_id, votes)
  select id, 0 from public.candidates where is_active = true
  on conflict (candidate_id) do nothing;

  update public.vote_tallies
  set votes = votes + case when candidate_id = p_candidate_id then 1 else 0 end;

  return jsonb_build_object('success', true);
end;
$$;

-- -------------------------------------------------------------------------
-- 7. RPC admin (service_role saja, PIN dicek di sini + rate limit di API)
-- -------------------------------------------------------------------------
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
    raise exception 'PIN admin belum diatur. Jalankan private.set_admin_pin di SQL Editor.' using errcode = 'P0001';
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
  select extract(epoch from updated_at)::bigint::text from private.admin_credentials where id = true;
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
    'voted_count', (select count(*) from public.registered_voters),
    'eligible_count', (select count(*) from public.eligible_voters),
    -- Hasil per calon disembunyikan selama bilik suara terbuka agar panitia
    -- tidak bisa mencocokkan kenaikan suara dengan daftar hadir.
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
  update public.vote_tallies set votes = 0;
  delete from public.registered_voters;
  delete from private.voter_otps;
  delete from private.ballot_tokens;
  return jsonb_build_object('success', true);
end;
$$;

-- -------------------------------------------------------------------------
-- 8. Hasil publik (hanya setelah dipublikasikan)
-- -------------------------------------------------------------------------
drop function if exists public.get_public_results();
create function public.get_public_results()
returns table (candidate_id uuid, order_number integer, candidate_name text, vote_count bigint)
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.election_settings where id = true and results_published = true) then
    raise exception 'Hasil belum dipublikasikan.';
  end if;
  return query
  select c.id, c.order_number, c.name, coalesce(t.votes, 0)::bigint
  from public.candidates c left join public.vote_tallies t on t.candidate_id = c.id
  where c.is_active = true
  order by c.order_number;
end;
$$;

-- -------------------------------------------------------------------------
-- 9. Hak akses: semua fungsi hanya service_role, kecuali get_public_results
-- -------------------------------------------------------------------------
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
        'check_voter_identity', 'safe_media_url', 'set_admin_pin'
      )
  loop
    execute 'revoke all on function ' || f.sig || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f.sig || ' to service_role';
  end loop;
end $$;

grant usage on schema private to service_role;
revoke all on all tables in schema private from public, anon, authenticated;
grant execute on function public.get_public_results() to anon, authenticated;

-- Supabase memberi default EXECUTE ke anon untuk fungsi baru di public.
-- Matikan agar fungsi yang ditambahkan nanti tidak otomatis terbuka.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- election_settings tetap bisa dibaca publik (teks beranda, jadwal), tapi
-- tidak bisa diubah. Pastikan tidak ada policy tulis untuk anon.
revoke insert, update, delete on public.election_settings from anon, authenticated;
revoke insert, update, delete on public.candidates from anon, authenticated;
revoke all on public.registered_voters from anon, authenticated;
revoke all on public.eligible_voters from anon, authenticated;
revoke all on public.vote_tallies from anon, authenticated;
