#!/usr/bin/env node
/**
 * sync.mjs — Sincronizador de reservas iCal → Firestore · Hostal San Pedro
 *
 * Descarga los calendarios iCal (.ics) de Booking.com, Airbnb, Hostelworld,
 * Expedia u otra plataforma, y deja cada estadía futura como un documento de
 * la colección `reservas` de Firestore (la misma que usa la app de recepción).
 * Sin dependencias: solo Node 20 (fetch, crypto, Intl).
 *
 * Variables de entorno
 *   ICAL_SOURCES              JSON: [{"plataforma":"Booking.com","habitacion":"1","url":"https://..."}, ...]
 *   FIREBASE_SERVICE_ACCOUNT  JSON completo de la cuenta de servicio de Firebase
 *   FIREBASE_PROJECT_ID       (opcional) id del proyecto; por defecto el de la cuenta de servicio
 *
 * Solo para pruebas (se salta la autenticación con Google):
 *   FIRESTORE_BASE_URL        p. ej. http://127.0.0.1:8080  → se usa como base de la API REST
 *   FIRESTORE_EMULATOR_HOST   p. ej. 127.0.0.1:8080         → ídem
 *   SYNC_HOY                  fija la fecha "hoy" (YYYY-MM-DD) en vez de usar el reloj
 *
 * Uso:  node sync.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── Constantes ─────────────────────────────

export const ZONA_HORARIA = 'America/Santiago';
export const COLECCION = 'reservas';
export const ORIGEN = 'ics-auto';
export const PLATAFORMAS = ['Booking.com', 'Airbnb', 'Hostelworld', 'Expedia', 'Otro'];
/** Campos que vienen del calendario y que la sincronización mantiene al día. */
export const CAMPOS_DEL_CALENDARIO = ['plataforma', 'habitacion', 'nombre', 'llegada', 'salida', 'notas'];
export const TAMANO_LOTE = 400; // escrituras por commit (Firestore permite 500)
export const MAX_NOTAS = 300;
export const MAX_UID = 180;
const TIEMPO_ESPERA_MS = 30_000;
const URL_TOKEN = 'https://oauth2.googleapis.com/token';
const ALCANCE = 'https://www.googleapis.com/auth/datastore';
const URL_FIRESTORE = 'https://firestore.googleapis.com';

// ───────────────────────────── Fechas y zonas ─────────────────────────────

const formateadores = new Map();

function formateador(zona) {
  let f = formateadores.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formateadores.set(zona, f);
  }
  return f;
}

/** true si Node conoce la zona horaria IANA (p. ej. "Europe/Madrid"). */
export function zonaValida(zona) {
  try { formateador(zona); return true; } catch { return false; }
}

function partesEnZona(msUtc, zona) {
  const p = {};
  for (const { type, value } of formateador(zona).formatToParts(new Date(msUtc))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return p;
}

const dos = (n) => String(n).padStart(2, '0');

/** Fecha YYYY-MM-DD que corresponde a un instante UTC en la zona indicada. */
export function fechaEnZona(msUtc, zona = ZONA_HORARIA) {
  const p = partesEnZona(msUtc, zona);
  return `${p.year}-${dos(p.month)}-${dos(p.day)}`;
}

/** "Hoy" en la zona del hostal. */
export function hoyEnZona(zona = ZONA_HORARIA, ahoraMs = Date.now()) {
  return fechaEnZona(ahoraMs, zona);
}

function desfaseMs(msUtc, zona) {
  const p = partesEnZona(msUtc, zona);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - msUtc;
}

/** Convierte una hora "de pared" de una zona horaria a instante UTC (ms). */
export function localAUtc({ anio, mes, dia, hora = 0, minuto = 0, segundo = 0 }, zona) {
  const supuesto = Date.UTC(anio, mes - 1, dia, hora, minuto, segundo);
  let utc = supuesto - desfaseMs(supuesto, zona);
  utc = supuesto - desfaseMs(utc, zona); // segunda pasada por si cae en cambio de horario
  return utc;
}

/**
 * Interpreta un valor DTSTART/DTEND de iCal.
 * Acepta fecha (20261020), fecha-hora UTC (20261020T150000Z), con TZID o "flotante"
 * (sin zona → se asume la hora del hostal).
 * Devuelve { fecha: 'YYYY-MM-DD' en la zona del hostal, msUtc, esFecha }.
 */
export function fechaIcal(valor, params = {}, zona = ZONA_HORARIA) {
  const v = String(valor ?? '').trim();
  const esTipoFecha = String(params.VALUE || '').toUpperCase() === 'DATE' || /^\d{8}$/.test(v);
  if (esTipoFecha) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) throw new Error(`fecha iCal no reconocida: "${v}"`);
    const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
    validarFecha(anio, mes, dia, v);
    return { fecha: `${m[1]}-${m[2]}-${m[3]}`, msUtc: Date.UTC(anio, mes - 1, dia), esFecha: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) throw new Error(`fecha-hora iCal no reconocida: "${v}"`);
  const partes = { anio: +m[1], mes: +m[2], dia: +m[3], hora: +m[4], minuto: +m[5], segundo: +(m[6] || 0) };
  validarFecha(partes.anio, partes.mes, partes.dia, v);
  let msUtc;
  if (m[7]) {
    msUtc = Date.UTC(partes.anio, partes.mes - 1, partes.dia, partes.hora, partes.minuto, partes.segundo);
  } else {
    const tzid = String(params.TZID || '').trim();
    const zonaEvento = tzid && zonaValida(tzid) ? tzid : zona; // TZID desconocido → hora del hostal
    msUtc = localAUtc(partes, zonaEvento);
  }
  return { fecha: fechaEnZona(msUtc, zona), msUtc, esFecha: false };
}

