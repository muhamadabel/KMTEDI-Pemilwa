-- KMTEDI Pemilwa backend
-- Apply this migration in Supabase SQL Editor or with Supabase CLI.
-- No service-role key belongs in the frontend or this repository.

create extension if not exists pgcrypto;

do $$ begin
  create type public.user_role as enum ('voter', 'admin');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role public.user_role not null default 'voter',
  has_voted boolean not null default false,
  voted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_email_domain check (email ~* '^[^@[:space:]]+@mail[.]ugm[.]ac[.]id$')
);

create table if not exists public.candidates (
  id uuid primary key default gen_random_uuid(),
  order_number integer not null unique check (order_number > 0),
  name text not null,
  nim text,
  batch text,
  photo_url text,
  vision text not null default '',
  mission text[] not null default '{}',
  programs text[] not null default '{}',
  organization_history text,
  social_links jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.election_settings (
  id boolean primary key default true check (id = true),
  title text not null default 'Pemilihan Ketua KMTEDI',
  subtitle text not null default 'Pemilwa KMTEDI 2026',
  voting_open boolean not null default false,
  voting_start timestamptz,
  voting_end timestamptz,
  results_published boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid references auth.users(id)
);

insert into public.election_settings (id) values (true)
on conflict (id) do nothing;

-- The ballot deliberately has no voter_id, NIM, or email.
create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  cast_at timestamptz not null default timezone('utc', now())
);

create index if not exists candidates_active_order_idx on public.candidates (is_active, order_number);
create index if not exists votes_candidate_idx on public.votes (candidate_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists candidates_touch_updated_at on public.candidates;
create trigger candidates_touch_updated_at before update on public.candidates
for each row execute function public.touch_updated_at();

drop trigger if exists settings_touch_updated_at on public.election_settings;
create trigger settings_touch_updated_at before update on public.election_settings
for each row execute function public.touch_updated_at();

-- Only Google accounts on the UGM mail domain can create a profile.
create or replace function public.handle_new_ugm_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  normalized_email text := lower(coalesce(new.email, ''));
begin
  if normalized_email !~ '^[^@[:space:]]+@mail[.]ugm[.]ac[.]id$' then
    raise exception 'Only @mail.ugm.ac.id accounts may access Pemilwa KMTEDI';
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    normalized_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_ugm_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'::public.user_role
  );
$$;

grant execute on function public.is_admin() to authenticated;

-- Atomic one-account-one-vote operation. The profile update is the lock.
create or replace function public.cast_vote(p_candidate_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  changed_rows integer;
  candidate_exists boolean;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in';
  end if;

  if not exists (
    select 1 from public.election_settings
    where id = true
      and voting_open = true
      and (voting_start is null or timezone('utc', now()) >= voting_start)
      and (voting_end is null or timezone('utc', now()) <= voting_end)
  ) then
    raise exception 'Voting is currently closed';
  end if;

  select exists(select 1 from public.candidates where id = p_candidate_id and is_active = true)
  into candidate_exists;
  if not candidate_exists then
    raise exception 'Candidate is not available';
  end if;

  update public.profiles
  set has_voted = true, voted_at = timezone('utc', now())
  where id = auth.uid() and has_voted = false;
  get diagnostics changed_rows = row_count;

  if changed_rows <> 1 then
    raise exception 'This account has already voted';
  end if;

  insert into public.votes (candidate_id) values (p_candidate_id);
  return jsonb_build_object('success', true, 'message', 'Vote recorded');
end;
$$;

grant execute on function public.cast_vote(uuid) to authenticated;

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
    raise exception 'Results have not been published';
  end if;

  return query
  select c.id, c.order_number, c.name, count(v.id)::bigint
  from public.candidates c
  left join public.votes v on v.candidate_id = c.id
  where c.is_active = true
  group by c.id, c.order_number, c.name
  order by c.order_number;
end;
$$;

grant execute on function public.get_public_results() to anon, authenticated;

create or replace function public.get_admin_results()
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
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  return query
  select c.id, c.order_number, c.name, count(v.id)::bigint
  from public.candidates c
  left join public.votes v on v.candidate_id = c.id
  group by c.id, c.order_number, c.name
  order by c.order_number;
end;
$$;

grant execute on function public.get_admin_results() to authenticated;

create or replace function public.get_admin_stats()
returns table (
  registered_voters bigint,
  voters_who_voted bigint
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  return query
  select count(*)::bigint, count(*) filter (where has_voted)::bigint
  from public.profiles;
end;
$$;

grant execute on function public.get_admin_stats() to authenticated;

alter table public.profiles enable row level security;
alter table public.candidates enable row level security;
alter table public.election_settings enable row level security;
alter table public.votes enable row level security;

drop policy if exists profiles_self_or_admin_read on public.profiles;
create policy profiles_self_or_admin_read on public.profiles
for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists candidates_public_read on public.candidates;
create policy candidates_public_read on public.candidates
for select to anon, authenticated using (is_active = true or public.is_admin());

drop policy if exists candidates_admin_insert on public.candidates;
create policy candidates_admin_insert on public.candidates
for insert to authenticated with check (public.is_admin());

drop policy if exists candidates_admin_update on public.candidates;
create policy candidates_admin_update on public.candidates
for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists candidates_admin_delete on public.candidates;
create policy candidates_admin_delete on public.candidates
for delete to authenticated using (public.is_admin());

drop policy if exists settings_public_read on public.election_settings;
create policy settings_public_read on public.election_settings
for select to anon, authenticated using (true);

drop policy if exists settings_admin_update on public.election_settings;
create policy settings_admin_update on public.election_settings
for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists votes_admin_read on public.votes;
create policy votes_admin_read on public.votes
for select to authenticated using (public.is_admin());

-- Candidate media is public, but only admins can write it.
insert into storage.buckets (id, name, public)
values ('candidate-media', 'candidate-media', true)
on conflict (id) do update set public = true;

drop policy if exists candidate_media_public_read on storage.objects;
create policy candidate_media_public_read on storage.objects
for select to anon, authenticated using (bucket_id = 'candidate-media');
drop policy if exists candidate_media_admin_insert on storage.objects;
create policy candidate_media_admin_insert on storage.objects
for insert to authenticated with check (bucket_id = 'candidate-media' and public.is_admin());
drop policy if exists candidate_media_admin_update on storage.objects;
create policy candidate_media_admin_update on storage.objects
for update to authenticated using (bucket_id = 'candidate-media' and public.is_admin()) with check (bucket_id = 'candidate-media' and public.is_admin());
drop policy if exists candidate_media_admin_delete on storage.objects;
create policy candidate_media_admin_delete on storage.objects
for delete to authenticated using (bucket_id = 'candidate-media' and public.is_admin());

-- After the first permitted Google login, bootstrap the panitia account manually:
-- update public.profiles set role = 'admin' where email = 'panitia@mail.ugm.ac.id';
