-- =========================================================================
-- MIGRATION: PEMILWA KMTEDI (VERIFIKASI NIM, NAMA, & BISA GANTI PILIHAN)
-- =========================================================================

-- 1. Tabel Pemilih Terdaftar & Pilihan Paslon
drop table if exists public.registered_voters cascade;

create table public.registered_voters (
  nim text primary key,
  raw_name text not null,
  normalized_name text not null,
  has_voted boolean not null default false,
  candidate_id uuid references public.candidates(id) on delete set null,
  voted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index idx_voters_norm_name on public.registered_voters (normalized_name);
create index idx_voters_candidate on public.registered_voters (candidate_id);
alter table public.registered_voters enable row level security;

drop policy if exists voters_anon_read on public.registered_voters;
create policy voters_anon_read on public.registered_voters for select to anon, authenticated using (true);

-- 2. Pastikan kolom election_settings siap
alter table public.election_settings
add column if not exists admin_pin text not null default 'KMTEDI2026',
add column if not exists hero_slides jsonb default '[{"image":"assets/ig-panel-1.jpg","caption":"Ruang untuk<br>gagasan baru."},{"image":"assets/ig-panel-2.jpg","caption":"Kampus yang<br>ikut bergerak."},{"image":"assets/ig-panel-6.jpg","caption":"Pilih dengan<br>kesadaran."}]'::jsonb,
add column if not exists marquee_text text default 'KMTEDI / PEMILWA 2026 ✦ SATU SUARA SATU KETUA ✦ PILIH DENGAN SADAR ✦ BACA GAGASANNYA ✦',
add column if not exists about_statement text default 'Satu pemilihan umum untuk menentukan Ketua KMTEDI pada periode kepengurusan berikutnya.',
add column if not exists about_info text default 'Seluruh mahasiswa aktif KMTEDI berhak memberikan satu suara sah. Verifikasi pemilih menggunakan NIM mahasiswa dan Nama Lengkap. Selama bilik suara dibuka panitia, pemilih dapat meninjau dan memperbarui pilihannya.',
add column if not exists timeline_items jsonb default '[{"no":"01","title":"Pendaftaran","desc":"Calon ketua menyiapkan berkas pencalonan dan verifikasi panitia.","date":"SELESAI"},{"no":"02","title":"Masa Kampanye","desc":"Penyampaian visi misi, debat kandidat, dan publikasi program kerja.","date":"SEDANG BERJALAN"},{"no":"03","title":"Pemungutan Suara","desc":"Bilik suara dibuka. Mahasiswa memasukkan NIM dan Nama untuk memilih calon.","date":"SEGERA"},{"no":"04","title":"Pengumuman","desc":"Rekapitulasi resmi selesai dan hasil dibuka untuk seluruh mahasiswa.","date":"AKHIR"}]'::jsonb;

-- Pastikan voting terbuka
update public.election_settings set voting_open = true where id = true;

-- 3. Fungsi Verifikasi Awal Pemilih & Cek Pilihan Aktif
create or replace function public.verify_voter(p_nim text, p_name text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  clean_nim text;
  clean_name text;
  voter_rec record;
begin
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  clean_name := upper(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));

  if length(clean_nim) < 4 then
    return jsonb_build_object('eligible', false, 'message', 'NIM tidak valid. Masukkan NIM mahasiswa yang benar.');
  end if;

  if length(clean_name) < 2 then
    return jsonb_build_object('eligible', false, 'message', 'Nama lengkap tidak boleh kosong.');
  end if;

  -- Cek jika ada orang lain yang menggunakan nama ini tapi NIM berbeda
  if exists (
    select 1 from public.registered_voters
    where normalized_name = clean_name and nim <> clean_nim and has_voted = true
  ) then
    return jsonb_build_object('eligible', false, 'message', 'Nama "' || clean_name || '" sudah terdaftar dengan NIM berbeda!');
  end if;

  -- Cek data voter yang sudah ada
  select has_voted, candidate_id into voter_rec
  from public.registered_voters
  where nim = clean_nim;

  return jsonb_build_object(
    'eligible', true,
    'nim', clean_nim,
    'name', clean_name,
    'has_voted', coalesce(voter_rec.has_voted, false),
    'current_candidate_id', voter_rec.candidate_id,
    'message', 'Verifikasi berhasil.'
  );
end;
$$;

grant execute on function public.verify_voter(text, text) to anon, authenticated;

-- 4. Fungsi Kirim / Ganti Pilihan Suara (Bisa ganti pilihan sampai gate ditutup)
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
  prev_candidate_id uuid;
  is_change boolean := false;
begin
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  clean_name := upper(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));

  if length(clean_nim) < 4 then raise exception 'NIM tidak valid!'; end if;
  if length(clean_name) < 2 then raise exception 'Nama lengkap tidak boleh kosong!'; end if;

  -- 1. Cek apakah bilik suara sedang dibuka oleh admin
  if not exists (
    select 1 from public.election_settings
    where id = true and voting_open = true
  ) then
    raise exception 'Bilik suara saat ini sedang DITUTUP oleh panitia pemilwa.';
  end if;

  -- 2. Cek calon valid
  select exists(select 1 from public.candidates where id = p_candidate_id and is_active = true)
  into candidate_exists;
  if not candidate_exists then
    raise exception 'Calon yang dipilih tidak valid atau sudah nonaktif.';
  end if;

  -- 3. Cek konflik nama dengan NIM berbeda
  if exists (
    select 1 from public.registered_voters
    where normalized_name = clean_name and nim <> clean_nim and has_voted = true
  ) then
    raise exception 'Nama "%" sudah terdaftar dengan NIM berbeda!', clean_name;
  end if;

  -- 4. Cek apakah ini pemilih baru atau ganti pilihan
  select candidate_id into prev_candidate_id
  from public.registered_voters
  where nim = clean_nim and has_voted = true;

  if prev_candidate_id is not null then
    is_change := true;
  end if;

  -- 5. Catat / perbarui pilihan pemilih
  insert into public.registered_voters (nim, raw_name, normalized_name, has_voted, candidate_id, voted_at)
  values (clean_nim, trim(p_name), clean_name, true, p_candidate_id, timezone('utc', now()))
  on conflict (nim) do update set
    has_voted = true,
    candidate_id = excluded.candidate_id,
    voted_at = timezone('utc', now()),
    raw_name = excluded.raw_name,
    normalized_name = excluded.normalized_name;

  return jsonb_build_object(
    'success', true,
    'is_change', is_change,
    'candidate_id', p_candidate_id,
    'message', case when is_change then 'Pilihan Anda berhasil diperbarui!' else 'Suara Anda berhasil dicatat!' end
  );