function validarFecha(anio, mes, dia, original) {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 1970 || anio > 2200) {
    throw new Error(`fecha iCal fuera de rango: "${original}"`);
  }
}

/** Duración iCal (P3D, P1W, PT2H30M, P1DT12H) en milisegundos; null si no se entiende. */
export function duracionMs(valor) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(valor ?? '').trim());
  if (!m) return null;
  const signo = m[1] === '-' ? -1 : 1;
  const segundos = (+(m[2] || 0)) * 7 * 86400 + (+(m[3] || 0)) * 86400
    + (+(m[4] || 0)) * 3600 + (+(m[5] || 0)) * 60 + (+(m[6] || 0));
  return signo * segundos * 1000;
}

// ───────────────────────────── Parser iCal ─────────────────────────────

/** Deshace el plegado de líneas (RFC 5545: una línea que empieza con espacio o tabulador continúa la anterior). */
export function desplegarLineas(texto) {
  const lineas = String(texto ?? '').replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const salida = [];
  for (const linea of lineas) {
    if ((linea.startsWith(' ') || linea.startsWith('\t')) && salida.length) {
      salida[salida.length - 1] += linea.slice(1);
    } else {
      salida.push(linea);
    }
  }
  return salida.filter((l) => l.length > 0);
}

/** Deshace los escapes de texto iCal: \, \; \n \N \\ */
export function desescaparTexto(texto) {
  return String(texto ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Separa "NOMBRE;PARAM=valor;OTRO="a:b":valor" en { nombre, params, valor }. */
export function partirLinea(linea) {
  let i = 0;
  let comillas = false;
  for (; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') comillas = !comillas;
    else if (c === ':' && !comillas) break;
  }
  if (i >= linea.length) return null;
  const cabecera = linea.slice(0, i);
  const valor = linea.slice(i + 1);
  const trozos = [];
  let actual = '';
  comillas = false;
  for (const c of cabecera) {
    if (c === '"') { comillas = !comillas; continue; }
    if (c === ';' && !comillas) { trozos.push(actual); actual = ''; } else actual += c;
  }
  trozos.push(actual);
  const nombre = trozos[0].trim().toUpperCase();
  if (!nombre) return null;
  const params = {};
  for (const t of trozos.slice(1)) {
    const eq = t.indexOf('=');
    if (eq > 0) params[t.slice(0, eq).trim().toUpperCase()] = t.slice(eq + 1).trim();
  }
  return { nombre, params, valor };
}

/**
 * Extrae los VEVENT de un texto iCal.
 * Devuelve [{ uid, summary, description, status, dtstart, dtend, duration }], donde
 * dtstart/dtend son { valor, params } (o null) para interpretarlos con fechaIcal().
 */
export function parsearIcs(texto) {
  const eventos = [];
  let actual = null;    // VEVENT en construcción
  let anidados = 0;     // componentes dentro del VEVENT (VALARM...) que se ignoran
  for (const linea of desplegarLineas(texto)) {
    const p = partirLinea(linea);
    if (!p) continue;
    const { nombre, params, valor } = p;
    if (nombre === 'BEGIN') {
      const componente = valor.trim().toUpperCase();
      if (actual) anidados++;
      else if (componente === 'VEVENT') actual = {};
      continue;
    }
    if (nombre === 'END') {
      if (actual && anidados > 0) { anidados--; continue; }
      if (actual && valor.trim().toUpperCase() === 'VEVENT') { eventos.push(actual); actual = null; }
      continue;
    }
    if (!actual || anidados > 0) continue;
    if (!(nombre in actual)) actual[nombre] = { valor, params }; // la primera aparición manda
  }
  return eventos.map((pr) => ({
    uid: pr.UID ? desescaparTexto(pr.UID.valor).trim() : '',
    summary: pr.SUMMARY ? desescaparTexto(pr.SUMMARY.valor).trim() : '',
    description: pr.DESCRIPTION ? desescaparTexto(pr.DESCRIPTION.valor).trim() : '',
    status: pr.STATUS ? pr.STATUS.valor.trim().toUpperCase() : '',
    dtstart: pr.DTSTART || null,
    dtend: pr.DTEND || null,
    duration: pr.DURATION ? pr.DURATION.valor.trim() : null,
  }));
}

// ───────────────────────────── Evento → documento ─────────────────────────────

/** true si el SUMMARY describe un bloqueo de fechas y no una reserva. */
export function esBloqueo(summary) {
  const s = String(summary ?? '').toLowerCase();
  return /closed|not available|no disponible|bloque|unavailable/.test(s) && !/reserv/.test(s);
}

/** Nombre que verá recepción: "Bloqueo", el SUMMARY sin prefijo "Reserved -", o "Reserva <plataforma>". */
export function nombreDesdeSummary(summary, plataforma) {
  if (esBloqueo(summary)) return 'Bloqueo';
  const limpio = String(summary ?? '')
    .replace(/^\s*(reserved|reservation|reservada|reservado|reserva)\s*(?:[-–—:]\s*|$)/i, '')
    .trim();
  return limpio || `Reserva ${plataforma}`;
}

/** Id de documento: hash corto y estable del uid. */
export function idDocumento(uid) {
  return crypto.createHash('sha1').update(String(uid), 'utf8').digest('hex').slice(0, 28);
}

const elegir = (obj, campos) => Object.fromEntries(campos.map((c) => [c, obj[c]]));

/**
 * Convierte un VEVENT en { id, doc } con los campos de la colección `reservas`.
 * Devuelve null si el evento ya pasó (salida < hoy) o viene cancelado (STATUS:CANCELLED).
 * Lanza si el evento no se puede interpretar.
 */
export function eventoADocumento(ev, fuente, hoy, ahoraIso) {
  if (ev.status === 'CANCELLED') return null;
  if (!ev.dtstart) throw new Error('evento sin DTSTART');
  const inicio = fechaIcal(ev.dtstart.valor, ev.dtstart.params);
  let fechaFin;
  if (ev.dtend) {
    fechaFin = fechaIcal(ev.dtend.valor, ev.dtend.params).fecha;
  } else {
    const dur = ev.duration ? duracionMs(ev.duration) : null;
    const ms = inicio.msUtc + (dur ?? (inicio.esFecha ? 86_400_000 : 0));
    fechaFin = inicio.esFecha ? new Date(ms).toISOString().slice(0, 10) : fechaEnZona(ms);
  }
  const llegada = inicio.fecha;
  const salida = fechaFin;
  if (salida < llegada) throw new Error(`salida (${salida}) anterior a la llegada (${llegada})`);
  if (salida < hoy) return null;

  const uid = (ev.uid || `${fuente.plataforma}|${fuente.habitacion}|${llegada}|${salida}`).slice(0, MAX_UID);
  const nombre = nombreDesdeSummary(ev.summary, fuente.plataforma);
  const doc = {
    plataforma: fuente.plataforma,
    codigo: '',
    nombre,
    apellido: '',
    nombreCompleto: nombre,
    nacionalidad: '',
    llegada,
    salida,
    personas: 1,
    habitacion: fuente.habitacion,
    telefono: '',
    email: '',
    total: 0,
    notas: ev.description.slice(0, MAX_NOTAS),
    estado: 'reservada',
    origen: ORIGEN,
    uid,
    creadoEn: ahoraIso,
    actualizadoEn: ahoraIso,
  };
  return { id: idDocumento(uid), doc };
}

/**
 * Decide qué escribir sobre un documento que ya existe.
 * - Solo se vuelven a escribir los campos del calendario que cambiaron respecto a lo
 *   que la sincronización escribió la última vez (icsDatos); así se respetan las
 *   correcciones que recepción haga a mano (p. ej. ponerle nombre a un "Bloqueo").
 * - `estado` nunca se pisa, salvo para reactivar una reserva que esta misma
 *   sincronización había cancelado y que volvió a aparecer en el calendario.
 * Devuelve null si no hay nada que escribir.
 */
export function planificarActualizacion(actual, nuevo, ahoraIso) {
  const previos = actual.icsDatos && typeof actual.icsDatos === 'object' ? actual.icsDatos : actual;
  const campos = {};
  for (const campo of CAMPOS_DEL_CALENDARIO) {
    if (previos[campo] !== nuevo[campo]) {
      campos[campo] = nuevo[campo];
      if (campo === 'nombre') campos.nombreCompleto = nuevo.nombre;
    }
  }
  const reactivar = actual.estado === 'cancelada' && actual.canceladoPor === ORIGEN;
  const eliminar = [];
  if (reactivar) {
    campos.estado = 'reservada';
    eliminar.push('canceladoEn', 'canceladoPor');
  }
  if (Object.keys(campos).length === 0) return null;
  campos.icsDatos = elegir(nuevo, CAMPOS_DEL_CALENDARIO);
  campos.actualizadoEn = ahoraIso;
  return { campos, eliminar, reactivar };
}

// ───────────────────────────── Firestore (API REST) ─────────────────────────────

export function aValorFirestore(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(aValorFirestore) } };
  if (typeof v === 'object') return { mapValue: { fields: codificarCampos(v) } };
  throw new Error(`Tipo no soportado para Firestore: ${typeof v}`);
}

