// Giffig Admin: geschützte Schnittstelle zum Hochladen und Verwalten von Memes.
// Läuft als Supabase Edge Function. Alle Schreibzugriffe laufen hier mit dem Service-Schlüssel,
// der niemals im Browser landet. Zugang nur mit Passwort (als PBKDF2-Hash gespeichert).
// Rollen: "owner" (Admin, darf alles) und "uploader" (eingeladene Person, darf eigene Bilder hochladen und verwalten).
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
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_BATCH = 40;
const TYPES: Record<string, string> = { "image/webp": "webp", "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg" };
const FILE_RE = /^up-[a-z0-9]{8}\.(webp|gif|png|jpg)$/;
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_RE = /^[A-Za-zÄÖÜäöüß0-9 _.-]{2,24}$/;
const ORIGIN_OK = /^(https:\/\/marlonm05\.github\.io|http:\/\/localhost:\d+|http:\/\/127\.0\.0\.1:\d+)$/;
const SELECT_MEME = "id,file,name,tags,hidden,created_at,uploaded_by,uploaded_by_name";
const enc = new TextEncoder();

// ---------- kleine Helfer ----------
const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (u: Uint8Array) => toB64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const pickChars = (n: number, alphabet: string) => Array.from(rand(n), (b) => alphabet[b % alphabet.length]).join("");
const rid = (n: number) => pickChars(n, "abcdefghijklmnopqrstuvwxyz0123456789");
const DUMMY_SALT = toB64(new Uint8Array(16));
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
// Token: "<Ablauf>.<Benutzer-Id oder owner>.<Signatur>"
async function makeToken(keyB64: string, uid: string) {
  const exp = Date.now() + TOKEN_TTL_MS;
  return { token: `${exp}.${uid}.${toB64Url(await hmac(keyB64, `${exp}.${uid}`))}`, exp };
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
const normCode = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

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
type Who = { id: string; name: string; role: "owner" | "uploader"; approval: boolean };

async function getConfig() {
  const { data } = await db.from("admin_config").select("*").eq("id", 1).maybeSingle();
  return data as { salt: string; hash: string; iterations: number; token_key: string } | null;
}
// Wer ruft an? Prüft Signatur, Ablauf und ob die Person noch freigeschaltet ist.
async function whoIs(body: Json): Promise<Who> {
  const cfg = await getConfig();
  if (!cfg) throw new HttpError(409, "not_configured");
  const [e, uid, sig] = String(body.token ?? "").split(".");
  const exp = Number(e);
  if (!exp || exp < Date.now() || !uid || !sig) throw new HttpError(401, "auth");
  if (!safeEq(toB64Url(await hmac(cfg.token_key, `${e}.${uid}`)), sig)) throw new HttpError(401, "auth");
  if (uid === "owner") return { id: "owner", name: "Admin", role: "owner", approval: false };
  if (!UUID_RE.test(uid)) throw new HttpError(401, "auth");
  const { data: u } = await db.from("admin_users").select("id,name,role,approval_required,disabled").eq("id", uid).maybeSingle();
  if (!u || u.disabled) throw new HttpError(401, "auth");
  return { id: u.id, name: u.name, role: u.role, approval: u.approval_required };
}
const owner = async (body: Json) => {
  const w = await whoIs(body);
  if (w.role !== "owner") throw new HttpError(403, "forbidden");
  return w;
};
const uploaderId = (w: Who) => (w.id === "owner" ? null : w.id);
const sessionInfo = (w: Who) => ({ role: w.role, name: w.name, approval: w.approval });

// ---------- Anmeldung ----------
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
  return { ...(await makeToken(tokenKey, "owner")), role: "owner", name: "Admin" };
}

async function actLogin(body: Json, ip: string) {
  if (await lockedOut(ip)) throw new HttpError(429, "locked");
  const cfg = await getConfig();
  if (!cfg) throw new HttpError(409, "not_configured");
  const name = String(body.name ?? "").trim().slice(0, 40);
  const password = String(body.password ?? "").slice(0, 200);
  const asOwner = !name || /^(admin|owner)$/i.test(name);
  let uid = "owner", rec = { salt: cfg.salt, hash: cfg.hash, iterations: cfg.iterations }, role = "owner", shown = "Admin", usable = true;
  if (!asOwner) {
    const { data: u } = await db.from("admin_users").select("id,name,role,salt,hash,iterations,disabled").ilike("name", name.replace(/[\\%_]/g, "\\$&")).maybeSingle();
    if (u) { uid = u.id; rec = u; role = u.role; shown = u.name; usable = !u.disabled; }
    else { usable = false; rec = { salt: DUMMY_SALT, hash: "", iterations: ITERATIONS }; }  // gleiche Rechenzeit, damit man keine Namen erraten kann
  }
  const given = await derive(password, rec.salt, rec.iterations);
  if (!usable || !safeEq(given, rec.hash)) {
    await noteFailure(ip, "login");
    throw new HttpError(401, "bad_password");
  }
  if (uid !== "owner") await db.from("admin_users").update({ last_login: new Date().toISOString() }).eq("id", uid);
  return { ...(await makeToken(cfg.token_key, uid)), role, name: shown };
}

