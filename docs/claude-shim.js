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
  /* espera el primer estado de la sesión (Firebase la recuerda en el equipo); sin sesión entra como pasajero anónimo */
  var usuario = new Promise(function (res) {
    var un = auth.onAuthStateChanged(function (u) { un(); res(u); });
  }).then(function (u) {
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
        if (name === "db") return u ? fs : null;
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
