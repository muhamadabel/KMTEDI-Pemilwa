-- Replace the placeholder candidate data before opening voting.
insert into public.candidates (order_number, name, nim, batch, vision, mission, programs, organization_history, photo_url)
values
(1, 'Calon Satu', null, null, 'Visi calon satu akan diisi panitia.', array['Misi utama calon satu'], array['Program prioritas 01', 'Program prioritas 02'], null, null),
(2, 'Calon Dua', null, null, 'Visi calon dua akan diisi panitia.', array['Misi utama calon dua'], array['Program prioritas 01', 'Program prioritas 02'], null, null),
(3, 'Calon Tiga', null, null, 'Visi calon tiga akan diisi panitia.', array['Misi utama calon tiga'], array['Program prioritas 01', 'Program prioritas 02'], null, null)
on conflict (order_number) do update set
  name = excluded.name,
  vision = excluded.vision,
  mission = excluded.mission,
  programs = excluded.programs;
