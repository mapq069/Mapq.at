// Smart Home für die Familien-App (mapq.at/familie → „Zuhause“): Govee, Shelly und Smart Life / Tuya.
//
// Die Familie trägt die Zugangsdaten in der App ein. Sie liegen nur hier auf dem Server in mapq_einstellungen
// (smart_govee_key, smart_shelly_*, smart_tuya_*) und gehen nie zurück an den Browser.
// Die App bekommt eine einheitliche Geräteliste. Zustände werden kurz zwischengespeichert
// (mapq_einstellungen „smart_cache:…“), damit die Grenzen der Anbieter halten (Shelly: 1 Anfrage pro Sekunde).
//
// Aktionen (nur Familien-Konto oder Admin, geprüft in index.ts):
//   smart-status     { frisch? }                      → Anbieter, Geräte, Einstellungen je Gerät
//   smart-set        { id | ids, befehl }             → befehl: { an } | { hell } | { farbe } | { kelvin } | { szene } | { position }
//   smart-szenen     { id }                           → Govee-Szenen eines Lichts
//   smart-einrichten { anbieter, …Zugangsdaten }      → prüft und speichert; { anbieter, trennen: true } entfernt sie
//   smart-geraet     { id, name?, raum?, start?, aus? } → eigener Name, Raum, auf Start zeigen, ausblenden

const te = new TextEncoder();

export type Art = "licht" | "schalter" | "rollo" | "sensor" | "geraet";
export type Anbieter = "govee" | "shelly" | "tuya";
export type Geraet = {
  id: string;
  anbieter: Anbieter;
  name: string;
  art: Art;
  modell?: string;
  online: boolean;
  an?: boolean | null;
  hell?: number | null;
  farbe?: string | null;
  kelvin?: number | null;
  kmin?: number;
  kmax?: number;
  position?: number | null;
  bewegt?: string | null;
  temp?: number | null;
  feuchte?: number | null;
  watt?: number | null;
  kann: { an?: boolean; hell?: boolean; farbe?: boolean; kelvin?: boolean; szenen?: boolean; position?: boolean; stopp?: boolean };
  // deno-lint-ignore no-explicit-any
  ref?: any;
};
export type Befehl = { an?: boolean; hell?: number; farbe?: string; kelvin?: number; szene?: string; position?: number | "open" | "close" | "stop" };
// deno-lint-ignore no-explicit-any
type Db = (path: string, init?: RequestInit) => Promise<any>;
export type Ctx = { db: Db; s: Record<string, string> };
// deno-lint-ignore no-explicit-any
type Eintrag = { zeit: number; daten: any };
type Cache = Record<string, Eintrag>;
type Neu = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Roh = any;

/** Fehler mit einer Meldung, die so in der App erscheinen darf. */
export class Fehler extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.status = status;
  }
}

