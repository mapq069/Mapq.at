-- Familien-App mapq.at/familie (kann gefahrlos mehrmals ausgeführt werden – auch als Update)
-- Setzt voraus: Anfragen-Postfach (mapq_ist_admin) und „Push & Statistik“ (mapq_einstellungen, push_url, push_secret).
-- Zugriff hat nur das Familien-Konto (dessen ID in mapq_einstellungen.familie_user steht) und der Admin.

grant select, insert, update on public.mapq_einstellungen to service_role;

create or replace function public.mapq_ist_familie()
returns boolean language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and (
  auth.uid()::text = (select wert from public.mapq_einstellungen where schluessel = 'familie_user')
  or public.mapq_ist_admin()) $$;
revoke all on function public.mapq_ist_familie() from public, anon;
grant execute on function public.mapq_ist_familie() to authenticated;

-- ---------- Tabellen ----------
create table if not exists public.familie_mitglieder (
  name text primary key check (char_length(name) between 1 and 30),
  erstellt timestamptz not null default now()
);
alter table public.familie_mitglieder
  add column if not exists farbe text check (char_length(farbe) <= 20),
  add column if not exists bild text check (char_length(bild) <= 200),
  add column if not exists status text check (char_length(status) <= 30),
  add column if not exists status_seit timestamptz;

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
alter table public.familie_eintraege
  add column if not exists kategorie text check (char_length(kategorie) <= 20),
  add column if not exists menge text check (char_length(menge) <= 30);
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
alter table public.familie_termine add column if not exists erinnerung int check (erinnerung between 0 and 20160);
create index if not exists familie_termine_datum on public.familie_termine (datum);

create table if not exists public.familie_alben (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 60),
  von text
);
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
alter table public.familie_fotos
  add column if not exists typ text not null default 'foto' check (typ in ('foto', 'video')),
  add column if not exists album_id uuid,
  add column if not exists dauer real;
alter table public.familie_fotos alter column klein drop not null;
do $$ begin
  alter table public.familie_fotos add constraint familie_fotos_album_fk foreign key (album_id) references public.familie_alben (id) on delete set null;
exception when duplicate_object then null; end $$;
create index if not exists familie_fotos_erstellt on public.familie_fotos (erstellt desc);
create index if not exists familie_fotos_album on public.familie_fotos (album_id);

create table if not exists public.familie_nachrichten (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  text text not null check (char_length(text) between 1 and 2000),
  von text
);
alter table public.familie_nachrichten add column if not exists optionen text[] check (cardinality(optionen) between 2 and 6);
create index if not exists familie_nachrichten_erstellt on public.familie_nachrichten (erstellt desc);

create table if not exists public.familie_stimmen (
  nachricht_id uuid not null references public.familie_nachrichten (id) on delete cascade,
  name text not null,
  option int not null check (option between 0 and 5),
  erstellt timestamptz not null default now(),
  primary key (nachricht_id, name)
);
create table if not exists public.familie_reaktionen (
  ziel_typ text not null check (ziel_typ in ('nachricht', 'foto')),
  ziel_id uuid not null,
  name text not null,
  emoji text not null check (char_length(emoji) <= 16),
  erstellt timestamptz not null default now(),
  primary key (ziel_typ, ziel_id, name, emoji)
);
create index if not exists familie_reaktionen_ziel on public.familie_reaktionen (ziel_id);
create table if not exists public.familie_kommentare (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  ziel_typ text not null check (ziel_typ in ('nachricht', 'foto')),
  ziel_id uuid not null,
  text text not null check (char_length(text) between 1 and 1000),
  von text
);
create index if not exists familie_kommentare_ziel on public.familie_kommentare (ziel_id, erstellt);

create table if not exists public.familie_aufgaben (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  titel text not null check (char_length(titel) between 1 and 120),
  rhythmus text not null check (rhythmus in ('taeglich', 'woechentlich', 'zweiwoechentlich', 'monatlich')),
  wochentag int check (wochentag between 1 and 7),
  monatstag int check (monatstag between 1 and 31),
  start date not null default current_date,
  personen text[] not null default '{}',
  erinnerung boolean not null default true,
  von text
);
create table if not exists public.familie_aufgaben_log (
  aufgabe_id uuid not null references public.familie_aufgaben (id) on delete cascade,
  datum date not null,
  von text,
  erstellt timestamptz not null default now(),
  primary key (aufgabe_id, datum)
);

