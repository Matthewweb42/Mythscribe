/*
 * Serves Desk's pictures (codex portraits, backgrounds) at /_blob/<id> from the IndexedDB store
 * the shim writes to. Nothing else goes through this worker.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open("mythscribe-web", 1);
  r.onupgradeneeded = () => { const d = r.result; for (const [n, o] of [["docs", { keyPath: "path" }], ["meta"], ["blobs", { keyPath: "id" }]]) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith("/_blob/")) return;
  const id = decodeURIComponent(url.pathname.slice(7));
  e.respondWith(open().then((d) => new Promise((res) => {
    const r = d.transaction("blobs").objectStore("blobs").get(id);
    r.onsuccess = () => res(r.result ? new Response(r.result.blob, { headers: { "content-type": r.result.contentType, "cache-control": "private, max-age=31536000, immutable" } }) : new Response("Not on this device", { status: 404 }));
    r.onerror = () => res(new Response("Not on this device", { status: 404 }));
  })).catch(() => new Response("Not on this device", { status: 404 })));
});
