// Giffig online: stellt dieselbe Schnittstelle wie die claude.ai-Fähigkeiten bereit
// (room, db), aber ohne Claude. Der Browser, der ein Spiel erstellt, ist der Server
// (PeerJS/WebRTC); die Ruhmeshalle wird lokal auf dem Gerät gespeichert.
(function () {
  "use strict";
  const PREFIX = "gfg1-";
  const MAX_CONNS = 11;
  const CONNECT_MS = 20000;
  // Mehrere STUN-Server plus TURN-Relays (auch über TCP/443 für strenge WLANs).
  const ICE_SERVERS = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478", "stun:global.stun.twilio.com:3478"] },
    { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" },
    { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turns:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
  ];
  const PEER_OPTS = { debug: 0, config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 } };
  const MSG_NO_SERVER = "Der Vermittlungsserver ist nicht erreichbar. Prüf deine Internetverbindung oder probier ein anderes Netz.";
  const MSG_NOT_FOUND = "Kein Spiel mit diesem Code gefunden. Prüf den Code und ob der Host die Seite noch offen hat.";
  const MSG_NAT = "Der Host ist da, aber die direkte Verbindung klappt in deinem Netz nicht (typisch bei Handy-Daten, Schul- oder Firmen-WLAN). Mach den Verbindungstest oder wechsel das Netz, zum Beispiel auf dasselbe WLAN wie der Host.";
  const bytes = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
  const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);

  function makeRoom(name, create) {
    return new Promise((resolve, reject) => {
      if (typeof Peer !== "function") { reject({ message: "Die Verbindungsbibliothek konnte nicht geladen werden. Prüf deine Internetverbindung." }); return; }
      const hubId = PREFIX + name;
      const peer = create ? new Peer(hubId, PEER_OPTS) : new Peer(PEER_OPTS);
      let peerOpen = false;
      const peers = new Map();
      const conns = new Map();
      let handlers = [], errHandlers = [], myLabel = null, myPres = {}, hubConn = null;
      let settled = false, closed = false, cache = Object.freeze([]), queued = false, sendTimer = 0;

      const fail = (msg) => { if (!settled) { settled = true; clearTimeout(timeout); try { peer.destroy(); } catch {} reject({ message: msg }); } };
      const timeout = setTimeout(() => fail(create ? MSG_NO_SERVER : (!peerOpen ? MSG_NO_SERVER : hubConn ? MSG_NAT : MSG_NOT_FOUND)), CONNECT_MS);

      function notify() {
        if (queued) return; queued = true;
        setTimeout(() => {
          queued = false;
          cache = Object.freeze([...peers.values()].map((p) => Object.freeze({ peer: p.peer, by: null, isMe: p.peer === myLabel, sameTab: p.peer === myLabel, kind: "viewer", guest: false, presence: Object.freeze(p.presence), updatedAt: p.updatedAt })));
          for (const h of handlers) { try { h({ peers: cache, joined: [], left: [], updated: [] }); } catch (e) { console.error(e); } }
        }, 0);
      }
      function setPeer(label, presence) { peers.set(label, { peer: label, presence, updatedAt: Date.now() }); notify(); }
      function dropPeer(label) { if (peers.delete(label)) notify(); }
      function lost() {
        if (closed) return; closed = true;
        for (const f of errHandlers) { try { f({ code: "upstream_error", message: "Verbindung zum Host verloren" }); } catch {} }
        try { peer.destroy(); } catch {}
      }
      function relay(msg, except) { for (const [label, c] of conns) if (label !== except && c.open) { try { c.send(msg); } catch {} } }

      const api = {
        name,
        presence(patch) {
          if (closed) return Promise.resolve();
          const next = { ...myPres };
          for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete next[k]; else next[k] = JSON.parse(JSON.stringify(v)); }
          if (bytes(next) > 4096) return Promise.reject({ code: "invalid_argument", message: "presence too large" });
          myPres = next;
          if (myLabel) setPeer(myLabel, myPres);
          clearTimeout(sendTimer);
          sendTimer = setTimeout(() => {
            if (create) relay({ t: "p", peer: myLabel, p: myPres });
            else if (hubConn && hubConn.open) { try { hubConn.send({ t: "p", p: myPres }); } catch {} }
          }, 40);
          return Promise.resolve();
        },
        peers: () => cache,
        onPeers(h, onErr) { handlers.push(h); if (onErr) errHandlers.push(onErr); notify(); return () => { handlers = handlers.filter((x) => x !== h); errHandlers = errHandlers.filter((x) => x !== onErr); }; },
        onConnection(h) { setTimeout(() => h(!closed), 0); return () => {}; },
        connected: () => !closed,
        emit: () => Promise.resolve(),
        on: () => () => {},
        leave() { closed = true; try { peer.destroy(); } catch {} return Promise.resolve(); },
      };

      peer.on("open", (id) => {
        myLabel = id; peerOpen = true;
        if (create) {
          setPeer(myLabel, myPres);
          settled = true; clearTimeout(timeout); resolve(api);
          return;
        }
        hubConn = peer.connect(hubId, { reliable: true });
        hubConn.on("open", () => {
          hubConn.send({ t: "p", p: myPres });
        });
        hubConn.on("data", (m) => {
          if (!isObj(m)) return;
          if (m.t === "hello" && Array.isArray(m.list)) {
            for (const [label, p] of m.list) if (typeof label === "string" && isObj(p)) setPeer(label, p);
            setPeer(myLabel, myPres);
            if (!settled) { settled = true; clearTimeout(timeout); resolve(api); }
          } else if (m.t === "p" && typeof m.peer === "string" && isObj(m.p) && m.peer !== myLabel) setPeer(m.peer, m.p);
          else if (m.t === "x" && typeof m.peer === "string") dropPeer(m.peer);
          else if (m.t === "full") fail("Dieses Spiel ist voll.");
        });
        hubConn.on("iceStateChanged", (st) => { if (st === "failed" && !settled) fail(MSG_NAT); });
        hubConn.on("close", () => { if (settled) lost(); else fail(MSG_NAT); });
        hubConn.on("error", () => { if (settled) lost(); else fail(MSG_NAT); });
      });

      if (create) {
        peer.on("connection", (conn) => {
          conn.on("open", () => {
            if (conns.size >= MAX_CONNS) { try { conn.send({ t: "full" }); } catch {} setTimeout(() => conn.close(), 300); return; }
            conns.set(conn.peer, conn);
            conn.send({ t: "hello", list: [...peers.values()].map((p) => [p.peer, p.presence]) });
          });
          conn.on("data", (m) => {
            if (!isObj(m) || m.t !== "p" || !isObj(m.p) || bytes(m.p) > 4096 || !conns.has(conn.peer)) return;
            setPeer(conn.peer, m.p);
            relay({ t: "p", peer: conn.peer, p: m.p }, conn.peer);
          });
          const gone = () => { if (conns.delete(conn.peer)) { dropPeer(conn.peer); relay({ t: "x", peer: conn.peer }); } };
          conn.on("close", gone);
          conn.on("error", gone);
        });
      }

      peer.on("error", (err) => {
        const type = err && err.type;
        if (!settled) {
          if (type === "unavailable-id") fail("taken");
          else if (type === "peer-unavailable") fail(MSG_NOT_FOUND);
          else if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") fail(MSG_NO_SERVER);
          else fail("Verbindung fehlgeschlagen (" + (type || "unbekannt") + "). Versuch es gleich nochmal.");
          return;
        }
        if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
          // Signalisierung weg: bestehende Verbindungen laufen weiter, neue Spieler kommen nicht mehr rein.
          try { peer.reconnect(); } catch {}
        }
      });
      peer.on("disconnected", () => { if (!closed) { try { peer.reconnect(); } catch {} } });
      // Handy-Browser trennen die Verbindung zum Vermittlungsserver, wenn die Seite im Hintergrund war.
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !closed && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch {} } });
    });
  }

  // Verbindungstest: zeigt, was in deinem Netz funktioniert.
  async function diagnose() {
    const out = { online: navigator.onLine !== false, signaling: false, stun: false, turn: false, turnTcp: false, error: "" };
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch("https://0.peerjs.com/peerjs/id?ts=" + Date.now(), { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t); out.signaling = r.ok;
    } catch (e) { out.error = String(e && e.message || e); }
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pc.createDataChannel("t");
      await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, 9000);
        pc.onicecandidate = (e) => {
          if (!e.candidate) { clearTimeout(timer); done(); return; }
          const c = e.candidate.candidate;
          if (/ typ srflx /.test(c)) out.stun = true;
          if (/ typ relay /.test(c)) { out.turn = true; if (/ tcp /i.test(c)) out.turnTcp = true; }
        };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(done);
      });
      pc.close();
    } catch (e) { out.error = out.error || String(e && e.message || e); }
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
    presence: () => Promise.resolve(),
    peers: () => [],
    onPeers: () => () => {},
    onConnection: (h) => { setTimeout(() => h(true), 0); return () => {}; },
    join: (name, opts) => makeRoom(name, !!(opts && opts.create)),
  };
  window.claude = { use: (n) => Promise.resolve(n === "room" ? lobby : n === "db" ? localDb : n === "user" ? localUser : null) };
})();