create table if not exists public.familie_rezepte (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  titel text not null check (char_length(titel) between 1 and 120),
  zutaten text check (char_length(zutaten) <= 4000),
  anleitung text check (char_length(anleitung) <= 8000),
  portionen int check (portionen between 1 and 50),
  dauer int check (dauer between 1 and 1440),
  bild text,
  klein text,
  von text
);
create table if not exists public.familie_essen (
  datum date primary key,
  gericht text not null check (char_length(gericht) between 1 and 120),
  koch text,
  rezept_id uuid references public.familie_rezepte (id) on delete set null,
  zutaten text check (char_length(zutaten) <= 4000),
  notiz text check (char_length(notiz) <= 500),
  von text,
  erstellt timestamptz not null default now()
);
create table if not exists public.familie_countdowns (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  titel text not null check (char_length(titel) between 1 and 80),
  datum date not null,
  emoji text check (char_length(emoji) <= 16),
  von text
);
create table if not exists public.familie_infos (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  aktualisiert timestamptz not null default now(),
  art text not null default 'sonstiges' check (art in ('notfall', 'arzt', 'haus', 'muell', 'schule', 'sonstiges')),
  titel text not null check (char_length(titel) between 1 and 80),
  inhalt text check (char_length(inhalt) <= 4000),
  von text
);

-- Punkte & Belohnungen: Putzplan und To-dos bringen Punkte, die man gegen Belohnungen eintauschen kann
alter table public.familie_aufgaben add column if not exists punkte int not null default 10 check (punkte between 0 and 1000);
alter table public.familie_eintraege add column if not exists punkte int check (punkte between 0 and 1000);
create table if not exists public.familie_punkte (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 30),
  punkte int not null check (punkte between -100000 and 100000 and punkte <> 0),
  art text not null check (art in ('putzplan', 'todo', 'bonus', 'einloesung')),
  grund text check (char_length(grund) <= 120),
  ref text check (char_length(ref) <= 120),
  von text
);
create unique index if not exists familie_punkte_ref on public.familie_punkte (ref);
create index if not exists familie_punkte_name on public.familie_punkte (name, erstellt desc);
create table if not exists public.familie_belohnungen (
  id uuid primary key default gen_random_uuid(),
  erstellt timestamptz not null default now(),
  titel text not null check (char_length(titel) between 1 and 80),
  emoji text check (char_length(emoji) <= 16),
  kosten int not null check (kosten between 1 and 100000),
  von text
);

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
create table if not exists public.familie_erinnert (
  schluessel text primary key,
  zeit timestamptz not null default now()
);

-- ---------- Nur die Familie (und der Admin) dürfen lesen und schreiben ----------
do $$
declare t text;
begin
  foreach t in array array['familie_mitglieder', 'familie_eintraege', 'familie_termine', 'familie_alben', 'familie_fotos',
    'familie_nachrichten', 'familie_stimmen', 'familie_reaktionen', 'familie_kommentare', 'familie_aufgaben', 'familie_aufgaben_log',
    'familie_rezepte', 'familie_essen', 'familie_countdowns', 'familie_infos', 'familie_abos', 'familie_punkte', 'familie_belohnungen'] loop
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
alter table public.familie_erinnert enable row level security;
revoke all on public.familie_erinnert from anon, authenticated;

