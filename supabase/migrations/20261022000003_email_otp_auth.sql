-- =========================================================================
-- MIGRATION: PEMILWA KMTEDI (VERIFIKASI OTP EMAIL UGM ANTI-CURANG)
-- =========================================================================

-- 1. Tabel Pemilih Terdaftar (Dengan Kolom Email UGM)
drop table if exists public.registered_voters cascade;

create table public.registered_voters (
  nim text primary key,
  raw_name text not null,
  normalized_name text not null,
  email text not null,
  has_voted boolean not null default false,
  voted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index idx_voters_norm_name on public.registered_voters (normalized_name);
create index idx_voters_email on public.registered_voters (email);
alter table public.registered_voters enable row level security;

drop policy if exists voters_anon_read on public.registered_voters;
create policy voters_anon_read on public.registered_voters for select to anon, authenticated using (true);

-- 2. Tabel Penyimpanan OTP Sementara
drop table if exists public.voter_otps cascade;

create table public.voter_otps (
  email text primary key,
  nim text not null,
  raw_name text not null,
  normalized_name text not null,
  otp_code text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.voter_otps enable row level security;
-- Note: voter_otps diakses aman hanya melalui SECURITY DEFINER functions

-- 3. Fungsi Pembuatan / Pengiriman OTP
create or replace function public.generate_voter_otp(
  p_nim text,
  p_name text,
  p_email text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  clean_nim text;
  clean_name text;
  clean_email text;
  code text;
  exp timestamptz;
begin
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  clean_name := upper(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));
  clean_email := lower(trim(coalesce(p_email, '')));

  if length(clean_nim) < 4 then
    raise exception 'NIM tidak valid. Masukkan NIM mahasiswa yang benar.';
  end if;

  if length(clean_name) < 2 then
    raise exception 'Nama lengkap tidak boleh kosong.';
  end if;

  if clean_email not like '%@mail.ugm.ac.id' and clean_email not like '%@ugm.ac.id' then
    raise exception 'Email harus berakhiran @mail.ugm.ac.id';
  end if;

  -- Cek status bilik suara
  if not exists (select 1 from public.election_settings where id = true and voting_open = true) then
    raise exception 'Bilik suara saat ini sedang DITUTUP oleh panitia pemilwa.';
  end if;

  -- Cek apakah NIM sudah memilih
  if exists (select 1 from public.registered_voters where nim = clean_nim and has_voted = true) then
    raise exception 'NIM % sudah pernah digunakan untuk memilih!', clean_nim;
  end if;

  -- Cek apakah Nama sudah memilih
  if exists (select 1 from public.registered_voters where normalized_name = clean_name and has_voted = true) then
    raise exception 'Nama "%" sudah pernah digunakan untuk memilih!', clean_name;
  end if;

  -- Cek apakah Email sudah memilih
  if exists (select 1 from public.registered_voters where email = clean_email and has_voted = true) then
    raise exception 'Email % sudah pernah digunakan untuk memilih!', clean_email;
  end if;

  -- Generate 6 digit kode acak
  code := lpad((floor(random() * 900000) + 100000)::text, 6, '0');
  exp := timezone('utc', now()) + interval '5 minutes';

  insert into public.voter_otps (email, nim, raw_name, normalized_name, otp_code, expires_at, attempts, created_at)
  values (clean_email, clean_nim, trim(p_name), clean_name, code, exp, 0, timezone('utc', now()))
  on conflict (email) do update set
    nim = excluded.nim,
    raw_name = excluded.raw_name,
    normalized_name = excluded.normalized_name,
    otp_code = excluded.otp_code,
    expires_at = excluded.expires_at,
    attempts = 0,
    created_at = timezone('utc', now());

  return jsonb_build_object(
    'success', true,
    'email', clean_email,
    'nim', clean_nim,
    'name', clean_name,
    'otp_code', code
  );
end;
$$;

grant execute on function public.generate_voter_otp(text, text, text) to anon, authenticated;

-- 4. Fungsi Verifikasi Kode OTP
create or replace function public.verify_voter_otp(
  p_email text,
  p_otp text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  clean_email text;
  clean_otp text;
  otp_rec record;
begin
  clean_email := lower(trim(coalesce(p_email, '')));
  clean_otp := trim(coalesce(p_otp, ''));

  select * into otp_rec from public.voter_otps where email = clean_email;
  if not found then
    raise exception 'Kode OTP tidak ditemukan atau belum pernah diminta. Silakan minta kode baru.';
  end if;

  if otp_rec.expires_at < timezone('utc', now()) then
    delete from public.voter_otps where email = clean_email;
    raise exception 'Kode OTP sudah kedaluwarsa (lebih dari 5 menit). Silakan minta kode baru.';
  end if;

  if otp_rec.attempts >= 4 then
    delete from public.voter_otps where email = clean_email;
    raise exception 'Batas percobaan salah terlampaui. Silakan minta kode OTP baru.';
  end if;

  if otp_rec.otp_code <> clean_otp then
    update public.voter_otps set attempts = attempts + 1 where email = clean_email;
    raise exception 'Kode OTP salah! Periksa kembali 6 angka pada email Anda.';
  end if;

  -- Hapus OTP setelah berhasil diverifikasi
  delete from public.voter_otps where email = clean_email;

  return jsonb_build_object(
    'success', true,
    'nim', otp_rec.nim,
    'raw_name', otp_rec.raw_name,
    'normalized_name', otp_rec.normalized_name,
    'email', otp_rec.email
  );
end;
$$;

grant execute on function public.verify_voter_otp(text, text) to anon, authenticated;

-- 5. Fungsi Voting Resmi (Terkunci dengan Email, NIM, & Nama)
create or replace function public.cast_vote_by_nim_and_name(
  p_candidate_id uuid,
  p_nim text,
  p_name text,
  p_email text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  clean_nim text;
  clean_name text;
  clean_email text;
  candidate_exists boolean;
begin
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  clean_name := upper(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));
  clean_email := lower(trim(coalesce(p_email, '')));

  if length(clean_nim) < 4 then raise exception 'NIM tidak valid!'; end if;
  if length(clean_name) < 2 then raise exception 'Nama lengkap tidak boleh kosong!'; end if;
  if clean_email = '' then raise exception 'Email mahasiswa wajib diisi!'; end if;

  -- 1. Cek apakah bilik suara buka
  if not exists (select 1 from public.election_settings where id = true and voting_open = true) then
    raise exception 'Bilik suara saat ini sedang DITUTUP oleh panitia pemilwa.';
  end if;

  -- 2. Cek calon valid
  select exists(select 1 from public.candidates where id = p_candidate_id and is_active = true)
  into candidate_exists;
  if not candidate_exists then
    raise exception 'Calon yang dipilih tidak valid.';
  end if;

  -- 3. Cek duplikasi
  if exists (select 1 from public.registered_voters where nim = clean_nim and has_voted = true) then
    raise exception 'NIM % sudah pernah menggunakan hak suara. Pemilihan hanya dapat dilakukan 1 kali!', clean_nim;
  end if;

  if exists (select 1 from public.registered_voters where normalized_name = clean_name and has_voted = true) then
    raise exception 'Nama "%" sudah pernah menggunakan hak suara. Pemilihan hanya dapat dilakukan 1 kali!', clean_name;
  end if;

  if exists (select 1 from public.registered_voters where email = clean_email and has_voted = true) then
    raise exception 'Email % sudah pernah digunakan untuk memilih. Pemilihan hanya dapat dilakukan 1 kali!', clean_email;
  end if;

  -- Catat pemilih
  insert into public.registered_voters (nim, raw_name, normalized_name, email, has_voted, voted_at)
  values (clean_nim, trim(p_name), clean_name, clean_email, true, timezone('utc', now()))
  on conflict (nim) do update set
    has_voted = true,
    voted_at = timezone('utc', now()),
    raw_name = excluded.raw_name,
    normalized_name = excluded.normalized_name,
    email = excluded.email;

  -- Catat suara anonim
  insert into public.votes (candidate_id) values (p_candidate_id);

  return jsonb_build_object('success', true, 'nim', clean_nim, 'name', clean_name);
end;
$$;

grant execute on function public.cast_vote_by_nim_and_name(uuid, text, text, text) to anon, authenticated;

-- Compatibility overload tanpa p_email jika ada client lama
create or replace function public.cast_vote_by_nim_and_name(
  p_candidate_id uuid,
  p_nim text,
  p_name text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  return public.cast_vote_by_nim_and_name(p_candidate_id, p_nim, p_name, 'unspecified@mail.ugm.ac.id');
end;
$$;

grant execute on function public.cast_vote_by_nim_and_name(uuid, text, text) to anon, authenticated;

-- 6. Presensi Pemilih untuk Admin (Menampilkan Email UGM)
create or replace function public.admin_get_voters_by_pin(p_pin text)
returns table (
  nim text,
  normalized_name text,
  email text,
  voted_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  return query
  select r.nim, r.normalized_name, r.email, r.voted_at
  from public.registered_voters r
  where r.has_voted = true
  order by r.voted_at desc;
end;
$$;

grant execute on function public.admin_get_voters_by_pin(text) to anon, authenticated;
