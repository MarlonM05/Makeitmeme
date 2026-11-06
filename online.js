// Giffig online: stellt dieselbe Schnittstelle wie die claude.ai-Fähigkeiten bereit
// (room, db), aber ohne Claude. Der Spielraum läuft über Supabase Realtime (WebSocket über
// Port 443, funktioniert in praktisch jedem Netz). Die Ruhmeshalle liegt lokal auf dem Gerät.
// Der Schlüssel unten ist ein öffentlicher Browser-Schlüssel und darf im Code stehen.
(function () {
  "use strict";
  const SUPABASE_URL = "https://wpqrfrrhufnvdxcdqrcv.supabase.co";
  const SUPABASE_KEY = "sb_publishable_lvsuefwTpYIo55gci4xPlA_1miuYt9J";
  const JOIN_MS = 12000;        // so lange warten wir auf den Server
  const KEEPALIVE_MS = 8000;    // eigenen Zustand regelmäßig erneut senden
  const STALE_MS = 30000;       // Spieler ohne Lebenszeichen gelten als weg
  const SEND_GAP_MS = 120;      // Updates bündeln (Limit im Gratis-Tarif: 100 Nachrichten/s)
  const MSG_NO_SERVER = "Der Spielserver ist nicht erreichbar. Prüf deine Internetverbindung, schalte VPN oder Werbeblocker aus oder probier ein anderes Netz.";
  const MSG_NOT_FOUND = "Kein Spiel mit diesem Code gefunden. Prüf den Code und ob der Host die Seite noch offen hat.";
  const MAX_PRESENCE = 48000;  // Broadcast verträgt viel mehr als die 4 KB im Claude-Fenster; 16 Spieler brauchen mehr Platz
  const bytes = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
  const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
  const rid = (n) => Array.from({ length: n }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("");

  // Hochgeladene Memes liegen im öffentlichen Speicher; das Spiel baut daraus die Bildadressen.
  window.GIFFIG_STORAGE_BASE = SUPABASE_URL + "/storage/v1/object/public/memes/";

  let client = null;
  function sb() {
    if (client) return client;
    if (!window.supabase || typeof window.supabase.createClient !== "function") return null;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return client;
  }

  function makeRoom(name, create) {
    return new Promise((resolve, reject) => {
      const c = sb();
      if (!c) { reject({ message: "Die Verbindungsbibliothek konnte nicht geladen werden. Prüf deine Internetverbindung." }); return; }
      const label = rid(10);
      const ch = c.channel(name, { config: { broadcast: { self: false, ack: false }, presence: { key: label } } });
      const peers = new Map();
      let handlers = [], errHandlers = [], myPres = {};
      let settled = false, closed = false, cache = Object.freeze([]), queued = false, sendTimer = 0, downSince = 0;
      let keepTimer = 0, pruneTimer = 0, watchTimer = 0, joinTimer = 0, tracked = false;

      const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(joinTimer); fn(arg); };
      const fail = (msg) => { if (settled) return; cleanup(); done(reject, { message: msg }); };
      function cleanup() {
        closed = true; clearTimeout(sendTimer); clearInterval(keepTimer); clearInterval(pruneTimer); clearInterval(watchTimer); clearTimeout(joinTimer);
        try { ch.untrack(); } catch {}
        try { c.removeChannel(ch); } catch {}
      }
      function notify() {
        if (queued) return; queued = true;
        setTimeout(() => {
          queued = false;
          cache = Object.freeze([...peers.values()].map((p) => Object.freeze({ peer: p.peer, by: null, isMe: p.peer === label, sameTab: p.peer === label, kind: "viewer", guest: false, presence: Object.freeze(p.presence), updatedAt: p.updatedAt })));
          for (const h of handlers) { try { h({ peers: cache, joined: [], left: [], updated: [] }); } catch (e) { console.error(e); } }
        }, 0);
      }
      function setPeer(key, presence) { peers.set(key, { peer: key, presence, updatedAt: Date.now() }); notify(); }
      function dropPeer(key) { if (key !== label && peers.delete(key)) notify(); }
      function sendNow(evt, payload) { if (closed) return; try { const p = ch.send({ type: "broadcast", event: evt, payload }); if (p && p.catch) p.catch(() => {}); } catch {} }
      function sendMine() { sendNow("p", { peer: label, p: myPres }); }
      function others() { return Object.keys(ch.presenceState() || {}).filter((k) => k !== label); }
      function lost() {
        if (closed) return; cleanup();
        for (const f of errHandlers) { try { f({ code: "upstream_error", message: "Verbindung zum Spielserver verloren" }); } catch {} }
      }

      const api = {
        name,
        presence(patch) {
          if (closed) return Promise.resolve();
          const next = { ...myPres };
          for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete next[k]; else next[k] = JSON.parse(JSON.stringify(v)); }
          if (bytes(next) > MAX_PRESENCE) return Promise.reject({ code: "invalid_argument", message: "presence too large" });
          myPres = next; setPeer(label, myPres);
          if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = 0; sendMine(); }, SEND_GAP_MS);
          return Promise.resolve();
        },
        peers: () => cache,
        onPeers(h, onErr) { handlers.push(h); if (onErr) errHandlers.push(onErr); notify(); return () => { handlers = handlers.filter((x) => x !== h); errHandlers = errHandlers.filter((x) => x !== onErr); }; },
        onConnection(h) { setTimeout(() => h(!closed), 0); return () => {}; },
        connected: () => !closed && !downSince,
        emit: () => Promise.resolve(),
        on: () => () => {},
        leave() { cleanup(); return Promise.resolve(); },
      };

      ch.on("broadcast", { event: "p" }, ({ payload }) => {
        if (!isObj(payload) || typeof payload.peer !== "string" || payload.peer === label || !isObj(payload.p) || bytes(payload.p) > MAX_PRESENCE) return;
        setPeer(payload.peer, payload.p);
      });
      ch.on("broadcast", { event: "hi" }, ({ payload }) => {
        if (!isObj(payload) || payload.peer === label) return;
        setTimeout(sendMine, Math.random() * (300 + peers.size * 100));  // Antworten streuen, damit viele Spieler den Server nicht auf einmal fluten
      });
      ch.on("presence", { event: "leave" }, ({ key }) => { if (typeof key === "string") dropPeer(key); });
      ch.on("presence", { event: "sync" }, () => {
        if (!tracked) return;
        const now = Date.now(), here = new Set(Object.keys(ch.presenceState() || {}));
        for (const [k, p] of peers) if (k !== label && !here.has(k) && now - p.updatedAt > 3000) dropPeer(k);
        if (!settled) {
          const o = others();
          if (create) { if (o.length) fail("taken"); else done(resolve, api); }
          else if (o.length) done(resolve, api);
        }
      });

      joinTimer = setTimeout(() => {
        if (settled) return;
        if (!tracked) fail(MSG_NO_SERVER); else fail(create ? MSG_NO_SERVER : MSG_NOT_FOUND);
      }, JOIN_MS);

      ch.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          downSince = 0;
          try { await ch.track({ at: Date.now() }); } catch { if (!settled) fail(MSG_NO_SERVER); return; }
          tracked = true;
          setPeer(label, myPres);
          if (!keepTimer) {
            keepTimer = setInterval(sendMine, KEEPALIVE_MS);
            pruneTimer = setInterval(() => { const now = Date.now(); for (const [k, p] of peers) if (k !== label && now - p.updatedAt > STALE_MS) dropPeer(k); }, 5000);
            watchTimer = setInterval(() => { if (settled && downSince && Date.now() - downSince > 25000) lost(); }, 5000);
          }
          sendNow("hi", { peer: label }); sendMine();
          // Falls wir schon allein sind und die Presence-Liste schon vorliegt, jetzt entscheiden.
          setTimeout(() => { if (!settled && tracked) { const o = others(); if (create) { if (o.length) fail("taken"); else done(resolve, api); } else if (o.length) done(resolve, api); } }, 1500);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (!settled) fail(MSG_NO_SERVER); else if (!downSince) downSince = Date.now();
        } else if (status === "CLOSED") {
          if (!settled && !closed) fail(MSG_NO_SERVER); else if (settled && !closed && !downSince) downSince = Date.now();
        }
      });

      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !closed && tracked) { sendNow("hi", { peer: label }); sendMine(); } });
    });
  }

  // Hochgeladene Memes (nur sichtbare) und die vom Admin entfernten eingebauten Bilder. Beides ist ohne Anmeldung lesbar.
  async function catalog() {
    const c = sb();
    if (!c) return { rows: [], removed: [] };
    const [m, r] = await Promise.all([
      c.from("memes").select("file,name,tags").order("created_at", { ascending: true }).limit(2000),
      c.from("catalog_hidden").select("id").limit(2000),
    ]);
    if (m.error) throw m.error;
    return { rows: m.data || [], removed: (r.data || []).map((x) => x.id) };
  }

  // Verbindungstest: erreichen wir den Spielserver, und wie schnell?
  async function diagnose() {
    const out = { online: navigator.onLine !== false, server: false, ms: 0, error: "" };
    const c = sb();
    if (!c) { out.error = "Bibliothek nicht geladen"; return out; }
    const t0 = performance.now();
    const ch = c.channel("giffig-test-" + rid(6));
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Zeitüberschreitung")), 9000);
        ch.subscribe((s) => { if (s === "SUBSCRIBED") { clearTimeout(t); resolve(); } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") { clearTimeout(t); reject(new Error(s)); } });
      });
      out.server = true; out.ms = Math.round(performance.now() - t0);
    } catch (e) { out.error = String(e && e.message || e); }
    try { c.removeChannel(ch); } catch {}
    return out;
  }

  // Lokale Ruhmeshalle (pro Gerät)
  const listeners = new Map();
  const readCol = (path) => { try { return JSON.parse(localStorage.getItem("giffig-db-" + path) || "{}"); } catch { return {}; } };
  const writeCol = (path, o) => { try { localStorage.setItem("giffig-db-" + path, JSON.stringify(o)); } catch {} for (const f of listeners.get(path) || []) f(); };
  class LocalQuery {
    constructor(path, order, lim) { this.path = path; this.order = order; this.lim = lim || 1000; }
    orderBy(f, d) { return new LocalQuery(this.path, [f, d || "asc"], this.lim); }
    limit(n) { return new LocalQuery(this.path, this.order, n); }
    _snap() {
      let docs = Object.entries(readCol(this.path)).map(([id, data]) => ({ id, exists: true, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } }));
      if (this.order) { const [f, d] = this.order; docs.sort((a, b) => ((a.data()[f] > b.data()[f]) ? 1 : -1) * (d === "desc" ? -1 : 1)); }
      docs = docs.slice(0, this.lim);
      return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] };
    }
    get() { return Promise.resolve(this._snap()); }
    onSnapshot(next) {
      const fire = () => next(this._snap());
      if (!listeners.has(this.path)) listeners.set(this.path, new Set());
      listeners.get(this.path).add(fire); setTimeout(fire, 0);
      return () => listeners.get(this.path).delete(fire);
    }
    doc(id) {
      const path = this.path;
      return {
        id,
        set: (d) => { const o = readCol(path); o[id] = d; writeCol(path, o); return Promise.resolve(); },
        delete: () => { const o = readCol(path); delete o[id]; writeCol(path, o); return Promise.resolve(); },
      };
    }
  }
  const localDb = { collection: (p) => new LocalQuery(p) };
  const localUser = { canEdit: () => true, isOwner: () => true, can: () => Promise.resolve(true) };
  const lobby = {
    local: true,
    diagnose,
    catalog,
    presence: () => Promise.resolve(),
    peers: () => [],
    onPeers: () => () => {},
    onConnection: (h) => { setTimeout(() => h(true), 0); return () => {}; },
    join: (name, opts) => makeRoom(name, !!(opts && opts.create)),
  };
  window.claude = { use: (n) => Promise.resolve(n === "room" ? lobby : n === "db" ? localDb : n === "user" ? localUser : null) };
})();