// Einladung einlösen: neue Person legt ihr Passwort fest (oder setzt es zurück).
async function actJoin(body: Json, ip: string) {
  if (await lockedOut(ip)) throw new HttpError(429, "locked");
  const password = String(body.password ?? "");
  if (password.length < 12 || password.length > 200) throw new HttpError(400, "password_length");
  const codeHash = await sha256hex(normCode(body.code));
  const { data: inv } = await db.from("admin_invites").select("*").eq("code_hash", codeHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!inv) {
    await noteFailure(ip, "join");
    throw new HttpError(403, "bad_code");
  }
  const cfg = await getConfig();
  if (!cfg) throw new HttpError(409, "not_configured");
  const salt = toB64(rand(16)), hash = await derive(password, salt, ITERATIONS);
  let uid = String(inv.user_id ?? "");
  if (uid) {
    const { error } = await db.from("admin_users").update({ salt, hash, iterations: ITERATIONS }).eq("id", uid);
    if (error) throw error;
  } else {
    const { data: ex } = await db.from("admin_users").select("id").ilike("name", String(inv.name).replace(/[\\%_]/g, "\\$&")).maybeSingle();
    if (ex) throw new HttpError(409, "name_taken");
    const { data, error } = await db.from("admin_users").insert({ name: inv.name, role: "uploader", salt, hash, iterations: ITERATIONS, approval_required: inv.approval_required }).select("id").single();
    if (error || !data) throw error ?? new Error("insert");
    uid = data.id;
  }
  await db.from("admin_invites").delete().eq("id", inv.id);
  const { data: u } = await db.from("admin_users").select("name,role").eq("id", uid).single();
  return { ...(await makeToken(cfg.token_key, uid)), role: u?.role ?? "uploader", name: u?.name ?? inv.name };
}

// ---------- Bilder ----------
async function actList(body: Json) {
  const who = await whoIs(body);
  let q = db.from("memes").select(SELECT_MEME).order("created_at", { ascending: false }).limit(2000);
  if (who.role !== "owner") q = q.eq("uploaded_by", who.id);
  const { data, error } = await q;
  if (error) throw error;
  let removed: string[] = [];
  const reviews: Record<string, string> = {};
  if (who.role === "owner") {
    const r = await db.from("catalog_hidden").select("id");
    removed = (r.data ?? []).map((x: { id: string }) => x.id);
    const rv = await db.from("admin_reviews").select("item,decision").eq("reviewer", who.id).limit(5000);
    for (const x of rv.data ?? []) reviews[x.item] = x.decision;
  }
  return { me: sessionInfo(who), memes: data, removed, reviews };
}

async function actPrepare(body: Json) {
  await whoIs(body);
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
  const who = await whoIs(body);
  const items = Array.isArray(body.items) ? (body.items.slice(0, MAX_BATCH) as Json[]) : [];
  const added: Json[] = [], failed: Json[] = [];
  const hidden = who.role === "uploader" && who.approval;  // Freigabe nötig: erst ausgeblendet
  for (const it of items) {
    const file = String(it?.file ?? ""), name = cleanName(it?.name), tags = cleanTags(it?.tags);
    if (!FILE_RE.test(file) || !name) { failed.push({ file, error: "invalid" }); continue; }
    const { data: ex } = await db.storage.from(BUCKET).exists(file);
    if (!ex) { failed.push({ file, error: "missing" }); continue; }
    const { data, error } = await db.from("memes").insert({ file, name, tags, hidden, uploaded_by: uploaderId(who), uploaded_by_name: who.name }).select(SELECT_MEME).single();
    if (error || !data) failed.push({ file, error: "db" }); else added.push(data);
  }
  return { added, failed };
}