export function codificarCampos(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = aValorFirestore(v);
  return fields;
}

export function deValorFirestore(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodificarCampos(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deValorFirestore);
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

export function decodificarCampos(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = deValorFirestore(v);
  return obj;
}

/** Cliente mínimo de la API REST de Firestore (runQuery y commit). */
export class Firestore {
  constructor({ baseUrl = URL_FIRESTORE, proyecto, token, fetchImpl = globalThis.fetch, tiempoEsperaMs = TIEMPO_ESPERA_MS }) {
    if (!proyecto) throw new Error('Falta el id del proyecto de Firebase.');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.prefijo = `projects/${proyecto}/databases/(default)/documents`;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.tiempoEsperaMs = tiempoEsperaMs;
  }

  nombreDocumento(coleccion, id) {
    return `${this.prefijo}/${coleccion}/${id}`;
  }

  async solicitar(metodo, sufijo, cuerpo) {
    const url = `${this.baseUrl}/v1/${this.prefijo}${sufijo}`;
    const res = await this.fetchImpl(url, {
      method: metodo,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(this.tiempoEsperaMs),
    });
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { /* no era JSON */ }
    if (!res.ok) {
      const detalle = json?.error?.message
        || (Array.isArray(json) && json.find((x) => x?.error)?.error?.message)
        || texto.slice(0, 200);
      throw new Error(`Firestore ${metodo} ${sufijo} → HTTP ${res.status}: ${detalle}`);
    }
    return json;
  }

  /** Ejecuta una structuredQuery y devuelve los documentos ({ name, fields, ... }). */
  async consultar(structuredQuery) {
    const r = await this.solicitar('POST', ':runQuery', { structuredQuery });
    return (Array.isArray(r) ? r : []).filter((x) => x && x.document).map((x) => x.document);
  }

  /** Aplica un lote de escrituras de forma atómica. */
  async commit(writes) {
    return this.solicitar('POST', ':commit', { writes });
  }
}

// ───────────────────────────── Autenticación con Google ─────────────────────────────

const base64url = (datos) => Buffer.from(datos).toString('base64url');

/** JWT RS256 firmado con la clave privada de la cuenta de servicio. */
export function crearJwt(cuenta, { ahora = Math.floor(Date.now() / 1000), alcance = ALCANCE } = {}) {
  const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const aud = cuenta.token_uri || URL_TOKEN;
  const cuerpo = base64url(JSON.stringify({
    iss: cuenta.client_email, scope: alcance, aud, iat: ahora, exp: ahora + 3600,
  }));
  const firma = crypto.sign('sha256', Buffer.from(`${cabecera}.${cuerpo}`), cuenta.private_key);
  return `${cabecera}.${cuerpo}.${base64url(firma)}`;
}

/** Canjea el JWT por un token OAuth de acceso. */
export async function obtenerToken(cuenta, { fetchImpl = globalThis.fetch } = {}) {
  const jwt = crearJwt(cuenta);
  const res = await fetchImpl(cuenta.token_uri || URL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
    signal: AbortSignal.timeout(TIEMPO_ESPERA_MS),
  });
  const texto = await res.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* no era JSON */ }
  if (!res.ok || !json?.access_token) {
    const detalle = json?.error_description || json?.error || texto.slice(0, 200);
    throw new Error(`No se pudo obtener el token de Google (HTTP ${res.status}): ${detalle}`);
  }
  return json.access_token;
}

