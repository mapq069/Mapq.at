// mapq-push – schickt Web-Push-Benachrichtigungen an die mapq-Admin-App.
//
// Aufrufe:
//  • vom Datenbank-Trigger bei neuer Anfrage: Header "x-mapq-secret" (aus mapq_einstellungen.push_secret)
//  • vom Panel als Test: Header "Authorization: Bearer <Login-Token>" + "apikey" – nur für den Admin
//
// Nur Standard-WebCrypto: VAPID (RFC 8292) und aes128gcm-Verschlüsselung (RFC 8291 / RFC 8188).
// In Supabase mit ausgeschalteter „JWT-Verifizierung“ bereitstellen – die Prüfung passiert hier.

const te = new TextEncoder();

export const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str: string): Uint8Array {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** Verschlüsselt eine Nachricht für ein Push-Abo (RFC 8291, Content-Encoding aes128gcm). */
export async function encryptPayload(
  payload: Uint8Array,
  p256dh: string,
  auth: string,
  fixed?: { salt: Uint8Array; serverKeys: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const server = fixed?.serverKeys ??
    await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, server.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const recordSize = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** Authorization-Header für VAPID (RFC 8292). */
export async function vapidHeader(endpoint: string, subject: string, publicKey: string, privateKey: string): Promise<string> {
  const pub = b64u.dec(publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), d: privateKey, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${publicKey}`;
}

type Abo = { id: string; endpoint: string; p256dh: string; auth: string };
type Nachricht = { title: string; body: string; url: string; tag: string };

/** Schickt eine Nachricht an ein Abo. Gibt den HTTP-Status des Push-Dienstes zurück. */
export async function sendPush(abo: Abo, msg: Nachricht, vapid: { subject: string; publicKey: string; privateKey: string }): Promise<number> {
  const body = await encryptPayload(te.encode(JSON.stringify(msg)), abo.p256dh, abo.auth);
  const res = await fetch(abo.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
      Authorization: await vapidHeader(abo.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey),
    },
    body,
  });
  await res.body?.cancel();
  return res.status;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-mapq-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  const base = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = { apikey: service, "Content-Type": "application/json" };
    if (service.startsWith("eyJ")) headers.Authorization = `Bearer ${service}`;
    const r = await fetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };

  try {
    const rows: { schluessel: string; wert: string }[] = await db("mapq_einstellungen?select=schluessel,wert");
    const s = Object.fromEntries(rows.map((r) => [r.schluessel, r.wert]));
    const data = await req.json().catch(() => ({}));
    let msg: Nachricht;

    const secret = req.headers.get("x-mapq-secret");
    if (secret && s.push_secret && secret === s.push_secret) {
      const vorname = String(data.name ?? "").trim().split(/\s+/)[0];
      msg = {
        title: "Neue Anfrage",
        body: [vorname, data.art].filter(Boolean).join(" · ") || "Jemand hat das Formular auf mapq.at ausgefüllt.",
        url: "/admin.html#inquiries",
        tag: `anfrage-${data.id ?? Date.now()}`,
      };
    } else {
      // Test aus dem Panel – nur wenn der Login-Token zum Admin gehört
      const auth = req.headers.get("authorization") ?? "";
      const apikey = req.headers.get("apikey") ?? "";
      const r = await fetch(`${base}/rest/v1/rpc/mapq_ist_admin`, {
        method: "POST",
        headers: { apikey, Authorization: auth, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok || (await r.json()) !== true) return json({ error: "Kein Zugriff" }, 401);
      msg = { title: "mapq.at Admin", body: "Test: Benachrichtigungen funktionieren.", url: "/admin.html", tag: "test" };
    }

    const vapid = { subject: s.vapid_subject, publicKey: s.vapid_public, privateKey: s.vapid_private };
    const abos: Abo[] = await db("push_abos?select=id,endpoint,p256dh,auth");
    let sent = 0, removed = 0, failed = 0;
    await Promise.all(abos.map(async (abo) => {
      try {
        const status = await sendPush(abo, msg, vapid);
        if (status >= 200 && status < 300) sent++;
        else if (status === 404 || status === 410) { await db(`push_abos?id=eq.${abo.id}`, { method: "DELETE" }); removed++; }
        else { failed++; console.error("Push abgelehnt", status, new URL(abo.endpoint).host); }
      } catch (e) { failed++; console.error("Push-Fehler", (e as Error).message); }
    }));
    return json({ sent, removed, failed, devices: abos.length });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
}

Deno.serve(handler);