-- ---------- Fotos & Videos: privater Speicher, nur für die Familie ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('familie', 'familie', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "familie_lesen" on storage.objects;
create policy "familie_lesen" on storage.objects for select to authenticated
  using (bucket_id = 'familie' and public.mapq_ist_familie());
drop policy if exists "familie_hochladen" on storage.objects;
create policy "familie_hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'familie' and public.mapq_ist_familie());
drop policy if exists "familie_loeschen" on storage.objects;
create policy "familie_loeschen" on storage.objects for delete to authenticated
  using (bucket_id = 'familie' and public.mapq_ist_familie());

-- ---------- Infos für die App und das Panel ----------
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

-- Reaktionen und Kommentare mitlöschen, wenn eine Nachricht oder ein Foto gelöscht wird
create or replace function public.mapq_familie_aufraeumen()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin
  delete from public.familie_reaktionen where ziel_id = old.id;
  delete from public.familie_kommentare where ziel_id = old.id;
  return old;
end $$;
drop trigger if exists familie_aufraeumen on public.familie_nachrichten;
create trigger familie_aufraeumen after delete on public.familie_nachrichten for each row execute function public.mapq_familie_aufraeumen();
drop trigger if exists familie_aufraeumen on public.familie_fotos;
create trigger familie_aufraeumen after delete on public.familie_fotos for each row execute function public.mapq_familie_aufraeumen();

-- ---------- Benachrichtigungen ----------
-- Schickt eine Mitteilung über die Funktion mapq-push an die Familien-Handys (p_an = nur an diese Person, p_von = an alle außer diese)
create or replace function public.mapq_familie_senden(p_titel text, p_text text, p_url text, p_tag text, p_an text default null, p_von text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare ziel text; geheim text;
begin
  select wert into ziel from public.mapq_einstellungen where schluessel = 'push_url';
  select wert into geheim from public.mapq_einstellungen where schluessel = 'push_secret';
  if ziel is null or geheim is null then return; end if;
  perform net.http_post(
    url := ziel,
    body := jsonb_build_object('ziel', 'familie', 'titel', p_titel, 'text', p_text, 'url', p_url, 'tag', p_tag, 'an', p_an, 'von', p_von),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-mapq-secret', geheim),
    timeout_milliseconds := 10000
  );
end $$;
revoke all on function public.mapq_familie_senden(text, text, text, text, text, text) from public, anon, authenticated;

-- Push an alle anderen Familien-Handys, wenn jemand etwas einträgt
create or replace function public.mapq_familie_push()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  r jsonb := to_jsonb(new);
  wer text := coalesce(r->>'von', '');
  v_art text; titel text; txt text; tab text;
begin
  if not exists (select 1 from public.familie_abos a where a.name is distinct from nullif(wer, '')) then return new; end if;
  v_art := case tg_table_name
    when 'familie_eintraege' then r->>'liste'
    when 'familie_termine' then 'termin'
    when 'familie_fotos' then 'foto'
    when 'familie_kommentare' then 'kommentar'
    when 'familie_punkte' then 'punkte'
    else 'nachricht' end;
  -- Punkte: nur Bonus und Einlösen melden (Putzplan und To-dos zählen still mit)
  if v_art = 'punkte' and r->>'art' not in ('bonus', 'einloesung') then return new; end if;
  -- Bündeln: pro Person und Bereich höchstens alle 3 Minuten eine Mitteilung (Pinnwand, Antworten und Punkte immer)
  if v_art not in ('nachricht', 'kommentar', 'punkte') then
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
    when 'foto' then case when r->>'typ' = 'video' then 'Neues Video' else 'Neue Fotos' end
    when 'kommentar' then coalesce(nullif(wer, ''), 'Jemand') || ' hat geantwortet'
    when 'punkte' then case when r->>'art' = 'einloesung' then '🎁 ' || (r->>'name') || ' löst ein' else '⭐ Punkte für ' || (r->>'name') end
    else coalesce(nullif(wer, ''), 'Pinnwand') end;
  txt := case v_art
    when 'einkauf' then coalesce(nullif(wer, '') || ': ', '') || coalesce(nullif(r->>'menge', '') || ' ', '') || (r->>'text')
    when 'todo' then coalesce(nullif(wer, '') || ': ', '') || (r->>'text') || coalesce(' → ' || nullif(r->>'fuer', ''), '')
    when 'termin' then (r->>'titel') || ' · ' || to_char((r->>'datum')::date, 'DD.MM.') || coalesce(' ' || left(r->>'zeit', 5), '') || coalesce(' (' || nullif(wer, '') || ')', '')
    when 'foto' then coalesce(nullif(wer, ''), 'Jemand') || case when r->>'typ' = 'video' then ' hat ein Video geteilt' else ' hat Fotos geteilt' end || coalesce(': ' || nullif(r->>'text', ''), '')
    when 'kommentar' then left(r->>'text', 180)
    when 'punkte' then coalesce(nullif(r->>'grund', ''), 'Belohnung') || ' (' || case when (r->>'punkte')::int > 0 then '+' else '' end || (r->>'punkte') || ')'
      || case when r->>'art' = 'bonus' and nullif(wer, '') is not null then ' · von ' || wer else '' end
    else case when r->'optionen' is not null and r->>'optionen' <> 'null' then '📊 Umfrage: ' else '' end || left(r->>'text', 180) end;
  tab := case v_art when 'einkauf' then 'listen' when 'todo' then 'listen' when 'termin' then 'kalender' when 'foto' then 'fotos'
    when 'kommentar' then case when r->>'ziel_typ' = 'foto' then 'fotos' else 'pinnwand' end when 'punkte' then 'punkte' else 'pinnwand' end;
  perform public.mapq_familie_senden(titel, txt, '/familie/#' || tab,
    case when v_art in ('nachricht', 'kommentar', 'punkte') then 'familie-n-' || (r->>'id') else 'familie-' || v_art end,
    null, nullif(wer, ''));
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
drop trigger if exists familie_push on public.familie_kommentare;
create trigger familie_push after insert on public.familie_kommentare for each row execute function public.mapq_familie_push();
drop trigger if exists familie_push on public.familie_punkte;
create trigger familie_push after insert on public.familie_punkte for each row execute function public.mapq_familie_push();

-- ---------- Punkte ----------
-- Putzplan abgehakt → Punkte für die Person, die es erledigt hat (wieder aufgehoben → Punkte weg)
create or replace function public.mapq_familie_punkte_putzplan()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare a record;
begin
  if tg_op = 'DELETE' then
    delete from public.familie_punkte where ref = 'aufgabe:' || old.aufgabe_id || ':' || old.datum;
    return old;
  end if;
  select titel, punkte into a from public.familie_aufgaben where id = new.aufgabe_id;
  if coalesce(a.punkte, 0) > 0 and nullif(new.von, '') is not null then
    insert into public.familie_punkte (name, punkte, art, grund, ref, von)
      values (new.von, a.punkte, 'putzplan', left(a.titel, 120), 'aufgabe:' || new.aufgabe_id || ':' || new.datum, new.von)
      on conflict (ref) do nothing;
  end if;
  return new;
exception when others then
  return coalesce(new, old); -- Punkte dürfen das Abhaken nie verhindern
end $$;
drop trigger if exists familie_punkte on public.familie_aufgaben_log;
create trigger familie_punkte after insert or delete on public.familie_aufgaben_log for each row execute function public.mapq_familie_punkte_putzplan();

-- To-do mit Punkten erledigt → Punkte für die Person, die es abgehakt hat (wieder offen → Punkte weg)
create or replace function public.mapq_familie_punkte_todo()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.liste <> 'todo' then return new; end if;
  if new.erledigt and not coalesce(old.erledigt, false) and coalesce(new.punkte, 0) > 0 and nullif(new.erledigt_von, '') is not null then
    insert into public.familie_punkte (name, punkte, art, grund, ref, von)
      values (new.erledigt_von, new.punkte, 'todo', left(new.text, 120), 'todo:' || new.id, new.erledigt_von)
      on conflict (ref) do nothing;
  elsif not new.erledigt and coalesce(old.erledigt, false) then
    delete from public.familie_punkte where ref = 'todo:' || new.id;
  end if;
  return new;
exception when others then
  return new;
end $$;
drop trigger if exists familie_punkte on public.familie_eintraege;
create trigger familie_punkte after update of erledigt on public.familie_eintraege for each row execute function public.mapq_familie_punkte_todo();

-- Einlösen nur mit genug Punkten; Einlösen zieht ab, alles andere zählt dazu
create or replace function public.mapq_familie_punkte_pruefen()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare stand int;
begin
  if new.art = 'einloesung' then
    if new.punkte > 0 then new.punkte := -new.punkte; end if;
    select coalesce(sum(punkte), 0) into stand from public.familie_punkte where name = new.name;
    if stand + new.punkte < 0 then
      raise exception 'Nicht genug Punkte: % hat % Punkte.', new.name, stand using errcode = 'P0001';
    end if;
  elsif new.art in ('putzplan', 'todo') and new.punkte < 0 then
    raise exception 'Ungültige Punkte.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists familie_punkte_pruefen on public.familie_punkte;
create trigger familie_punkte_pruefen before insert on public.familie_punkte for each row execute function public.mapq_familie_punkte_pruefen();

-- Punktestand je Person: stand (zum Einlösen), woche und monat (gesammelt, für die Rangliste)
create or replace function public.mapq_familie_punktestand()
returns jsonb language sql stable security definer set search_path = ''
as $$ select case when public.mapq_ist_familie() then coalesce((select jsonb_object_agg(name, jsonb_build_object('stand', stand, 'woche', woche, 'monat', monat, 'gesamt', gesamt))
  from (select name, sum(punkte)::int as stand,
      coalesce(sum(punkte) filter (where punkte > 0 and erstellt >= (date_trunc('week', now() at time zone 'Europe/Vienna') at time zone 'Europe/Vienna')), 0)::int as woche,
      coalesce(sum(punkte) filter (where punkte > 0 and erstellt >= (date_trunc('month', now() at time zone 'Europe/Vienna') at time zone 'Europe/Vienna')), 0)::int as monat,
      coalesce(sum(punkte) filter (where punkte > 0), 0)::int as gesamt
    from public.familie_punkte group by name) x), '{}'::jsonb) end $$;
revoke all on function public.mapq_familie_punktestand() from public, anon;
grant execute on function public.mapq_familie_punktestand() to authenticated;

-- ---------- Erinnerungen (läuft alle 5 Minuten) ----------
-- Jahrestag im Jahr y (29. Februar → 28. Februar)
create or replace function public.mapq_jahrestag(d date, y int)
returns date language sql immutable set search_path = ''
as $$ select make_date(y, extract(month from d)::int, least(extract(day from d)::int,
  extract(day from (make_date(y, extract(month from d)::int, 1) + interval '1 month - 1 day'))::int)) $$;

-- Der wievielte Termin einer wiederkehrenden Aufgabe ist am Tag p_d? (null = an dem Tag nicht fällig)
create or replace function public.mapq_aufgabe_index(p_rhythmus text, p_wochentag int, p_monatstag int, p_start date, p_d date)
returns int language plpgsql immutable set search_path = ''
as $$
declare erst date; diff int; tag int;
begin
  if p_d < p_start then return null; end if;
  if p_rhythmus = 'taeglich' then return p_d - p_start; end if;
  if p_rhythmus in ('woechentlich', 'zweiwoechentlich') then
    erst := p_start + ((coalesce(p_wochentag, extract(isodow from p_start)::int) - extract(isodow from p_start)::int + 7) % 7);
    if p_d < erst then return null; end if;
    diff := p_d - erst;
    if p_rhythmus = 'woechentlich' then return case when diff % 7 = 0 then diff / 7 end; end if;
    return case when diff % 14 = 0 then diff / 14 end;
  end if;
  tag := coalesce(p_monatstag, extract(day from p_start)::int);
  if extract(day from p_d)::int <> least(tag, extract(day from (date_trunc('month', p_d) + interval '1 month - 1 day'))::int) then return null; end if;
  diff := (extract(year from p_d)::int * 12 + extract(month from p_d)::int) - (extract(year from p_start)::int * 12 + extract(month from p_start)::int);
  if extract(day from p_start)::int > least(tag, extract(day from (date_trunc('month', p_start) + interval '1 month - 1 day'))::int) then diff := diff - 1; end if;
  return diff;
end $$;

create or replace function public.mapq_familie_erinnern(p_jetzt timestamp default null)
returns int language plpgsql security definer set search_path = ''
as $$
declare
  jetzt timestamp := coalesce(p_jetzt, now() at time zone 'Europe/Vienna');
  heute date := jetzt::date;
  t record; a record; d date; beginn timestamp; wann timestamp; k text; n int := 0; idx int; jahre int; wer text; wann_txt text;
begin
  if not exists (select 1 from public.familie_abos) then return 0; end if;

  -- 1) Termine mit Erinnerung (für ganztägige Termine zählt 8 Uhr als Beginn)
  for t in select * from public.familie_termine where erinnerung is not null and (jaehrlich or datum between heute - 1 and heute + 15) loop
    foreach d in array (case when t.jaehrlich
        then array[public.mapq_jahrestag(t.datum, extract(year from heute)::int), public.mapq_jahrestag(t.datum, extract(year from heute)::int + 1)]
        else array[t.datum] end) loop
      if d < t.datum then continue; end if;
      beginn := d + coalesce(t.zeit, time '08:00');
      wann := beginn - make_interval(mins => t.erinnerung);
      if jetzt >= wann and jetzt < wann + interval '60 minutes' and jetzt < beginn + interval '30 minutes' then
        k := 'termin:' || t.id || ':' || d || ':' || t.erinnerung;
        if not exists (select 1 from public.familie_erinnert where schluessel = k) then
          insert into public.familie_erinnert (schluessel) values (k);
          wann_txt := case when d = heute then 'Heute' when d = heute + 1 then 'Morgen' else to_char(d, 'DD.MM.') end
            || coalesce(' um ' || to_char(t.zeit, 'HH24:MI'), '') || coalesce(' · ' || nullif(t.ort, ''), '');
          perform public.mapq_familie_senden('⏰ ' || t.titel, wann_txt, '/familie/#kalender', 'erinnerung-' || t.id, nullif(t.fuer, ''), null);
          n := n + 1;
        end if;
      end if;
    end loop;
  end loop;

  -- 2) Geburtstage und Jahrestage: am Morgen des Tages (ab 8 Uhr)
  if jetzt::time >= time '08:00' and jetzt::time < time '12:00' then
    for t in select * from public.familie_termine where jaehrlich loop
      d := public.mapq_jahrestag(t.datum, extract(year from heute)::int);
      if d = heute and d >= t.datum then
        k := 'jahr:' || t.id || ':' || d;
        if not exists (select 1 from public.familie_erinnert where schluessel = k) then
          insert into public.familie_erinnert (schluessel) values (k);
          jahre := extract(year from heute)::int - extract(year from t.datum)::int;
          perform public.mapq_familie_senden('🎂 Heute: ' || t.titel, case when jahre > 0 then jahre || ' Jahre' else 'Heute ist der große Tag!' end,
            '/familie/#kalender', 'jahr-' || t.id, null, null);
          n := n + 1;
        end if;
      end if;
    end loop;

  -- 3) Putzplan: am Morgen an die Person, die dran ist
    for a in select * from public.familie_aufgaben where erinnerung loop
      idx := public.mapq_aufgabe_index(a.rhythmus, a.wochentag, a.monatstag, a.start, heute);
      if idx is not null and not exists (select 1 from public.familie_aufgaben_log l where l.aufgabe_id = a.id and l.datum = heute) then
        k := 'aufgabe:' || a.id || ':' || heute;
        if not exists (select 1 from public.familie_erinnert where schluessel = k) then
          insert into public.familie_erinnert (schluessel) values (k);
          wer := case when cardinality(a.personen) > 0 then a.personen[(idx % cardinality(a.personen)) + 1] end;
          perform public.mapq_familie_senden('🧹 Heute dran: ' || a.titel, coalesce(wer || ' ist dran', 'Für alle'), '/familie/#listen', 'aufgabe-' || a.id, wer, null);
          n := n + 1;
        end if;
      end if;
    end loop;
  end if;

  delete from public.familie_erinnert where zeit < now() - interval '60 days';
  return n;
