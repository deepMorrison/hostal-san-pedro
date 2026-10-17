/* Recepción Atacama — versión web (GitHub Pages + Firebase).
   La app se escribió para Claude, donde pide sus servicios con claude.use("db" | "user" | "downloads" | ...).
   Este archivo entrega lo mismo usando Firebase:
   - pasajero (celular, sin cuenta): sesión anónima; solo puede CREAR su pre-registro y leer la información pública;
   - personal (equipos de recepción): correo y contraseña, una vez por equipo; ve y edita todo.
   Quién es personal lo deciden las reglas de Firestore (firestore.rules), no este archivo. */
(function () {
  "use strict";
  window.WEB_MODE = true;
  var cfg = window.FIREBASE_CONFIG || {};
  var configurado = !!(cfg.apiKey && cfg.projectId && !/PEGA|TU_/i.test(cfg.apiKey + cfg.projectId));

  function guardarArchivo(o) {
    var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: /\.csv$/i.test(o.filename) ? "text/csv;charset=utf-8" : "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = o.filename || "archivo"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return Promise.resolve(true);
  }
  var downloads = { save: guardarArchivo };

  if (!configurado || !window.firebase) {
    window.WEB_SETUP_ERROR = !window.firebase ? "sdk" : "config";
    console.warn("Recepción Atacama: falta la configuración de Firebase en config.js; el pre-registro funciona solo con código.");
    window.claude = { use: function (n) { return Promise.resolve(n === "downloads" ? downloads : null); } };
    window.webAuth = { login: function () { return Promise.reject({ code: "config" }); }, logout: function () { return Promise.resolve(); } };
    return;
  }

  firebase.initializeApp(cfg);
  var auth = firebase.auth();
  var fs = firebase.firestore();
  try { fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) {}

  var esPersonal = function (u) { return !!(u && !u.isAnonymous); };

  /* ---- Sin internet (solo equipos del personal) ----
     Firestore guarda una copia en el equipo (IndexedDB) y deja en cola lo que se escribe sin señal; lo envía solo al volver.
     Sus escrituras se confirman recién cuando llegan al servidor, así que aquí se da por guardado a los 2,5 s
     (ya quedó en el equipo) para que la pantalla no se quede «Guardando…»; si después el servidor lo rechaza, se avisa. */
  var pendientes = 0;
  function avisarPendientes() { window.FB_PENDIENTES = pendientes; window.dispatchEvent(new CustomEvent("fb-pendientes", { detail: pendientes })); }
  function conPlazo(p, valor) {
    pendientes++; avisarPendientes();
    p.then(function () {}, function (e) {
      console.warn("Escritura rechazada", e);
      window.dispatchEvent(new CustomEvent("fb-error-escritura", { detail: { code: e && e.code } }));
    }).then(function () { pendientes--; avisarPendientes(); });
    return Promise.race([p.then(function () { return valor; }), new Promise(function (r) { setTimeout(function () { r(valor); }, 2500); })]);
  }
  function docSinBloqueo(d) {
    return {
      id: d.id, path: d.path,
      get: function (o) { return d.get(o); },
      onSnapshot: function (a, b, c) { return d.onSnapshot(a, b, c); },
      collection: function (c) { return colSinBloqueo(d.collection(c)); },
      set: function (v, o) { return conPlazo(o ? d.set(v, o) : d.set(v)); },
      update: function (v) { return conPlazo(d.update(v)); },
      delete: function () { return conPlazo(d.delete()); }
    };
  }
  function colSinBloqueo(c) {
    return {
      id: c.id, path: c.path,
      where: function (a, b, v) { return c.where(a, b, v); },
      orderBy: function (a, b) { return b ? c.orderBy(a, b) : c.orderBy(a); },
      limit: function (n) { return c.limit(n); },
      get: function (o) { return c.get(o); },
      onSnapshot: function (a, b, e) { return c.onSnapshot(a, b, e); },
      doc: function (id) { return docSinBloqueo(id ? c.doc(id) : c.doc()); },
      add: function (v) { var r = c.doc(); return conPlazo(r.set(v), r); }
    };
  }
  var dbPersonal = { collection: function (p) { return colSinBloqueo(fs.collection(p)); }, doc: function (p) { return docSinBloqueo(fs.doc(p)); } };

  /* Copia de la app en el equipo (service worker): abre aunque no haya señal */
  function registrarSW(personal) {
    if (!("serviceWorker" in navigator) || !/^https:|^http:\/\/(127\.0\.0\.1|localhost)/.test(location.href)) return;
    navigator.serviceWorker.register("sw.js").then(function () {
      if (!personal) return;
      /* el personal deja listo también el lector de documentos (≈10 MB) para escanear sin señal */
      var precargar = function () {
        ["tess/worker.min.js", "tess/tesseract-core-lstm.wasm.js", "tess/tesseract-core-simd-lstm.wasm.js", "tess/mrz-model.gz.wasm", "tess/spa-model.gz.wasm",
         "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js"].forEach(function (u) {
          fetch(u, /^https?:/.test(u) ? { mode: "no-cors" } : {}).catch(function () {});
        });
      };
      if (navigator.serviceWorker.controller) setTimeout(precargar, 4000);
      else navigator.serviceWorker.addEventListener("controllerchange", function () { setTimeout(precargar, 1000); }, { once: true });
    }).catch(function (e) { console.warn("Sin copia local de la app", e); });
  }
  /* espera el primer estado de la sesión (Firebase la recuerda en el equipo); sin sesión entra como pasajero anónimo */
  var usuario = new Promise(function (res) {
    var un = auth.onAuthStateChanged(function (u) { un(); res(u); });
  }).then(function (u) {
    if (u && !u.isAnonymous) {
      registrarSW(true);
      return fs.enablePersistence({ synchronizeTabs: true }).catch(function (e) { console.warn("Base local no disponible", e && e.code); }).then(function () { window.WEB_OFFLINE = true; return u; });
    }
    registrarSW(false);
    if (u) return u;
    return auth.signInAnonymously().then(function (c) { return c.user; }).catch(function (e) {
      console.warn("Sesión anónima no disponible", e && e.code);
      window.WEB_AUTH_ERROR = e && e.code;
      return null;
    });
  });

  window.claude = {
    use: function (name) {
      return usuario.then(function (u) {
        if (name === "db") return u ? (esPersonal(u) ? dbPersonal : fs) : null;
        if (name === "user") return {
          canEdit: function () { return Promise.resolve(esPersonal(u)); },
          can: function () { return Promise.resolve(esPersonal(u)); },
          isOwner: function () { return Promise.resolve(esPersonal(u)); },
          id: function () { return Promise.resolve(u ? u.uid : null); },
          email: u && u.email || ""
        };
        if (name === "downloads") return downloads;
        return null; /* sample (IA) y artifact (publicar) no existen fuera de Claude */
      });
    }
  };

  window.webAuth = {
    /* inicia sesión y comprueba que las reglas lo reconocen como personal; si no, cierra la sesión */
    login: function (email, pass) {
      return auth.signInWithEmailAndPassword(email, pass).then(function () {
        return fs.doc("config/hostal").get().catch(function (e) {
          if (e && e.code === "permission-denied") {
            return auth.signOut().then(function () { return auth.signInAnonymously().catch(function () {}); }).then(function () { throw { code: "sin-permiso" }; });
          }
          throw e;
        });
      });
    },
    logout: function () { return auth.signOut(); },
    ready: usuario
  };
})();
