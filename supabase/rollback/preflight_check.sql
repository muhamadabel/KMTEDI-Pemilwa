-- Pemeriksaan sebelum migrasi 20261125000000 dijalankan pada database produksi.
-- Hanya membaca. Tidak mengubah data apa pun.
-- Jalankan dengan role yang punya akses ke schema private (service_role atau postgres).
-- Simpan keluarannya sebagai bukti pra-rilis.

\echo '=== 1. Jumlah data yang akan dipertahankan ==='
select 'candidates' as tabel, count(*) from public.candidates
union all select 'election_settings', count(*) from public.election_settings
union all select 'registered_voters', count(*) from public.registered_voters
union all select 'registered_voters_has_voted', count(*) from public.registered_voters where has_voted = true
union all select 'vote_tallies', count(*) from public.vote_tallies
union all select 'eligible_voters', count(*) from public.eligible_voters;

\echo '=== 2. Suara yang sudah masuk (harus sama setelah migrasi) ==='
select coalesce(sum(votes), 0) as total_suara from public.vote_tallies;

\echo '=== 3. Duplikat email beda huruf besar/kecil (harus KOSONG) ==='
-- Jika ada isi, JANGAN lanjutkan migrasi. Gabungkan dulu secara manual.
select lower(trim(email)) as email_normal, count(*) as jumlah
from public.registered_voters
group by 1
having count(*) > 1;

\echo '=== 4. Email tidak valid yang bisa menggagalkan constraint NOT VALID ==='
select count(*) as email_tidak_valid
from public.registered_voters
where email is null or trim(email) = '' or position('@' in email) = 0;

\echo '=== 5. Apakah PIN admin sudah pernah dirotasi ==='
select exists (
  select 1 from information_schema.tables
  where table_schema = 'private' and table_name = 'admin_credentials'
) as tabel_admin_credentials_ada;

\echo '=== 6. Nilai tally per calon (pembanding pasca-migrasi) ==='
select c.order_number, c.name, coalesce(t.votes, 0) as suara
from public.candidates c
left join public.vote_tallies t on t.candidate_id = c.id
order by c.order_number;

\echo '=== 7. Status bilik saat ini ==='
select voting_open, voting_start, voting_end, results_published
from public.election_settings
where id = true;
