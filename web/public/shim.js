/*
 * Mythscribe Desk on the web: the browser side of `window.claude.use(name)`.
 *
 * Desk was written as a claude.ai artifact and asks the page for five capabilities. This file
 * answers them in a normal browser, so Desk's own code runs unchanged:
 *   db        every document in IndexedDB (instant, works offline), copied to /api/sync
 *   sample    Ms Scribe's calls through /api/ai, with Desk's tools run here in the browser
 *   downloads a normal file download
 *   assets    pictures kept in IndexedDB and served at /_blob/<id> by sw.js
 *   mcp       null: no Google Drive yet (Desk then offers Word files from this device)
 * Sign-in: the MythScribe account (email link or 6-digit code), unless /api/config says none.
 */
(() => {
  "use strict";

  /* ---------------- small helpers ---------------- */
  const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const randId = (n = 20) => { const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", b = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (const x of b) s += a[x % 62]; return s; };
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  /** The db contract's update: nested objects merge, anything else (arrays too) replaces. */
  function merge(base, patch) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
    return out;
  }

  /* ---------------- config and sign-in ---------------- */
  const SESSION_KEY = "msw.session";
  let session = lsGet(SESSION_KEY); // { token, email, userId, access, accessExp }
  let configP = null;
  function config() {
    if (!configP) configP = fetch("/api/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("config"))))
      .then((c) => { lsSet("msw.config", c); return c; })
      .catch(() => lsGet("msw.config") || { auth: "cloud", ai: true });
    return configP;
  }
  async function post(path, body, headers) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...(headers || {}) }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw err(data.code || "http_" + r.status, data.message || "That didn't work. Try again.", { status: r.status });
    return data;
  }
  function saveSession(s) { session = s; lsSet(SESSION_KEY, s); }
  let refreshing = null;
  async function accessToken() {
    if (!session) return null;
    if (session.access && session.accessExp > Date.now() + 30000) return session.access;
    if (!refreshing) refreshing = post("/api/auth/refresh", { refreshToken: session.token })
      .then((r) => { saveSession({ ...session, access: r.access.token, accessExp: Date.parse(r.access.expiresAt) }); return session.access; })
      .catch((e) => { if (e.status === 401 || e.status === 404 || e.status === 400) { saveSession(null); signInNeeded(); } throw e; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  /** fetch with the account's bearer; one retry after a refresh on 401. */
  async function api(path, init = {}, retried) {
    const c = await config();
    const headers = { ...(init.headers || {}) };
    if (c.auth !== "none") {
      const t = await accessToken();
      if (!t) { signInNeeded(); throw err("session_expired", "Sign in to MythScribe first."); }
      headers.authorization = "Bearer " + t;
    }
    const r = await fetch(path, { ...init, headers });
    if (r.status === 401 && c.auth !== "none" && !retried && session) { session.accessExp = 0; return api(path, init, true); }
    if (r.status === 401) { saveSession(null); signInNeeded(); }
    return r;
  }

  let signedIn = null, signInResolve = null;
  function whenSignedIn() {
    if (!signedIn) signedIn = config().then((c) => (c.auth === "none" || session ? undefined : new Promise((res) => { signInResolve = res; showSignIn(); })));
    return signedIn;
  }
  function signInNeeded() { if (!document.getElementById("mswSignIn")) showSignIn(true); }

  function showSignIn(again) {
    if (document.getElementById("mswSignIn")) return;
    const mount = () => {
      const box = document.createElement("div");
      box.id = "mswSignIn";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.innerHTML = '<style>#mswSignIn{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(20,18,16,.55);font:16px/1.5 system-ui,sans-serif}#mswSignIn .c{background:#fffdf9;color:#2a2622;max-width:380px;width:calc(100% - 32px);padding:24px;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25)}#mswSignIn h2{margin:0 0 6px;font:600 20px/1.3 Georgia,serif}#mswSignIn p{margin:0 0 14px;color:#5b544c}#mswSignIn input{box-sizing:border-box;width:100%;font:inherit;padding:10px 12px;border:1px solid #cfc6ba;border-radius:8px;margin:0 0 10px;background:#fff;color:inherit}#mswSignIn button{font:inherit;padding:10px 14px;border-radius:8px;border:0;background:#5b3f8c;color:#fff;cursor:pointer;width:100%}#mswSignIn .e{color:#a12b2b;min-height:1.5em;margin:6px 0 0;font-size:14px}@media (prefers-color-scheme:dark){#mswSignIn .c{background:#26221f;color:#eee6dc}#mswSignIn p{color:#b8aea2}#mswSignIn input{background:#1c1917;border-color:#4a433c}}</style>' +
        '<form class="c" id="mswForm"><h2>' + (again ? "Sign in again" : "Sign in to Mythscribe") + '</h2><p id="mswMsg">Use your MythScribe account. We\'ll email you a link and a code.</p>' +
        '<input id="mswEmail" type="email" autocomplete="email" placeholder="you@example.com" required aria-label="Email address">' +
        '<input id="mswCode" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" maxlength="6" hidden aria-label="Code from the email">' +
        '<button id="mswGo" type="submit">Email me a link</button><div class="e" id="mswErr" role="alert"></div></form>';
      document.body.appendChild(box);
      const $ = (id) => box.querySelector("#" + id);
      let attempt = null, poll = null;
      const done = (r) => {
        clearInterval(poll);
        saveSession({ token: r.session.token, email: r.session.email, userId: r.session.userId, access: r.access ? r.access.token : null, accessExp: r.access ? Date.parse(r.access.expiresAt) : 0 });
        box.remove();
        if (signInResolve) { signInResolve(); signInResolve = null; }
        sync.soon(100);
      };
      const tick = async () => {
        try {
          const r = await post("/api/auth/poll", { attemptId: attempt.attemptId, pollSecret: attempt.pollSecret });
          if (r.status === "ready") done(r);
          else if (r.status === "expired") { clearInterval(poll); attempt = null; $("mswCode").hidden = true; $("mswEmail").hidden = false; $("mswGo").textContent = "Email me a link"; $("mswErr").textContent = "That sign-in expired. Try again."; }
        } catch {}
      };
      $("mswForm").onsubmit = async (e) => {
        e.preventDefault(); $("mswErr").textContent = ""; $("mswGo").disabled = true;
        try {
          if (!attempt) {
            attempt = await post("/api/auth/start", { email: $("mswEmail").value });
            $("mswMsg").textContent = "Check " + $("mswEmail").value.trim() + ". Click the link in the email, or type its code here.";
            $("mswEmail").hidden = true; $("mswCode").hidden = false; $("mswCode").focus(); $("mswGo").textContent = "Sign in";
            poll = setInterval(tick, 3000);
          } else {
            const r = await post("/api/auth/verify", { attemptId: attempt.attemptId, pollSecret: attempt.pollSecret, code: $("mswCode").value });
            if (r.status === "ready") done(r); else $("mswErr").textContent = r.status === "expired" ? "Too many tries. Start again." : "That code didn't match.";
          }
        } catch (x) { $("mswErr").textContent = x.message || "That didn't work."; }
        $("mswGo").disabled = false;
      };
      $("mswEmail").focus();
    };
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });
  }

  /* ---------------- IndexedDB ---------------- */
  // One database, shared with sw.js: docs (every Desk document), meta (sync cursor), blobs (pictures).
  const IDB_NAME = "mythscribe-web", IDB_VER = 1;
  const openIdb = () => new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, IDB_VER);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs", { keyPath: "path" }); if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta"); if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  let idbP = null;
  const idb = () => (idbP || (idbP = openIdb()));
  const tx = async (store, mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(store, mode); let out; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); out = fn(t.objectStore(store)); }); };
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  /* ---------------- the document store ---------------- */
  // Every document is held in memory (books are modest) and written through to IndexedDB.
  // rec: { path, parent, id, data (frozen), deleted, dirty (local version, 0 = sent), rev }
  const mem = new Map();
  let localSeq = 0, loaded = null;
  const parentOf = (p) => p.slice(0, p.lastIndexOf("/"));
  const lastSeg = (p) => p.slice(p.lastIndexOf("/") + 1);
  function checkPath(path, even) {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.endsWith("/") || path.includes("//")) throw new TypeError("Bad path: " + path);
    const n = path.split("/").length;
    if ((n % 2 === 0) !== even) throw new TypeError((even ? "A document path needs an even number of segments: " : "A collection path needs an odd number of segments: ") + path);
    return path;
  }
  function load() {
    if (!loaded) loaded = idb().then((d) => new Promise((res, rej) => {
      const r = d.transaction("docs").objectStore("docs").getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    })).then((rows) => {
      for (const rec of rows) { deepFreeze(rec.data); mem.set(rec.path, rec); if (rec.dirty > localSeq) localSeq = rec.dirty; }
    });
    return loaded;
  }
  const persist = (rec) => tx("docs", "readwrite", (s) => s.put(rec)).catch((e) => console.warn("[mythscribe] couldn't save to this browser", e));

  // snapshots: one frozen object per record version, so unchanged docs compare ===
  const snapCache = new WeakMap();
  function docSnap(path, rec) {
    if (!rec || rec.deleted) return { id: lastSeg(path), exists: false, data: () => undefined, metadata: { fromCache: false, hasPendingWrites: !!(rec && rec.dirty) } };
    let s = snapCache.get(rec);
    if (!s) { const data = rec.data; s = Object.freeze({ id: rec.id, exists: true, data: () => data, metadata: Object.freeze({ fromCache: false, hasPendingWrites: !!rec.dirty }) }); snapCache.set(rec, s); }
    return s;
  }

  const docSubs = new Map(); // path -> Set<fn>
  const querySubs = new Set(); // { col, q, next, last: Map<id, snap>, order: string[] }
  const bc = typeof BroadcastChannel === "function" ? new BroadcastChannel("mythscribe-web-db") : null;
  let pendingPaths = new Set(), flushQueued = false;
  function changed(path) {
    pendingPaths.add(path);
    if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
  }
  function flush() {
    flushQueued = false;
    const paths = pendingPaths; pendingPaths = new Set();
    const cols = new Set();
    for (const p of paths) {
      cols.add(parentOf(p));
      const subs = docSubs.get(p);
      if (subs) { const s = docSnap(p, mem.get(p)); for (const fn of [...subs]) safe(fn, s); }
    }
    for (const sub of [...querySubs]) if (cols.has(sub.col)) deliver(sub, false);
  }
  const safe = (fn, v) => { try { fn(v); } catch (e) { setTimeout(() => { throw e; }); } };

  function matchWhere(data, w) {
    const v = data[w.field];
    switch (w.op) {
      case "==": return v === w.value || (v != null && JSON.stringify(v) === JSON.stringify(w.value));
      case "!=": return v !== undefined && JSON.stringify(v) !== JSON.stringify(w.value);
      case "<": return v != null && v < w.value;
      case "<=": return v != null && v <= w.value;
      case ">": return v != null && v > w.value;
      case ">=": return v != null && v >= w.value;
      case "in": return Array.isArray(w.value) && w.value.some((x) => x === v);
      case "not-in": return v !== undefined && Array.isArray(w.value) && !w.value.some((x) => x === v);
      case "array-contains": return Array.isArray(v) && v.some((x) => x === w.value || JSON.stringify(x) === JSON.stringify(w.value));
      default: throw err("invalid_argument", "Unknown operator " + w.op);
    }
  }
  function runQuery(col, q) {
    let recs = [];
    for (const rec of mem.values()) if (rec.parent === col && !rec.deleted && rec.data) recs.push(rec);
    for (const w of q.where) recs = recs.filter((r) => matchWhere(r.data, w));
    if (q.order) {
      const { field, dir } = q.order, sign = dir === "desc" ? -1 : 1;
      recs.sort((a, b) => {
        const x = a.data[field], y = b.data[field];
        if (x === undefined && y === undefined) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        if (x === undefined) return 1; if (y === undefined) return -1;
        return (x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sign;
      });
    } else recs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (q.limit) recs = recs.slice(0, q.limit);
    return recs;
  }
  function querySnap(recs, changes) {
    const docs = recs.map((r) => docSnap(r.path, r));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => changes, metadata: { fromCache: false, hasPendingWrites: recs.some((r) => r.dirty) } };
  }
  function deliver(sub, first) {
    const recs = runQuery(sub.col, sub.q);
    const order = recs.map((r) => r.id), now = new Map(recs.map((r) => [r.id, docSnap(r.path, r)]));
    const changes = [];
    if (first) recs.forEach((r, i) => changes.push({ type: "added", doc: now.get(r.id), oldIndex: -1, newIndex: i }));
    else {
      sub.order.forEach((id, i) => { if (!now.has(id)) changes.push({ type: "removed", doc: sub.last.get(id), oldIndex: i, newIndex: -1 }); });
      order.forEach((id, i) => {
        const prev = sub.last.get(id);
        if (!prev) changes.push({ type: "added", doc: now.get(id), oldIndex: -1, newIndex: i });
        else if (prev !== now.get(id)) changes.push({ type: "modified", doc: now.get(id), oldIndex: sub.order.indexOf(id), newIndex: i });
      });
      if (!changes.length) return;
    }
    sub.last = now; sub.order = order;
    safe(sub.next, querySnap(recs, changes));
  }

  function write(path, data, deleted) {
    const rec = { path, parent: parentOf(path), id: lastSeg(path), data: deleted ? undefined : deepFreeze(data), deleted: !!deleted, dirty: ++localSeq, rev: (mem.get(path) || {}).rev || 0 };
    mem.set(path, rec);
    changed(path);
    if (bc) bc.postMessage({ rec });
    sync.soon(2000);
    return persist(rec);
  }
  if (bc) bc.onmessage = (e) => { const rec = e.data && e.data.rec; if (rec && rec.path) { deepFreeze(rec.data); mem.set(rec.path, rec); changed(rec.path); } };

  const leases = new Map();
  function docRef(path) {
    checkPath(path, true);
    return {
      id: lastSeg(path), path,
      async get() { await load(); return docSnap(path, mem.get(path)); },
      async set(data) { if (!isObj(data)) throw err("invalid_argument", "A document must be an object."); await load(); return write(path, clone(data)); },
      async update(data) {
        if (!isObj(data)) throw err("invalid_argument", "update needs an object.");
        await load(); const rec = mem.get(path);
        if (!rec || rec.deleted) throw err("invalid_argument", "update needs a document that exists: " + path);
        return write(path, merge(rec.data, data));
      },
      async delete() { await load(); const rec = mem.get(path); if (!rec || rec.deleted) return; return write(path, undefined, true); },
      async acquire({ holder, ttlMs, data } = {}) {
        await load();
        const ttl = Math.min(600000, Math.max(1000, ttlMs || 30000)), now = Date.now(), cur = leases.get(path);
        if (cur && cur.until > now && cur.holder !== holder) return { acquired: false, expiresAt: new Date(cur.until).toISOString() };
        leases.set(path, { holder, until: now + ttl });
        if (data && isObj(data)) { const rec = mem.get(path); await write(path, rec && !rec.deleted ? merge(rec.data, data) : clone(data)); }
        return { acquired: true, version: (mem.get(path) || {}).dirty || 0, expiresAt: new Date(now + ttl).toISOString(), holder };
      },
      onSnapshot(next, error) {
        let live = true; const fn = (s) => { if (live) next(s); };
        load().then(() => { if (!live) return; let set = docSubs.get(path); if (!set) docSubs.set(path, (set = new Set())); set.add(fn); fn(docSnap(path, mem.get(path))); }).catch((e) => error && error(err("unavailable", String(e))));
        return () => { live = false; const set = docSubs.get(path); if (set) set.delete(fn); };
      },
      collection(sub) { return colRef(path + "/" + sub); },
    };
  }
  function makeQuery(col, q) {
    return {
      where(field, op, value) { return makeQuery(col, { ...q, where: [...q.where, { field, op, value }] }); },
      orderBy(field, dir) { return makeQuery(col, { ...q, order: { field, dir: dir || "asc" } }); },
      limit(n) { return makeQuery(col, { ...q, limit: Math.max(1, Math.min(1000, n | 0)) }); },
      async get() { await load(); return querySnap(runQuery(col, q), []); },
      onSnapshot(next, error) {
        const sub = { col, q, next, last: new Map(), order: [] }; let live = true;
        load().then(() => { if (!live) return; querySubs.add(sub); deliver(sub, true); }).catch((e) => error && error(err("unavailable", String(e))));
        return () => { live = false; querySubs.delete(sub); };
      },
    };
  }
  function colRef(path) {
    checkPath(path, false);
    const q = makeQuery(path, { where: [], order: null, limit: 0 });
    return Object.assign(q, {
      path,
      doc(id) { return docRef(path + "/" + (id == null ? randId() : id)); },
      async add(data) { const ref = this.doc(); await ref.set(data); return ref; },
    });
  }
  const db = { doc: docRef, collection: colRef };

  /* ---------------- sync to /api/sync ---------------- */
  const sync = (() => {
    let timer = null, running = false, again = false, lastOk = 0;
    const cursorKey = "cursor";
    async function readCursor() { const d = await idb(); return new Promise((res) => { const r = d.transaction("meta").objectStore("meta").get(cursorKey); r.onsuccess = () => res(r.result || 0); r.onerror = () => res(0); }); }
    const writeCursor = (c) => tx("meta", "readwrite", (s) => s.put(c, cursorKey));
    async function once() {
      await load();
      let cursor = await readCursor();
      for (let round = 0; round < 200; round++) {
        const dirty = [...mem.values()].filter((r) => r.dirty).slice(0, 250);
        const sent = dirty.map((r) => [r.path, r.dirty]);
        const res = await api("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ since: cursor, push: dirty.map((r) => ({ path: r.path, data: r.deleted ? null : r.data })) }) });
        if (!res.ok) throw err("sync_" + res.status, "Sync failed (" + res.status + ")");
        const out = await res.json();
        for (const [p, v] of sent) { const r = mem.get(p); if (r && r.dirty === v) { const done = { ...r, dirty: 0 }; mem.set(p, done); persist(done); } }
        for (const ch of out.changes) {
          const local = mem.get(ch.path);
          if (local && local.dirty) continue; // a newer local write goes up on the next round
          const del = ch.data === null;
          if (local && local.deleted === del && (del || JSON.stringify(local.data) === JSON.stringify(ch.data))) { if (local.rev !== ch.rev) { const r = { ...local, rev: ch.rev }; mem.set(ch.path, r); persist(r); } continue; }
          if (!local && del) continue;
          const rec = { path: ch.path, parent: parentOf(ch.path), id: lastSeg(ch.path), data: del ? undefined : deepFreeze(ch.data), deleted: del, dirty: 0, rev: ch.rev };
          mem.set(ch.path, rec); persist(rec); changed(ch.path);
        }
        cursor = out.cursor; await writeCursor(cursor);
        if (!out.more && ![...mem.values()].some((r) => r.dirty)) break;
      }
      lastOk = Date.now();
    }
    async function run() {
      if (running) { again = true; return; }
      running = true;
      try { do { again = false; await once(); } while (again); }
      catch (e) { if (e.code !== "session_expired") console.info("[mythscribe] sync will retry:", e.message || e); }
      finally { running = false; }
    }
    function soon(ms) { clearTimeout(timer); timer = setTimeout(run, ms); }
    setInterval(() => { if (document.visibilityState === "visible") run(); }, 30000);
    addEventListener("online", () => soon(500));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") soon(500); else if ([...mem.values()].some((r) => r.dirty)) run(); });
    return { run, soon, readCursor, get lastOk() { return lastOk; } };
  })();

  /** Before Desk reads anything on a device that has never synced, pull the account's books, so
   * Desk's first-run defaults don't go up over them. Gives up after 15 s (offline still works). */
  let ready = null;
  function dbReady() {
    if (!ready) ready = (async () => {
      await whenSignedIn(); await load();
      const cursor = await sync.readCursor();
      if (!cursor && navigator.onLine !== false) await Promise.race([sync.run(), new Promise((r) => setTimeout(r, 15000))]);
      else sync.soon(1000);
    })();
    return ready;
  }

  /* ---------------- sample: Ms Scribe through /api/ai ---------------- */
  const TIERS = ["quick", "default", "complex"];
  function toMessages(input) {
    const list = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : null;
    if (!list || !list.length) throw err("invalid_argument", "sample needs a string or a list of messages.");
    const out = [];
    for (const m of list) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) throw err("invalid_argument", "Each message needs role user or assistant.");
      const content = typeof m.content === "string" ? m.content : String(m.content ?? "");
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) prev.content += "\n\n" + content; else out.push({ role: m.role, content });
    }
    if (out[0].role !== "user") out.unshift({ role: "user", content: "(Start.)" });
    if (out[out.length - 1].role !== "user") throw err("invalid_argument", "The last message must be the user's.");
    return out;
  }
  async function round(body, signal, onDelta) {
    let res;
    try { res = await api("/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }); }
    catch (e) { if (signal && signal.aborted) throw err("cancelled", "Stopped."); throw e.code ? e : err("upstream_error", "Couldn't reach Ms Scribe. Check your connection."); }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw err(e.code === "quota" ? "rate_limited" : e.code || "upstream_error", e.message || "Ms Scribe had a problem (" + res.status + ")."); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", done = null;
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (/^event: (.*)$/m.exec(chunk) || [])[1], data = (/^data: (.*)$/m.exec(chunk) || [])[1];
          if (!ev || data == null) continue;
          const d = JSON.parse(data);
          if (ev === "text") onDelta(d.d);
          else if (ev === "done") done = d;
          else if (ev === "error") throw err(d.code || "upstream_error", d.message);
        }
      }
    } catch (e) { if (signal && signal.aborted) throw err("cancelled", "Stopped."); throw e; }
    if (!done) throw err("upstream_error", "Ms Scribe's answer was cut off. Try again.");
    return done;
  }
  const replay = new Map(); // the platform's 5-minute replay cache for identical calls
  async function sample(input, opts = {}) {
    const tier = TIERS.includes(opts.modelTier) ? opts.modelTier : "default";
    const signal = opts.signal, onText = typeof opts.onText === "function" ? opts.onText : null;
    if (signal && signal.aborted) throw err("cancelled", "Stopped.");
    const messages = toMessages(input);
    const tools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;
    const key = !tools && opts.cache !== false ? tier + "\u0000" + JSON.stringify(messages) : null;
    if (key) { const hit = replay.get(key); if (hit && hit.until > Date.now()) { if (onText) onText({ text: hit.r.text, delta: hit.r.text }); return { ...hit.r }; } }
    const parts = []; let cur = "", truncated = false;
    const joined = () => [...parts, cur].filter((s) => s.trim()).join("\n\n");
    try {
      for (let n = 0; n < 16; n++) {
        cur = "";
        const body = { tier, messages, tools: tools ? tools.map((t) => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema || { type: "object", properties: {} } })) : undefined };
        const out = await round(body, signal, (d) => { cur += d; if (onText) onText({ text: joined(), delta: d }); });
        parts.push(cur); cur = "";
        if (out.stop_reason === "refusal") throw err("refused", "Ms Scribe can't help with that one.");
        if (out.stop_reason === "max_tokens") truncated = true;
        const uses = (out.content || []).filter((b) => b.type === "tool_use");
        if (out.stop_reason !== "tool_use" || !uses.length || !tools) break;
        messages.push({ role: "assistant", content: out.content });
        const results = await Promise.all(uses.map(async (u) => {
          const t = tools.find((x) => x.name === u.name);
          try {
            if (!t) throw new Error("No tool named " + u.name);
            const r = await t.execute(u.input || {}, { signal });
            return { type: "tool_result", tool_use_id: u.id, content: typeof r === "string" ? r : JSON.stringify(r === undefined ? null : r) };
          } catch (e) {
            if (signal && signal.aborted) throw err("cancelled", "Stopped.");
            return { type: "tool_result", tool_use_id: u.id, content: String((e && e.message) || e), is_error: true };
          }
        }));
        messages.push({ role: "user", content: results });
      }
    } catch (e) { e.text = joined(); throw e; }
    const r = { text: joined(), truncated, modelTierApplied: tier };
    if (key) { replay.set(key, { r, until: Date.now() + 300000 }); if (replay.size > 50) replay.delete(replay.keys().next().value); }
    return r;
  }
  sample.json = async (input, opts) => {
    const r = await sample(input, opts);
    let t = r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const tryParse = (s) => { try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; } };
    let p = tryParse(t);
    if (!p.ok) { const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]")); if (a >= 0 && b > a) p = tryParse(t.slice(a, b + 1)); }
    if (!p.ok) throw err("invalid_json", "Ms Scribe's answer wasn't the JSON that was asked for.", { text: r.text });
    return p.v;
  };
  sample.limits = async () => ({ maxPromptBytes: 900000, tools: { maxCount: 12 }, modelTiers: TIERS.slice() });

  /* ---------------- downloads and assets ---------------- */
  const downloads = {
    async save({ filename, data }) {
      if (!(data instanceof Blob)) throw err("invalid_argument", "save needs a Blob.");
      const url = URL.createObjectURL(data), a = document.createElement("a");
      a.href = url; a.download = String(filename || "download").replace(/[\\/:*?"<>|]+/g, "-"); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: "delivered" };
    },
  };
  const assets = {
    async upload(blob) {
      if (!(blob instanceof Blob)) throw err("invalid_argument", "upload needs a Blob or File.");
      if (blob.size > 20 * 1024 * 1024) throw err("too_large", "Pictures up to 20 MB.");
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const row = { id, blob, contentType: blob.type || "application/octet-stream", sizeBytes: blob.size, at: Date.now() };
      await tx("blobs", "readwrite", (s) => s.put(row));
      return { id, url: "/_blob/" + id, sizeBytes: row.sizeBytes, contentType: row.contentType };
    },
    async list() {
      const d = await idb();
      const rows = await new Promise((res, rej) => { const r = d.transaction("blobs").objectStore("blobs").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      return { assets: rows.map((r) => ({ id: r.id, url: "/_blob/" + r.id, sizeBytes: r.sizeBytes, contentType: r.contentType })), usage: { bytes: rows.reduce((n, r) => n + r.sizeBytes, 0) } };
    },
    async delete(id) { await tx("blobs", "readwrite", (s) => s.delete(String(id))); },
  };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  /* ---------------- reader links (Desk's reading page, kept on the server) ---------------- */
  async function roomsCall(path, init) {
    const r = await api(path, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw err(body.code || "upstream_error", body.message || "The reader links didn't answer (" + r.status + ").");
    return body;
  }
  const rooms = {
    available: true,
    create: (d) => roomsCall("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) }),
    list: (bookId) => roomsCall("/api/rooms?book=" + encodeURIComponent(bookId || "")).then((b) => b.rooms || []),
    notes: (token) => roomsCall("/api/rooms/" + encodeURIComponent(token) + "/notes"),
    close: (token) => roomsCall("/api/rooms/" + encodeURIComponent(token) + "/close", { method: "POST" }),
    link: (token) => location.origin + "/r/" + token,
  };

  /* ---------------- window.claude ---------------- */
  const caps = {
    db: () => dbReady().then(() => db),
    sample: () => whenSignedIn().then(config).then((c) => (c.ai ? sample : null)),
    downloads: () => Promise.resolve(downloads),
    assets: () => idb().then(() => assets),
    mcp: () => Promise.resolve(null),
  };
  const memo = new Map();
  const claude = Object.freeze({
    use(name) {
      if (!memo.has(name)) memo.set(name, (caps[name] ? caps[name]() : Promise.resolve(null)).catch((e) => { console.warn("[mythscribe] " + name + " unavailable", e); return null; }));
      return memo.get(name);
    },
  });
  Object.defineProperty(window, "claude", { value: claude, configurable: false, writable: false });
  // For tests and the console: the web build's own hooks.
  window.__mythscribeWeb = { sync, db, sample, rooms, signOut: () => { const t = session; saveSession(null); if (t) post("/api/auth/signout", {}, { authorization: "Bearer " + (t.access || t.token) }).catch(() => {}); location.reload(); } };
})();