async function ownMeme(who: Who, id: string) {
  const { data } = await db.from("memes").select("id,file,uploaded_by").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "not_found");
  if (who.role !== "owner" && data.uploaded_by !== who.id) throw new HttpError(403, "forbidden");
  return data as { id: string; file: string; uploaded_by: string | null };
}

async function actUpdate(body: Json) {
  const who = await whoIs(body);
  const id = String(body.id ?? "");
  await ownMeme(who, id);
  const patch: Json = {};
  if (body.name !== undefined) { const n = cleanName(body.name); if (!n) throw new HttpError(400, "name"); patch.name = n; }
  if (body.tags !== undefined) patch.tags = cleanTags(body.tags);
  if (body.hidden !== undefined) { if (who.role !== "owner") throw new HttpError(403, "forbidden"); patch.hidden = body.hidden === true; }
  if (!Object.keys(patch).length) throw new HttpError(400, "empty");
  const { data, error } = await db.from("memes").update(patch).eq("id", id).select(SELECT_MEME).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "not_found");
  return { meme: data };
}

async function actDelete(body: Json) {
  const who = await whoIs(body);
  const id = String(body.id ?? "");
  const m = await ownMeme(who, id);
  await db.storage.from(BUCKET).remove([m.file]);
  const { error } = await db.from("memes").delete().eq("id", id);
  if (error) throw error;
  return { ok: true };
}

// Eingebaute Bilder aus dem Spiel nehmen oder wieder aufnehmen (nur Admin).
async function actBuiltinSet(body: Json) {
  await owner(body);
  const id = String(body.id ?? "");
  if (!ID_RE.test(id) || id.startsWith("up-")) throw new HttpError(400, "id");
  if (body.removed === true) {
    const { error } = await db.from("catalog_hidden").upsert({ id });
    if (error) throw error;
  } else {
    const { error } = await db.from("catalog_hidden").delete().eq("id", id);
    if (error) throw error;
  }
  return { ok: true };
}

// Tinder-Ansicht: behalten oder entfernen, und merken, was schon geprüft wurde (nur Admin).
// decision: "keep" (bleibt im Spiel, ein ausgeblendeter Upload wird freigegeben), "remove" (aus dem Spiel nehmen)
// oder null (Entscheidung zurücknehmen).
async function actReview(body: Json) {
  const who = await owner(body);
  const item = String(body.item ?? "");
  const decision = body.decision === "keep" || body.decision === "remove" ? (body.decision as string) : null;
  const isUpload = FILE_RE.test(item);
  if (!isUpload && (!ID_RE.test(item) || item.startsWith("up-"))) throw new HttpError(400, "id");
  const { data: prevRow } = await db.from("admin_reviews").select("decision").eq("reviewer", who.id).eq("item", item).maybeSingle();
  const prev = prevRow?.decision ?? null;
  if (isUpload) {
    const { data: m } = await db.from("memes").select("id,hidden").eq("file", item).maybeSingle();
    if (!m) throw new HttpError(404, "not_found");
    if (decision === "remove" && !m.hidden) await db.from("memes").update({ hidden: true }).eq("id", m.id);
    else if (decision === "keep" && m.hidden) await db.from("memes").update({ hidden: false }).eq("id", m.id);
    else if (decision === null && prev === "remove" && m.hidden) await db.from("memes").update({ hidden: false }).eq("id", m.id);
  } else if (decision === "remove") {
    const { error } = await db.from("catalog_hidden").upsert({ id: item });
    if (error) throw error;
  } else if (decision === "keep" || (decision === null && prev === "remove")) {
    await db.from("catalog_hidden").delete().eq("id", item);
  }
  if (decision === null) await db.from("admin_reviews").delete().eq("reviewer", who.id).eq("item", item);
  else {
    const { error } = await db.from("admin_reviews").upsert({ reviewer: who.id, item, decision, decided_at: new Date().toISOString() }, { onConflict: "reviewer,item" });
    if (error) throw error;
  }
  return { ok: true };
}

async function actReviewReset(body: Json) {
  const who = await owner(body);
  await db.from("admin_reviews").delete().eq("reviewer", who.id);
  return { ok: true };
}

