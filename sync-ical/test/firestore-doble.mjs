/**
 * Doble de Firestore para las pruebas: un servidor HTTP de Node que implementa lo
 * mínimo de la API REST que usa sync.mjs (runQuery y commit) más get/list/patch
 * para inspeccionar y preparar datos. Guarda los documentos en memoria con el
 * mismo formato de la API ({ stringValue }, { integerValue }, { mapValue }, ...).
 *
 * Es independiente de sync.mjs a propósito: así una codificación mal hecha en el
 * script se nota en las pruebas.
 */
import http from 'node:http';

function plano(valor) {
  if (!valor || typeof valor !== 'object') return null;
  if ('stringValue' in valor) return valor.stringValue;
  if ('integerValue' in valor) return Number(valor.integerValue);
  if ('doubleValue' in valor) return valor.doubleValue;
  if ('booleanValue' in valor) return valor.booleanValue;
  if ('nullValue' in valor) return null;
  if ('timestampValue' in valor) return valor.timestampValue;
  if ('mapValue' in valor) return planoCampos(valor.mapValue.fields || {});
  if ('arrayValue' in valor) return (valor.arrayValue.values || []).map(plano);
  return null;
}

function planoCampos(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) o[k] = plano(v);
  return o;
}

function codificar(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(codificar) } };
  if (typeof v === 'object') return { mapValue: { fields: codificarCampos(v) } };
  throw new Error(`tipo no soportado: ${typeof v}`);
}

function codificarCampos(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) f[k] = codificar(v);
  return f;
}

function cumpleFiltro(fields, filtro) {
  if (!filtro) return true;
  if (filtro.compositeFilter) {
    const resultados = (filtro.compositeFilter.filters || []).map((f) => cumpleFiltro(fields, f));
    return filtro.compositeFilter.op === 'OR' ? resultados.some(Boolean) : resultados.every(Boolean);
  }
  if (filtro.fieldFilter) {
    const { field, op, value } = filtro.fieldFilter;
    const crudo = fields[field.fieldPath];
    if (crudo === undefined) return false; // Firestore excluye documentos sin el campo
    const a = plano(crudo);
    const b = plano(value);
    if (typeof a !== typeof b) return false; // tipos distintos no se comparan
    switch (op) {
      case 'EQUAL': return a === b;
      case 'NOT_EQUAL': return a !== b;
      case 'GREATER_THAN': return a > b;
      case 'GREATER_THAN_OR_EQUAL': return a >= b;
      case 'LESS_THAN': return a < b;
      case 'LESS_THAN_OR_EQUAL': return a <= b;
      default: throw new Error(`operador no soportado por el doble: ${op}`);
    }
  }
  if (filtro.unaryFilter) {
    const { field, op } = filtro.unaryFilter;
    const crudo = fields[field.fieldPath];
    if (op === 'IS_NULL') return crudo !== undefined && 'nullValue' in crudo;
    if (op === 'IS_NOT_NULL') return crudo !== undefined && !('nullValue' in crudo);
    throw new Error(`operador unario no soportado: ${op}`);
  }
  throw new Error('filtro no soportado por el doble');
}

function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    req.on('data', (t) => trozos.push(t));
    req.on('end', () => resolver(Buffer.concat(trozos).toString('utf8')));
    req.on('error', rechazar);
  });
}

class ErrorApi extends Error {
  constructor(codigo, estado, mensaje) { super(mensaje); this.codigo = codigo; this.estado = estado; }
}