export function leerCuentaServicio(texto) {
  if (!texto || !String(texto).trim()) {
    throw new Error('Falta el secreto FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).');
  }
  let cuenta;
  try { cuenta = JSON.parse(texto); } catch (e) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT no es JSON válido: ${e.message}`);
  }
  for (const campo of ['client_email', 'private_key', 'project_id']) {
    if (!cuenta[campo]) throw new Error(`FIREBASE_SERVICE_ACCOUNT no trae el campo "${campo}".`);
  }
  cuenta.private_key = String(cuenta.private_key).replace(/\\n/g, '\n'); // por si se pegó con \n literales
  return cuenta;
}

// ───────────────────────────── Configuración ─────────────────────────────

export function normalizarPlataforma(valor) {
  const texto = String(valor ?? '').trim();
  if (!texto) return 'Otro';
  const clave = texto.toLowerCase().replace(/\.com$/, '');
  const conocida = PLATAFORMAS.find((p) => p.toLowerCase().replace(/\.com$/, '') === clave);
  return conocida || texto;
}

/** Valida ICAL_SOURCES y devuelve [{ plataforma, habitacion, url, etiqueta }]. */
export function leerFuentes(texto) {
  if (!texto || !String(texto).trim()) {
    throw new Error('Falta el secreto ICAL_SOURCES (lista JSON de calendarios).');
  }
  let lista;
  try { lista = JSON.parse(texto); } catch (e) {
    throw new Error(`ICAL_SOURCES no es JSON válido: ${e.message}`);
  }
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Error('ICAL_SOURCES debe ser una lista JSON con al menos un calendario.');
  }
  return lista.map((f, i) => {
    const n = i + 1;
    if (!f || typeof f !== 'object') throw new Error(`ICAL_SOURCES: la entrada #${n} no es un objeto.`);
    const url = String(f.url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(`ICAL_SOURCES: la entrada #${n} no tiene una "url" http(s) válida.`);
    const habitacion = String(f.habitacion ?? '').trim();
    if (!habitacion) throw new Error(`ICAL_SOURCES: la entrada #${n} no tiene "habitacion".`);
    const plataforma = normalizarPlataforma(f.plataforma);
    return { plataforma, habitacion, url, etiqueta: `${plataforma} · hab. ${habitacion}` };
  });
}

