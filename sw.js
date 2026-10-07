// Service worker: l'app si apre anche con poca rete. I dati (prezzi)
// vengono sempre chiesti prima alla rete, e solo se manca si usa l'ultima copia.
const VERSIONE = "lancetta-v2";
const GUSCIO = ["./", "index.html", "css/app.css", "js/app.js", "manifest.webmanifest", "icons/icona.svg", "icons/icona-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSIONE).then((c) => c.addAll(GUSCIO)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((chiavi) => Promise.all(chiavi.filter((k) => k !== VERSIONE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((risposta) => {
        const copia = risposta.clone();
        caches.open(VERSIONE).then((c) => c.put(e.request, copia));
        return risposta;
      })
      .catch(() => caches.match(e.request)),
  );
});
