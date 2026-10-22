-- Migration: NIM Verification + Admin PIN Access
-- Run this in Supabase SQL Editor once.

-- 1. Table for tracking voters by NIM
create table if not exists public.registered_voters (
  nim text primary key,
  name text,
  email text,
  has_voted boolean not null default false,
  voted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.registered_voters enable row level security;

-- 2. Add admin_pin to election_settings if not exists
alter table public.election_settings
add column if not exists admin_pin text not null default 'KMTEDI2026';

-- 3. Function to cast vote using NIM (Atomic, One-Man-One-Vote, Anonymous Ballot)
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
  candidate_exists boolean;
  already_voted boolean := false;
begin
  -- Normalize NIM
  clean_nim := upper(trim(regexp_replace(coalesce(p_nim, ''), '\s+', '', 'g')));
  if length(clean_nim) < 4 then
    raise exception 'NIM tidak valid. Masukkan NIM yang benar.';
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
    raise exception 'NIM % sudah pernah menggunakan hak suara!', clean_nim;
  end if;

  -- Record/lock voter record
  insert into public.registered_voters (nim, name, email, has_voted, voted_at)
  values (clean_nim, trim(coalesce(p_name, '')), trim(coalesce(p_email, '')), true, timezone('utc', now()))
  on conflict (nim) do update set
    has_voted = true,
    voted_at = timezone('utc', now()),
    name = coalesce(nullif(excluded.name, ''), public.registered_voters.name),
    email = coalesce(nullif(excluded.email, ''), public.registered_voters.email);

  -- Insert anonymous ballot (no voter identity stored with vote)
  insert into public.votes (candidate_id) values (p_candidate_id);

  return jsonb_build_object(
    'success', true,
    'message', 'Suaramu berhasil dicatat secara sah dan rahasia!',
    'nim', clean_nim
  );
end;
$$;

grant execute on function public.cast_vote_by_nim(uuid, text, text, text) to anon, authenticated;

-- 4. Admin PIN verification RPC
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

-- 5. Admin stats by PIN
create or replace function public.admin_get_stats_by_pin(p_pin text)
returns table (
  total_voters bigint,
  voted_count bigint,
  voting_open boolean,
  results_published boolean
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
    (select s.results_published from public.election_settings s where s.id = true limit 1)
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