/** Descarga un .ics y comprueba que de verdad sea un calendario. */
export async function descargarIcs(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'HostalSanPedro-sync-ical/1.0', Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIEMPO_ESPERA_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar el calendario`);
  const texto = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(texto)) {
    throw new Error('la respuesta no es un calendario iCal (¿URL incorrecta o caducada?)');
  }
  return texto;
}

/** Crea el cliente de Firestore: contra Google (con cuenta de servicio) o contra un doble local. */
export async function conectarFirestore(env, { fetchImpl } = {}) {
  const local = env.FIRESTORE_BASE_URL || (env.FIRESTORE_EMULATOR_HOST ? `http://${env.FIRESTORE_EMULATOR_HOST}` : '');
  if (local) {
    let proyecto = env.FIREBASE_PROJECT_ID;
    if (!proyecto) {
      try { proyecto = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}').project_id; } catch { /* sin cuenta */ }
    }
    proyecto = proyecto || 'demo-hostal';
    return { firestore: new Firestore({ baseUrl: local, proyecto, token: 'owner', fetchImpl }), proyecto, modo: 'local' };
  }
  const cuenta = leerCuentaServicio(env.FIREBASE_SERVICE_ACCOUNT);
  const proyecto = env.FIREBASE_PROJECT_ID || cuenta.project_id;
  const token = await obtenerToken(cuenta, { fetchImpl });
  return { firestore: new Firestore({ proyecto, token, fetchImpl }), proyecto, modo: 'google' };
}

