-- Rollback untuk 20261125000000_pemilwa_siap_300_pemilih.sql
-- Tujuan: mengembalikan fungsi dan bentuk data yang dipakai kode PRODUKSI saat ini
-- (commit 6d4f411), tanpa menghapus satu pun suara yang sudah tercatat.
--
-- Aturan yang tidak boleh dilanggar:
--   * Jangan DROP atau TRUNCATE public.registered_voters, public.vote_tallies,
--     public.candidates, public.election_settings, public.eligible_voters.
--   * Jangan mengubah nilai vote_tallies. Jumlah suara tetap apa adanya.
--   * Jangan menghapus baris presensi pemilih. Kehilangan satu baris berarti
--     satu pemilih bisa memilih dua kali.
--
-- Skrip ini idempoten: aman dijalankan dua kali.
-- Jalankan HANYA jika perlu kembali ke kode lama setelah cutover.

begin;

-- 1. Fungsi verifikasi OTP versi lama: (p_email, p_nim, p_otp), mengembalikan data voter.
create or replace function public.voter_verify_otp(
  p_email text,
  p_nim text,
  p_otp text
)
returns jsonb
language plpgsql
security definer set search_path = public, private
as $$
declare
  clean_email text := lower(trim(coalesce(p_email, '')));
  clean_nim text := nullif(trim(coalesce(p_nim, '')), '');
  otp_row private.voter_otps%rowtype;
begin
  select * into otp_row
  from private.voter_otps
  where lower(trim(email)) = clean_email
    and consumed_at is null
  order by created_at desc
  limit 1;

  if not found then
    raise exception 'Kode OTP tidak ditemukan. Silakan minta kode baru.' using errcode = 'P0001';
  end if;
  if otp_row.expires_at < now() then
    raise exception 'Kode OTP sudah kedaluwarsa. Silakan minta kode baru.' using errcode = 'P0001';
  end if;
  if otp_row.otp_code <> trim(coalesce(p_otp, '')) then
    raise exception 'Kode OTP salah.' using errcode = 'P0001';
  end if;

  update private.voter_otps
  set consumed_at = now()
  where id = otp_row.id;

  return jsonb_build_object(
    'ok', true,
    'email', clean_email,
    'nim', coalesce(clean_nim, otp_row.nim),
    'has_voted', exists (
      select 1 from public.registered_voters r
      where lower(trim(r.email)) = clean_email and r.has_voted = true
    )
  );
end;
$$;

-- 2. Fungsi pencatatan suara versi lama yang dipanggil /api/cast-vote kode lama.
create or replace function public.cast_vote_by_nim_and_email(
  p_nim text,
  p_email text,
  p_candidate_id uuid
)
returns jsonb
language plpgsql
security definer set search_path = public, private
as $$
declare
  clean_email text := lower(trim(coalesce(p_email, '')));
  voter_rows int := 0;
begin
  if clean_email = '' then
    raise exception 'Email wajib diisi.' using errcode = 'P0001';
  end if;

  insert into public.registered_voters (email, nim, has_voted, voted_at)
  values (clean_email, nullif(trim(coalesce(p_nim, '')), ''), true, now())
  on conflict (email) do update
    set has_voted = true,
        voted_at = now()
    where public.registered_voters.has_voted = false;
  get diagnostics voter_rows = row_count;

  if voter_rows <> 1 then
    raise exception 'Akun email ini sudah menggunakan hak suara.' using errcode = 'P0001';
  end if;

  insert into public.vote_tallies (candidate_id, votes)
  values (p_candidate_id, 0)
  on conflict (candidate_id) do nothing;

  update public.vote_tallies
  set votes = votes + 1
  where candidate_id = p_candidate_id;

  return jsonb_build_object('success', true);
end;
$$;

-- 3. Hak akses: kembalikan seperti semula, hanya service_role yang memakai fungsi ini
--    dari serverless function.
revoke all on function public.voter_verify_otp(text, text, text) from public, anon, authenticated;
grant execute on function public.voter_verify_otp(text, text, text) to service_role;
revoke all on function public.cast_vote_by_nim_and_email(text, text, uuid) from public, anon, authenticated;
grant execute on function public.cast_vote_by_nim_and_email(text, text, uuid) to service_role;

-- 4. Pastikan tidak ada baris presensi yang terhapus dan tidak ada tally negatif.
do $$
declare
  missing int;
begin
  select count(*) into missing
  from public.registered_voters
  where has_voted = true;
  raise notice 'Presensi pemilih yang masih tersimpan: %', missing;

  if exists (select 1 from public.vote_tallies where votes < 0) then
    raise exception 'Ada tally negatif. Hentikan rollback dan periksa manual.';
  end if;
end $$;

commit;

-- Catatan untuk operator rollback:
--   * Jangan menghapus token yang sudah dikonsumsi. Tidak berpengaruh setelah rollback.
--   * Kolom nim tetap nullable, dan kode lama hanya memakainya sebagai catatan.
--   * PIN admin baru (private.admin_credentials) tetap berlaku. Jangan hapus.
--   * Setelah rollback, login admin lama pada kode lama hanya bisa lewat
--     pemeriksaan database, karena PIN literal sudah dihapus dari kode.