export async function crearDobleFirestore({ proyecto = 'demo-hostal' } = {}) {
  const prefijoNombre = `projects/${proyecto}/databases/(default)/documents`;
  const prefijoRuta = `/v1/${prefijoNombre}`;
  const documentos = new Map(); // "coleccion/id" → { fields, createTime, updateTime }
  const registro = { solicitudes: [], commits: [], consultas: [], auth: [] };
  const fallos = { commit: 0, runQuery: 0 }; // cuántas veces responderá 500 cada endpoint

  const documentoSalida = (clave, d) => ({ name: `${prefijoNombre}/${clave}`, fields: d.fields, createTime: d.createTime, updateTime: d.updateTime });

  function claveDesdeNombre(nombre) {
    if (typeof nombre !== 'string' || !nombre.startsWith(`${prefijoNombre}/`)) {
      throw new ErrorApi(400, 'INVALID_ARGUMENT', `nombre de documento inválido: ${nombre}`);
    }
    const resto = nombre.slice(prefijoNombre.length + 1).split('/');
    if (resto.length !== 2 || !resto[0] || !resto[1]) throw new ErrorApi(400, 'INVALID_ARGUMENT', `ruta de documento inválida: ${nombre}`);
    return resto.join('/');
  }

  function aplicarEscritura(w, ahora) {
    if (w.delete) { documentos.delete(claveDesdeNombre(w.delete)); return; }
    if (!w.update) throw new ErrorApi(400, 'INVALID_ARGUMENT', 'escritura sin update ni delete');
    const clave = claveDesdeNombre(w.update.name);
    const existente = documentos.get(clave);
    if (w.currentDocument && 'exists' in w.currentDocument && w.currentDocument.exists !== Boolean(existente)) {
      throw new ErrorApi(400, 'FAILED_PRECONDITION', `precondición fallida para ${clave}`);
    }
    if (w.updateMask) {
      const campos = existente ? { ...existente.fields } : {};
      for (const ruta of w.updateMask.fieldPaths || []) {
        if (ruta.includes('.')) throw new ErrorApi(400, 'INVALID_ARGUMENT', 'el doble no soporta rutas anidadas en updateMask');
        if (w.update.fields && ruta in w.update.fields) campos[ruta] = w.update.fields[ruta];
        else delete campos[ruta];
      }
      documentos.set(clave, { fields: campos, createTime: existente?.createTime || ahora, updateTime: ahora });
    } else {
      documentos.set(clave, { fields: { ...(w.update.fields || {}) }, createTime: existente?.createTime || ahora, updateTime: ahora });
    }
  }

  function ejecutarConsulta(structuredQuery) {
    const coleccion = structuredQuery?.from?.[0]?.collectionId;
    if (!coleccion) throw new ErrorApi(400, 'INVALID_ARGUMENT', 'consulta sin colección');
    let resultado = [];
    for (const [clave, d] of documentos) {
      if (!clave.startsWith(`${coleccion}/`)) continue;
      if (cumpleFiltro(d.fields, structuredQuery.where)) resultado.push(documentoSalida(clave, d));
    }
    for (const orden of (structuredQuery.orderBy || []).slice().reverse()) {
      const campo = orden.field.fieldPath;
      const dir = orden.direction === 'DESCENDING' ? -1 : 1;
      resultado.sort((a, b) => (plano(a.fields[campo]) > plano(b.fields[campo]) ? dir : plano(a.fields[campo]) < plano(b.fields[campo]) ? -dir : 0));
    }
    if (structuredQuery.limit) resultado = resultado.slice(0, Number(structuredQuery.limit));
    return resultado;
  }

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://doble');
    const ahora = new Date().toISOString();
    const responder = (codigo, cuerpo) => {
      res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(cuerpo));
    };
    registro.solicitudes.push(`${req.method} ${url.pathname}`);
    registro.auth.push(req.headers.authorization || '');
    try {
      if (!req.headers.authorization) throw new ErrorApi(401, 'UNAUTHENTICATED', 'falta la cabecera Authorization');
      if (!url.pathname.startsWith(prefijoRuta)) throw new ErrorApi(404, 'NOT_FOUND', `ruta desconocida: ${url.pathname}`);
      const resto = url.pathname.slice(prefijoRuta.length);
      const cuerpo = req.method === 'GET' ? null : JSON.parse((await leerCuerpo(req)) || '{}');

      if (req.method === 'POST' && resto === ':runQuery') {
        if (fallos.runQuery > 0) { fallos.runQuery--; throw new ErrorApi(500, 'INTERNAL', 'fallo simulado en runQuery'); }
        registro.consultas.push(cuerpo.structuredQuery);
        const docs = ejecutarConsulta(cuerpo.structuredQuery);
        const readTime = ahora;
        return responder(200, docs.length ? docs.map((document) => ({ document, readTime })) : [{ readTime }]);
      }

      if (req.method === 'POST' && resto === ':commit') {
        if (fallos.commit > 0) { fallos.commit--; throw new ErrorApi(500, 'INTERNAL', 'fallo simulado en commit'); }
        const writes = cuerpo.writes || [];
        if (writes.length > 500) throw new ErrorApi(400, 'INVALID_ARGUMENT', 'máximo 500 escrituras por commit');
        // Atómico: se validan todas antes de aplicar ninguna.
        const copia = new Map(documentos);
        try { for (const w of writes) aplicarEscritura(w, ahora); } catch (e) {
          documentos.clear(); for (const [k, v] of copia) documentos.set(k, v);
          throw e;
        }
        registro.commits.push(writes.length);
        return responder(200, { writeResults: writes.map(() => ({ updateTime: ahora })), commitTime: ahora });
      }

      const partes = resto.split('/').filter(Boolean);
      if (req.method === 'GET' && partes.length === 1) {
        const docs = [];
        for (const [clave, d] of documentos) if (clave.startsWith(`${partes[0]}/`)) docs.push(documentoSalida(clave, d));
        return responder(200, docs.length ? { documents: docs } : {});
      }
      if (req.method === 'GET' && partes.length === 2) {
        const d = documentos.get(partes.join('/'));
        if (!d) throw new ErrorApi(404, 'NOT_FOUND', `no existe el documento ${partes.join('/')}`);
        return responder(200, documentoSalida(partes.join('/'), d));
      }
      if (req.method === 'PATCH' && partes.length === 2) {
        const rutas = url.searchParams.getAll('updateMask.fieldPaths');
        const w = { update: { name: `${prefijoNombre}/${partes.join('/')}`, fields: cuerpo.fields || {} } };
        if (rutas.length) w.updateMask = { fieldPaths: rutas };
        aplicarEscritura(w, ahora);
        return responder(200, documentoSalida(partes.join('/'), documentos.get(partes.join('/'))));
      }
      throw new ErrorApi(404, 'NOT_FOUND', `${req.method} ${url.pathname} no implementado en el doble`);
    } catch (e) {
      const codigo = e instanceof ErrorApi ? e.codigo : 500;
      responder(codigo, { error: { code: codigo, status: e.estado || 'INTERNAL', message: e.message } });
    }
  });

  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const { port } = servidor.address();

  return {
    url: `http://127.0.0.1:${port}`,
    proyecto,
    documentos,
    registro,
    fallos,
    /** Documento en JS plano (o null). */
    leer(coleccion, id) {
      const d = documentos.get(`${coleccion}/${id}`);
      return d ? planoCampos(d.fields) : null;
    },
    /** Todos los documentos de una colección como { id → objeto plano }. */
    todos(coleccion) {
      const o = {};
      for (const [clave, d] of documentos) if (clave.startsWith(`${coleccion}/`)) o[clave.slice(coleccion.length + 1)] = planoCampos(d.fields);
      return o;
    },
    /** Modifica campos de un documento "a mano" (como lo haría la app de recepción). */
    editar(coleccion, id, cambios) {
      const clave = `${coleccion}/${id}`;
      const d = documentos.get(clave);
      if (!d) throw new Error(`no existe ${clave}`);
      const fields = { ...d.fields };
      for (const [k, v] of Object.entries(cambios)) {
        if (v === undefined) delete fields[k]; else fields[k] = codificar(v);
      }
      documentos.set(clave, { ...d, fields, updateTime: new Date().toISOString() });
    },
    /** Crea un documento "a mano". */
    poner(coleccion, id, objeto) {
      const ahora = new Date().toISOString();
      documentos.set(`${coleccion}/${id}`, { fields: codificarCampos(objeto), createTime: ahora, updateTime: ahora });
    },
    reiniciar() { documentos.clear(); registro.solicitudes.length = 0; registro.commits.length = 0; registro.consultas.length = 0; registro.auth.length = 0; },
    cerrar() { return new Promise((resolver) => servidor.close(resolver)); },
  };
}