end $$;
revoke all on function public.mapq_familie_erinnern(timestamp) from public, anon, authenticated;

-- ---------- Automationen für „Zuhause“ (Zeitpläne) ----------
-- Jede Minute: Ist eine Zeit-Regel dran (smart_auto_naechste – setzt die Funktion mapq-push selbst), wird sie aufgerufen.
-- Sonst passiert nichts, die Funktion läuft also nur, wenn wirklich etwas zu tun ist.
create or replace function public.mapq_smart_automatik()
returns void language plpgsql security definer set search_path = ''
as $$
declare faellig text; ziel text; geheim text;
begin
  select wert into faellig from public.mapq_einstellungen where schluessel = 'smart_auto_naechste';
  if coalesce(faellig, '') = '' or now() < faellig::timestamptz then return; end if;
  select wert into ziel from public.mapq_einstellungen where schluessel = 'push_url';
  select wert into geheim from public.mapq_einstellungen where schluessel = 'push_secret';
  if ziel is null or geheim is null then return; end if;
  -- antwortet die Funktion nicht, frühestens in 5 Minuten wieder (sonst setzt sie den nächsten Termin selbst)
  update public.mapq_einstellungen set wert = to_char(now() at time zone 'UTC' + interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    where schluessel = 'smart_auto_naechste';
  perform net.http_post(
    url := ziel,
    body := jsonb_build_object('aktion', 'auto-lauf'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-mapq-secret', geheim),
    timeout_milliseconds := 30000
  );
exception when others then
  raise notice 'Automationen: %', sqlerrm;
end $$;
revoke all on function public.mapq_smart_automatik() from public, anon, authenticated;

-- Zeitplan (pg_cron). Fehlt die Erweiterung, läuft der Rest trotzdem.
do $$ begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then raise notice 'pg_cron nicht verfügbar: %', sqlerrm; end $$;
do $$ begin
  perform cron.schedule('mapq-familie-erinnerungen', '*/5 * * * *', 'select public.mapq_familie_erinnern()');
  perform cron.schedule('mapq-smart-automatik', '* * * * *', 'select public.mapq_smart_automatik()');
exception when others then raise notice 'Zeitplan nicht angelegt: %', sqlerrm; end $$;

select 'Fertig ✓' as ergebnis,
  case when exists (select 1 from pg_extension where extname = 'pg_cron') then 'Erinnerungen und Automationen aktiv' else 'Erinnerungen und Automationen: pg_cron fehlt' end as zeitplan;
