// Automationen für „Zuhause“ in der Familien-App – wie in Home Assistant, nur einfacher:
//   • zu einer Uhrzeit (z. B. 23:00 alles aus), an bestimmten Wochentagen
//   • bei Sonnenuntergang / Sonnenaufgang, mit Versatz (z. B. 15 Minuten vorher Licht an)
//   • wenn alle weg sind (die letzte Person verlässt Zuhause) / wenn der Erste heimkommt (optional nur, wenn es dunkel ist)
// Anwesenheit kommt von der Familien-Karte (geteilte Standorte, siehe standort.ts) und „Zuhause“ dort.
//
// Gespeichert in mapq_einstellungen:
//   smart_regeln          JSON-Liste der Regeln
//   smart_lauf:<id>       letzter Lauf einer Regel { zeit, fuer, ok, text }
//   smart_auto_naechste   wann die nächste Zeit-Regel fällig ist (ISO) – pg_cron (mapq_smart_automatik) ruft jede Minute
//                         die Datenbank, und nur wenn es so weit ist, diese Funktion mit { aktion: "auto-lauf" } auf
//   smart_anwesend        wer zuletzt daheim war { daheim: [Namen], zeit }
//
// Aktionen (Familie): auto-liste · auto-speichern { regel } · auto-loeschen { id } · auto-jetzt { id }
// Vom Zeitplan (mit x-mapq-secret, siehe index.ts): auto-lauf

import { Fehler, smartAktion } from "./smart.ts?v=3";

// deno-lint-ignore no-explicit-any
type Db = (path: string, init?: RequestInit) => Promise<any>;
type Ctx = { db: Db; s: Record<string, string> };
// deno-lint-ignore no-explicit-any
type Roh = any;
type Wann = "zeit" | "sonnenuntergang" | "sonnenaufgang" | "weg" | "heim";
type Tun = "an" | "aus" | "auf" | "zu";
export type Regel = {
  id: string; name: string; aktiv: boolean; wann: Wann;
  zeit?: string; versatz?: number; tage?: number[]; dunkel?: boolean;
  geraete: string[]; tun: Tun; ab: number;
};
type Lauf = { zeit: number; fuer: number; ok: boolean; text: string };
type Pos = { lat: number; lon: number };

const RK = "smart_regeln", LP = "smart_lauf:", NK = "smart_auto_naechste", AK = "smart_anwesend";
const WANN: Wann[] = ["zeit", "sonnenuntergang", "sonnenaufgang", "weg", "heim"];
const TUN: Tun[] = ["an", "aus", "auf", "zu"];
const INNSBRUCK: Pos = { lat: 47.2692, lon: 11.4041 };
export const RADIUS = 150; // m um „Zuhause“ (Familien-Karte) zählen als daheim
const FENSTER = 30 * 60000; // so lange darf eine verpasste Zeit-Regel noch nachgeholt werden
const MAX = 30;

const json = (v?: string): Roh => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
async function schreibe(ctx: Ctx, werte: Record<string, string>) {
  Object.assign(ctx.s, werte);
  await ctx.db("mapq_einstellungen?on_conflict=schluessel", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(Object.entries(werte).map(([schluessel, wert]) => ({ schluessel, wert }))),
  });
}
export function abstand(a: Pos, b: Pos) {
  const r = Math.PI / 180, x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

/* ---------- Zeit in Österreich ---------- */
const FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});
const WT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
type Tag = { y: number; m: number; d: number; wd: number };
/** Zeitpunkt → Datum, Uhrzeit und Wochentag (1 = Montag) in Wien */
export function wien(ms: number) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: WT.indexOf(p.weekday) + 1 };
}
/** Uhrzeit in Wien → Zeitpunkt (berücksichtigt Sommer-/Winterzeit) */
export function wienMs(y: number, m: number, d: number, h: number, min: number) {
  const soll = Date.UTC(y, m - 1, d, h, min);
  let t = soll;
  for (let i = 0; i < 3; i++) {
    const w = wien(t), diff = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - soll;
    if (!diff) break;
    t -= diff;
  }
  return t;
}
function tagUm(ms: number, plus: number): Tag {
  const w = wien(ms), u = new Date(Date.UTC(w.y, w.m - 1, w.d + plus));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), wd: ((u.getUTCDay() + 6) % 7) + 1 };
}

