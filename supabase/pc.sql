-- PC fernsteuern (mapq.at/pcon) – kann gefahrlos mehrmals ausgeführt werden (auch als Update).
-- Setzt voraus: Anfragen-Postfach (Funktion mapq_ist_admin).
-- Befehle geben darf nur der Admin. Das Hilfsprogramm auf dem PC meldet sich mit seinem eigenen
-- Schlüssel (gespeichert ist nur der SHA-256-Hash) und holt sich dabei den nächsten Befehl ab.
-- Diese Datei steht auch in pcon/index.html (PC_SQL) – beide gleich halten.

create table if not exists public.mapq_pc (
  id text primary key check (id ~ '^[a-z0-9-]{1,30}$'),
  erstellt timestamptz not null default now(),
  name text check (char_length(name) <= 40),
  token_hash text unique,
  zuletzt timestamptz,
  info jsonb,
  befehl text check (befehl in ('aus', 'neustart', 'schlafen', 'sperren')),
  befehl_zeit timestamptz,
  quittiert timestamptz,
  quittiert_befehl text,
  steckdose text check (char_length(steckdose) <= 100)
);
alter table public.mapq_pc enable row level security;
revoke all on public.mapq_pc from anon, authenticated;

-- Übersicht für die Seite (nur Admin, sonst null)
create or replace function public.mapq_pc_status()
returns jsonb language sql stable security definer set search_path = ''
as $$ select case when public.mapq_ist_admin() then jsonb_build_object(
  'jetzt', now(),
  'pcs', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'zuletzt', p.zuletzt, 'info', p.info,
      'online', coalesce(p.zuletzt > now() - interval '25 seconds', false),
      'befehl', case when p.befehl_zeit > now() - interval '2 minutes' then p.befehl end,
      'befehl_zeit', p.befehl_zeit, 'quittiert', p.quittiert, 'quittiert_befehl', p.quittiert_befehl,
      'steckdose', p.steckdose, 'verbunden', p.token_hash is not null) order by p.erstellt)
    from public.mapq_pc p), '[]'::jsonb)) end $$;
revoke all on function public.mapq_pc_status() from public, anon;
grant execute on function public.mapq_pc_status() to authenticated;

-- Befehl geben (null = zurücknehmen). Ein Befehl gilt 2 Minuten, danach verfällt er.
create or replace function public.mapq_pc_befehl(p_id text, p_befehl text)
returns jsonb language plpgsql security definer set search_path = ''
as $$ begin
  if not public.mapq_ist_admin() then raise exception 'Kein Zugriff' using errcode = '42501'; end if;
  if p_befehl is not null and p_befehl not in ('aus', 'neustart', 'schlafen', 'sperren') then raise exception 'Unbekannter Befehl'; end if;
  update public.mapq_pc set befehl = p_befehl, befehl_zeit = case when p_befehl is null then null else now() end where id = p_id;
  if not found then raise exception 'PC nicht gefunden'; end if;
  return jsonb_build_object('ok', true, 'zeit', now());
end $$;
revoke all on function public.mapq_pc_befehl(text, text) from public, anon;
grant execute on function public.mapq_pc_befehl(text, text) to authenticated;

-- Neuer Schlüssel für das Hilfsprogramm (legt den PC an; der alte Schlüssel gilt danach nicht mehr)
create or replace function public.mapq_pc_schluessel(p_id text default 'pc', p_name text default null)
returns text language plpgsql security definer set search_path = ''
as $$
declare t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.mapq_ist_admin() then raise exception 'Kein Zugriff' using errcode = '42501'; end if;
  insert into public.mapq_pc (id, name, token_hash)
    values (p_id, coalesce(nullif(left(trim(p_name), 40), ''), 'Mein PC'), encode(sha256(convert_to(t, 'UTF8')), 'hex'))
    on conflict (id) do update set token_hash = excluded.token_hash,
      name = coalesce(nullif(left(trim(p_name), 40), ''), public.mapq_pc.name), befehl = null, befehl_zeit = null;
  return t;
end $$;
revoke all on function public.mapq_pc_schluessel(text, text) from public, anon;
grant execute on function public.mapq_pc_schluessel(text, text) to authenticated;

-- Name und Steckdose (Gerät aus „Zuhause“, mit der sich der PC einschalten lässt) speichern
create or replace function public.mapq_pc_einstellen(p_id text, p_daten jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$ begin
  if not public.mapq_ist_admin() then raise exception 'Kein Zugriff' using errcode = '42501'; end if;
  update public.mapq_pc set
    name = case when p_daten ? 'name' then coalesce(nullif(left(trim(p_daten->>'name'), 40), ''), name) else name end,
    steckdose = case when p_daten ? 'steckdose' then nullif(left(p_daten->>'steckdose', 100), '') else steckdose end
  where id = p_id;
  if not found then raise exception 'PC nicht gefunden'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mapq_pc_einstellen(text, jsonb) from public, anon;
grant execute on function public.mapq_pc_einstellen(text, jsonb) to authenticated;

create or replace function public.mapq_pc_loeschen(p_id text)
returns void language plpgsql security definer set search_path = ''
as $$ begin
  if not public.mapq_ist_admin() then raise exception 'Kein Zugriff' using errcode = '42501'; end if;
  delete from public.mapq_pc where id = p_id;
end $$;
revoke all on function public.mapq_pc_loeschen(text) from public, anon;
grant execute on function public.mapq_pc_loeschen(text) to authenticated;

-- Vom Hilfsprogramm auf dem PC (alle paar Sekunden, ohne Anmeldung, nur mit Schlüssel):
-- „ich bin an“ + Infos (Name, Netzwerk) melden und den nächsten Befehl abholen (wird dabei quittiert)
create or replace function public.mapq_pc_melden(p_token text, p_info jsonb default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare p public.mapq_pc; b text;
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 200 then return jsonb_build_object('ok', false); end if;
  select * into p from public.mapq_pc where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found then return jsonb_build_object('ok', false, 'fehler', 'Unbekannter Schlüssel'); end if;
  b := case when p.befehl_zeit > now() - interval '2 minutes' then p.befehl end;
  update public.mapq_pc set
    zuletzt = now(),
    info = case when jsonb_typeof(p_info) = 'object' and pg_column_size(p_info) < 4000 then p_info else info end,
    befehl = null,
    quittiert = case when b is not null then now() else quittiert end,
    quittiert_befehl = coalesce(b, quittiert_befehl)
  where id = p.id;
  return jsonb_build_object('ok', true, 'befehl', b, 'name', p.name);
end $$;
revoke all on function public.mapq_pc_melden(text, jsonb) from public;
grant execute on function public.mapq_pc_melden(text, jsonb) to anon, authenticated;

select 'Fertig ✓' as ergebnis;
