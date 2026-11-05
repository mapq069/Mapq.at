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

-- ---------- Automatische Rangliste ----------
-- Werte vom 3-Sek-Burp mit Foto trägt die Website selbst ein. Im Panel kannst du jeden Eintrag
-- ausblenden oder Einreichungen, die nicht automatisch reinkommen, mit einem Tipp bestätigen.
-- Fotos und Kontaktdaten stehen hier nicht drin, nur was die Rangliste zeigt.

create table if not exists public.dezi_rangliste (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  anfrage uuid,
  name text not null check (char_length(name) between 1 and 60),
  instagram text check (char_length(instagram) <= 60),
  auto text not null check (char_length(auto) between 1 and 80),
  anlage text check (char_length(anlage) <= 160),
  db numeric(4,1) not null check (db between 40 and 160),
  bass_hz integer check (bass_hz between 0 and 500),
  sichtbar boolean not null default true
);
alter table public.dezi_rangliste enable row level security;

-- Alle dürfen die sichtbaren Einträge lesen (die Rangliste auf mapq.at/dezi)
drop policy if exists "dezi_lesen" on public.dezi_rangliste;
create policy "dezi_lesen" on public.dezi_rangliste
  for select to anon, authenticated using (sichtbar);

-- Die Website darf nur neue, sichtbare Einträge anlegen
drop policy if exists "dezi_eintragen" on public.dezi_rangliste;
create policy "dezi_eintragen" on public.dezi_rangliste
  for insert to anon with check (sichtbar);

-- Du (Admin) darfst alles: ausblenden, wieder zeigen, selbst eintragen, löschen
drop policy if exists "dezi_admin_all" on public.dezi_rangliste;
create policy "dezi_admin_all" on public.dezi_rangliste
  for all to authenticated
  using (public.mapq_ist_admin()) with check (public.mapq_ist_admin());

grant select, insert on public.dezi_rangliste to anon;
grant select, insert, update, delete on public.dezi_rangliste to authenticated;

-- Schutz vor Spam: höchstens 20 neue Einträge pro Stunde, Zeitpunkt setzt immer der Server
create or replace function public.dezi_bremse()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from public.dezi_rangliste where erstellt > now() - interval '1 hour') >= 20 then
    raise exception 'Zu viele neue Einträge – bitte später nochmal.';
  end if;
  new.erstellt := now();
  return new;
end $$;
drop trigger if exists dezi_bremse on public.dezi_rangliste;
create trigger dezi_bremse before insert on public.dezi_rangliste
  for each row execute function public.dezi_bremse();
