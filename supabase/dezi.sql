-- Dezi-Contest (mapq.at/dezi): Fotos zu Einreichungen
-- Einmal im Supabase SQL-Editor ausführen. Kann gefahrlos mehrmals laufen.
-- Setzt voraus: Anfragen-Postfach (Tabelle anfragen, Funktion mapq_ist_admin).
--
-- Öffentlicher Speicher-Bereich „dezi“: Ein Foto ist nur über seinen zufälligen Link
-- zu sehen (der steht in der Anfrage im Panel). Auflisten kann die Fotos niemand.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dezi', 'dezi', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Die Website darf Fotos nur hochladen (nicht lesen, überschreiben oder löschen)
drop policy if exists "dezi_upload" on storage.objects;
create policy "dezi_upload" on storage.objects
  for insert to anon
  with check (bucket_id = 'dezi' and (storage.foldername(name))[1] = 'einreichungen');

-- Du (Admin) darfst alles, z. B. Fotos löschen
drop policy if exists "dezi_admin" on storage.objects;
create policy "dezi_admin" on storage.objects
  for all to authenticated
  using (bucket_id = 'dezi' and public.mapq_ist_admin())
  with check (bucket_id = 'dezi' and public.mapq_ist_admin());