// ───────────────────────────── Sincronización ─────────────────────────────

const CONTADORES = ['leidos', 'vigentes', 'nuevas', 'actualizadas', 'reactivadas', 'canceladas', 'sinCambios', 'errores'];

/**
 * Sincroniza las fuentes con Firestore. Devuelve el resumen (ver imprimirResumen).
 * @param {object} o
 * @param {Array}    o.fuentes    salida de leerFuentes()
 * @param {Firestore} o.firestore
 * @param {string}   o.hoy        YYYY-MM-DD en la zona del hostal
 */
export async function sincronizar({ fuentes, firestore, hoy, ahora = () => new Date().toISOString(), log = console.log, fetchImpl = globalThis.fetch }) {
  const ahoraIso = ahora();
  const estadisticas = fuentes.map((fuente) => ({
    fuente, ...Object.fromEntries(CONTADORES.map((c) => [c, 0])), error: null, avisos: [],
  }));
  const erroresGlobales = [];

  // 1. Descargar y parsear todos los calendarios en paralelo (una fuente caída no detiene a las demás).
  log(`Descargando ${fuentes.length} calendario(s)…`);
  const descargas = await Promise.allSettled(fuentes.map((f) => descargarIcs(f.url, fetchImpl)));
  const resultados = descargas.map((r, i) => {
    const est = estadisticas[i];
    const etiqueta = `[${i + 1}/${fuentes.length}] ${fuentes[i].etiqueta}`;
    if (r.status === 'rejected') {
      est.errores++;
      est.error = r.reason?.name === 'TimeoutError' ? 'tiempo de espera agotado al descargar' : (r.reason?.message || String(r.reason));
      log(`${etiqueta}: ERROR — ${est.error}`);
      return { ok: false, eventos: [] };
    }
    try {
      const eventos = parsearIcs(r.value);
      est.leidos = eventos.length;
      log(`${etiqueta}: ${eventos.length} evento(s) leído(s)`);
      return { ok: true, eventos };
    } catch (e) {
      est.errores++;
      est.error = `no se pudo interpretar el calendario: ${e.message}`;
      log(`${etiqueta}: ERROR — ${est.error}`);
      return { ok: false, eventos: [] };
    }
  });

  // 2. Reservas vigentes que ya están en Firestore (salida >= hoy); nos quedamos con las de origen ics-auto.
  //    Se consulta por `salida` y no por `origen` para leer solo las reservas actuales y no todo el historial.
  const documentos = await firestore.consultar({
    from: [{ collectionId: COLECCION }],
    where: { fieldFilter: { field: { fieldPath: 'salida' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: hoy } } },
  });
  const existentes = new Map();
  for (const d of documentos) {
    const datos = decodificarCampos(d.fields);
    if (datos.origen !== ORIGEN) continue;
    existentes.set(d.name.split('/').pop(), { nombre: d.name, datos });
  }
  log(`Reservas vigentes en Firestore con origen "${ORIGEN}": ${existentes.size}`);

  // 3. Planificar escrituras.
  const escrituras = []; // { indice, tipo, write }
  const vistos = new Map(); // id de documento → índice de la fuente que lo aportó
  resultados.forEach((r, i) => {
    if (!r.ok) return;
    const est = estadisticas[i];
    for (const ev of r.eventos) {
      let convertido;
      try {
        convertido = eventoADocumento(ev, fuentes[i], hoy, ahoraIso);
      } catch (e) {
        est.errores++;
        est.avisos.push(`evento ${ev.uid || '(sin UID)'} ignorado: ${e.message}`);
        continue;
      }
      if (!convertido) continue; // pasado o cancelado
      const { id, doc } = convertido;
      if (vistos.has(id)) {
        est.avisos.push(`evento repetido (uid "${doc.uid}") ignorado; ya lo aportó ${fuentes[vistos.get(id)].etiqueta}`);
        continue;
      }
      vistos.set(id, i);
      est.vigentes++;
      const existente = existentes.get(id);
      if (!existente) {
        const completo = { ...doc, icsDatos: elegir(doc, CAMPOS_DEL_CALENDARIO) };
        escrituras.push({ indice: i, tipo: 'nuevas', write: { update: { name: firestore.nombreDocumento(COLECCION, id), fields: codificarCampos(completo) } } });
        continue;
      }
      const plan = planificarActualizacion(existente.datos, doc, ahoraIso);
      if (!plan) { est.sinCambios++; continue; }
      escrituras.push({
        indice: i,
        tipo: plan.reactivar ? 'reactivadas' : 'actualizadas',
        write: {
          update: { name: existente.nombre, fields: codificarCampos(plan.campos) },
          updateMask: { fieldPaths: [...Object.keys(plan.campos), ...plan.eliminar] },
        },
      });
    }
  });

  // 3b. Cancelaciones: reservas nuestras, aún "reservada", con llegada hoy o futura, que ya no están en su calendario.
  let sinFuente = 0;
  for (const [id, ex] of existentes) {
    if (vistos.has(id)) continue;
    const d = ex.datos;
    if (d.estado !== 'reservada' || !(typeof d.llegada === 'string' && d.llegada >= hoy)) continue;
    const i = fuentes.findIndex((f) => f.plataforma === d.plataforma && f.habitacion === d.habitacion);
    if (i < 0) { sinFuente++; continue; }      // ya no hay calendario configurado para ella: no se toca
    if (!resultados[i].ok) continue;             // su calendario falló hoy: no cancelamos nada
    escrituras.push({
      indice: i,
      tipo: 'canceladas',
      write: {
        update: { name: ex.nombre, fields: codificarCampos({ estado: 'cancelada', canceladoEn: ahoraIso, canceladoPor: ORIGEN, actualizadoEn: ahoraIso }) },
        updateMask: { fieldPaths: ['estado', 'canceladoEn', 'canceladoPor', 'actualizadoEn'] },
      },
    });
  }
  if (sinFuente) log(`AVISO: ${sinFuente} reserva(s) ${ORIGEN} sin calendario configurado (plataforma/habitación); no se tocan.`);

  // 4. Escribir en lotes.
  const lotes = [];
  for (let i = 0; i < escrituras.length; i += TAMANO_LOTE) lotes.push(escrituras.slice(i, i + TAMANO_LOTE));
  let lotesFallidos = 0;
  if (escrituras.length === 0) log('Nada que escribir: Firestore ya está al día.');
  else log(`Escribiendo ${escrituras.length} cambio(s) en ${lotes.length} lote(s)…`);
  for (const [n, lote] of lotes.entries()) {
    try {
      await firestore.commit(lote.map((e) => e.write));
      for (const e of lote) estadisticas[e.indice][e.tipo]++;
    } catch (e) {
      lotesFallidos++;
      for (const w of lote) estadisticas[w.indice].errores++;
      erroresGlobales.push(`Lote ${n + 1}/${lotes.length} (${lote.length} escrituras) falló: ${e.message}`);
      log(`ERROR en el lote ${n + 1}/${lotes.length}: ${e.message}`);
    }
  }

  const totales = Object.fromEntries(CONTADORES.map((c) => [c, estadisticas.reduce((s, e) => s + e[c], 0)]));
  const todasFallaron = resultados.length > 0 && resultados.every((r) => !r.ok);
  if (todasFallaron) erroresGlobales.push('Ningún calendario se pudo descargar.');
  return {
    hoy, ahora: ahoraIso, estadisticas, totales, existentes: existentes.size, sinFuente,
    escrituras: escrituras.length, lotes: lotes.length, lotesFallidos, errores: erroresGlobales,
    codigoSalida: todasFallaron || lotesFallidos > 0 ? 1 : 0,
  };
}

