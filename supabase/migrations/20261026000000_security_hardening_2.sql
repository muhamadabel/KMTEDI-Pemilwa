-- =========================================================================
-- MIGRATION: SECURITY HARDENING (PHASE 1b)
-- Jalankan setelah 20261025000000_security_hardening.sql.
-- =========================================================================

-- 1. Tabel profiles (sisa alur Google SSO lama) tidak dipakai lagi.
--    RLS sudah membatasi, tapi hak tabel untuk anon/authenticated dicabut total.
revoke all on public.profiles from anon, authenticated;

-- 2. Kolom yang boleh dibaca publik dibatasi eksplisit (NIM calon dan
--    updated_by tidak ikut terbuka lewat REST).
revoke select on public.candidates from anon, authenticated;
grant select (id, order_number, name, batch, photo_url, vision, mission, programs,
              organization_history, social_links, is_active)
  on public.candidates to anon, authenticated;

revoke select on public.election_settings from anon, authenticated;
grant select (id, title, subtitle, voting_open, voting_start, voting_end, results_published,
              hero_slides, marquee_text, about_statement, about_info, timeline_items)
  on public.election_settings to anon, authenticated;

-- 3. Fungsi trigger tidak perlu bisa dipanggil siapa pun.
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_ugm_user() from public, anon, authenticated;

-- 4. Batas kirim OTP per email dihitung di database dan hanya untuk OTP yang
--    benar-benar terbit (permintaan yang gagal validasi tidak ikut dihitung,
--    jadi orang lain tidak bisa menghabiskan kuota email korban dengan NIM asal).
alter table private.voter_otps add column if not exists window_start timestamptz;
alter table private.voter_otps add column if not exists sends int not null default 0;

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
      raise exception 'Tunggu 60 detik sebelum meminta kode baru.' using errcode = 'P0001';
    end if;
    if prev.window_start is not null and prev.window_start > now_ts - interval '1 hour' and prev.sends >= 6 then
      raise exception 'Kode OTP sudah diminta terlalu sering. Coba lagi dalam 1 jam.' using errcode = 'P0001';
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

revoke all on function public.voter_request_otp(text, text) from public, anon, authenticated;
grant execute on function public.voter_request_otp(text, text) to service_role;

-- 5. Kode yang kedaluwarsa atau terbakar (5x salah) hanya dinonaktifkan, tidak
--    dihapus, agar penghitung kirim per jam dan jeda 60 detik tetap berlaku.
--    Verifikasi juga wajib menyertakan NIM yang sama dengan saat meminta kode:
--    orang yang hanya tahu email korban tidak bisa membakar kode korban.
drop function if exists public.voter_verify_otp(text, text);
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
  -- Kegagalan dikembalikan sebagai {ok:false}, BUKAN raise exception, karena
  -- raise akan me-rollback penambahan attempts dan membuka brute force.
  select * into rec from private.voter_otps where email = clean_email for update;
  if not found or rec.otp_hash = '' or rec.nim <> private.normalize_nim(p_nim) then
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

revoke all on function public.voter_verify_otp(text, text, text) from public, anon, authenticated;
grant execute on function public.voter_verify_otp(text, text, text) to service_role;
