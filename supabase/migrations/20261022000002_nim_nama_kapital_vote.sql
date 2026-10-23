-- =========================================================================
-- MIGRATION: SISTEM PEMILWA KMTEDI (VERIFIKASI NIM & NAMA LENGKAP KAPITAL)
-- =========================================================================

-- 1. Tabel Pemilih Terdaftar (Deduplikasi NIM & Nama Kapital)
create table if not exists public.registered_voters (
  nim text primary key,
  raw_name text not null,
  normalized_name text not null,
  has_voted boolean not null default false,
  voted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

-- Index untuk pengecekan cepat nama kapital
create index if not exists idx_voters_norm_name on public.registered_voters (normalized_name);
alter table public.registered_voters enable row level security;

-- Policy RLS registered_voters
drop policy if exists voters_anon_read on public.registered_voters;
create policy voters_anon_read on public.registered_voters for select to anon, authenticated using (true);

-- 2. Pastikan kolom admin_pin dan panel beranda ada di election_settings
alter table public.election_settings
add column if not exists admin_pin text not null default 'KMTEDI2026',
add column if not exists hero_slides jsonb default '[{"image":"assets/ig-panel-1.jpg","caption":"Ruang untuk<br>gagasan baru."},{"image":"assets/ig-panel-2.jpg","caption":"Kampus yang<br>ikut bergerak."},{"image":"assets/ig-panel-6.jpg","caption":"Pilih dengan<br>kesadaran."}]'::jsonb,
add column if not exists marquee_text text default 'KMTEDI / PEMILWA 2026 ✦ SATU SUARA SATU KETUA ✦ PILIH DENGAN SADAR ✦ BACA GAGASANNYA ✦',
add column if not exists about_statement text default 'Satu pemilihan umum untuk menentukan Ketua KMTEDI pada periode kepengurusan berikutnya.',
add column if not exists about_info text default 'Seluruh mahasiswa aktif KMTEDI berhak memberikan satu suara sah. Verifikasi pemilih menggunakan NIM mahasiswa dan Nama Lengkap. Hasil suara disimpan tertutup dan rahasia sampai dibuka oleh panitia.',
add column if not exists timeline_items jsonb default '[{"no":"01","title":"Pendaftaran","desc":"Calon ketua menyiapkan berkas pencalonan dan verifikasi panitia.","date":"SELESAI"},{"no":"02","title":"Masa Kampanye","desc":"Penyampaian visi misi, debat kandidat, dan publikasi program kerja.","date":"SEDANG BERJALAN"},{"no":"03","title":"Pemungutan Suara","desc":"Bilik suara dibuka. Mahasiswa memasukkan NIM dan Nama untuk memilih calon.","date":"SEGERA"},{"no":"04","title":"Pengumuman","desc":"Rekapitulasi resmi selesai dan hasil dibuka untuk seluruh mahasiswa.","date":"AKHIR"}]'::jsonb;

-- Pastikan voting_open aktif
update public.election_settings set voting_open = true where id = true;

-- 3. Fungsi Verifikasi Awal Pemilih (Cek apakah NIM atau Nama sudah pernah vote)
create or replace function public.verify_voter(p_nim text, p_name text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  clean_nim text;
  clean_name text;
begin
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  clean_name := upper(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));

  if length(clean_nim) < 4 then
    return jsonb_build_object('eligible', false, 'message', 'NIM tidak valid. Masukkan NIM mahasiswa yang benar.');
  end if;

  if length(clean_name) < 2 then
    return jsonb_build_object('eligible', false, 'message', 'Nama lengkap tidak boleh kosong.');
  end if;

  -- Cek duplikasi NIM yang sudah memilih
  if exists (
    select 1 from public.registered_voters
    where nim = clean_nim and has_voted = true
  ) then
    return jsonb_build_object('eligible', false, 'message', 'NIM ' || clean_nim || ' sudah pernah digunakan untuk memilih!');
  end if;

  -- Cek duplikasi Nama Kapital yang sudah memilih
  if exists (
    select 1 from public.registered_voters
    where normalized_name = clean_name and has_voted = true
  ) then
    return jsonb_build_object('eligible', false, 'message', 'Nama "' || clean_name || '" sudah pernah digunakan untuk memilih!');
  end if;

  return jsonb_build_object(
    'eligible', true,
    'nim', clean_nim,
    'name', clean_name,
    'message', 'Verifikasi berhasil. Silakan tentukan pilihan Anda.'
  );
end;
$$;

grant execute on function public.verify_voter(text, text) to anon, authenticated;

-- 4. Fungsi Voting Resmi (Atomic: Kunci NIM & Nama Kapital + Kotak Suara Anonim)
create or replace function public.cast_vote_by_nim_and_name(
  p_candidate_id uuid,
  p_nim text,
  p_name text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  clean_nim text;
  clean_name text;
  candidate_exists boolean;
begin
  -- 1. Normalisasi NIM & Nama Kapital
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  clean_name := upper(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));

  if length(clean_nim) < 4 then
    raise exception 'NIM tidak valid!';
  end if;
  if length(clean_name) < 2 then
    raise exception 'Nama lengkap tidak boleh kosong!';
  end if;

  -- 2. Cek apakah bilik suara dibuka oleh admin
  if not exists (
    select 1 from public.election_settings
    where id = true and voting_open = true
  ) then
    raise exception 'Bilik suara saat ini sedang DITUTUP oleh panitia pemilwa.';
  end if;

  -- 3. Cek calon valid
  select exists(select 1 from public.candidates where id = p_candidate_id and is_active = true)
  into candidate_exists;
  if not candidate_exists then
    raise exception 'Calon yang dipilih tidak valid atau sudah nonaktif.';
  end if;

  -- 4. Cek duplikasi NIM
  if exists (
    select 1 from public.registered_voters
    where nim = clean_nim and has_voted = true
  ) then
    raise exception 'NIM % sudah pernah digunakan untuk memilih!', clean_nim;
  end if;

  -- 5. Cek duplikasi Nama Kapital
  if exists (
    select 1 from public.registered_voters
    where normalized_name = clean_name and has_voted = true
  ) then
    raise exception 'Nama "%" sudah pernah digunakan untuk memilih!', clean_name;
  end if;

  -- 6. Catat pemilih dan kunci hak suaranya
  insert into public.registered_voters (nim, raw_name, normalized_name, has_voted, voted_at)
  values (clean_nim, trim(p_name), clean_name, true, timezone('utc', now()))
  on conflict (nim) do update set
    has_voted = true,
    voted_at = timezone('utc', now()),
    raw_name = excluded.raw_name,
    normalized_name = excluded.normalized_name;

  -- 7. Masukkan surat suara anonim (tanpa identitas pemilih)
  insert into public.votes (candidate_id) values (p_candidate_id);

  return jsonb_build_object(
    'success', true,
    'message', 'Suaramu berhasil dicatat secara sah dan rahasia!',
    'nim', clean_nim,
    'name', clean_name
  );
end;
$$;

grant execute on function public.cast_vote_by_nim_and_name(uuid, text, text) to anon, authenticated;

-- 5. Fungsi Admin Reset Kotak Suara & Pemilih
create or replace function public.admin_reset_votes(p_pin text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  delete from public.votes;
  delete from public.registered_voters;

  return jsonb_build_object('success', true, 'message', 'Semua kotak suara dan data pemilih berhasil di-reset total!');
end;
$$;

grant execute on function public.admin_reset_votes(text) to anon, authenticated;


-- 6. Fungsi Ambil Daftar Hadir Pemilih (Presensi Suara Masuk - Rahasia Tanpa Pilihan Calon)
create or replace function public.admin_get_voters_by_pin(p_pin text)
returns table (
  nim text,
  normalized_name text,
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
  select r.nim, r.normalized_name, r.voted_at
  from public.registered_voters r
  where r.has_voted = true
  order by r.voted_at desc;
end;
$$;

grant execute on function public.admin_get_voters_by_pin(text) to anon, authenticated;
