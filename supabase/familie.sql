-- Familien-App mapq.at/familie (kann gefahrlos mehrmals ausgeführt werden)
-- Setzt voraus: Anfragen-Postfach (mapq_ist_admin) und „Push & Statistik“ (mapq_einstellungen, push_url, push_secret).
-- Zugriff hat nur das Familien-Konto (dessen ID die Funktion mapq-push in mapq_einstellungen.familie_user ablegt) und der Admin.

grant select, insert, update on public.mapq_einstellungen to service_role;

create or replace function public.mapq_ist_familie()
returns boolean language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and (
  auth.uid()::text = (select wert from public.mapq_einstellungen where schluessel = 'familie_user')
  or public.mapq_ist_admin()) $$;
revoke all on function public.mapq_ist_familie() from public, anon;
grant execute on function public.mapq_ist_familie() to authenticated;

-- Tabellen
create table if not exists public.familie_mitglieder (
  name text primary key check (char_length(name) between 1 and 30),
  erstellt timestamptz not null default now()
);
create table if not exists public.familie_eintraege (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  liste text not null check (liste in ('einkauf', 'todo')),
  text text not null check (char_length(text) between 1 and 200),
  von text,
  fuer text,
  erledigt boolean not null default false,
  erledigt_von text,
  erledigt_am timestamptz
);
create index if not exists familie_eintraege_liste on public.familie_eintraege (liste, erledigt);
create table if not exists public.familie_termine (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  titel text not null check (char_length(titel) between 1 and 120),
  datum date not null,
  zeit time,
  ort text check (char_length(ort) <= 120),
  notiz text check (char_length(notiz) <= 1000),
  fuer text,
  von text,
  jaehrlich boolean not null default false
);
create index if not exists familie_termine_datum on public.familie_termine (datum);
create table if not exists public.familie_fotos (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  pfad text not null,
  klein text not null,
  breite int,
  hoehe int,
  text text check (char_length(text) <= 300),
  von text
);
create index if not exists familie_fotos_erstellt on public.familie_fotos (erstellt desc);
create table if not exists public.familie_nachrichten (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  text text not null check (char_length(text) between 1 and 2000),
  von text
);
create index if not exists familie_nachrichten_erstellt on public.familie_nachrichten (erstellt desc);
create table if not exists public.familie_abos (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  name text,
  geraet text
);
create table if not exists public.familie_push_log (
  art text not null,
  von text not null,
  zeit timestamptz not null default now(),
  primary key (art, von)
);

-- Nur die Familie (und der Admin) dürfen lesen und schreiben
do $$
declare t text;
begin
  foreach t in array array['familie_mitglieder', 'familie_eintraege', 'familie_termine', 'familie_fotos', 'familie_nachrichten', 'familie_abos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "familie" on public.%I', t);
    execute format('create policy "familie" on public.%I for all to authenticated using (public.mapq_ist_familie()) with check (public.mapq_ist_familie())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant select, delete on public.%I to service_role', t);
  end loop;
end $$;
alter table public.familie_push_log enable row level security;
revoke all on public.familie_push_log from anon, authenticated;

-- Fotos: privater Speicher, nur für die Familie
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('familie', 'familie', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;
drop policy if exists "familie_lesen" on storage.objects;
create policy "familie_lesen" on storage.objects for select to authenticated
  using (bucket_id = 'familie' and public.mapq_ist_familie());
drop policy if exists "familie_hochladen" on storage.objects;
create policy "familie_hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'familie' and public.mapq_ist_familie());
drop policy if exists "familie_loeschen" on storage.objects;
create policy "familie_loeschen" on storage.objects for delete to authenticated
  using (bucket_id = 'familie' and public.mapq_ist_familie());

-- Infos für die App und das Panel
create or replace function public.mapq_familie_info()
returns jsonb language sql stable security definer set search_path = ''
as $$ select case when public.mapq_ist_familie() then jsonb_build_object(
  'vapid_public', (select wert from public.mapq_einstellungen where schluessel = 'vapid_public')) end $$;
revoke all on function public.mapq_familie_info() from public, anon;
grant execute on function public.mapq_familie_info() to authenticated;

create or replace function public.mapq_familie_status()
returns jsonb language sql stable security definer set search_path = ''
as $$ select case when public.mapq_ist_admin() then jsonb_build_object(
  'passwort', exists (select 1 from public.mapq_einstellungen where schluessel = 'familie_user'),
  'mitglieder', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from public.familie_mitglieder),
  'geraete', (select count(*) from public.familie_abos),
  'fotos', (select count(*) from public.familie_fotos)) end $$;
