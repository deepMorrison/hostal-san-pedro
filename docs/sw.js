/* Copia local de la app de recepción (para abrirla aunque se corte internet).
   - La página principal y config.js: primero internet (para recibir las actualizaciones), si no hay, la copia guardada.
   - El resto (SDK, lector de documentos, librerías y fuentes): la copia guardada; si falta, se descarga y se guarda.
   - Firebase (la base de datos) no pasa por aquí: tiene su propia copia local y su cola de envíos. */
var VERSION = "hsp-20261017155131";
var BASE = ["./", "index.html", "config.js", "claude-shim.js",
  "vendor/firebase-app-compat.js", "vendor/firebase-auth-compat.js", "vendor/firebase-firestore-compat.js"];
var EXTERNOS = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(BASE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf("hsp-") === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function primeroRed(req) {
  return fetch(req).then(function (r) {
    if (r && r.ok) { var c = r.clone(); caches.open(VERSION).then(function (k) { k.put(req, c); }); }
    return r;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match("index.html"); });
  });
}
function primeroCopia(req) {
  return caches.match(req).then(function (r) {
    if (r) return r;
    return fetch(req).then(function (resp) {
      if (resp && (resp.ok || resp.type === "opaque")) { var c = resp.clone(); caches.open(VERSION).then(function (k) { k.put(req, c); }); }
      return resp;
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf("/__") >= 0) return; /* pruebas locales */
    if (req.mode === "navigate" || /\/(index\.html|config\.js)?$/.test(url.pathname)) { e.respondWith(primeroRed(req)); return; }
    e.respondWith(primeroCopia(req));
    return;
  }
  if (EXTERNOS.test(req.url)) e.respondWith(primeroCopia(req));
});