// ---------- Personen (nur Admin) ----------
async function actUsers(body: Json) {
  await owner(body);
  const [us, iv, ms] = await Promise.all([
    db.from("admin_users").select("id,name,role,approval_required,disabled,created_at,last_login").order("created_at"),
    db.from("admin_invites").select("id,name,approval_required,user_id,expires_at").gt("expires_at", new Date().toISOString()).order("created_at"),
    db.from("memes").select("uploaded_by,hidden,created_at").limit(5000),
  ]);
  const stats = new Map<string, { uploads: number; pending: number; last: string }>();
  for (const m of ms.data ?? []) {
    if (!m.uploaded_by) continue;
    const s = stats.get(m.uploaded_by) ?? { uploads: 0, pending: 0, last: "" };
    s.uploads++; if (m.hidden) s.pending++; if (m.created_at > s.last) s.last = m.created_at;
    stats.set(m.uploaded_by, s);
  }
  const users = (us.data ?? []).filter((u: { role: string }) => u.role === "uploader").map((u: { id: string }) => ({ ...u, ...(stats.get(u.id) ?? { uploads: 0, pending: 0, last: "" }) }));
  return { users, invites: iv.data ?? [] };
}

async function makeInvite(name: string, approval: boolean, userId: string | null) {
  const code = pickChars(12, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  const expires = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const { error } = await db.from("admin_invites").insert({ code_hash: await sha256hex(code), name, approval_required: approval, user_id: userId, expires_at: expires });
  if (error) throw error;
  return { code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, name, expires };
}

async function actInvite(body: Json) {
  await owner(body);
  const name = String(body.name ?? "").trim();
  if (!NAME_RE.test(name) || /^(admin|owner)$/i.test(name)) throw new HttpError(400, "name");
  const like = name.replace(/[\\%_]/g, "\\$&");
  const [a, b] = await Promise.all([
    db.from("admin_users").select("id").ilike("name", like).maybeSingle(),
    db.from("admin_invites").select("id").ilike("name", like).gt("expires_at", new Date().toISOString()).maybeSingle(),
  ]);
  if (a.data || b.data) throw new HttpError(409, "name_taken");
  return await makeInvite(name, body.approval === true, null);
}

async function actReinvite(body: Json) {
  await owner(body);
  const id = String(body.id ?? "");
  const { data: u } = await db.from("admin_users").select("id,name,approval_required").eq("id", id).maybeSingle();
  if (!u) throw new HttpError(404, "not_found");
  return await makeInvite(u.name, u.approval_required, u.id);
}

async function actInviteDelete(body: Json) {
  await owner(body);
  await db.from("admin_invites").delete().eq("id", String(body.id ?? ""));
  return { ok: true };
}

async function actUserUpdate(body: Json) {
  await owner(body);
  const id = String(body.id ?? ""), patch: Json = {};
  if (body.disabled !== undefined) patch.disabled = body.disabled === true;
  if (body.approval !== undefined) patch.approval_required = body.approval === true;
  if (!Object.keys(patch).length) throw new HttpError(400, "empty");
  const { data, error } = await db.from("admin_users").update(patch).eq("id", id).eq("role", "uploader").select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "not_found");
  return { ok: true };
}

async function actUserDelete(body: Json) {
  await owner(body);
  const id = String(body.id ?? "");
  const { data: u } = await db.from("admin_users").select("id").eq("id", id).eq("role", "uploader").maybeSingle();
  if (!u) throw new HttpError(404, "not_found");
  if (body.deleteUploads === true) {
    const { data: ms } = await db.from("memes").select("id,file").eq("uploaded_by", id);
    if (ms?.length) {
      await db.storage.from(BUCKET).remove(ms.map((m: { file: string }) => m.file));
      await db.from("memes").delete().eq("uploaded_by", id);
    }
  }
  const { error } = await db.from("admin_users").delete().eq("id", id);
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
      case "join": return reply(200, await actJoin(body, ip));
      case "list": return reply(200, await actList(body));
      case "prepare": return reply(200, await actPrepare(body));
      case "add": return reply(200, await actAdd(body));
      case "update": return reply(200, await actUpdate(body));
      case "delete": return reply(200, await actDelete(body));
      case "builtin_set": return reply(200, await actBuiltinSet(body));
      case "review": return reply(200, await actReview(body));
      case "review_reset": return reply(200, await actReviewReset(body));
      case "users": return reply(200, await actUsers(body));
      case "invite": return reply(200, await actInvite(body));
      case "reinvite": return reply(200, await actReinvite(body));
      case "invite_delete": return reply(200, await actInviteDelete(body));
      case "user_update": return reply(200, await actUserUpdate(body));
      case "user_delete": return reply(200, await actUserDelete(body));
      default: throw new HttpError(400, "action");
    }
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { error: e.code, ...e.extra });
    console.error("giffig-admin", e);
    return reply(500, { error: "server" });
  }
});
