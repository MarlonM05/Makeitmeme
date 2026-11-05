// Giffig Admin: geschützte Schnittstelle zum Hochladen und Verwalten von Memes.
// Läuft als Supabase Edge Function. Alle Schreibzugriffe laufen hier mit dem Service-Schlüssel,
// der niemals im Browser landet. Zugang nur mit Admin-Passwort (als PBKDF2-Hash gespeichert).
import { createClient } from "npm:@supabase/supabase-js@2";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return keys.default ?? (Object.values(keys)[0] as string) ?? "";
  } catch {
    return "";
  }
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = "memes";
const ITERATIONS = 300000;
const TOKEN_TTL_MS = 8 * 3600 * 1000;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_BATCH = 40;
const TYPES: Record<string, string> = { "image/webp": "webp", "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg" };
const FILE_RE = /^up-[a-z0-9]{8}\.(webp|gif|png|jpg)$/;
const ORIGIN_OK = /^(https:\/\/marlonm05\.github\.io|http:\/\/localhost:\d+|http:\/\/127\.0\.0\.1:\d+)$/;
const enc = new TextEncoder();

// ---------- kleine Helfer ----------
const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (u: Uint8Array) => toB64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const rid = (n: number) => Array.from(rand(n), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
async function sha256hex(s: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function derive(pw: string, saltB64: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations }, key, 256);
  return toB64(new Uint8Array(bits));
}
async function hmac(keyB64: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", fromB64(keyB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function makeToken(keyB64: string) {
  const exp = Date.now() + TOKEN_TTL_MS;
  return { token: `${exp}.${toB64Url(await hmac(keyB64, String(exp)))}`, exp };
}
async function tokenOk(token: unknown, keyB64: string) {
  const [e, s] = String(token ?? "").split(".");
  const exp = Number(e);
  if (!exp || exp < Date.now() || !s) return false;
  return safeEq(toB64Url(await hmac(keyB64, String(exp))), s);
}
function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(o) ? o : "https://marlonm05.github.io",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const clientIp = (req: Request) =>
  req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? (req.headers.get("x-forwarded-for") ?? "").split(",").pop()?.trim() ?? "unknown";

// ---------- Schutz gegen Raten ----------
async function lockedOut(ip: string) {
  const [a, b] = await Promise.all([
    db.from("admin_attempts").select("id", { count: "exact", head: true }).eq("ip", ip).gte("at", new Date(Date.now() - 15 * 60 * 1000).toISOString()),
    db.from("admin_attempts").select("id", { count: "exact", head: true }).gte("at", new Date(Date.now() - 3600 * 1000).toISOString()),
  ]);
  // Pro Adresse 8 Fehlversuche in 15 Minuten, insgesamt 60 pro Stunde (gegen wechselnde Adressen).
  return (a.count ?? 0) >= 8 || (b.count ?? 0) >= 60;
}
async function noteFailure(ip: string, kind: string) {
  await db.from("admin_attempts").insert({ ip, kind });
  if (Math.random() < 0.05) await db.from("admin_attempts").delete().lt("at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
}

// ---------- Eingaben prüfen ----------
const cleanName = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40);
const cleanTags = (v: unknown) => Array.from(new Set(String(v ?? "").split("").filter((c) => "dxv".includes(c)))).sort().join("");

type Json = Record<string, unknown>;
class HttpError extends Error { constructor(public status: number, public code: string, public extra: Json = {}) { super(code); } }

async function getConfig() {
  const { data } = await db.from("admin_config").select("*").eq("id", 1).maybeSingle();
  return data as { salt: string; hash: string; iterations: number; token_key: string } | null;
}
async function requireAdmin(body: Json) {
  const cfg = await getConfig();
  if (!cfg) throw new HttpError(409, "not_configured");
  if (!(await tokenOk(body.token, cfg.token_key))) throw new HttpError(401, "auth");
  return cfg;
}

// ---------- Aktionen ----------
async function actStatus() {
  return { configured: !!(await getConfig()) };
}