end;
$$;

grant execute on function public.cast_vote_by_nim_and_name(uuid, text, text) to anon, authenticated;

-- 5. Rekapitulasi Suara Admin (Mengambil suara terkini tiap paslon)
create or replace function public.admin_get_results_by_pin(p_pin text)
returns table (
  candidate_id uuid,
  order_number integer,
  candidate_name text,
  vote_count bigint
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  return query
  select c.id, c.order_number, c.name, count(r.nim)::bigint
  from public.candidates c
  left join public.registered_voters r on r.candidate_id = c.id and r.has_voted = true
  group by c.id, c.order_number, c.name
  order by c.order_number;
end;
$$;

grant execute on function public.admin_get_results_by_pin(text) to anon, authenticated;

-- 6. Rekapitulasi Publik (Hanya jika admin sudah mempublikasikan)
create or replace function public.get_public_results()
returns table (
  candidate_id uuid,
  order_number integer,
  candidate_name text,
  vote_count bigint
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.election_settings where id = true and results_published = true) then
    raise exception 'Hasil perolehan suara belum dipublikasikan oleh panitia.';
  end if;

  return query
  select c.id, c.order_number, c.name, count(r.nim)::bigint
  from public.candidates c
  left join public.registered_voters r on r.candidate_id = c.id and r.has_voted = true
  where c.is_active = true
  group by c.id, c.order_number, c.name
  order by c.order_number;
end;
$$;

grant execute on function public.get_public_results() to anon, authenticated;

-- 7. Presensi Pemilih untuk Admin (Rahasia tanpa pilihan paslon)
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

-- 8. Reset Kotak Suara & Pemilih
create or replace function public.admin_reset_votes(p_pin text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  delete from public.registered_voters;

  return jsonb_build_object('success', true, 'message', 'Semua kotak suara dan data pemilih berhasil di-reset total!');
end;
$$;

grant execute on function public.admin_reset_votes(text) to anon, authenticated;
