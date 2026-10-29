// Familien-Karte (mapq.at/familie → Mehr → „Wo sind alle?“): freiwillig geteilte Standorte der Familie.
//
// Jede Person teilt ihren Standort selbst – in der App (Tipp auf „Teilen“) oder automatisch mit einem
// iPhone-Kurzbefehl, der einen persönlichen Schlüssel mitschickt. Gespeichert in mapq_einstellungen:
//   standort:<Name>          → { lat, lon, gen, zeit, quelle, ort }   (leer = nicht geteilt)
//   standort_token:<sha256>  → Name                                   (nur der Hash des Schlüssels)
//   familie_zuhause          → { lat, lon }                           (für „Zuhause“ statt Ortsname)
//
// Aktionen:
//   standort          { token, lat, lon, gen? }  – vom Kurzbefehl, ohne Anmeldung, nur mit Schlüssel
//   standort-liste    {}                         – alle Standorte (Familie)
//   standort-setzen   { name, lat, lon, gen? }   – aus der App (Familie)
//   standort-token    { name }                   – neuer Kurzbefehl-Schlüssel (alter wird ungültig)
//   standort-stopp    { name }                   – nicht mehr teilen: Standort und Schlüssel weg
//   standort-zuhause  { lat, lon } | { loeschen } – Zuhause festlegen

import { Fehler } from "./smart.ts?v=3";

// deno-lint-ignore no-explicit-any
type Db = (path: string, init?: RequestInit) => Promise<any>;
type Ctx = { db: Db; s: Record<string, string> };
// deno-lint-ignore no-explicit-any
type Roh = any;
type Ort = { lat: number; lon: number; gen: number | null; zeit: number; quelle: "app" | "kurzbefehl"; ort: string | null };

const SP = "standort:", TP = "standort_token:";
const te = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", te.encode(s)));
const zahl = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};
const json = (v?: string): Roh => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
/** Entfernung in Metern */
export function abstand(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180, x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

async function schreibe(db: Db, werte: Record<string, string>) {
  await db("mapq_einstellungen?on_conflict=schluessel", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(Object.entries(werte).map(([schluessel, wert]) => ({ schluessel, wert }))),
  });
}
async function istMitglied(db: Db, name: string) {
  const r = await db(`familie_mitglieder?select=name&name=eq.${encodeURIComponent(name)}`);
  return Array.isArray(r) && r.length > 0;
}
/** Ortsname (Stadtteil oder Ort) über OpenStreetMap – nur, wenn es schnell geht */
async function ortsname(lat: number, lon: number): Promise<string | null> {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat=${lat}&lon=${lon}`, {
      headers: { "User-Agent": "mapq.at-familie/1.0 (+https://mapq.at)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const a = (await r.json())?.address ?? {};
    const n = a.suburb || a.village || a.town || a.city_district || a.city || a.municipality || a.county;
    return n ? String(n).slice(0, 60) : null;
  } catch {
    return null;
  }
}
function pruefe(data: Roh) {
  const lat = zahl(data.lat), lon = zahl(data.lon), gen = zahl(data.gen);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat === 0 && lon === 0)) {
    throw new Fehler("Ungültiger Standort (lat/lon fehlen).");
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, gen: gen !== null && gen >= 0 ? Math.round(gen) : null };
}
async function setzen(ctx: Ctx, name: string, p: { lat: number; lon: number; gen: number | null }, quelle: Ort["quelle"]) {
  const alt: Ort | null = json(ctx.s[SP + name]);
  // Ortsname nur neu holen, wenn sich die Person merklich bewegt hat
  const ort = alt?.ort && abstand(alt, p) < 300 ? alt.ort : await ortsname(p.lat, p.lon);
  const neu: Ort = { ...p, zeit: Date.now(), quelle, ort };
  await schreibe(ctx.db, { [SP + name]: JSON.stringify(neu) });
  return neu;
}
const nameAus = (data: Roh) => {
  const n = String(data.name ?? "").trim();
  if (!n || n.length > 30) throw new Fehler("Kein Name angegeben.");
  return n;
};

export async function standortAktion(data: Roh, ctx: Ctx): Promise<unknown> {
  const a = String(data?.aktion);
  const { db, s } = ctx;

  if (a === "standort") {
    const token = String(data.token ?? "").trim();
    const name = token.length >= 20 ? s[TP + await sha(token)] : "";
    if (!name) throw new Fehler("Unbekannter Schlüssel – in der Familien-App unter „Ich → Standort“ einen neuen erstellen.", 401);
    const o = await setzen(ctx, name, pruefe(data), "kurzbefehl");
    return { ok: true, name, ort: o.ort };
  }

  if (a === "standort-liste") {
    const standorte = Object.entries(s).filter(([k, v]) => k.startsWith(SP) && v).map(([k, v]) => ({ name: k.slice(SP.length), ...json(v) }))
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
    const kurzbefehl = [...new Set(Object.entries(s).filter(([k, v]) => k.startsWith(TP) && v).map(([, v]) => v))];
    return { standorte, kurzbefehl, zuhause: json(s.familie_zuhause) };
  }

  if (a === "standort-setzen") {
    const name = nameAus(data);
    if (!(await istMitglied(db, name))) throw new Fehler("Diese Person gibt es in der Familie nicht.");
    return { ok: true, standort: { name, ...(await setzen(ctx, name, pruefe(data), "app")) } };
  }

  if (a === "standort-token") {
    const name = nameAus(data);
    if (!(await istMitglied(db, name))) throw new Fehler("Diese Person gibt es in der Familie nicht.");
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
    const werte: Record<string, string> = { [TP + await sha(token)]: name };
    for (const [k, v] of Object.entries(s)) if (k.startsWith(TP) && v === name) werte[k] = ""; // alter Schlüssel gilt nicht mehr
    await schreibe(db, werte);
    return { ok: true, token };
  }

  if (a === "standort-stopp") {
    const name = nameAus(data);
    const werte: Record<string, string> = { [SP + name]: "" };
    for (const [k, v] of Object.entries(s)) if (k.startsWith(TP) && v === name) werte[k] = "";
    await schreibe(db, werte);
    return { ok: true };
  }

  if (a === "standort-zuhause") {
    if (data.loeschen === true) { await schreibe(db, { familie_zuhause: "" }); return { ok: true, zuhause: null }; }
    const p = pruefe(data);
    await schreibe(db, { familie_zuhause: JSON.stringify({ lat: p.lat, lon: p.lon }) });
    return { ok: true, zuhause: { lat: p.lat, lon: p.lon } };
  }

  throw new Fehler("Unbekannte Aktion.");
}