revoke all on function public.mapq_familie_status() from public, anon;
grant execute on function public.mapq_familie_status() to authenticated;

-- Push an alle anderen Familien-Handys, wenn jemand etwas einträgt
create or replace function public.mapq_familie_push()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  r jsonb := to_jsonb(new);
  wer text := coalesce(r->>'von', '');
  ziel text; geheim text; v_art text; titel text; txt text; tab text;
begin
  select wert into ziel from public.mapq_einstellungen where schluessel = 'push_url';
  select wert into geheim from public.mapq_einstellungen where schluessel = 'push_secret';
  if ziel is null or geheim is null then return new; end if;
  if not exists (select 1 from public.familie_abos a where a.name is distinct from nullif(wer, '')) then return new; end if;
  v_art := case tg_table_name
    when 'familie_eintraege' then r->>'liste'
    when 'familie_termine' then 'termin'
    when 'familie_fotos' then 'foto'
    else 'nachricht' end;
  -- Bündeln: pro Person und Bereich höchstens alle 3 Minuten eine Mitteilung (Pinnwand immer)
  if v_art <> 'nachricht' then
    if exists (select 1 from public.familie_push_log l where l.art = v_art and l.von = wer and l.zeit > now() - interval '3 minutes') then
      return new;
    end if;
    insert into public.familie_push_log (art, von, zeit) values (v_art, wer, now())
      on conflict (art, von) do update set zeit = excluded.zeit;
  end if;
  titel := case v_art
    when 'einkauf' then 'Einkaufsliste'
    when 'todo' then 'Neues To-do'
    when 'termin' then 'Neuer Termin'
    when 'foto' then 'Neue Fotos'
    else coalesce(nullif(wer, ''), 'Pinnwand') end;
  txt := case v_art
    when 'einkauf' then coalesce(nullif(wer, '') || ': ', '') || (r->>'text')
    when 'todo' then coalesce(nullif(wer, '') || ': ', '') || (r->>'text') || coalesce(' → ' || nullif(r->>'fuer', ''), '')
    when 'termin' then (r->>'titel') || ' · ' || to_char((r->>'datum')::date, 'DD.MM.') || coalesce(' ' || left(r->>'zeit', 5), '') || coalesce(' (' || nullif(wer, '') || ')', '')
    when 'foto' then coalesce(nullif(wer, ''), 'Jemand') || ' hat Fotos geteilt' || coalesce(': ' || nullif(r->>'text', ''), '')
    else left(r->>'text', 180) end;
  tab := case v_art when 'einkauf' then 'listen' when 'todo' then 'listen' when 'termin' then 'kalender' when 'foto' then 'fotos' else 'pinnwand' end;
  perform net.http_post(
    url := ziel,
    body := jsonb_build_object('ziel', 'familie', 'titel', titel, 'text', txt, 'url', '/familie/#' || tab,
      'tag', case when v_art = 'nachricht' then 'familie-n-' || (r->>'id') else 'familie-' || v_art end,
      'von', nullif(wer, '')),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-mapq-secret', geheim),
    timeout_milliseconds := 10000
  );
  return new;
exception when others then
  return new; -- ein Push-Fehler darf nie einen Eintrag verhindern
end $$;

drop trigger if exists familie_push on public.familie_eintraege;
create trigger familie_push after insert on public.familie_eintraege for each row execute function public.mapq_familie_push();
drop trigger if exists familie_push on public.familie_termine;
create trigger familie_push after insert on public.familie_termine for each row execute function public.mapq_familie_push();
drop trigger if exists familie_push on public.familie_fotos;
create trigger familie_push after insert on public.familie_fotos for each row execute function public.mapq_familie_push();
drop trigger if exists familie_push on public.familie_nachrichten;
create trigger familie_push after insert on public.familie_nachrichten for each row execute function public.mapq_familie_push();
