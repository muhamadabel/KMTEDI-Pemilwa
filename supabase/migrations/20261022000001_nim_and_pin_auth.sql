-- Migration: NIM Verification + Strict @mail.ugm.ac.id domain + Admin PIN + Candidate CRUD + Homepage Panels Config
-- Run this in Supabase SQL Editor.

-- 1. Table for tracking voters by NIM & UGM Email
create table if not exists public.registered_voters (
  nim text primary key,
  name text,
  email text not null,
  has_voted boolean not null default false,
  voted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_registered_voters_email on public.registered_voters (lower(email));
alter table public.registered_voters enable row level security;

-- 2. Add columns to election_settings
alter table public.election_settings
add column if not exists admin_pin text not null default 'KMTEDI2026',
add column if not exists hero_slides jsonb default '[{"image":"assets/ig-panel-1.jpg","caption":"Ruang untuk<br>gagasan baru."},{"image":"assets/ig-panel-2.jpg","caption":"Kampus yang<br>ikut bergerak."},{"image":"assets/ig-panel-6.jpg","caption":"Pilih dengan<br>kesadaran."}]'::jsonb,
add column if not exists marquee_text text default 'KMTEDI / PEMILWA 2026 ✦ SATU SUARA SATU KETUA ✦ PILIH DENGAN SADAR ✦ BACA GAGASANNYA ✦',
add column if not exists about_statement text default 'Satu pemilihan umum untuk menentukan Ketua KMTEDI pada periode kepengurusan berikutnya.',
add column if not exists about_info text default 'Seluruh mahasiswa aktif KMTEDI berhak memberikan satu suara sah. Verifikasi pemilih menggunakan NIM mahasiswa dan email @mail.ugm.ac.id. Hasil suara disimpan tertutup dan rahasia sampai dibuka oleh panitia.',
add column if not exists timeline_items jsonb default '[{"no":"01","title":"Pendaftaran","desc":"Calon ketua menyiapkan berkas pencalonan dan verifikasi panitia.","date":"SELESAI"},{"no":"02","title":"Masa Kampanye","desc":"Penyampaian visi misi, debat kandidat, dan publikasi program kerja.","date":"SEDANG BERJALAN"},{"no":"03","title":"Pemungutan Suara","desc":"Bilik suara dibuka. Mahasiswa memasukkan NIM dan memilih calon.","date":"SEGERA"},{"no":"04","title":"Pengumuman","desc":"Rekapitulasi resmi selesai dan hasil dibuka untuk seluruh mahasiswa.","date":"AKHIR"}]'::jsonb;

-- 3. Verifikasi PIN Admin
create or replace function public.admin_verify_pin(p_pin text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.election_settings
    where id = true and admin_pin = p_pin
  );
$$;

grant execute on function public.admin_verify_pin(text) to anon, authenticated;

-- 4. Function to cast vote using NIM + Strict @mail.ugm.ac.id
create or replace function public.cast_vote_by_nim(
  p_candidate_id uuid,
  p_nim text,
  p_name text default null,
  p_email text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  clean_nim text;
  clean_email text;
  candidate_exists boolean;
  already_voted boolean := false;
begin
  -- Normalize & Validate NIM
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  if length(clean_nim) < 4 then
    raise exception 'NIM tidak valid. Masukkan NIM yang benar.';
  end if;

  -- Normalize & Strictly Validate @mail.ugm.ac.id
  clean_email := lower(trim(coalesce(p_email, '')));
  if clean_email !~ '^[^@[:space:]]+@mail[.]ugm[.]ac[.]id$' then
    raise exception 'Verifikasi gagal: Pemilihan hanya menerima akun resmi @mail.ugm.ac.id!';
  end if;

  -- Check if election is open
  if not exists (
    select 1 from public.election_settings
    where id = true
      and voting_open = true
      and (voting_start is null or timezone('utc', now()) >= voting_start)
      and (voting_end is null or timezone('utc', now()) <= voting_end)
  ) then
    raise exception 'Bilik suara saat ini sedang DITUTUP oleh panitia.';
  end if;

  -- Check candidate exists and active
  select exists(select 1 from public.candidates where id = p_candidate_id and is_active = true)
  into candidate_exists;
  if not candidate_exists then
    raise exception 'Calon yang dipilih tidak valid atau sudah nonaktif.';
  end if;

  -- Check if this NIM already voted
  select has_voted into already_voted
  from public.registered_voters
  where nim = clean_nim;

  if already_voted = true then
    raise exception 'NIM % sudah pernah digunakan untuk memilih!', clean_nim;
  end if;

  -- Check if this email already voted
  if exists (
    select 1 from public.registered_voters
    where lower(email) = clean_email and has_voted = true
  ) then
    raise exception 'Akun email % sudah pernah digunakan untuk memilih!', clean_email;
  end if;

  -- Record/lock voter record
  insert into public.registered_voters (nim, name, email, has_voted, voted_at)
  values (clean_nim, trim(coalesce(p_name, '')), clean_email, true, timezone('utc', now()))
  on conflict (nim) do update set
    has_voted = true,
    voted_at = timezone('utc', now()),
    name = coalesce(nullif(excluded.name, ''), public.registered_voters.name),
    email = clean_email;

  -- Insert anonymous ballot (no voter identity stored with vote)
  insert into public.votes (candidate_id) values (p_candidate_id);

  return jsonb_build_object(
    'success', true,
    'message', 'Suaramu berhasil dicatat secara sah dan rahasia!',
    'nim', clean_nim,
    'email', clean_email
  );
end;
$$;

grant execute on function public.cast_vote_by_nim(uuid, text, text, text) to anon, authenticated;

-- 5. Admin stats by PIN
create or replace function public.admin_get_stats_by_pin(p_pin text)
returns table (
  total_voters bigint,
  voted_count bigint,
  voting_open boolean,
  results_published boolean,
  hero_slides jsonb,
  marquee_text text,
  about_statement text,
  about_info text,
  timeline_items jsonb
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  return query
  select
    count(*)::bigint as total_voters,
    count(*) filter (where has_voted)::bigint as voted_count,
    (select s.voting_open from public.election_settings s where s.id = true limit 1),
    (select s.results_published from public.election_settings s where s.id = true limit 1),
    (select s.hero_slides from public.election_settings s where s.id = true limit 1),
    (select s.marquee_text from public.election_settings s where s.id = true limit 1),
    (select s.about_statement from public.election_settings s where s.id = true limit 1),
    (select s.about_info from public.election_settings s where s.id = true limit 1),
    (select s.timeline_items from public.election_settings s where s.id = true limit 1)
  from public.registered_voters;
end;
$$;

grant execute on function public.admin_get_stats_by_pin(text) to anon, authenticated;

-- 6. Admin results by PIN
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
  select c.id, c.order_number, c.name, count(v.id)::bigint
  from public.candidates c
  left join public.votes v on v.candidate_id = c.id
  group by c.id, c.order_number, c.name
  order by c.order_number;
end;
$$;

grant execute on function public.admin_get_results_by_pin(text) to anon, authenticated;

-- 7. Admin toggle voting / results by PIN
create or replace function public.admin_toggle_switch(p_pin text, p_field text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  new_state boolean;
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  if p_field = 'voting_open' then
    update public.election_settings set voting_open = not voting_open where id = true
    returning voting_open into new_state;
    return jsonb_build_object('field', 'voting_open', 'new_state', new_state);
  elsif p_field = 'results_published' then
    update public.election_settings set results_published = not results_published where id = true
    returning results_published into new_state;
    return jsonb_build_object('field', 'results_published', 'new_state', new_state);
  else
    raise exception 'Field tidak dikenal';
  end if;
end;
$$;

grant execute on function public.admin_toggle_switch(text, text) to anon, authenticated;

-- 8. Admin Save Candidate (Insert or Update biodata paslon & riwayat)
create or replace function public.admin_save_candidate(
  p_pin text,
  p_id uuid,
  p_order_number integer,
  p_name text,
  p_batch text default null,
  p_nim text default null,
  p_photo_url text default null,
  p_vision text default '',
  p_mission text[] default '{}',
  p_programs text[] default '{}',
  p_organization_history text default '',
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  saved_id uuid;
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  if p_order_number is null or p_order_number < 1 then
    raise exception 'Nomor urut calon harus angka positif (1, 2, dst)!';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Nama calon tidak boleh kosong!';
  end if;

  if p_id is not null then
    update public.candidates
    set
      order_number = p_order_number,
      name = trim(p_name),
      batch = nullif(trim(p_batch), ''),
      nim = nullif(trim(p_nim), ''),
      photo_url = nullif(trim(p_photo_url), ''),
      vision = coalesce(trim(p_vision), ''),
      mission = coalesce(p_mission, '{}'),
      programs = coalesce(p_programs, '{}'),
      organization_history = coalesce(trim(p_organization_history), ''),
      is_active = coalesce(p_is_active, true),
      updated_at = timezone('utc', now())
    where id = p_id
    returning id into saved_id;

    if saved_id is null then
      raise exception 'Calon dengan ID tersebut tidak ditemukan.';
    end if;
  else
    insert into public.candidates (
      order_number, name, batch, nim, photo_url, vision, mission, programs, organization_history, is_active
    ) values (
      p_order_number, trim(p_name), nullif(trim(p_batch), ''), nullif(trim(p_nim), ''),
      nullif(trim(p_photo_url), ''), coalesce(trim(p_vision), ''), coalesce(p_mission, '{}'),
      coalesce(p_programs, '{}'), coalesce(trim(p_organization_history), ''), coalesce(p_is_active, true)
    )
    returning id into saved_id;
  end if;

  return jsonb_build_object('success', true, 'id', saved_id, 'message', 'Data calon berhasil disimpan!');
end;
$$;

grant execute on function public.admin_save_candidate(text, uuid, integer, text, text, text, text, text, text[], text[], text, boolean) to anon, authenticated;

-- 9. Admin Delete Candidate
create or replace function public.admin_delete_candidate(p_pin text, p_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  delete from public.candidates where id = p_id;
  return jsonb_build_object('success', true, 'message', 'Calon berhasil dihapus!');
end;
$$;

grant execute on function public.admin_delete_candidate(text, uuid) to anon, authenticated;

-- 10. Admin Save Homepage Panels (Hero Carousel, Marquee, About, Timeline)
create or replace function public.admin_save_panels(
  p_pin text,
  p_hero_slides jsonb default null,
  p_marquee_text text default null,
  p_about_statement text default null,
  p_about_info text default null,
  p_timeline_items jsonb default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.admin_verify_pin(p_pin) then
    raise exception 'PIN Admin salah atau tidak valid!';
  end if;

  update public.election_settings
  set
    hero_slides = coalesce(p_hero_slides, hero_slides),
    marquee_text = coalesce(nullif(trim(p_marquee_text), ''), marquee_text),
    about_statement = coalesce(nullif(trim(p_about_statement), ''), about_statement),
    about_info = coalesce(nullif(trim(p_about_info), ''), about_info),
    timeline_items = coalesce(p_timeline_items, timeline_items),
    updated_at = timezone('utc', now())
  where id = true;

  return jsonb_build_object('success', true, 'message', 'Semua panel beranda berhasil diperbarui!');
end;
$$;

grant execute on function public.admin_save_panels(text, jsonb, text, text, text, jsonb) to anon, authenticated;


-- Enhanced bulletproof cast_vote for Google SSO users
create or replace function public.cast_vote(p_candidate_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  user_id uuid := auth.uid();
  user_email text;
  changed_rows integer;
  candidate_exists boolean;
begin
  if user_id is null then
    raise exception 'Anda harus login terlebih dahulu dengan akun @mail.ugm.ac.id.';
  end if;

  select lower(coalesce(email, '')) into user_email from auth.users where id = user_id;
  if user_email !~ '^[^@[:space:]]+@mail[.]ugm[.]ac[.]id$' then
    raise exception 'Hanya akun resmi @mail.ugm.ac.id yang berhak memilih!';
  end if;

  -- Check if voting is open
  if not exists (
    select 1 from public.election_settings
    where id = true
      and voting_open = true
      and (voting_start is null or timezone('utc', now()) >= voting_start)
      and (voting_end is null or timezone('utc', now()) <= voting_end)
  ) then
    raise exception 'Bilik suara saat ini sedang DITUTUP oleh panitia pemilwa.';
  end if;

  -- Check candidate
  select exists(select 1 from public.candidates where id = p_candidate_id and is_active = true)
  into candidate_exists;
  if not candidate_exists then
    raise exception 'Calon yang dipilih tidak valid atau sudah nonaktif.';
  end if;

  -- Ensure profile exists
  insert into public.profiles (id, email, has_voted)
  values (user_id, user_email, false)
  on conflict (id) do update set email = excluded.email;

  -- Lock voter account
  update public.profiles
  set has_voted = true, voted_at = timezone('utc', now())
  where id = user_id and has_voted = false;
  get diagnostics changed_rows = row_count;

  if changed_rows <> 1 then
    raise exception 'Akun Anda sudah pernah menggunakan hak suara dalam pemilihan ini!';
  end if;

  -- Insert anonymous ballot
  insert into public.votes (candidate_id) values (p_candidate_id);

  return jsonb_build_object('success', true, 'message', 'Suara sah Anda berhasil dicatat secara rahasia!');
end;
$$;

grant execute on function public.cast_vote(uuid) to authenticated, anon;
