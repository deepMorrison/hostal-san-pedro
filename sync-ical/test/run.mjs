#!/usr/bin/env node
/**
 * Pruebas del sincronizador: `node test/run.mjs`
 *
 * Levanta un servidor local con calendarios .ics de ejemplo, un doble de Firestore
 * (API REST en memoria) y un doble del endpoint OAuth de Google; luego ejecuta
 * `node sync.mjs` como proceso aparte en distintos escenarios y comprueba el
 * resultado. Termina con código 0 si todo pasa.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { crearDobleFirestore } from './firestore-doble.mjs';
import { crearServidorIcs } from './servidor-ics.mjs';
import { crearDobleOauth } from './oauth-doble.mjs';
import * as sync from '../sync.mjs';

const HOY = '2026-10-14'; // "hoy" fijo para que las muestras no caduquen
const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUTA_SYNC = path.join(DIR, '..', 'sync.mjs');
const COL = sync.COLECCION;
const muestra = (nombre) => fs.readFileSync(path.join(DIR, 'muestras', nombre), 'utf8');
const id = (uid) => sync.idDocumento(uid);
const esIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);

// ───────────── mini marco de pruebas ─────────────
const resultados = [];
let seccionActual = '';
function seccion(titulo) { seccionActual = titulo; console.log(`\n■ ${titulo}`); }
async function prueba(nombre, fn) {
  try {
    await fn();
    resultados.push({ seccion: seccionActual, nombre, ok: true });
    console.log(`  ✔ ${nombre}`);
  } catch (e) {
    resultados.push({ seccion: seccionActual, nombre, ok: false, error: e });
    console.log(`  ✘ ${nombre}\n    ${String(e?.stack || e).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

// ───────────── utilidades sobre calendarios ─────────────
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function quitarEvento(ics, uid) {
  const re = new RegExp(`^UID:${escapar(uid)}\\r?$`, 'm');
  let quitados = 0;
  const salida = ics.replace(/BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT\r?\n/g, (bloque) => {
    if (re.test(bloque)) { quitados++; return ''; }
    return bloque;
  });
  assert.equal(quitados, 1, `no se encontró el evento ${uid} para quitarlo`);
  return salida;
}
function cambiar(ics, de, a) {
  assert.ok(ics.includes(de), `no se encontró "${de}" en el calendario`);
  return ics.replace(de, a);
}
function calendarioGrande(n) {
  const lineas = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Prueba//Lotes//ES'];
  for (let i = 0; i < n; i++) {
    const inicio = new Date(Date.UTC(2026, 10, 1 + i)); // desde el 1 de noviembre de 2026, un día por evento
    const fin = new Date(inicio.getTime() + 2 * 86_400_000);
    const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    lineas.push('BEGIN:VEVENT', `UID:grande-${i}@prueba`, `DTSTART;VALUE=DATE:${ymd(inicio)}`, `DTEND;VALUE=DATE:${ymd(fin)}`, `SUMMARY:Reserved - Huésped ${i}`, 'END:VEVENT');
  }
  lineas.push('END:VCALENDAR');
  return `${lineas.join('\r\n')}\r\n`;
}

// ───────────── ejecución de sync.mjs como proceso aparte ─────────────
function ejecutarSync(env) {
  return new Promise((resolver) => {
    const entorno = { ...process.env, ...env };
    delete entorno.GITHUB_ACTIONS;
    delete entorno.GITHUB_STEP_SUMMARY;
    const hijo = spawn(process.execPath, [RUTA_SYNC], { env: entorno, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    hijo.on('close', (codigo) => resolver({ codigo, salida }));
  });
}

// ═════════════════════════════ PRUEBAS ═════════════════════════════

seccion('Parser iCal y fechas (en proceso)');

await prueba('desplegar líneas plegadas con CRLF, espacio y tabulador', () => {
  const lineas = sync.desplegarLineas('﻿A:uno\r\n dos\r\n\ttres\r\nB:x\n y\r\n');
  assert.deepEqual(lineas, ['A:unodostres', 'B:xy']);
});

await prueba('partir línea con parámetros entre comillas que contienen ":" y ";"', () => {
  const p = sync.partirLinea('DTSTART;TZID="America/Santiago";X-RARO="a:b;c":20261020T100000');
  assert.deepEqual(p, { nombre: 'DTSTART', params: { TZID: 'America/Santiago', 'X-RARO': 'a:b;c' }, valor: '20261020T100000' });
  assert.equal(sync.partirLinea('sin dos puntos'), null);
});

await prueba('desescapar \\, \\; \\n \\N y \\\\', () => {
  assert.equal(sync.desescaparTexto('a\\, b\\; c\\nd\\Ne\\\\f'), 'a, b; c\nd\ne\\f');
});

await prueba('duraciones iCal', () => {
  assert.equal(sync.duracionMs('P3D'), 3 * 86_400_000);
  assert.equal(sync.duracionMs('P1W'), 7 * 86_400_000);
  assert.equal(sync.duracionMs('PT1H30M'), 5_400_000);
  assert.equal(sync.duracionMs('P1DT12H'), 36 * 3_600_000);
  assert.equal(sync.duracionMs('-PT15M'), -900_000);
  assert.equal(sync.duracionMs('tres días'), null);
});

await prueba('fechas: solo fecha, UTC, TZID, flotante y TZID desconocido', () => {
  assert.equal(sync.fechaIcal('20261020', { VALUE: 'DATE' }).fecha, '2026-10-20');
  assert.equal(sync.fechaIcal('20261020').fecha, '2026-10-20');
  assert.equal(sync.fechaIcal('20261201T020000Z').fecha, '2026-11-30');            // 02:00 UTC = 23:00 del día anterior en Chile (UTC-3)
  assert.equal(sync.fechaIcal('20260701T020000Z').fecha, '2026-06-30');            // en invierno Chile está en UTC-4
  assert.equal(sync.fechaIcal('20261120T030000', { TZID: 'Europe/Madrid' }).fecha, '2026-11-19');
  assert.equal(sync.fechaIcal('20261215T140000').fecha, '2026-12-15');             // flotante → hora del hostal
  assert.equal(sync.fechaIcal('20270105T000500', { TZID: 'Zona/Inventada' }).fecha, '2027-01-05');
  assert.throws(() => sync.fechaIcal('2026-10-20'), /no reconocida/);
  assert.throws(() => sync.fechaIcal('20261340'), /fuera de rango/);
  assert.equal(sync.hoyEnZona('America/Santiago', Date.UTC(2026, 9, 15, 2, 30)), '2026-10-14'); // 02:30 UTC del 15 = 23:30 del 14 en Chile
});

await prueba('parsear VEVENT: primera propiedad manda, VALARM anidado se ignora, STATUS', () => {
  const eventos = sync.parsearIcs(muestra('airbnb.ics'));
  assert.equal(eventos.length, 3);
  assert.equal(eventos[0].summary, 'Reserved');
  assert.equal(eventos[0].description, 'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH\nPhone Number (Last 4 Digits): 4321');
  assert.equal(eventos[2].summary, 'Reserved - Familia Pérez, López');
  assert.ok(eventos[2].description.startsWith('Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMLARGOLARGO\nPhone'));
  assert.ok(eventos[2].description.includes('una bici para recorrer el pueblo'));
  assert.ok(!eventos[2].description.includes('Recordatorio'), 'la DESCRIPTION del VALARM no debe pisar la del evento');
  assert.equal(eventos[2].uid.length, 197, 'el UID plegado en 3 líneas se reconstruye completo');
  assert.ok(eventos[2].uid.length > sync.MAX_UID, 'la muestra debe superar los 180 caracteres para probar el recorte');
  const zonas = sync.parsearIcs(muestra('zonas.ics'));
  assert.equal(zonas.length, 7);
  assert.equal(zonas.find((e) => e.uid === 'tz-cancelado@otro').status, 'CANCELLED');
  assert.equal(zonas.find((e) => e.uid === 'tz-duracion@otro').duration, 'P3D');
});

seccion('Reglas de conversión (en proceso)');

await prueba('bloqueos y nombres', () => {
  assert.equal(sync.nombreDesdeSummary('CLOSED - Not available', 'Booking.com'), 'Bloqueo');
  assert.equal(sync.nombreDesdeSummary('Airbnb (Not available)', 'Airbnb'), 'Bloqueo');
  assert.equal(sync.nombreDesdeSummary('No disponible', 'Otro'), 'Bloqueo');
  assert.equal(sync.nombreDesdeSummary('Bloqueo mantención', 'Otro'), 'Bloqueo');
  assert.equal(sync.nombreDesdeSummary('Unavailable', 'Otro'), 'Bloqueo');
  assert.equal(sync.nombreDesdeSummary('Unavailable (reserved)', 'Otro'), 'Unavailable (reserved)'); // contiene "reserv"
  assert.equal(sync.nombreDesdeSummary('Reserved', 'Airbnb'), 'Reserva Airbnb');
  assert.equal(sync.nombreDesdeSummary('Reserved - Juan Pérez', 'Booking.com'), 'Juan Pérez');
  assert.equal(sync.nombreDesdeSummary('Reserva - Juan Pérez', 'Booking.com'), 'Juan Pérez');
  assert.equal(sync.nombreDesdeSummary('Reserva: Juan', 'Otro'), 'Juan');
  assert.equal(sync.nombreDesdeSummary('Reserva de Juan', 'Otro'), 'Reserva de Juan'); // sin separador no se recorta
  assert.equal(sync.nombreDesdeSummary('', 'Expedia'), 'Reserva Expedia');
  assert.equal(sync.nombreDesdeSummary('  Reserved -  ', 'Hostelworld'), 'Reserva Hostelworld');
});

await prueba('id de documento: sha1 hex de 28 caracteres, estable', () => {
  const a = sync.idDocumento('abc@booking.com');
  assert.match(a, /^[0-9a-f]{28}$/);
  assert.equal(a, sync.idDocumento('abc@booking.com'));
  assert.equal(a, crypto.createHash('sha1').update('abc@booking.com').digest('hex').slice(0, 28));
  assert.notEqual(a, sync.idDocumento('abd@booking.com'));
});

await prueba('eventoADocumento: campos exactos, pasado → null, cancelado → null, uid de respaldo', () => {
  const fuente = { plataforma: 'Booking.com', habitacion: '7' };
  const ev = { uid: 'x@y', summary: 'Reserved - Ana', description: 'hola', status: '', dtstart: { valor: '20261105', params: { VALUE: 'DATE' } }, dtend: { valor: '20261107', params: { VALUE: 'DATE' } }, duration: null };
  const { id: docId, doc } = sync.eventoADocumento(ev, fuente, HOY, '2026-10-14T12:00:00.000Z');
  assert.equal(docId, sync.idDocumento('x@y'));
  assert.deepEqual(doc, {
    plataforma: 'Booking.com', codigo: '', nombre: 'Ana', apellido: '', nombreCompleto: 'Ana', nacionalidad: '',
    llegada: '2026-11-05', salida: '2026-11-07', personas: 1, habitacion: '7', telefono: '', email: '', total: 0,
    notas: 'hola', estado: 'reservada', origen: 'ics-auto', uid: 'x@y', creadoEn: '2026-10-14T12:00:00.000Z', actualizadoEn: '2026-10-14T12:00:00.000Z',
  });
  assert.equal(sync.eventoADocumento({ ...ev, dtstart: { valor: '20261001', params: {} }, dtend: { valor: '20261013', params: {} } }, fuente, HOY, 'x'), null);
  assert.notEqual(sync.eventoADocumento({ ...ev, dtstart: { valor: '20261001', params: {} }, dtend: { valor: '20261014', params: {} } }, fuente, HOY, 'x'), null, 'sale hoy → vigente');
  assert.equal(sync.eventoADocumento({ ...ev, status: 'CANCELLED' }, fuente, HOY, 'x'), null);
  const sinUid = sync.eventoADocumento({ ...ev, uid: '' }, fuente, HOY, 'x');
  assert.equal(sinUid.doc.uid, 'Booking.com|7|2026-11-05|2026-11-07');
  const largo = sync.eventoADocumento({ ...ev, uid: 'u'.repeat(500), description: 'd'.repeat(1000) }, fuente, HOY, 'x');
  assert.equal(largo.doc.uid.length, 180);
  assert.equal(largo.doc.notas.length, 300);
  assert.equal(largo.id, sync.idDocumento('u'.repeat(180)));
  const sinFin = sync.eventoADocumento({ ...ev, dtend: null }, fuente, HOY, 'x');
  assert.equal(sinFin.doc.salida, '2026-11-06', 'sin DTEND ni DURATION un evento de fecha dura 1 día');
  assert.throws(() => sync.eventoADocumento({ ...ev, dtend: { valor: '20261104', params: {} } }, fuente, HOY, 'x'), /anterior a la llegada/);
  assert.throws(() => sync.eventoADocumento({ ...ev, dtstart: null }, fuente, HOY, 'x'), /sin DTSTART/);
});

await prueba('planificarActualizacion respeta ediciones de recepción y reactiva solo lo cancelado por la sincronización', () => {
  const nuevo = { plataforma: 'Booking.com', habitacion: '1', nombre: 'Bloqueo', nombreCompleto: 'Bloqueo', llegada: '2026-11-01', salida: '2026-11-03', notas: '' };
  const icsDatos = { plataforma: 'Booking.com', habitacion: '1', nombre: 'Bloqueo', llegada: '2026-11-01', salida: '2026-11-03', notas: '' };
  // recepción le puso nombre y teléfono; el calendario no cambió → nada que escribir
  assert.equal(sync.planificarActualizacion({ ...nuevo, nombre: 'Juan', telefono: '123', estado: 'reservada', icsDatos }, nuevo, 'T'), null);
  // cambian las fechas → solo fechas, icsDatos y actualizadoEn
  const plan = sync.planificarActualizacion({ ...nuevo, nombre: 'Juan', estado: 'checkin', icsDatos }, { ...nuevo, salida: '2026-11-04' }, 'T');
  assert.deepEqual(Object.keys(plan.campos).sort(), ['actualizadoEn', 'icsDatos', 'salida']);
  assert.equal(plan.campos.icsDatos.salida, '2026-11-04');
  assert.equal(plan.reactivar, false);
  // cancelada por recepción → no se toca el estado
  assert.equal(sync.planificarActualizacion({ ...nuevo, estado: 'cancelada', icsDatos }, nuevo, 'T'), null);
  // cancelada por la sincronización y reaparece → se reactiva
  const re = sync.planificarActualizacion({ ...nuevo, estado: 'cancelada', canceladoPor: 'ics-auto', canceladoEn: 'X', icsDatos }, nuevo, 'T');
  assert.equal(re.reactivar, true);
  assert.equal(re.campos.estado, 'reservada');
  assert.deepEqual(re.eliminar, ['canceladoEn', 'canceladoPor']);
  // documento antiguo sin icsDatos → se compara con sus propios campos
  const viejo = sync.planificarActualizacion({ ...nuevo, estado: 'reservada' }, { ...nuevo, nombre: 'Otro' }, 'T');
  assert.equal(viejo.campos.nombre, 'Otro');
  assert.equal(viejo.campos.nombreCompleto, 'Otro');
});

await prueba('codificación Firestore ida y vuelta (enteros como integerValue, mapas, nulos)', () => {
  const obj = { s: 'texto', n: 1, t: 0, d: 1.5, b: true, z: null, m: { a: 'b' }, l: ['x', 2] };
  const fields = sync.codificarCampos(obj);
  assert.deepEqual(fields.n, { integerValue: '1' });
  assert.deepEqual(fields.t, { integerValue: '0' });
  assert.deepEqual(fields.d, { doubleValue: 1.5 });
  assert.deepEqual(sync.decodificarCampos(fields), obj);
});

await prueba('leerFuentes valida y normaliza', () => {
  const f = sync.leerFuentes(JSON.stringify([
    { plataforma: 'booking', habitacion: 1, url: 'https://ejemplo.test/a.ics' },
    { plataforma: 'AIRBNB', habitacion: ' 2 ', url: 'http://ejemplo.test/b.ics' },
    { plataforma: 'Mi motor', habitacion: '3', url: 'https://ejemplo.test/c.ics' },
    { habitacion: '4', url: 'https://ejemplo.test/d.ics' },
  ]));
  assert.deepEqual(f.map((x) => [x.plataforma, x.habitacion]), [['Booking.com', '1'], ['Airbnb', '2'], ['Mi motor', '3'], ['Otro', '4']]);
  assert.equal(f[0].etiqueta, 'Booking.com · hab. 1');
  assert.throws(() => sync.leerFuentes(''), /Falta el secreto ICAL_SOURCES/);
  assert.throws(() => sync.leerFuentes('{no es json'), /no es JSON válido/);
  assert.throws(() => sync.leerFuentes('[]'), /al menos un calendario/);
  assert.throws(() => sync.leerFuentes('[{"habitacion":"1","url":"ftp://x"}]'), /url/);
  assert.throws(() => sync.leerFuentes('[{"url":"https://x/y.ics"}]'), /habitacion/);
});

// ───────────── escenarios de punta a punta con el doble de Firestore ─────────────

const ics = await crearServidorIcs();
const doble = await crearDobleFirestore({ proyecto: 'hostal-prueba' });

const fuentes = [
  { plataforma: 'Booking.com', habitacion: '1', url: ics.definir('/booking.ics', muestra('booking.ics').replace(/\r?\n/g, '\r\n')) },
  { plataforma: 'Airbnb', habitacion: '2', url: ics.definir('/airbnb.ics', muestra('airbnb.ics')) },
  { plataforma: 'Otro', habitacion: '3', url: ics.definir('/zonas.ics', muestra('zonas.ics')) },
  { plataforma: 'Hostelworld', habitacion: '4', url: ics.definir('/hostelworld.ics', muestra('hostelworld.ics')) },
  { plataforma: 'Expedia', habitacion: '5', url: ics.definir('/expedia.ics', { estado: 500, cuerpo: 'Internal Server Error', tipo: 'text/plain' }) },
];
const envBase = { ICAL_SOURCES: JSON.stringify(fuentes), FIRESTORE_BASE_URL: doble.url, FIREBASE_PROJECT_ID: 'hostal-prueba', SYNC_HOY: HOY };
const ID = {
  bkCerrado: id('bk-0001-cerrado@booking.com'),
  bkReserva: id('bk-0002-reserva@booking.com'),
  bkPasado: id('bk-0003-pasado@booking.com'),
  bkSaleHoy: id('bk-0004-sale-hoy@booking.com'),
  bkSinUid: id('Booking.com|1|2026-12-01|2026-12-03'),
  abReserved: id('1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d@airbnb.com'),
  abBloqueo: id('bloqueo-airbnb-0001@airbnb.com'),
  abLargo: id(`largo-${'0123456789'.repeat(20)}@airbnb.com`.slice(0, 180)),
  madrid: id('tz-madrid@otro'), utc: id('tz-utc@otro'), flotante: id('tz-flotante@otro'), duracion: id('tz-duracion@otro'),
  santiago: id('tz-santiago@otro'), desconocida: id('tz-desconocida@otro'), cancelado: id('tz-cancelado@otro'),
  hw1: id('hw-0001'), hw2: id('hw-0002'),
};
const fila = (salida, etiqueta) => {
  const linea = salida.split('\n').find((l) => l.startsWith(etiqueta));
  assert.ok(linea, `no está la fila "${etiqueta}" en el resumen:\n${salida}`);
  const numeros = linea.slice(etiqueta.length).trim().split(/\s+/).map(Number);
  const [leidos, vigentes, nuevas, actualizadas, reactivadas, canceladas, sinCambios, errores] = numeros;
  return { leidos, vigentes, nuevas, actualizadas, reactivadas, canceladas, sinCambios, errores };
};

let salida1 = '';
seccion('Corrida 1 · creación (4 calendarios buenos + 1 que responde 500)');

await prueba('termina con código 0 y crea 15 reservas; la fuente caída no detiene a las demás', async () => {
  const r = await ejecutarSync(envBase);
  salida1 = r.salida;
  assert.equal(r.codigo, 0, r.salida);
  assert.equal(Object.keys(doble.todos(COL)).length, 15);
  assert.deepEqual(fila(r.salida, 'Booking.com · hab. 1'), { leidos: 5, vigentes: 4, nuevas: 4, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Airbnb · hab. 2'), { leidos: 3, vigentes: 3, nuevas: 3, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Otro · hab. 3'), { leidos: 7, vigentes: 6, nuevas: 6, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Hostelworld · hab. 4'), { leidos: 2, vigentes: 2, nuevas: 2, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Expedia · hab. 5'), { leidos: 0, vigentes: 0, nuevas: 0, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 1 });
  assert.deepEqual(fila(r.salida, 'TOTAL'), { leidos: 17, vigentes: 15, nuevas: 15, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 1 });
  assert.match(r.salida, /Expedia · hab\. 5: HTTP 500 al descargar el calendario/);
  assert.equal(doble.registro.commits.length, 1);
  assert.equal(doble.registro.commits[0], 15);
});

await prueba('el documento tiene EXACTAMENTE los campos de la app (más icsDatos de la sincronización)', () => {
  const d = doble.leer(COL, ID.bkReserva);
  assert.ok(d, 'no existe la reserva de Booking');
  const { creadoEn, actualizadoEn, icsDatos, ...resto } = d;
  assert.ok(esIso(creadoEn) && esIso(actualizadoEn));
  assert.equal(creadoEn, actualizadoEn);
  assert.deepEqual(resto, {
    plataforma: 'Booking.com', codigo: '', nombre: 'María González', apellido: '', nombreCompleto: 'María González', nacionalidad: '',
    llegada: '2026-11-05', salida: '2026-11-07', personas: 1, habitacion: '1', telefono: '', email: '', total: 0,
    notas: 'Reserva 1234567890\nHuéspedes: 2\nTeléfono: +56 9 1234 5678', estado: 'reservada', origen: 'ics-auto', uid: 'bk-0002-reserva@booking.com',
  });
  assert.deepEqual(icsDatos, { plataforma: 'Booking.com', habitacion: '1', nombre: 'María González', llegada: '2026-11-05', salida: '2026-11-07', notas: 'Reserva 1234567890\nHuéspedes: 2\nTeléfono: +56 9 1234 5678' });
  // tipos en bruto, como los espera la app (enteros, no doubles)
  const crudo = doble.documentos.get(`${COL}/${ID.bkReserva}`).fields;
  assert.deepEqual(crudo.personas, { integerValue: '1' });
  assert.deepEqual(crudo.total, { integerValue: '0' });
  assert.deepEqual(crudo.llegada, { stringValue: '2026-11-05' });
});

await prueba('bloqueos, prefijos, "Reserva <plataforma>", evento pasado ignorado y salida hoy incluida', () => {
  assert.equal(doble.leer(COL, ID.bkCerrado).nombre, 'Bloqueo');
  assert.equal(doble.leer(COL, ID.bkCerrado).nombreCompleto, 'Bloqueo');
  assert.equal(doble.leer(COL, ID.abBloqueo).nombre, 'Bloqueo');
  assert.equal(doble.leer(COL, ID.flotante).nombre, 'Bloqueo');
  assert.equal(doble.leer(COL, ID.abReserved).nombre, 'Reserva Airbnb');
  assert.equal(doble.leer(COL, ID.bkSinUid).nombre, 'Ana Rojas');
  assert.equal(doble.leer(COL, ID.hw1).nombre, 'Tomás Díaz');
  assert.equal(doble.leer(COL, ID.bkPasado), null, 'el evento terminado antes de hoy no se crea');
  assert.equal(doble.leer(COL, ID.cancelado), null, 'STATUS:CANCELLED no se crea');
  assert.deepEqual([doble.leer(COL, ID.bkSaleHoy).llegada, doble.leer(COL, ID.bkSaleHoy).salida], ['2026-10-12', '2026-10-14']);
});

await prueba('líneas plegadas, escapes, notas recortadas a 300 y uid recortado a 180', () => {
  const ab = doble.leer(COL, ID.abReserved);
  assert.equal(ab.notas, 'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH\nPhone Number (Last 4 Digits): 4321');
  const largo = doble.leer(COL, ID.abLargo);
  assert.ok(largo, 'no existe la reserva con uid largo');
  assert.equal(largo.nombre, 'Familia Pérez, López');
  assert.equal(largo.uid.length, 180);
  assert.equal(largo.notas.length, 300);
  assert.ok(largo.notas.startsWith('Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMLARGOLARGO\nPhone Number (Last 4 Digits): 9876\nLlegan en bus desde Calama, piden cama extra para el niño, desayuno sin gluten y una bici para recorrer el pueblo.'));
  assert.ok(!largo.notas.includes('Recordatorio'));
});

await prueba('fechas con zona horaria: TZID Europe/Madrid, UTC, flotante, DURATION, TZID desconocido', () => {
  const f = (k) => [doble.leer(COL, ID[k]).llegada, doble.leer(COL, ID[k]).salida];
  assert.deepEqual(f('madrid'), ['2026-11-19', '2026-11-22']);     // 03:00 Madrid = 23:00 del día anterior en Chile
  assert.deepEqual(f('utc'), ['2026-11-30', '2026-12-04']);        // 02:00Z = 23:00 del día anterior en Chile
  assert.deepEqual(f('flotante'), ['2026-12-15', '2026-12-17']);
  assert.deepEqual(f('duracion'), ['2026-12-20', '2026-12-23']);
  assert.deepEqual(f('santiago'), ['2026-12-28', '2026-12-30']);
  assert.deepEqual(f('desconocida'), ['2027-01-05', '2027-01-07']);
  assert.equal(doble.leer(COL, ID.madrid).notas, 'Llega desde Madrid');
});

await prueba('el doble responde GET de un documento por la API REST', async () => {
  const res = await fetch(`${doble.url}/v1/projects/hostal-prueba/databases/(default)/documents/${COL}/${ID.hw2}`, { headers: { Authorization: 'Bearer owner' } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.name, `projects/hostal-prueba/databases/(default)/documents/${COL}/${ID.hw2}`);
  assert.equal(json.fields.nombre.stringValue, 'Camila Vera');
  const res404 = await fetch(`${doble.url}/v1/projects/hostal-prueba/databases/(default)/documents/${COL}/no-existe`, { headers: { Authorization: 'Bearer owner' } });
  assert.equal(res404.status, 404);
});

seccion('Corrida 2 · idempotencia (misma entrada, vía FIRESTORE_EMULATOR_HOST)');

await prueba('segunda corrida: sin duplicados, sin escrituras, nada cambia', async () => {
  const antes = structuredClone(doble.todos(COL));
  const commitsAntes = doble.registro.commits.length;
  const { FIRESTORE_BASE_URL, ...sinBase } = envBase;
  const r = await ejecutarSync({ ...sinBase, FIRESTORE_EMULATOR_HOST: doble.url.replace('http://', '') });
  assert.equal(r.codigo, 0, r.salida);
  assert.deepEqual(doble.todos(COL), antes);
  assert.equal(Object.keys(doble.todos(COL)).length, 15);
  assert.equal(doble.registro.commits.length, commitsAntes, 'no debe haber commits cuando no hay cambios');
  assert.deepEqual(fila(r.salida, 'TOTAL'), { leidos: 17, vigentes: 15, nuevas: 0, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 15, errores: 1 });
  assert.match(r.salida, /Nada que escribir/);
});

seccion('Corrida 3 · cambios de fechas y de nombre en el calendario');

await prueba('se actualizan solo los documentos cambiados; creadoEn se conserva', async () => {
  const antes = structuredClone(doble.todos(COL));
  ics.definir('/airbnb.ics', cambiar(muestra('airbnb.ics'), 'DTEND;VALUE=DATE:20261028', 'DTEND;VALUE=DATE:20261030'));
  ics.definir('/booking.ics', cambiar(muestra('booking.ics'), 'SUMMARY:Reserved - María González', 'SUMMARY:Reserved - María González Díaz').replace(/\r?\n/g, '\r\n'));
  await new Promise((r) => setTimeout(r, 5));
  const r = await ejecutarSync(envBase);
  assert.equal(r.codigo, 0, r.salida);
  assert.deepEqual(fila(r.salida, 'Airbnb · hab. 2'), { leidos: 3, vigentes: 3, nuevas: 0, actualizadas: 1, reactivadas: 0, canceladas: 0, sinCambios: 2, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Booking.com · hab. 1'), { leidos: 5, vigentes: 4, nuevas: 0, actualizadas: 1, reactivadas: 0, canceladas: 0, sinCambios: 3, errores: 0 });
  const ab = doble.leer(COL, ID.abReserved);
  assert.equal(ab.salida, '2026-10-30');
  assert.equal(ab.llegada, '2026-10-25');
  assert.equal(ab.creadoEn, antes[ID.abReserved].creadoEn);
  assert.notEqual(ab.actualizadoEn, antes[ID.abReserved].actualizadoEn);
  assert.equal(ab.icsDatos.salida, '2026-10-30');
  const bk = doble.leer(COL, ID.bkReserva);
  assert.equal(bk.nombre, 'María González Díaz');
  assert.equal(bk.nombreCompleto, 'María González Díaz');
  assert.equal(bk.estado, 'reservada');
  // los demás documentos quedan idénticos
  const despues = doble.todos(COL);
  for (const k of Object.keys(antes)) if (k !== ID.abReserved && k !== ID.bkReserva) assert.deepEqual(despues[k], antes[k], `cambió ${k} sin motivo`);
  assert.equal(Object.keys(despues).length, 15);
});

seccion('Corrida 4 · no pisar "checkin" ni las correcciones de recepción');

await prueba('recepción hizo checkin y corrigió nombre/teléfono: las fechas se actualizan, lo demás se respeta', async () => {
  // recepción: checkin en la reserva de Airbnb, y le pone nombre y teléfono al bloqueo de Booking
  doble.editar(COL, ID.abReserved, { estado: 'checkin', nombre: 'Rosa Lagos', nombreCompleto: 'Rosa Lagos', telefono: '+56 9 8765 4321' });
  doble.editar(COL, ID.bkCerrado, { nombre: 'Carlos Vidal', nombreCompleto: 'Carlos Vidal', personas: 2 });
  ics.definir('/airbnb.ics', cambiar(muestra('airbnb.ics'), 'DTEND;VALUE=DATE:20261028', 'DTEND;VALUE=DATE:20261031'));
  const r = await ejecutarSync(envBase);
  assert.equal(r.codigo, 0, r.salida);
  const ab = doble.leer(COL, ID.abReserved);
  assert.equal(ab.salida, '2026-10-31', 'la fecha nueva sí se escribe');
  assert.equal(ab.estado, 'checkin', 'el estado checkin no se pisa');
  assert.equal(ab.nombre, 'Rosa Lagos', 'el nombre puesto por recepción se respeta (el calendario no cambió ese dato)');
  assert.equal(ab.telefono, '+56 9 8765 4321');
  const bk = doble.leer(COL, ID.bkCerrado);
  assert.equal(bk.nombre, 'Carlos Vidal');
  assert.equal(bk.personas, 2);
  assert.deepEqual(fila(r.salida, 'Airbnb · hab. 2'), { leidos: 3, vigentes: 3, nuevas: 0, actualizadas: 1, reactivadas: 0, canceladas: 0, sinCambios: 2, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Booking.com · hab. 1'), { leidos: 5, vigentes: 4, nuevas: 0, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 4, errores: 0 });
});

seccion('Corrida 5 · cancelación de eventos desaparecidos');

await prueba('evento futuro que desaparece → cancelada; salida hoy / fuente caída / cancelada por recepción → no se tocan', async () => {
  // Booking: desaparecen la reserva de María (futura) y la de Pedro (ya llegó, sale hoy)
  let bk = quitarEvento(muestra('booking.ics'), 'bk-0002-reserva@booking.com');
  bk = quitarEvento(bk, 'bk-0004-sale-hoy@booking.com');
  ics.definir('/booking.ics', bk.replace(/\r?\n/g, '\r\n'));
  // Hostelworld se cae: sus reservas deben quedar intactas aunque "no se vean"
  ics.definir('/hostelworld.ics', { estado: 500, cuerpo: 'caído', tipo: 'text/plain' });
  // recepción canceló a mano el bloqueo de Airbnb (sigue en el calendario): no se reactiva ni se toca
  doble.editar(COL, ID.abBloqueo, { estado: 'cancelada' });
  const r = await ejecutarSync(envBase);
  assert.equal(r.codigo, 0, r.salida);
  const maria = doble.leer(COL, ID.bkReserva);
  assert.equal(maria.estado, 'cancelada');
  assert.equal(maria.canceladoPor, 'ics-auto');
  assert.ok(esIso(maria.canceladoEn));
  assert.equal(maria.nombre, 'María González Díaz', 'los demás campos se conservan');
  assert.equal(doble.leer(COL, ID.bkSaleHoy).estado, 'reservada', 'llegada pasada: no se cancela');
  assert.equal(doble.leer(COL, ID.hw1).estado, 'reservada', 'fuente caída: no se cancela');
  assert.equal(doble.leer(COL, ID.hw2).estado, 'reservada', 'fuente caída: no se cancela');
  assert.equal(doble.leer(COL, ID.abBloqueo).estado, 'cancelada');
  assert.equal(doble.leer(COL, ID.abBloqueo).canceladoPor, undefined);
  assert.deepEqual(fila(r.salida, 'Booking.com · hab. 1'), { leidos: 3, vigentes: 2, nuevas: 0, actualizadas: 0, reactivadas: 0, canceladas: 1, sinCambios: 2, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Hostelworld · hab. 4'), { leidos: 0, vigentes: 0, nuevas: 0, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 1 });
  assert.equal(Object.keys(doble.todos(COL)).length, 15, 'cancelar no borra documentos');
});

seccion('Corrida 6 · el evento cancelado por la sincronización vuelve a aparecer');

await prueba('se reactiva (estado reservada, sin canceladoEn/canceladoPor); la cancelada por recepción sigue cancelada', async () => {
  ics.definir('/booking.ics', muestra('booking.ics').replace(/\r?\n/g, '\r\n'));
  ics.definir('/hostelworld.ics', muestra('hostelworld.ics'));
  const r = await ejecutarSync(envBase);
  assert.equal(r.codigo, 0, r.salida);
  const maria = doble.leer(COL, ID.bkReserva);
  assert.equal(maria.estado, 'reservada');
  assert.equal(maria.canceladoEn, undefined);
  assert.equal(maria.canceladoPor, undefined);
  assert.equal(maria.nombre, 'María González', 'el nombre vuelve al del calendario porque el calendario cambió');
  assert.equal(doble.leer(COL, ID.abBloqueo).estado, 'cancelada');
  assert.deepEqual(fila(r.salida, 'Booking.com · hab. 1'), { leidos: 5, vigentes: 4, nuevas: 0, actualizadas: 0, reactivadas: 1, canceladas: 0, sinCambios: 3, errores: 0 });
  assert.deepEqual(fila(r.salida, 'Hostelworld · hab. 4'), { leidos: 2, vigentes: 2, nuevas: 0, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 2, errores: 0 });
});

seccion('Casos de error y límites');

await prueba('reservas ics-auto cuya fuente ya no está configurada no se tocan', async () => {
  const sinHostelworld = fuentes.filter((f) => f.plataforma !== 'Hostelworld');
  const r = await ejecutarSync({ ...envBase, ICAL_SOURCES: JSON.stringify(sinHostelworld) });
  assert.equal(r.codigo, 0, r.salida);
  assert.equal(doble.leer(COL, ID.hw2).estado, 'reservada');
  assert.match(r.salida, /2 reserva\(s\) ics-auto sin calendario configurado/);
});

await prueba('respuesta que no es iCal (p. ej. una página HTML de login) cuenta como error de esa fuente', async () => {
  ics.definir('/expedia.ics', { estado: 200, cuerpo: '<html><body>Inicia sesión</body></html>', tipo: 'text/html' });
  const r = await ejecutarSync(envBase);
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Expedia · hab\. 5: la respuesta no es un calendario iCal/);
  ics.definir('/expedia.ics', { estado: 500, cuerpo: 'Internal Server Error', tipo: 'text/plain' });
});

await prueba('si falla el commit en Firestore: código 1, nada se escribe, y la corrida siguiente lo repara', async () => {
  ics.definir('/hostelworld.ics', cambiar(muestra('hostelworld.ics'), 'DTEND;VALUE=DATE:20261218', 'DTEND;VALUE=DATE:20261219'));
  doble.fallos.commit = 1;
  const r = await ejecutarSync(envBase);
  assert.equal(r.codigo, 1, r.salida);
  assert.match(r.salida, /ERROR en el lote 1\/1: Firestore POST :commit → HTTP 500: fallo simulado en commit/);
  assert.equal(doble.leer(COL, ID.hw2).salida, '2026-12-18');
  assert.deepEqual(fila(r.salida, 'Hostelworld · hab. 4'), { leidos: 2, vigentes: 2, nuevas: 0, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 1, errores: 1 });
  const r2 = await ejecutarSync(envBase);
  assert.equal(r2.codigo, 0, r2.salida);
  assert.equal(doble.leer(COL, ID.hw2).salida, '2026-12-19');
});

await prueba('si falla la consulta a Firestore: error fatal con código 1 y sin escrituras', async () => {
  doble.fallos.runQuery = 1;
  const commits = doble.registro.commits.length;
  const r = await ejecutarSync(envBase);
  assert.equal(r.codigo, 1, r.salida);
  assert.match(r.salida, /ERROR FATAL: Firestore POST :runQuery → HTTP 500/);
  assert.equal(doble.registro.commits.length, commits);
});

await prueba('todas las fuentes caídas → código 1 y ninguna reserva cancelada', async () => {
  const todasCaidas = fuentes.map((f) => ({ ...f, url: `${ics.url}/expedia.ics` }));
  const antes = structuredClone(doble.todos(COL));
  const r = await ejecutarSync({ ...envBase, ICAL_SOURCES: JSON.stringify(todasCaidas) });
  assert.equal(r.codigo, 1, r.salida);
  assert.match(r.salida, /Ningún calendario se pudo descargar/);
  assert.deepEqual(doble.todos(COL), antes);
});

await prueba('ICAL_SOURCES inválido o ausente → código 1 con mensaje claro', async () => {
  const r = await ejecutarSync({ ...envBase, ICAL_SOURCES: '[{"plataforma":"Airbnb"}]' });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /ERROR FATAL: ICAL_SOURCES: la entrada #1 no tiene una "url"/);
  const r2 = await ejecutarSync({ ...envBase, ICAL_SOURCES: '' });
  assert.equal(r2.codigo, 1);
  assert.match(r2.salida, /Falta el secreto ICAL_SOURCES/);
});

await prueba('sin doble ni cuenta de servicio → error claro pidiendo FIREBASE_SERVICE_ACCOUNT', async () => {
  const { FIRESTORE_BASE_URL, ...sinBase } = envBase;
  const r = await ejecutarSync({ ...sinBase, FIREBASE_SERVICE_ACCOUNT: '' });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /Falta el secreto FIREBASE_SERVICE_ACCOUNT/);
});

await prueba('lotes: 450 eventos se escriben en commits de como máximo 400', async () => {
  const doble2 = await crearDobleFirestore({ proyecto: 'hostal-lotes' });
  try {
    const grande = [{ plataforma: 'Otro', habitacion: '6', url: ics.definir('/grande.ics', calendarioGrande(450)) }];
    const r = await ejecutarSync({ ...envBase, ICAL_SOURCES: JSON.stringify(grande), FIRESTORE_BASE_URL: doble2.url, FIREBASE_PROJECT_ID: 'hostal-lotes' });
    assert.equal(r.codigo, 0, r.salida);
    assert.deepEqual(doble2.registro.commits, [400, 50]);
    assert.equal(Object.keys(doble2.todos(COL)).length, 450);
    assert.deepEqual(fila(r.salida, 'Otro · hab. 6'), { leidos: 450, vigentes: 450, nuevas: 450, actualizadas: 0, reactivadas: 0, canceladas: 0, sinCambios: 0, errores: 0 });
    assert.equal(doble2.leer(COL, id('grande-449@prueba')).nombre, 'Huésped 449');
  } finally {
    await doble2.cerrar();
  }
});

seccion('Autenticación con cuenta de servicio (JWT RS256 → token OAuth)');

await prueba('el JWT se firma bien, el token se obtiene y se usa en las llamadas a Firestore', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const clientEmail = 'sincronizador@hostal-prueba.iam.gserviceaccount.com';
  const oauth = await crearDobleOauth({ clavePublica: publicKey, clientEmail, token: 'token-de-prueba' });
  const doble3 = await crearDobleFirestore({ proyecto: 'hostal-prueba' });
  try {
    const cuentaTexto = JSON.stringify({
      type: 'service_account', project_id: 'hostal-prueba', private_key_id: 'abc',
      private_key: privateKey.replace(/\n/g, '\\n'), // como suele venir pegado: con \n literales
      client_email: clientEmail, token_uri: oauth.url,
    });
    const cuenta = sync.leerCuentaServicio(cuentaTexto);
    assert.ok(cuenta.private_key.includes('\n'));
    const token = await sync.obtenerToken(cuenta);
    assert.equal(token, 'token-de-prueba');
    assert.equal(oauth.registro.solicitudes, 1);
    assert.deepEqual(oauth.registro.rechazos, []);
    assert.equal(oauth.registro.ultimoJwt.claims.scope, 'https://www.googleapis.com/auth/datastore');
    assert.equal(oauth.registro.ultimoJwt.claims.iss, clientEmail);
    // un JWT con otra clave debe rechazarse
    const otra = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await assert.rejects(sync.obtenerToken({ ...cuenta, private_key: otra.privateKey }), /firma RS256 inválida/);
    // el token se manda en Authorization en runQuery y commit
    const firestore = new sync.Firestore({ baseUrl: doble3.url, proyecto: 'hostal-prueba', token });
    const resumen = await sync.sincronizar({ fuentes: sync.leerFuentes(JSON.stringify(fuentes.slice(3, 4))), firestore, hoy: HOY, log: () => {} });
    assert.equal(resumen.codigoSalida, 0);
    assert.equal(resumen.totales.nuevas, 2);
    assert.ok(doble3.registro.auth.length >= 2);
    assert.ok(doble3.registro.auth.every((a) => a === 'Bearer token-de-prueba'), JSON.stringify(doble3.registro.auth));
    // errores de cuenta mal pegada
    assert.throws(() => sync.leerCuentaServicio('{"client_email":"x"}'), /no trae el campo "private_key"/);
    assert.throws(() => sync.leerCuentaServicio('no json'), /no es JSON válido/);
  } finally {
    await oauth.cerrar();
    await doble3.cerrar();
  }
});

await prueba('resumen en Markdown para la página del run de GitHub', async () => {
  const firestore = new sync.Firestore({ baseUrl: doble.url, proyecto: 'hostal-prueba', token: 'owner' });
  const resumen = await sync.sincronizar({ fuentes: sync.leerFuentes(JSON.stringify(fuentes)), firestore, hoy: HOY, log: () => {} });
  const md = sync.resumenMarkdown(resumen);
  assert.match(md, /^## Sincronización iCal → Firestore/);
  assert.match(md, /\| Booking\.com · hab\. 1 \| 5 \| 4 \|/);
  assert.match(md, /\| TOTAL \|/);
  assert.match(md, /Expedia · hab\. 5: HTTP 500/);
});

// ───────────── cierre y resumen ─────────────
await ics.cerrar();
await doble.cerrar();

const ok = resultados.filter((r) => r.ok).length;
const mal = resultados.length - ok;
console.log('\n════════════════════════════════════════');
console.log(`Pruebas: ${resultados.length} · correctas: ${ok} · fallidas: ${mal}`);
if (mal) {
  for (const r of resultados.filter((x) => !x.ok)) console.log(`  ✘ [${r.seccion}] ${r.nombre}`);
}
console.log(mal ? 'RESULTADO: HAY FALLOS' : 'RESULTADO: TODO OK');
process.exit(mal ? 1 : 0);