/* ---------- Hilfen ---------- */
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
export const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));
const zeitlimit = () => AbortSignal.timeout(12000);
const jsonWert = (v: unknown): Roh => {
  if (typeof v !== "string") return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
};
/** h 0–360, s und v 0–1 → #rrggbb */
export function hsvHex(h: number, s: number, v: number): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgbHex(f(5) * 255, f(3) * 255, f(1) * 255);
}
export function hexHsv(hx: string) {
  const [r, g, b] = hexRgb(hx).map((x) => x / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}
async function sha256Hex(s: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(secret: string, s: string) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Zwischenspeicher und Einstellungen (Tabelle mapq_einstellungen) ---------- */
const CP = "smart_cache:";
async function ladeCache(db: Db): Promise<Cache> {
  const rows: { schluessel: string; wert: string }[] = (await db(`mapq_einstellungen?select=schluessel,wert&schluessel=like.${CP}*`)) ?? [];
  const c: Cache = {};
  for (const r of rows) {
    try {
      const j = JSON.parse(r.wert);
      if (j && j.daten != null) c[r.schluessel.slice(CP.length)] = j;
    } catch { /* kaputter Eintrag – wird neu geholt */ }
  }
  return c;
}
async function schreibe(db: Db, rows: { schluessel: string; wert: string }[]) {
  if (!rows.length) return;
  await db("mapq_einstellungen?on_conflict=schluessel", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}
const merke = (db: Db, neu: Neu) =>
  schreibe(db, Object.entries(neu).map(([k, daten]) => ({ schluessel: CP + k, wert: JSON.stringify({ zeit: Date.now(), daten }) })));
const einstellen = (db: Db, werte: Record<string, string>) => schreibe(db, Object.entries(werte).map(([schluessel, wert]) => ({ schluessel, wert })));

const TUYA_HOSTS: Record<string, string> = {
  eu: "openapi.tuyaeu.com",
  "eu-w": "openapi-weaz.tuyaeu.com",
  us: "openapi.tuyaus.com",
  "us-e": "openapi-ueaz.tuyaus.com",
  in: "openapi.tuyain.com",
  cn: "openapi.tuyacn.com",
};
type GoveeCfg = { key: string };
type ShellyCfg = { key: string; host: string; ids: string[] };
type TuyaCfg = { id: string; secret: string; region: string };
type Konfig = { govee: GoveeCfg | null; shelly: ShellyCfg | null; tuya: TuyaCfg | null };
const liste = (s?: string) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
function konfig(s: Record<string, string>): Konfig {
  return {
    govee: s.smart_govee_key ? { key: s.smart_govee_key } : null,
    shelly: s.smart_shelly_key && s.smart_shelly_host && liste(s.smart_shelly_ids).length
      ? { key: s.smart_shelly_key, host: s.smart_shelly_host, ids: liste(s.smart_shelly_ids) }
      : null,
    tuya: s.smart_tuya_id && s.smart_tuya_secret
      ? { id: s.smart_tuya_id, secret: s.smart_tuya_secret, region: TUYA_HOSTS[s.smart_tuya_region] ? s.smart_tuya_region : "eu" }
      : null,
  };
}

/* =====================================================================
   Govee (OpenAPI, openapi.api.govee.com) – Schlüssel aus der Govee-Home-App
   ===================================================================== */
const GOVEE = "https://openapi.api.govee.com/router/api/v1";
async function goveeApi(key: string, path: string, payload?: unknown): Promise<Roh> {
  let r: Response;
  try {
    r = await fetch(GOVEE + path, {
      method: payload ? "POST" : "GET",
      headers: { "Govee-API-Key": key, "Content-Type": "application/json" },
      body: payload ? JSON.stringify({ requestId: crypto.randomUUID(), payload }) : undefined,
      signal: zeitlimit(),
    });
  } catch {
    throw new Fehler("Govee ist gerade nicht erreichbar.", 502);
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new Fehler("Govee: Der API-Schlüssel stimmt nicht.");
  if (r.status === 429) throw new Fehler("Govee: Zu viele Anfragen – in einer Minute nochmal versuchen.", 429);
  if (!r.ok || (j.code !== undefined && Number(j.code) !== 200)) throw new Fehler("Govee: " + (j.msg || j.message || `Fehler ${r.status}`), 502);
  return j;
}
// deno-lint-ignore no-explicit-any
const goveeCap = (caps: any[], type: string, inst: string) => (caps ?? []).find((c) => c?.type === "devices.capabilities." + type && c?.instance === inst);
function goveeBasis(d: Roh): Geraet {
  const caps = d.capabilities ?? [];
  const kt = goveeCap(caps, "color_setting", "colorTemperatureK");
  const typ = String(d.type ?? "");
  const art: Art = typ.endsWith(".light") ? "licht" : typ.endsWith(".socket") ? "schalter"
    : /thermometer|sensor/.test(typ) || goveeCap(caps, "property", "sensorTemperature") ? "sensor" : "geraet";
  return {
    id: `govee~${d.sku}~${d.device}`,
    anbieter: "govee",
    name: String(d.deviceName || d.sku || "Govee").trim().slice(0, 60),
    art,
    modell: d.sku,
    online: true,
    kann: {
      an: !!goveeCap(caps, "on_off", "powerSwitch"),
      hell: !!goveeCap(caps, "range", "brightness"),
      farbe: !!goveeCap(caps, "color_setting", "colorRgb"),
      kelvin: !!kt,
      szenen: !!goveeCap(caps, "dynamic_scene", "lightScene"),
    },
    kmin: num(kt?.parameters?.range?.min) ?? 2000,
    kmax: num(kt?.parameters?.range?.max) ?? 9000,
    ref: { sku: d.sku, device: d.device },
  };
}
function goveeZustand(g: Geraet, caps: Roh[]): Geraet {
  const v = (type: string, inst: string) => goveeCap(caps, type, inst)?.state?.value;
  const on = v("online", "online"), p = v("on_off", "powerSwitch"), b = v("range", "brightness");
  const rgb = v("color_setting", "colorRgb"), k = v("color_setting", "colorTemperatureK");
  const t = v("property", "sensorTemperature"), h = v("property", "sensorHumidity");
  const weiss = typeof k === "number" && k > 0;
  return {
    ...g,
    online: on === undefined ? true : on === true || on === "true" || on === 1,
    an: p === undefined || p === "" ? (g.kann.an ? null : undefined) : Number(p) === 1,
    hell: num(b),
    farbe: typeof rgb === "number" && rgb > 0 && !weiss ? "#" + rgb.toString(16).padStart(6, "0") : null,
    kelvin: weiss ? k : null,
    // Govee liefert Temperaturen in Fahrenheit
    temp: num(t) !== null ? Math.round(((t - 32) * 5) / 9 * 10) / 10 : null,
    feuchte: num(h) ?? num(h?.currentHumidity),
  };
}
async function goveeStatus(cfg: GoveeCfg, c: Cache, neu: Neu): Promise<Geraet[]> {
  let basis: Geraet[] | undefined = c["liste:govee"] && Date.now() - c["liste:govee"].zeit < 10 * 60e3 ? c["liste:govee"].daten : undefined;
  if (!basis) {
    const j = await goveeApi(cfg.key, "/user/devices");
    basis = (Array.isArray(j.data) ? j.data : []).filter((d: Roh) => d?.sku && d?.device).slice(0, 40).map(goveeBasis);
    c["liste:govee"] = { zeit: Date.now(), daten: basis };
    neu["liste:govee"] = basis;
  }
  return await Promise.all(basis!.map(async (g) => {
    try {
      const j = await goveeApi(cfg.key, "/device/state", g.ref);
      return goveeZustand(g, j.payload?.capabilities ?? []);
    } catch {
      return { ...g, an: g.kann.an ? null : undefined };
    }
  }));
}
async function goveeSzenen(cfg: GoveeCfg, c: Cache, neu: Neu, g: Geraet): Promise<{ name: string; wert: unknown }[]> {
  const k = `szenen:${g.id}`;
  if (c[k] && Date.now() - c[k].zeit < 7 * 864e5) return c[k].daten;
  const j = await goveeApi(cfg.key, "/device/scenes", g.ref);
  const cap = (j.payload?.capabilities ?? []).find((x: Roh) => x?.instance === "lightScene");
  const l = (cap?.parameters?.options ?? []).filter((o: Roh) => o?.name && o.value != null)
    .slice(0, 300).map((o: Roh) => ({ name: String(o.name).slice(0, 60), wert: o.value }));
  c[k] = { zeit: Date.now(), daten: l };
  neu[k] = l;
  return l;
}
async function goveeSetzen(cfg: GoveeCfg, c: Cache, neu: Neu, g: Geraet, b: Befehl): Promise<Geraet> {
  const send = (type: string, instance: string, value: unknown) =>
    goveeApi(cfg.key, "/device/control", { ...g.ref, capability: { type: "devices.capabilities." + type, instance, value } });
  if (typeof b.an === "boolean") {
    if (!g.kann.an) throw new Fehler("Das lässt sich nicht schalten.");
    await send("on_off", "powerSwitch", b.an ? 1 : 0);
    return { ...g, an: b.an };
  }
  // Helligkeit, Farbe, Weißton oder Szene schalten ein ausgeschaltetes Licht zuerst ein
  const ein = async () => { if (g.an === false && g.kann.an) await send("on_off", "powerSwitch", 1); };
  if (b.hell !== undefined && g.kann.hell) { await ein(); await send("range", "brightness", clamp(b.hell, 1, 100)); return { ...g, an: true, hell: b.hell }; }
  if (b.farbe && g.kann.farbe) { await ein(); await send("color_setting", "colorRgb", parseInt(b.farbe.slice(1), 16)); return { ...g, an: true, farbe: b.farbe, kelvin: null }; }
  if (b.kelvin && g.kann.kelvin) {
    const k = clamp(b.kelvin, g.kmin ?? 2000, g.kmax ?? 9000);
    await ein(); await send("color_setting", "colorTemperatureK", k);
    return { ...g, an: true, kelvin: k, farbe: null };
  }
  if (b.szene && g.kann.szenen) {
    const s = (await goveeSzenen(cfg, c, neu, g)).find((x) => x.name === b.szene);
    if (!s) throw new Fehler("Diese Szene gibt es nicht mehr.");
    await ein(); await send("dynamic_scene", "lightScene", s.wert);
    return { ...g, an: true };
  }
  throw new Fehler("Das geht bei diesem Gerät nicht.");
}

/* =====================================================================
   Shelly (Cloud Control API v2) – Schlüssel und Server aus der Shelly-App,
   Geräte-IDs je Gerät (Einstellungen → Geräteinformationen)
   ===================================================================== */
const SHELLY_FEHLER: Record<string, string> = {
  DEVICE_OFFLINE: "Das Gerät ist offline.",
  DEVICE_INVALID_MODE: "Das Gerät ist im falschen Modus.",
  DEVICE_INVALID_CHANNEL: "Diesen Kanal gibt es beim Gerät nicht.",
  DEVICE_NOT_FOUND: "Gerät nicht gefunden – stimmt die Geräte-ID?",
  DEVICE_FAILED_COMMAND: "Das Gerät hat den Befehl nicht ausgeführt.",
  DEVICE_UNSUPPORTED_COMMAND: "Das kann dieses Gerät nicht.",
  BAD_REQUEST: "Ungültige Anfrage.",
};
async function shellyApi(cfg: { key: string; host: string }, path: string, body: unknown, nochmal = true): Promise<Roh> {
  let r: Response;
  try {
    r = await fetch(`https://${cfg.host}/v2/devices/api/${path}?auth_key=${encodeURIComponent(cfg.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: zeitlimit(),
    });
  } catch {
    throw new Fehler("Shelly Cloud ist gerade nicht erreichbar.", 502);
  }
  // Shelly erlaubt 1 Anfrage pro Sekunde – bei „zu schnell“ einmal kurz warten und nochmal
  if (r.status === 429 && nochmal) { await r.body?.cancel(); await warte(1100); return shellyApi(cfg, path, body, false); }
  const txt = await r.text();
  const j = jsonWert(txt);
  if (r.status === 401 || r.status === 403) throw new Fehler("Shelly: Schlüssel oder Server stimmen nicht.");
  if (r.status === 429) throw new Fehler("Shelly: Zu viele Anfragen – kurz warten.", 429);
  if (!r.ok) {
    const code = String(j?.error ?? "");
    const extra = Array.isArray(j?.data?.messages) ? j.data.messages.join(" ") : "";
    throw new Fehler("Shelly: " + (SHELLY_FEHLER[code] || code || extra || `Fehler ${r.status}`), r.status >= 500 ? 502 : 400);
  }
  return j;
}
function shellyGeraete(d: Roh): Geraet[] {
  const st = d?.status ?? {}, se = d?.settings ?? {};
  const base = String(se?.name || se?.sys?.device?.name || se?.device?.hostname || d?.code || d?.id).trim().slice(0, 60);
  const g0 = { anbieter: "shelly" as const, online: d?.online === 1 || d?.online === true, modell: d?.code || d?.type || undefined };
  const out: Geraet[] = [];
  const gen1 = String(d?.gen ?? "").toUpperCase() === "G1" || Array.isArray(st.relays) || Array.isArray(st.lights) || Array.isArray(st.rollers);
  const mk = (komp: string, kanal: number, art: Art, name: string, x: Partial<Geraet>, typ: string) =>
    out.push({ ...g0, kann: {}, ...x, id: `shelly~${d.id}~${komp}`, name: String(name).slice(0, 60), art, ref: { id: String(d.id), kanal, typ, gen1 } });
  if (gen1) {
    const rollo = se?.mode === "roller" && Array.isArray(st.rollers);
    const relays: Roh[] = rollo ? [] : (st.relays ?? []);
    const lights: Roh[] = st.lights ?? [];
    const nm = (arr: Roh[], i: number, conf: Roh[]) => conf?.[i]?.name || (arr.length > 1 ? `${base} ${i + 1}` : base);
    relays.forEach((r, i) =>
      mk(`relay:${i}`, i, "schalter", nm(relays, i, se.relays), { an: !!r?.ison, watt: num(st.meters?.[i]?.power) ?? num(st.emeters?.[i]?.power), kann: { an: true } }, "switch"));
    lights.forEach((l, i) => {
      const farbig = l && "red" in l && (l.mode === "color" || se?.mode === "color");
      mk(`light:${i}`, i, "licht", nm(lights, i, se.lights), {
        an: !!l?.ison,
        hell: num(farbig ? l.gain : l?.brightness),
        farbe: farbig ? rgbHex(l.red, l.green, l.blue) : null,
        kelvin: !farbig ? num(l?.temp) : null,
        kmin: 2700, kmax: 6500,
        kann: { an: true, hell: !!l && ("brightness" in l || "gain" in l), farbe: !!l && "red" in l, kelvin: !!l && "temp" in l },
      }, "light");
    });
    if (rollo) {
      (st.rollers as Roh[]).forEach((r, i) =>
        mk(`roller:${i}`, i, "rollo", st.rollers.length > 1 ? `${base} ${i + 1}` : base, {
          position: r?.positioning ? num(r.current_pos) : null,
          bewegt: r?.state ?? null,
          kann: { position: !!r?.positioning, stopp: true },
        }, "cover"));
    }
    const t = num(st.tmp?.tC), h = num(st.hum?.value);
    if (t !== null || h !== null) mk("sensor", 0, "sensor", base, { temp: t, feuchte: h }, "sensor");
  } else {
    const keys = Object.keys(st).filter((k) => /^(switch|light|rgb|rgbw|cct|cover):\d+$/.test(k)).sort();
    for (const k of keys) {
      const [typ, nr] = k.split(":");
      const i = Number(nr), s = st[k] ?? {}, conf = se?.[k] ?? {};
      const name = conf.name || (keys.length > 1 ? `${base} ${i + 1}` : base);
      if (typ === "switch") mk(k, i, "schalter", name, { an: !!s.output, watt: num(s.apower), kann: { an: true } }, "switch");
      else if (typ === "cover") {
        mk(k, i, "rollo", name, { position: num(s.current_pos), bewegt: s.state ?? null, kann: { position: num(s.current_pos) !== null, stopp: true } }, "cover");
      } else {
        mk(k, i, "licht", name, {
          an: !!s.output,
          hell: num(s.brightness),
          farbe: Array.isArray(s.rgb) ? rgbHex(s.rgb[0], s.rgb[1], s.rgb[2]) : null,
          kann: { an: true, hell: "brightness" in s, farbe: Array.isArray(s.rgb) },
        }, "light");
      }
    }
    const t = num(st["temperature:0"]?.tC), h = num(st["humidity:0"]?.rh);
    if (t !== null || h !== null) mk("sensor", 0, "sensor", base, { temp: t, feuchte: h }, "sensor");
  }
  if (!out.length) mk("geraet", 0, "geraet", base, {}, "none");
  return out;
}
async function shellyStatus(cfg: ShellyCfg): Promise<Geraet[]> {
  const out: Geraet[] = [];
  for (let i = 0; i < cfg.ids.length; i += 10) {
    if (i) await warte(1100); // Shelly erlaubt 1 Anfrage pro Sekunde
    const j = await shellyApi(cfg, "get", { ids: cfg.ids.slice(i, i + 10), select: ["status", "settings"] });
    for (const d of Array.isArray(j) ? j : []) out.push(...shellyGeraete(d));
  }
  return out;
}
async function shellySetzen(cfg: ShellyCfg, _c: Cache, _n: Neu, g: Geraet, b: Befehl): Promise<Geraet> {
  const r = g.ref, base = { id: r.id, channel: r.kanal };
  if (r.typ === "switch" && typeof b.an === "boolean") {
    await shellyApi(cfg, "set/switch", { ...base, on: b.an });
    return { ...g, an: b.an };
  }
  if (r.typ === "light") {
    if (typeof b.an === "boolean") { await shellyApi(cfg, "set/light", { ...base, on: b.an }); return { ...g, an: b.an }; }
    if (b.hell !== undefined) {
      await shellyApi(cfg, "set/light", { ...base, on: true, ...(g.farbe && r.gen1 ? { gain: b.hell } : { brightness: b.hell }) });
      return { ...g, an: true, hell: b.hell };
    }
    if (b.farbe && g.kann.farbe) {
      const [red, green, blue] = hexRgb(b.farbe);
      await shellyApi(cfg, "set/light", { ...base, on: true, mode: "color", red, green, blue, gain: g.hell ?? 100 });
      return { ...g, an: true, farbe: b.farbe, kelvin: null };
    }
    if (b.kelvin && g.kann.kelvin) {
      const k = clamp(b.kelvin, 2700, 6500);
      await shellyApi(cfg, "set/light", { ...base, on: true, mode: "white", temperature: k, brightness: g.hell ?? 100 });
      return { ...g, an: true, kelvin: k, farbe: null };
    }
  }
  if (r.typ === "cover" && b.position !== undefined) {
    if (typeof b.position === "number" && !g.kann.position) throw new Fehler("Der Rollladen ist nicht kalibriert – nur Auf, Stopp und Zu.");
    await shellyApi(cfg, "set/cover", { ...base, position: b.position });
    return {
      ...g,
      position: typeof b.position === "number" ? b.position : g.position,
      bewegt: b.position === "stop" ? "stop" : b.position === "open" ? "opening" : b.position === "close" ? "closing" : g.bewegt,
    };
  }
  throw new Fehler("Das geht bei diesem Gerät nicht.");
}
/** Mehrere Shelly-Geräte in einer Anfrage ein- oder ausschalten. Gibt die IDs zurück, die nicht geklappt haben. */
async function shellyGruppe(cfg: ShellyCfg, geraete: Geraet[], an: boolean): Promise<Set<string>> {
  const body: Record<string, { ids: string[]; command: { on: boolean } }> = {};
  const wer: Record<string, string> = {};
  for (const g of geraete) {
    const t = g.ref.typ === "switch" ? "switch" : g.ref.typ === "light" ? "light" : null;
    if (!t) continue;
    const key = `${g.ref.id}_${g.ref.kanal}`;
    (body[t] ??= { ids: [], command: { on: an } }).ids.push(key);
    wer[key] = g.id;
  }
  if (!Object.keys(body).length) throw new Fehler("Das geht bei diesen Geräten nicht.");
  const j = await shellyApi(cfg, "set/groups", body);
  return new Set(Object.keys(j?.failedCommands ?? {}).map((k) => wer[k]).filter(Boolean));
}

/* =====================================================================
   Smart Life / Tuya (Tuya Cloud, Projekt auf iot.tuya.com mit verknüpfter Smart-Life-App)
   ===================================================================== */
function tuyaFehler(j: Roh): Fehler {
  const c = Number(j?.code);
  const m = c === 1004 || c === 1001 || c === 1100 ? "Access ID oder Access Secret stimmen nicht (oder falsches Rechenzentrum)."
    : c === 28841002 ? "Der kostenlose Zeitraum für „IoT Core“ ist abgelaufen – auf iot.tuya.com verlängern."
    : c === 28841105 || c === 1106 || c === 28841101 ? "Dem Cloud-Projekt fehlt die Berechtigung (Dienst „IoT Core“ aktivieren)."
    : c === 2001 ? "Das Gerät ist offline."
    : c === 2008 ? "Das kann dieses Gerät nicht."
    : String(j?.msg || `Fehler ${j?.code ?? ""}`).trim();
  return new Fehler("Smart Life: " + m, c === 2001 || c === 2008 ? 400 : 502);
}
async function tuyaRoh(cfg: TuyaCfg, method: string, path: string, body?: unknown, token?: string): Promise<Roh> {
  const t = String(Date.now());
  const b = body === undefined ? "" : JSON.stringify(body);
  // Signatur (seit 2021): client_id + access_token + t + METHOD\nSHA256(Body)\n\nPfad
  const zuSignieren = [method, await sha256Hex(b), "", path].join("\n");
  const sign = (await hmacHex(cfg.secret, cfg.id + (token ?? "") + t + zuSignieren)).toUpperCase();
  const headers: Record<string, string> = { client_id: cfg.id, sign, t, sign_method: "HMAC-SHA256", "Content-Type": "application/json" };
  if (token) headers.access_token = token;
  let r: Response;
  try {
    r = await fetch(`https://${TUYA_HOSTS[cfg.region] ?? TUYA_HOSTS.eu}${path}`, { method, headers, body: b || undefined, signal: zeitlimit() });
  } catch {
    throw new Fehler("Smart Life (Tuya) ist gerade nicht erreichbar.", 502);
  }
  return await r.json().catch(() => ({ success: false, msg: `Fehler ${r.status}` }));
}
async function tuyaToken(cfg: TuyaCfg, c: Cache, neu: Neu, neuHolen = false): Promise<string> {
  const alt = c["token:tuya"]?.daten;
  if (!neuHolen && alt?.token && alt.id === cfg.id && alt.bis > Date.now() + 60e3) return alt.token;
  const j = await tuyaRoh(cfg, "GET", "/v1.0/token?grant_type=1");
  if (!j?.success || !j.result?.access_token) throw tuyaFehler(j);
  const d = { token: String(j.result.access_token), bis: Date.now() + (num(j.result.expire_time) ?? 3600) * 1000, id: cfg.id };
  c["token:tuya"] = { zeit: Date.now(), daten: d };
  neu["token:tuya"] = d;
  return d.token;
}
async function tuyaApi(cfg: TuyaCfg, c: Cache, neu: Neu, method: string, path: string, body?: unknown): Promise<Roh> {
  let j = await tuyaRoh(cfg, method, path, body, await tuyaToken(cfg, c, neu));
  if (!j?.success && (Number(j?.code) === 1010 || Number(j?.code) === 1011 || /token/i.test(String(j?.msg ?? "")))) {
    j = await tuyaRoh(cfg, method, path, body, await tuyaToken(cfg, c, neu, true));
  }
  if (!j?.success) throw tuyaFehler(j);
  return j.result;
}
async function tuyaListe(cfg: TuyaCfg, c: Cache, neu: Neu): Promise<Roh[]> {
  const alle: Roh[] = [];
  let key = "";
  for (let i = 0; i < 6; i++) {
    // Abfrage-Parameter in alphabetischer Reihenfolge (gehen so in die Signatur ein)
    const q = key ? `last_row_key=${encodeURIComponent(key)}&size=50` : "size=50";
    const r = await tuyaApi(cfg, c, neu, "GET", `/v1.0/iot-01/associated-users/devices?${q}`);
    alle.push(...(Array.isArray(r?.devices) ? r.devices : []));
    if (!r?.has_more || !r?.last_row_key) break;
    key = String(r.last_row_key);
  }
  return alle.filter((d) => d?.id).slice(0, 80);
}
type Bereich = { min: number; max: number };
function bereich(v: Roh, std: [number, number]): Bereich {
  const min = num(v?.min) ?? std[0], max = num(v?.max) ?? std[1];
  return { min, max: max > min ? max : min + 1 };
}
const prozent = (x: number, r: Bereich) => clamp(Math.round(((x - r.min) / (r.max - r.min)) * 100), 1, 100);
const ausProzent = (p: number, r: Bereich) => clamp(Math.round(r.min + (p / 100) * (r.max - r.min)), r.min, r.max);
const skaliert = (x: unknown, w: Roh) => {
  const n = num(x);
  if (n === null) return null;
  return Math.round((n / 10 ** (num(w?.scale) ?? 0)) * 10) / 10;
};
const STECKDOSEN = ["cz", "pc", "kg", "tdq", "dlq", "zndb", "znrb"];
function tuyaGeraete(d: Roh, spec: Roh): Geraet[] {
  const S: Record<string, Roh> = Object.fromEntries((Array.isArray(d.status) ? d.status : []).map((x: Roh) => [x.code, x.value]));
  const F: Record<string, { type: string; v: Roh }> = {}, W: Record<string, { type: string; v: Roh }> = {};
  for (const f of spec?.functions ?? []) F[f.code] = { type: f.type, v: jsonWert(f.values) };
  for (const f of spec?.status ?? []) W[f.code] = { type: f.type, v: jsonWert(f.values) };
  const hat = (code: string) => code in F || code in S;
  const wert = (code: string) => (F[code] ?? W[code])?.v;
  const id = String(d.id);
  const name = String(d.name || d.product_name || "Gerät").trim().slice(0, 60);
  const g0 = { anbieter: "tuya" as const, online: d.online !== false, modell: d.product_name || d.category || undefined };

  // Licht (auch LED-Streifen und Dimmer)
  const led = ["switch_led", "switch_led_1"].find(hat);
  if (led) {
    const v2 = (c?: string) => !!c && c.endsWith("_v2");
    const bc = ["bright_value_v2", "bright_value", "bright_value_1"].find(hat);
    const cc = ["colour_data_v2", "colour_data"].find(hat);
    const tc = ["temp_value_v2", "temp_value", "temp_value_1"].find(hat);
    const br = bc ? bereich(wert(bc), v2(bc) ? [10, 1000] : [25, 255]) : null;
    const tr = tc ? bereich(wert(tc), v2(tc) ? [0, 1000] : [0, 255]) : null;
    const cv = cc ? wert(cc) : null;
    const cr = { s: bereich(cv?.s, v2(cc) ? [0, 1000] : [0, 255]).max, v: bereich(cv?.v, v2(cc) ? [0, 1000] : [0, 255]).max };
    let hell: number | null = null, farbe: string | null = null, kelvin: number | null = null;
    const hsv = cc && S.work_mode === "colour" ? jsonWert(S[cc]) : null;
    if (hsv && num(hsv.h) !== null) {
      farbe = hsvHex(hsv.h, clamp((num(hsv.s) ?? 0) / cr.s, 0, 1), 1);
      hell = clamp(Math.round(((num(hsv.v) ?? cr.v) / cr.v) * 100), 1, 100);
    } else {
      if (bc && br && num(S[bc]) !== null) hell = prozent(S[bc], br);
      if (tc && tr && num(S[tc]) !== null) kelvin = Math.round(2700 + ((S[tc] - tr.min) / (tr.max - tr.min)) * 3800);
    }
    return [{
      ...g0, id: `tuya~${id}~${led}`, name, art: "licht", an: !!S[led], hell, farbe, kelvin, kmin: 2700, kmax: 6500,
      kann: { an: true, hell: !!bc, farbe: !!cc, kelvin: !!tc },
      ref: { id, code: led, bc, cc, tc, br, tr, cr, wm: hat("work_mode") },
    }];
  }

  // Rollladen, Vorhang, Markise
  if (hat("control") || hat("percent_control")) {
    return [{
      ...g0, id: `tuya~${id}~control`, name, art: "rollo",
      position: num(S.percent_state) ?? num(S.percent_control), bewegt: null,
      kann: { position: hat("percent_control"), stopp: hat("control") },
      ref: { id, code: "control", pc: hat("percent_control"), ctrl: hat("control") },
    }];
  }

  const out: Geraet[] = [];
  // Steckdosen, Schalter (auch mehrfach) und andere Geräte mit Ein/Aus
  // Reihenfolge: switch, switch_1, switch_2 …, dann USB-Anschlüsse (switch_usb1 …)
  const nr = (c: string) => (c.includes("usb") ? 100 : 0) + Number(c.replace(/\D/g, "") || 0);
  const sw = [...new Set([...Object.keys(F), ...Object.keys(S)])]
    .filter((c) => /^switch(_usb)?(_?\d+)?$/.test(c) && (F[c]?.type === "Boolean" || typeof S[c] === "boolean"))
    .sort((a, b) => nr(a) - nr(b));
  const steck = sw.filter((c) => !c.includes("usb"));
  const watt = skaliert(S.cur_power, W.cur_power?.v ?? { scale: 1 });
  sw.forEach((code) => out.push({
    ...g0, id: `tuya~${id}~${code}`,
    name: code.includes("usb") ? `${name} USB${sw.filter((c) => c.includes("usb")).length > 1 ? " " + code.replace(/\D/g, "") : ""}`
      : steck.length > 1 ? `${name} ${steck.indexOf(code) + 1}` : name,
    art: STECKDOSEN.includes(d.category) ? "schalter" : "geraet",
    an: !!S[code], watt: sw.length === 1 ? watt : null, kann: { an: true }, ref: { id, code },
  }));

  // Temperatur- und Feuchtesensoren
  const tcode = ["va_temperature", "temp_current", "temp_indoor"].find((c) => c in S);
  const hcode = ["va_humidity", "humidity_value", "humidity_indoor", "humidity_current"].find((c) => c in S);
  if (tcode || hcode) {
    out.push({
      ...g0, id: `tuya~${id}~sensor`, name: sw.length ? `${name} (Sensor)` : name, art: "sensor",
      temp: tcode ? skaliert(S[tcode], W[tcode]?.v ?? { scale: tcode === "va_temperature" ? 1 : 0 }) : null,
      feuchte: hcode ? skaliert(S[hcode], W[hcode]?.v ?? { scale: 0 }) : null,
      kann: {}, ref: { id },
    });
  }
  if (!out.length) out.push({ ...g0, id: `tuya~${id}~`, name, art: "geraet", kann: {}, ref: { id } });
  return out;
}
async function tuyaStatus(cfg: TuyaCfg, c: Cache, neu: Neu): Promise<Geraet[]> {
  const geraete = await tuyaListe(cfg, c, neu);
  const ohne = geraete.filter((d) => !Array.isArray(d.status)).map((d) => String(d.id));
  for (let i = 0; i < ohne.length; i += 20) {
    const r = await tuyaApi(cfg, c, neu, "GET", `/v1.0/iot-03/devices/status?device_ids=${ohne.slice(i, i + 20).join(",")}`);
    for (const x of Array.isArray(r) ? r : []) {
      const d = geraete.find((y) => y.id === x.id);
      if (d) d.status = x.status;
    }
  }
  // Wertebereiche je Gerät (einmalig holen, dann aus dem Zwischenspeicher)
  const fehlt = geraete.filter((d) => !c[`spec:tuya:${d.id}`]);
  for (let i = 0; i < fehlt.length; i += 8) {
    await Promise.all(fehlt.slice(i, i + 8).map(async (d) => {
      try {
        const r = await tuyaApi(cfg, c, neu, "GET", `/v1.0/iot-03/devices/${encodeURIComponent(d.id)}/specification`);
        const sp = { functions: r?.functions ?? [], status: r?.status ?? [] };
        c[`spec:tuya:${d.id}`] = { zeit: Date.now(), daten: sp };
        neu[`spec:tuya:${d.id}`] = sp;
      } catch { /* ohne Wertebereiche gelten die üblichen */ }
    }));
  }
  return geraete.flatMap((d) => tuyaGeraete(d, c[`spec:tuya:${d.id}`]?.daten));
}
async function tuyaSetzen(cfg: TuyaCfg, c: Cache, neu: Neu, g: Geraet, b: Befehl): Promise<Geraet> {
  const r = g.ref, cmds: { code: string; value: unknown }[] = [];
  const n: Geraet = { ...g };
  if (g.art === "licht") {
    if (typeof b.an === "boolean") { cmds.push({ code: r.code, value: b.an }); n.an = b.an; }
    else {
      if (g.an === false) cmds.push({ code: r.code, value: true });
      n.an = true;
      if (b.hell !== undefined && (r.bc || r.cc)) {
        if (g.farbe && r.cc) {
          const h = hexHsv(g.farbe);
          cmds.push({ code: r.cc, value: { h: h.h, s: Math.round(h.s * r.cr.s), v: Math.round((b.hell / 100) * r.cr.v) } });
        } else cmds.push({ code: r.bc, value: ausProzent(b.hell, r.br) });
        n.hell = b.hell;
      } else if (b.farbe && r.cc) {
        const h = hexHsv(b.farbe);
        if (r.wm) cmds.push({ code: "work_mode", value: "colour" });
        cmds.push({ code: r.cc, value: { h: h.h, s: Math.round(h.s * r.cr.s), v: Math.round(((g.hell ?? 100) / 100) * r.cr.v) } });
        n.farbe = hsvHex(h.h, h.s, 1);
        n.kelvin = null;
      } else if (b.kelvin && r.tc) {
        const k = clamp(b.kelvin, 2700, 6500);
        if (r.wm) cmds.push({ code: "work_mode", value: "white" });
        cmds.push({ code: r.tc, value: clamp(Math.round(r.tr.min + ((k - 2700) / 3800) * (r.tr.max - r.tr.min)), r.tr.min, r.tr.max) });
        n.kelvin = k;
        n.farbe = null;
      } else throw new Fehler("Das geht bei diesem Gerät nicht.");
    }
  } else if (g.kann.an && typeof b.an === "boolean" && r.code) {
    cmds.push({ code: r.code, value: b.an });
    n.an = b.an;
  } else if (g.art === "rollo" && b.position !== undefined) {
    if (typeof b.position === "number") {
      if (!r.pc) throw new Fehler("Dieser Rollladen kennt keine Position – nur Auf, Stopp und Zu.");
      cmds.push({ code: "percent_control", value: b.position });
      n.position = b.position;
    } else if (r.ctrl) cmds.push({ code: "control", value: b.position });
    else if (r.pc && b.position !== "stop") { cmds.push({ code: "percent_control", value: b.position === "open" ? 100 : 0 }); n.position = b.position === "open" ? 100 : 0; }
    else throw new Fehler("Das geht bei diesem Gerät nicht.");
    if (typeof b.position === "string") n.bewegt = b.position === "stop" ? "stop" : b.position === "open" ? "opening" : "closing";
  } else throw new Fehler("Das geht bei diesem Gerät nicht.");
  await tuyaApi(cfg, c, neu, "POST", `/v1.0/iot-03/devices/${encodeURIComponent(r.id)}/commands`, { commands: cmds });
  return n;
}

/* =====================================================================
   Gemeinsamer Teil
   ===================================================================== */
const ANBIETER: Anbieter[] = ["govee", "shelly", "tuya"];
const ADAPTER = {
  // deno-lint-ignore no-explicit-any
  govee: { status: goveeStatus as any, setzen: goveeSetzen as any },
  // deno-lint-ignore no-explicit-any
  shelly: { status: shellyStatus as any, setzen: shellySetzen as any },
  // deno-lint-ignore no-explicit-any
  tuya: { status: tuyaStatus as any, setzen: tuyaSetzen as any },
};
const fuerApp = (g: Geraet) => { const { ref: _ref, ...rest } = g; return rest; };
const einst = (s: Record<string, string>): Record<string, Roh> => { try { return JSON.parse(s.smart_geraete || "{}") || {}; } catch { return {}; } };

/** Aktueller Zustand aller Geräte – aus dem Zwischenspeicher, wenn er jung genug ist. */
async function zustand(ctx: Ctx, frisch: "nein" | "ja" | "immer", c?: Cache) {
  const cfg = konfig(ctx.s);
  const cache = c ?? await ladeCache(ctx.db);
  const neu: Neu = {};
  const fehler: Record<string, string> = {};
  const maxAlter = frisch === "immer" ? 0 : frisch === "ja" ? 5000 : 20000;
  const listen = await Promise.all(ANBIETER.map(async (a) => {
    const k = cfg[a];
    if (!k) return [] as Geraet[];
    const alt = cache[`status:${a}`];
    if (alt && Date.now() - alt.zeit < maxAlter) return alt.daten as Geraet[];
    try {
      const g: Geraet[] = await ADAPTER[a].status(k, cache, neu);
      cache[`status:${a}`] = { zeit: Date.now(), daten: g };
      neu[`status:${a}`] = g;
      return g;
    } catch (e) {
      fehler[a] = e instanceof Fehler ? e.message : `${a}: ${(e as Error).message}`;
      if (!(e instanceof Fehler)) console.error("Smart Home", a, e);
      return (alt?.daten as Geraet[]) ?? [];
    }
  }));
  await merke(ctx.db, neu).catch((e) => console.error("Smart-Cache", (e as Error).message));
  return { cfg, cache, geraete: listen.flat(), fehler };
}

function pruefeBefehl(b: Roh): Befehl {
  if (typeof b?.an === "boolean") return { an: b.an };
  if (num(b?.hell) !== null) return { hell: clamp(Math.round(b.hell), 1, 100) };
  if (typeof b?.farbe === "string" && /^#[0-9a-f]{6}$/i.test(b.farbe)) return { farbe: b.farbe.toLowerCase() };
  if (num(b?.kelvin) !== null) return { kelvin: clamp(Math.round(b.kelvin), 1000, 10000) };
  if (typeof b?.szene === "string" && b.szene && b.szene.length <= 60) return { szene: b.szene };
  if (b?.position === "open" || b?.position === "close" || b?.position === "stop") return { position: b.position };
  if (num(b?.position) !== null) return { position: clamp(Math.round(b.position), 0, 100) };
  throw new Fehler("Ungültiger Befehl.");
}

async function aktionStatus(ctx: Ctx, frisch: boolean) {
  const z = await zustand(ctx, frisch ? "ja" : "nein");
  const s = ctx.s;
  return {
    anbieter: {
      govee: { aktiv: !!z.cfg.govee, fehler: z.fehler.govee ?? null },
      shelly: { aktiv: !!z.cfg.shelly, fehler: z.fehler.shelly ?? null, host: s.smart_shelly_host || null, ids: liste(s.smart_shelly_ids) },
      tuya: { aktiv: !!z.cfg.tuya, fehler: z.fehler.tuya ?? null, region: s.smart_tuya_region || "eu" },
    },
    geraete: z.geraete.map(fuerApp),
    einst: einst(s),
    zeit: Date.now(),
  };
}

async function aktionSetzen(ctx: Ctx, data: Roh) {
  const b = pruefeBefehl(data.befehl);
  const ids: string[] = (Array.isArray(data.ids) ? data.ids : [data.id]).map((x: unknown) => String(x ?? "")).filter(Boolean).slice(0, 40);
  if (!ids.length) throw new Fehler("Kein Gerät angegeben.");
  let z = await zustand(ctx, "nein");
  if (ids.some((id) => !z.geraete.find((g) => g.id === id))) z = await zustand(ctx, "immer", z.cache);
  const ziel = ids.map((id) => z.geraete.find((g) => g.id === id)).filter((g): g is Geraet => !!g);
  if (!ziel.length) throw new Fehler("Gerät nicht gefunden – lade die Seite neu.", 404);
  const neu: Neu = {};
  const ok: Geraet[] = [];
  const fehler: string[] = [];
  const versuch = async (g: Geraet) => {
    try {
      if (!g.online) throw new Fehler("Das Gerät ist offline.");
      ok.push(await ADAPTER[g.anbieter].setzen(z.cfg[g.anbieter], z.cache, neu, g, b));
    } catch (e) {
      fehler.push(`${g.name}: ${e instanceof Fehler ? e.message : (e as Error).message}`);
    }
  };
  const shelly = ziel.filter((g) => g.anbieter === "shelly");
  const schnell = ziel.filter((g) => g.anbieter !== "shelly");
  const parallel = Promise.all(schnell.map(versuch));
  if (shelly.length > 1 && typeof b.an === "boolean" && z.cfg.shelly) {
    try {
      const nicht = await shellyGruppe(z.cfg.shelly, shelly, b.an);
      for (const g of shelly) nicht.has(g.id) ? fehler.push(`${g.name}: hat nicht reagiert.`) : ok.push({ ...g, an: b.an });
    } catch (e) {
      fehler.push((e as Error).message);
    }
  } else {
    for (const [i, g] of shelly.entries()) {
      if (i) await warte(1100);
      await versuch(g);
    }
  }
  await parallel;
  // Zwischenspeicher gleich mit dem neuen Zustand füllen, damit die App nicht zurückspringt
  for (const a of ANBIETER) {
    const alt = z.cache[`status:${a}`];
    const m = new Map(ok.filter((g) => g.anbieter === a).map((g) => [g.id, g]));
    if (alt && m.size) neu[`status:${a}`] = (alt.daten as Geraet[]).map((g) => m.get(g.id) ?? g);
  }
  await merke(ctx.db, neu).catch((e) => console.error("Smart-Cache", (e as Error).message));
  if (!ok.length) throw new Fehler(ids.length > 1 ? fehler.join(" · ") : (fehler[0]?.replace(/^[^:]+: /, "") ?? "Hat nicht geklappt."));
  return { geraete: ok.map(fuerApp), fehler };
}

async function aktionSzenen(ctx: Ctx, id: string) {
  const z = await zustand(ctx, "nein");
  const g = z.geraete.find((x) => x.id === id);
  if (!g || g.anbieter !== "govee" || !g.kann.szenen || !z.cfg.govee) throw new Fehler("Für dieses Gerät gibt es keine Szenen.");
  const neu: Neu = {};
  const l = await goveeSzenen(z.cfg.govee, z.cache, neu, g);
  await merke(ctx.db, neu).catch(() => {});
  return { szenen: l.map((x) => x.name) };
}

const SHELLY_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.shelly\.cloud$/;
async function aktionEinrichten(ctx: Ctx, data: Roh) {
  const a = String(data.anbieter ?? "");
  const s = ctx.s;
  const alt: Neu = { [`status:${a}`]: null, [`liste:${a}`]: null };
  if (!ANBIETER.includes(a as Anbieter)) throw new Fehler("Unbekannter Anbieter.");
  if (data.trennen === true) {
    const leer: Record<string, string> = a === "govee" ? { smart_govee_key: "" }
      : a === "shelly" ? { smart_shelly_key: "", smart_shelly_host: "", smart_shelly_ids: "" }
      : { smart_tuya_id: "", smart_tuya_secret: "", smart_tuya_region: "" };
    await einstellen(ctx.db, leer);
    await merke(ctx.db, a === "tuya" ? { ...alt, "token:tuya": null } : alt);
    return { ok: true };
  }
  const text = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

  if (a === "govee") {
    const key = text(data.key);
    if (!/^[A-Za-z0-9-]{16,80}$/.test(key)) throw new Fehler("Der API-Schlüssel sieht nicht richtig aus (z. B. 1a2b3c4d-…).");
    const j = await goveeApi(key, "/user/devices");
    const n = (Array.isArray(j.data) ? j.data : []).length;
    await einstellen(ctx.db, { smart_govee_key: key });
    await merke(ctx.db, alt);
    return { ok: true, anzahl: n };
  }

  if (a === "shelly") {
    const host = text(data.host).toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
    if (!SHELLY_HOST.test(host)) throw new Fehler("Der Server sieht nicht richtig aus (z. B. shelly-103-eu.shelly.cloud).");
    const key = text(data.key, 400) || s.smart_shelly_key || "";
    if (!key) throw new Fehler("Bitte den Cloud-Schlüssel (Authorization cloud key) eintragen.");
    const ids = [...new Set(String(data.ids ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
    if (!ids.length) throw new Fehler("Bitte mindestens eine Geräte-ID eintragen.");
    if (ids.length > 20) throw new Fehler("Höchstens 20 Shelly-Geräte.");
    const falsch = ids.find((x) => !/^[A-Za-z0-9_-]{4,40}$/.test(x));
    if (falsch) throw new Fehler(`„${falsch.slice(0, 40)}“ ist keine Geräte-ID.`);
    const cfg = { key, host, ids };
    const g = await shellyStatus(cfg);
    const gefunden = new Set(g.map((x) => x.ref.id));
    await einstellen(ctx.db, { smart_shelly_key: key, smart_shelly_host: host, smart_shelly_ids: ids.join(",") });
    await merke(ctx.db, { "status:shelly": g });
    return { ok: true, anzahl: g.length, unbekannt: ids.filter((x) => !gefunden.has(x)) };
  }

  // Smart Life / Tuya
  const id = text(data.id, 80);
  const secret = text(data.secret, 120) || (id === s.smart_tuya_id ? s.smart_tuya_secret : "") || "";
  const region = TUYA_HOSTS[String(data.region)] ? String(data.region) : "eu";
  if (!/^[A-Za-z0-9]{10,64}$/.test(id)) throw new Fehler("Die Access ID sieht nicht richtig aus.");
  if (!/^[A-Za-z0-9]{16,80}$/.test(secret)) throw new Fehler("Bitte das Access Secret eintragen.");
  const cfg = { id, secret, region };
  const c: Cache = {};
  const neu: Neu = {};
  await tuyaToken(cfg, c, neu, true);
  const n = (await tuyaListe(cfg, c, neu)).length;
  await einstellen(ctx.db, { smart_tuya_id: id, smart_tuya_secret: secret, smart_tuya_region: region });
  await merke(ctx.db, { ...alt, ...neu });
  return { ok: true, anzahl: n };
}

async function aktionGeraet(ctx: Ctx, data: Roh) {
  const id = String(data.id ?? "").slice(0, 200);
  if (!/^(govee|shelly|tuya)~/.test(id)) throw new Fehler("Unbekanntes Gerät.");
  const e = einst(ctx.s);
  const x: Roh = { ...(e[id] ?? {}) };
  if ("name" in data) x.name = String(data.name ?? "").trim().slice(0, 40) || undefined;
  if ("raum" in data) x.raum = String(data.raum ?? "").trim().slice(0, 30) || undefined;
  if ("start" in data) x.start = typeof data.start === "boolean" ? data.start : undefined;
  if ("aus" in data) x.aus = data.aus === true || undefined;
  const sauber = JSON.parse(JSON.stringify(x));
  if (Object.keys(sauber).length) e[id] = sauber;
  else delete e[id];
  if (Object.keys(e).length > 300) throw new Fehler("Zu viele Geräte-Einstellungen.");
  await einstellen(ctx.db, { smart_geraete: JSON.stringify(e) });
  return { einst: e };
}

/** Einstieg aus index.ts (Rolle ist dort schon geprüft). */
export async function smartAktion(data: Roh, ctx: Ctx): Promise<unknown> {
  switch (String(data?.aktion)) {
    case "smart-status": return await aktionStatus(ctx, data.frisch === true);
    case "smart-set": return await aktionSetzen(ctx, data);
    case "smart-szenen": return await aktionSzenen(ctx, String(data.id ?? ""));
    case "smart-einrichten": return await aktionEinrichten(ctx, data);
    case "smart-geraet": return await aktionGeraet(ctx, data);
    default: throw new Fehler("Unbekannte Aktion.");
  }
}

// Für Tests
export const _intern = { goveeBasis, goveeZustand, shellyGeraete, tuyaGeraete, tuyaRoh, pruefeBefehl };
