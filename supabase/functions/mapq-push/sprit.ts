// Spritpreise für die Familien-App (mapq.at/familie → Mehr → „Tanken“): die günstigsten Tankstellen in der Nähe.
//
// Quelle: Spritpreisrechner der E-Control (api.e-control.at, frei nutzbar, ohne Schlüssel). Die E-Control zeigt pro Suche
// nur die günstigeren Tankstellen mit Preis – so ist es gesetzlich geregelt. Ergebnisse werden 10 Minuten zwischengespeichert
// (eine Zeile mapq_einstellungen „smart_cache:sprit“ für alle Orte), damit nicht jedes Öffnen eine Anfrage auslöst.
//
// Aktion (nur Familie, geprüft in index.ts):
//   sprit { lat, lon, art: "DIE" | "SUP" | "GAS" } → { stationen: [{ id, name, adresse, lat, lon, preis, offen, km }], zeit }

import { Fehler } from "./smart.ts?v=3";

// deno-lint-ignore no-explicit-any
type Db = (path: string, init?: RequestInit) => Promise<any>;
type Ctx = { db: Db; s: Record<string, string> };
// deno-lint-ignore no-explicit-any
type Roh = any;
export type Station = { id: string; name: string; adresse: string; lat: number; lon: number; preis: number; offen: boolean | null; km: number | null };

const ARTEN = ["DIE", "SUP", "GAS"];
const KEY = "smart_cache:sprit";
const ALTER = 10 * 60 * 1000;
export const ECONTROL = "https://api.e-control.at/sprit/1.0/search/gas-stations/by-address";

const zahl = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Antwort der E-Control → Tankstellen mit Preis, günstigste zuerst */
export function stationen(roh: Roh): Station[] {
  if (!Array.isArray(roh)) return [];
  const out: Station[] = [];
  for (const t of roh) {
    const preise = (Array.isArray(t?.prices) ? t.prices : []).map((p: Roh) => zahl(p?.amount)).filter((p: number | null): p is number => p !== null && p > 0);
    const lat = zahl(t?.location?.latitude), lon = zahl(t?.location?.longitude);
    if (!preise.length || lat === null || lon === null) continue;
    const l = t.location ?? {};
    const ort = [l.postalCode, l.city].filter(Boolean).join(" ");
    out.push({
      id: String(t.id ?? `${lat},${lon}`),
      name: String(t.name ?? "Tankstelle").trim().slice(0, 80),
      adresse: [String(l.address ?? "").trim(), ort].filter(Boolean).join(", ").slice(0, 120),
      lat, lon,
      preis: Math.min(...preise),
      offen: typeof t.open === "boolean" ? t.open : null,
      km: zahl(t.distance) !== null ? Math.round(zahl(t.distance)! * 10) / 10 : null,
    });
  }
  return out.sort((a, b) => a.preis - b.preis || (a.km ?? 99) - (b.km ?? 99)).slice(0, 12);
}

export async function spritAktion(data: Roh, ctx: Ctx): Promise<unknown> {
  const lat = zahl(data?.lat), lon = zahl(data?.lon);
  const art = String(data?.art ?? "DIE").toUpperCase();
  if (!ARTEN.includes(art)) throw new Fehler("Unbekannte Sorte.");
  // Spritpreisrechner gibt es nur für Österreich (grob: Breite 46,3–49,1 · Länge 9,5–17,2)
  if (lat === null || lon === null || lat < 46.3 || lat > 49.1 || lon < 9.5 || lon > 17.2) throw new Fehler("Spritpreise gibt es nur für Orte in Österreich.");
  const ort = `${art}:${lat.toFixed(2)},${lon.toFixed(2)}`;

  let speicher: Record<string, { zeit: number; daten: Station[] }> = {};
  try {
    const r = await ctx.db(`mapq_einstellungen?select=wert&schluessel=eq.${encodeURIComponent(KEY)}`);
    speicher = JSON.parse(r?.[0]?.wert || "{}")?.daten || {};
  } catch { speicher = {}; }
  const alt = speicher[ort];
  if (alt && Date.now() - alt.zeit < ALTER && data?.frisch !== true) return { stationen: alt.daten, zeit: alt.zeit };

  let liste: Station[];
  try {
    const u = `${ECONTROL}?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}&fuelType=${art}&includeClosed=false`;
    const r = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "mapq.at-familie/1.0 (+https://mapq.at)" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`E-Control ${r.status}`);
    liste = stationen(await r.json());
  } catch (e) {
    console.error("Sprit", (e as Error).message);
    if (alt) return { stationen: alt.daten, zeit: alt.zeit, alt: true };
    throw new Fehler("Der Spritpreisrechner antwortet gerade nicht – versuch es gleich nochmal.", 502);
  }
  const zeit = Date.now();
  // nur junge Einträge behalten, damit die Zeile klein bleibt
  const neu: Record<string, { zeit: number; daten: Station[] }> = { [ort]: { zeit, daten: liste } };
  for (const [k, v] of Object.entries(speicher)) if (k !== ort && zeit - v.zeit < ALTER && Object.keys(neu).length < 20) neu[k] = v;
  await ctx.db("mapq_einstellungen?on_conflict=schluessel", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ schluessel: KEY, wert: JSON.stringify({ zeit, daten: neu }) }),
  }).catch((e: Error) => console.error("Sprit-Cache", e.message));
  return { stationen: liste, zeit };
}