// ───────────────────────────── Resumen ─────────────────────────────

const CABECERAS = ['Fuente', 'Leídos', 'Vigentes', 'Nuevas', 'Actualizadas', 'Reactivadas', 'Canceladas', 'Sin cambios', 'Errores'];

function filasResumen(resumen) {
  const filas = resumen.estadisticas.map((e) => [e.fuente.etiqueta, ...CONTADORES.map((c) => e[c])]);
  filas.push(['TOTAL', ...CONTADORES.map((c) => resumen.totales[c])]);
  return filas;
}

function tablaTexto(cabeceras, filas) {
  const anchos = cabeceras.map((c, i) => Math.max(c.length, ...filas.map((f) => String(f[i]).length)));
  const linea = (f) => f.map((c, i) => (i === 0 ? String(c).padEnd(anchos[i]) : String(c).padStart(anchos[i]))).join('  ');
  return [linea(cabeceras), anchos.map((a) => '─'.repeat(a)).join('  '), ...filas.map(linea)].join('\n');
}

export function imprimirResumen(resumen, log = console.log) {
  log('');
  log('═══ Resumen de la sincronización ═══');
  log(`Hoy (${ZONA_HORARIA}): ${resumen.hoy} · reservas vigentes ya en Firestore: ${resumen.existentes}`);
  log(tablaTexto(CABECERAS, filasResumen(resumen)));
  const conError = resumen.estadisticas.filter((e) => e.error);
  if (conError.length) {
    log('Calendarios con error (sus reservas NO se tocaron):');
    for (const e of conError) log(`  - ${e.fuente.etiqueta}: ${e.error}`);
  }
  const conAvisos = resumen.estadisticas.filter((e) => e.avisos.length);
  for (const e of conAvisos) for (const a of e.avisos) log(`  AVISO ${e.fuente.etiqueta}: ${a}`);
  for (const e of resumen.errores) log(`ERROR: ${e}`);
  log(`Escrituras: ${resumen.escrituras} en ${resumen.lotes} lote(s)${resumen.lotesFallidos ? ` · ${resumen.lotesFallidos} lote(s) fallido(s)` : ''} · resultado: ${resumen.codigoSalida === 0 ? 'OK' : 'CON ERRORES'}`);
}