/* ---------- Sonnenauf- und -untergang (Verfahren wie SunCalc, auf etwa eine Minute genau) ---------- */
const R = Math.PI / 180, J1970 = 2440588, J2000 = 2451545, NEIGUNG = R * 23.4397;
export function sonne(t: Tag, pos: Pos): { auf: number; unter: number } | null {
  const tage = wienMs(t.y, t.m, t.d, 12, 0) / 86400000 - 0.5 + J1970 - J2000;
  const lw = R * -pos.lon, phi = R * pos.lat;
  const n = Math.round(tage - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = R * (357.5291 + 0.98560028 * ds);
  const L = M + R * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + R * 102.9372 + Math.PI;
  const dek = Math.asin(Math.sin(NEIGUNG) * Math.sin(L));
  const mittag = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const c = (Math.sin(R * -0.833) - Math.sin(phi) * Math.sin(dek)) / (Math.cos(phi) * Math.cos(dek));
  if (c < -1 || c > 1) return null;
  const a = 0.0009 + (Math.acos(c) + lw) / (2 * Math.PI) + n;
  const unter = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const ms = (j: number) => Math.round((j + 0.5 - J1970) * 86400000);
  return { auf: ms(mittag - (unter - mittag)), unter: ms(unter) };
}
const zuhause = (s: Record<string, string>): Pos | null => { const z = json(s.familie_zuhause); return z && Number.isFinite(z.lat) && Number.isFinite(z.lon) ? z : null; };
const ort = (s: Record<string, string>) => zuhause(s) ?? INNSBRUCK;
export function istDunkel(s: Record<string, string>, jetzt: number) {
  const x = sonne(tagUm(jetzt, 0), ort(s));
  return !x || jetzt < x.auf + 15 * 60000 || jetzt > x.unter - 30 * 60000;
}

/* ---------- Regeln ---------- */
export const ladeRegeln = (s: Record<string, string>): Regel[] => { const l = json(s[RK]); return Array.isArray(l) ? l.filter((r) => r && r.id && WANN.includes(r.wann)) : []; };
const ladeLauf = (s: Record<string, string>, id: string): Lauf | null => json(s[LP + id]);
const istZeit = (r: Regel) => r.wann === "zeit" || r.wann === "sonnenuntergang" || r.wann === "sonnenaufgang";

/** Wann eine Zeit-Regel an diesem Tag dran ist (null = an dem Tag nicht) */
export function termin(r: Regel, t: Tag, pos: Pos): number | null {
  if (r.tage?.length && !r.tage.includes(t.wd)) return null;
  if (r.wann === "zeit") {
    const [h, min] = String(r.zeit).split(":").map(Number);
    return wienMs(t.y, t.m, t.d, h, min);
  }
  if (r.wann === "sonnenuntergang" || r.wann === "sonnenaufgang") {
    const x = sonne(t, pos);
    return x ? (r.wann === "sonnenaufgang" ? x.auf : x.unter) + (r.versatz ?? 0) * 60000 : null;
  }
  return null;
}
const erledigt = (r: Regel, l: Lauf | null) => Math.max(r.ab || 0, l?.fuer || 0);
/** Zeit-Regeln, die jetzt dran sind (auch gerade eben verpasste, höchstens 30 Minuten) */
export function faellig(regeln: Regel[], s: Record<string, string>, jetzt: number): { r: Regel; wann: number }[] {
  const pos = ort(s), out: { r: Regel; wann: number }[] = [];
  for (const r of regeln) {
    if (!r.aktiv || !istZeit(r)) continue;
    const fertig = erledigt(r, ladeLauf(s, r.id));
    const t = [-1, 0].map((i) => termin(r, tagUm(jetzt, i), pos)).filter((x): x is number => x !== null && x <= jetzt && jetzt - x < FENSTER && x > fertig);
    if (t.length) out.push({ r, wann: Math.max(...t) });
  }
  return out;
}
/** Nächster Zeitpunkt, an dem eine Zeit-Regel dran ist */
export function naechste(regeln: Regel[], s: Record<string, string>, jetzt: number): number | null {
  const pos = ort(s);
  let min: number | null = null;
  for (const r of regeln) {
    if (!r.aktiv || !istZeit(r)) continue;
    const fertig = erledigt(r, ladeLauf(s, r.id));
    for (let i = -1; i <= 8; i++) {
      const x = termin(r, tagUm(jetzt, i), pos);
      if (x !== null && x > fertig && x > jetzt - FENSTER) { if (min === null || x < min) min = x; break; }
    }
  }
  return min;
}

const GERAET = /^(alle:(licht|schalter|rollo)|raum:.{1,30}|(govee|shelly|tuya|smartthings)~.{1,200})$/;
export function pruefeRegel(x: Roh, alt?: Regel): Regel {
  const wann = String(x?.wann) as Wann;
  if (!WANN.includes(wann)) throw new Fehler("Wann soll das passieren?");
  const tun = String(x?.tun) as Tun;
  if (!TUN.includes(tun)) throw new Fehler("Was soll passieren – an, aus, auf oder zu?");
  const geraete = [...new Set<string>((Array.isArray(x?.geraete) ? x.geraete : []).map((g: unknown) => String(g ?? "").trim()))].filter((g) => GERAET.test(g)).slice(0, 40);
  if (!geraete.length) throw new Fehler("Wähl mindestens ein Gerät aus.");
  const r: Regel = {
    id: alt?.id ?? crypto.randomUUID().slice(0, 8),
    name: String(x?.name ?? "").trim().slice(0, 40) || "Automation",
    aktiv: x?.aktiv !== false,
    wann, geraete, tun,
    ab: Date.now(), // erst ab jetzt – was heute schon vorbei ist, wird nicht nachgeholt
  };
  if (wann === "zeit") {
    const z = String(x?.zeit ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(z)) throw new Fehler("Bitte eine Uhrzeit angeben.");
    r.zeit = z;
  }
  if (wann === "sonnenuntergang" || wann === "sonnenaufgang") {
    const v = Math.round(Number(x?.versatz ?? 0));
    r.versatz = Number.isFinite(v) ? Math.max(-180, Math.min(180, v)) : 0;
  }
  if (wann !== "weg" && wann !== "heim") {
    const t = [...new Set<number>((Array.isArray(x?.tage) ? x.tage : []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 7).sort();
    if (t.length && t.length < 7) r.tage = t;
  }
  if (wann === "heim" && x?.dunkel === true) r.dunkel = true;
  return r;
}

/* ---------- Ausführen ---------- */
const SCHALTBAR = ["licht", "schalter", "geraet", "tv"];
export async function ausfuehren(ctx: Ctx, r: Regel): Promise<{ ok: boolean; text: string }> {
  try {
    const st: Roh = await smartAktion({ aktion: "smart-status" }, ctx);
    const alle: Roh[] = Array.isArray(st?.geraete) ? st.geraete : [], einst: Roh = st?.einst ?? {};
    const rollo = r.tun === "auf" || r.tun === "zu";
    const passt = (d: Roh) => rollo ? d.art === "rollo" : SCHALTBAR.includes(d.art) && d.kann?.an !== false;
    const ziel = new Map<string, Roh>();
    for (const g of r.geraete) {
      // „alle …“ und Räume ohne ausgeblendete Geräte, einzeln gewählte immer
      const gruppe = (f: (d: Roh) => boolean) => alle.filter((d) => f(d) && !einst[d.id]?.aus && passt(d)).forEach((d) => ziel.set(d.id, d));
      if (g === "alle:licht") gruppe((d) => d.art === "licht");
      else if (g === "alle:schalter") gruppe((d) => d.art === "schalter" || d.art === "geraet");
      else if (g === "alle:rollo") gruppe((d) => d.art === "rollo");
      else if (g.startsWith("raum:")) gruppe((d) => (einst[d.id]?.raum || "") === g.slice(5) && d.art !== "tv");
      else { const d = alle.find((x) => x.id === g); if (d && passt(d)) ziel.set(d.id, d); }
    }
    if (!ziel.size) return { ok: false, text: "Keine passenden Geräte gefunden." };
    // nur schalten, was nötig ist (spart Anfragen – Shelly erlaubt nur eine pro Sekunde)
    const noetig = [...ziel.values()].filter((d) => {
      if (rollo) return d.online && (r.tun === "auf" ? (d.position ?? 0) < 99 : (d.position ?? 100) > 1 || d.position == null);
      if (!d.online && !(d.art === "tv" && r.tun === "an")) return false;
      return d.an !== (r.tun === "an");
    });
    if (!noetig.length) return { ok: true, text: `Schon alles ${r.tun}` };
    const befehl = rollo ? { position: r.tun === "auf" ? "open" : "close" } : { an: r.tun === "an" };
    const x: Roh = await smartAktion({ aktion: "smart-set", ids: noetig.map((d) => d.id), befehl }, ctx);
    const n = x?.geraete?.length ?? 0, f: string[] = x?.fehler ?? [];
    return { ok: !f.length, text: `${n} Gerät${n === 1 ? "" : "e"} ${r.tun}${f.length ? " · " + f.join(" · ") : ""}`.slice(0, 300) };
  } catch (e) {
    return { ok: false, text: ((e as Error).message || "Hat nicht geklappt.").slice(0, 300) };
  }
}
async function merkeLauf(ctx: Ctx, r: Regel, fuer: number, ergebnis: { ok: boolean; text: string }) {
  const l: Lauf = { zeit: Date.now(), fuer, ...ergebnis };
  await schreibe(ctx, { [LP + r.id]: JSON.stringify(l) });
}
async function planen(ctx: Ctx) {
  const n = naechste(ladeRegeln(ctx.s), ctx.s, Date.now());
  await schreibe(ctx, { [NK]: n === null ? "" : new Date(n).toISOString() });
}

/** Vom Zeitplan: fällige Zeit-Regeln ausführen und den nächsten Termin merken */
export async function autoLauf(ctx: Ctx) {
  const jetzt = Date.now(), dran = faellig(ladeRegeln(ctx.s), ctx.s, jetzt);
  for (const { r, wann } of dran) await merkeLauf(ctx, r, wann, await ausfuehren(ctx, r));
  await planen(ctx);
  return { ok: true, ausgefuehrt: dran.map((x) => x.r.name), naechste: ctx.s[NK] || null };
}

/**
 * Anwesenheit neu bestimmen – nach jedem geteilten Standort. Verlässt die letzte Person Zuhause, laufen die „weg“-Regeln,
 * kommt die erste heim, die „heim“-Regeln. ausloesen = false merkt sich nur den Stand (z. B. wenn jemand nicht mehr teilt).
 */
export async function anwesenheit(ctx: Ctx, aenderung: { name: string; pos: Pos | null } | null, ausloesen = true) {
  try {
    const z = zuhause(ctx.s);
    if (!z) return;
    const orte: Record<string, Pos> = {};
    for (const [k, v] of Object.entries(ctx.s)) {
      if (!k.startsWith("standort:") || !v) continue;
      const o = json(v);
      if (o && Number.isFinite(o.lat) && Number.isFinite(o.lon)) orte[k.slice(9)] = o;
    }
    if (aenderung) { if (aenderung.pos) orte[aenderung.name] = aenderung.pos; else delete orte[aenderung.name]; }
    const daheim = Object.entries(orte).filter(([, o]) => abstand(o, z) <= RADIUS).map(([n]) => n).sort();
    const vorher: string[] | null = Array.isArray(json(ctx.s[AK])?.daheim) ? json(ctx.s[AK]).daheim : null;
    if (vorher && vorher.join("|") === daheim.join("|")) return;
    await schreibe(ctx, { [AK]: JSON.stringify({ daheim, zeit: Date.now() }) });
    if (!ausloesen || !vorher) return;
    const ereignis = vorher.length && !daheim.length ? "weg" : !vorher.length && daheim.length ? "heim" : null;
    if (!ereignis) return;
    const jetzt = Date.now();
    for (const r of ladeRegeln(ctx.s)) {
      if (!r.aktiv || r.wann !== ereignis || (r.dunkel && !istDunkel(ctx.s, jetzt))) continue;
      await merkeLauf(ctx, r, jetzt, await ausfuehren(ctx, r));
    }
  } catch (e) {
    console.error("Anwesenheit", (e as Error).message); // darf das Teilen des Standorts nie stören
  }
}

async function liste(ctx: Ctx) {
  const regeln = ladeRegeln(ctx.s), jetzt = Date.now(), x = sonne(tagUm(jetzt, 0), ort(ctx.s));
  return {
    regeln,
    lauf: Object.fromEntries(regeln.map((r) => [r.id, ladeLauf(ctx.s, r.id)]).filter(([, l]) => l)),
    naechste: Object.fromEntries(regeln.filter((r) => r.aktiv && istZeit(r)).map((r) => [r.id, naechste([r], ctx.s, jetzt)])),
    sonne: x,
    zuhause: !!zuhause(ctx.s),
    daheim: json(ctx.s[AK])?.daheim ?? null,
  };
}

export async function regelAktion(data: Roh, ctx: Ctx): Promise<unknown> {
  const a = String(data?.aktion);
  const regeln = ladeRegeln(ctx.s);
  if (a === "auto-liste") return await liste(ctx);
  if (a === "auto-speichern") {
    const id = data?.regel?.id ? String(data.regel.id) : null;
    const alt = id ? regeln.find((r) => r.id === id) : undefined;
    if (id && !alt) throw new Fehler("Diese Automation gibt es nicht mehr – lade neu.", 404);
    if (!alt && regeln.length >= MAX) throw new Fehler(`Höchstens ${MAX} Automationen.`);
    const r = pruefeRegel(data.regel, alt);
    const neu = alt ? regeln.map((x) => x.id === r.id ? r : x) : [...regeln, r];
    await schreibe(ctx, { [RK]: JSON.stringify(neu) });
    await planen(ctx);
    return { ...(await liste(ctx)), regel: r };
  }
  if (a === "auto-loeschen") {
    const id = String(data?.id ?? "");
    await schreibe(ctx, { [RK]: JSON.stringify(regeln.filter((r) => r.id !== id)), [LP + id]: "" });
    await planen(ctx);
    return await liste(ctx);
  }
  if (a === "auto-jetzt") {
    const r = regeln.find((x) => x.id === String(data?.id ?? ""));
    if (!r) throw new Fehler("Diese Automation gibt es nicht mehr – lade neu.", 404);
    const e = await ausfuehren(ctx, r);
    await merkeLauf(ctx, r, ladeLauf(ctx.s, r.id)?.fuer ?? 0, e);
    return { ...(await liste(ctx)), ergebnis: e };
  }
  throw new Fehler("Unbekannte Aktion.");
}