async function actSetup(body: Json, ip: string) {
  if (await lockedOut(ip)) throw new HttpError(429, "locked");
  const password = String(body.password ?? "");
  if (password.length < 12 || password.length > 200) throw new HttpError(400, "password_length");
  const hash = await sha256hex(String(body.code ?? "").trim());
  const { data } = await db.from("admin_setup_tokens").select("token_hash").eq("token_hash", hash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!data) {
    await noteFailure(ip, "setup");
    throw new HttpError(403, "bad_code");
  }
  const salt = toB64(rand(16)), tokenKey = toB64(rand(32));
  const { error } = await db.from("admin_config").upsert({
    id: 1, salt, hash: await derive(password, salt, ITERATIONS), iterations: ITERATIONS, token_key: tokenKey, updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  await db.from("admin_setup_tokens").delete().neq("token_hash", "");
  return await makeToken(tokenKey);
}

async function actLogin(body: Json, ip: string) {
  if (await lockedOut(ip)) throw new HttpError(429, "locked");
  const cfg = await getConfig();
  if (!cfg) throw new HttpError(409, "not_configured");
  const given = await derive(String(body.password ?? "").slice(0, 200), cfg.salt, cfg.iterations);
  if (!safeEq(given, cfg.hash)) {
    await noteFailure(ip, "login");
    throw new HttpError(401, "bad_password");
  }
  return await makeToken(cfg.token_key);
}

async function actList(body: Json) {
  await requireAdmin(body);
  const { data, error } = await db.from("memes").select("id,file,name,tags,hidden,created_at").order("created_at", { ascending: false }).limit(2000);
  if (error) throw error;
  return { memes: data };
}

async function actPrepare(body: Json) {
  await requireAdmin(body);
  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_BATCH) : [];
  const out: Json[] = [];
  for (const f of files as Json[]) {
    const ext = TYPES[String(f?.type)];
    const size = Number(f?.size);
    if (!ext || !Number.isFinite(size) || size < 1 || size > MAX_BYTES) { out.push({ error: !ext ? "type" : "size" }); continue; }
    const path = `up-${rid(8)}.${ext}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) { out.push({ error: "sign" }); continue; }
    out.push({ path, token: data.token });
  }
  return { files: out };
}

async function actAdd(body: Json) {
  await requireAdmin(body);
  const items = Array.isArray(body.items) ? (body.items.slice(0, MAX_BATCH) as Json[]) : [];
  const added: Json[] = [], failed: Json[] = [];
  for (const it of items) {
    const file = String(it?.file ?? ""), name = cleanName(it?.name), tags = cleanTags(it?.tags);
    if (!FILE_RE.test(file) || !name) { failed.push({ file, error: "invalid" }); continue; }
    const { data: ex } = await db.storage.from(BUCKET).exists(file);
    if (!ex) { failed.push({ file, error: "missing" }); continue; }
    const { data, error } = await db.from("memes").insert({ file, name, tags }).select("id,file,name,tags,hidden,created_at").single();
    if (error || !data) failed.push({ file, error: "db" }); else added.push(data);
  }
  return { added, failed };
}

async function actUpdate(body: Json) {
  await requireAdmin(body);
  const id = String(body.id ?? "");
  const patch: Json = {};
  if (body.name !== undefined) { const n = cleanName(body.name); if (!n) throw new HttpError(400, "name"); patch.name = n; }
  if (body.tags !== undefined) patch.tags = cleanTags(body.tags);
  if (body.hidden !== undefined) patch.hidden = body.hidden === true;
  if (!Object.keys(patch).length) throw new HttpError(400, "empty");
  const { data, error } = await db.from("memes").update(patch).eq("id", id).select("id,file,name,tags,hidden,created_at").maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "not_found");
  return { meme: data };
}

async function actDelete(body: Json) {
  await requireAdmin(body);
  const id = String(body.id ?? "");
  const { data } = await db.from("memes").select("file").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "not_found");
  await db.storage.from(BUCKET).remove([data.file]);
  const { error } = await db.from("memes").delete().eq("id", id);
  if (error) throw error;
  return { ok: true };
}

// ---------- Server ----------
Deno.serve(async (req: Request) => {
  const headers = { ...cors(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  const reply = (status: number, data: Json) => new Response(JSON.stringify(data), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "method" });
  try {
    const text = await req.text();
    if (text.length > 200_000) throw new HttpError(413, "too_large");
    let body: Json;
    try { body = JSON.parse(text || "{}"); } catch { throw new HttpError(400, "json"); }
    const ip = clientIp(req);
    switch (body.action) {
      case "status": return reply(200, await actStatus());
      case "setup": return reply(200, await actSetup(body, ip));
      case "login": return reply(200, await actLogin(body, ip));
      case "list": return reply(200, await actList(body));
      case "prepare": return reply(200, await actPrepare(body));
      case "add": return reply(200, await actAdd(body));
      case "update": return reply(200, await actUpdate(body));
      case "delete": return reply(200, await actDelete(body));
      default: throw new HttpError(400, "action");
    }
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { error: e.code, ...e.extra });
    console.error("giffig-admin", e);
    return reply(500, { error: "server" });
  }
});