/** Resumen en Markdown para la página del run de GitHub Actions ($GITHUB_STEP_SUMMARY). */
export function resumenMarkdown(resumen) {
  const filas = filasResumen(resumen);
  const md = [
    '## Sincronización iCal → Firestore · Hostal San Pedro',
    '',
    `Hoy (${ZONA_HORARIA}): **${resumen.hoy}** · resultado: **${resumen.codigoSalida === 0 ? 'OK' : 'CON ERRORES'}** · escrituras: ${resumen.escrituras}`,
    '',
    `| ${CABECERAS.join(' | ')} |`,
    `| ${CABECERAS.map((c, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...filas.map((f) => `| ${f.join(' | ')} |`),
  ];
  const conError = resumen.estadisticas.filter((e) => e.error);
  if (conError.length) {
    md.push('', '**Calendarios con error** (sus reservas no se tocaron):', '');
    for (const e of conError) md.push(`- ${e.fuente.etiqueta}: ${e.error}`);
  }
  for (const e of resumen.estadisticas) for (const a of e.avisos) md.push(`- Aviso ${e.fuente.etiqueta}: ${a}`);
  if (resumen.errores.length) {
    md.push('', '**Errores:**', '');
    for (const e of resumen.errores) md.push(`- ${e}`);
  }
  return `${md.join('\n')}\n`;
}

// ───────────────────────────── Programa principal ─────────────────────────────

export async function main(env = process.env, log = console.log) {
  const enActions = env.GITHUB_ACTIONS === 'true';
  log('Sincronizador de reservas iCal → Firestore · Hostal San Pedro');
  const fuentes = leerFuentes(env.ICAL_SOURCES);
  const hoy = env.SYNC_HOY && /^\d{4}-\d{2}-\d{2}$/.test(env.SYNC_HOY) ? env.SYNC_HOY : hoyEnZona();
  const { firestore, proyecto, modo } = await conectarFirestore(env);
  log(`Proyecto: ${proyecto} · modo: ${modo === 'local' ? 'doble local (sin autenticación)' : 'Google Firestore'} · hoy: ${hoy} · fuentes: ${fuentes.length}`);

  const resumen = await sincronizar({ fuentes, firestore, hoy, log });
  imprimirResumen(resumen, log);

  if (enActions) {
    for (const e of resumen.estadisticas) {
      if (e.error) log(`::warning title=Calendario con error::${e.fuente.etiqueta}: ${e.error}`);
    }
    for (const e of resumen.errores) log(`::error title=Sincronización::${e}`);
    if (env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, resumenMarkdown(resumen)); } catch (e) { log(`AVISO: no se pudo escribir el resumen del run: ${e.message}`); }
    }
  }
  return resumen.codigoSalida;
}

const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esPrincipal) {
  main().then((codigo) => { process.exitCode = codigo; }).catch((e) => {
    const mensaje = e?.message || String(e);
    console.error(`ERROR FATAL: ${mensaje}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Sincronización::${mensaje}`);
    process.exitCode = 1;
  });
}
