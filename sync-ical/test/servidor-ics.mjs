/**
 * Servidor HTTP local que sirve los calendarios .ics de prueba.
 * Cada ruta puede devolver un texto (200, text/calendar) o { estado, cuerpo, tipo }
 * para simular errores (500, 404, HTML en vez de iCal, etc.).
 */
import http from 'node:http';

export async function crearServidorIcs() {
  const rutas = new Map();
  const registro = { solicitudes: [] };

  const servidor = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://ics');
    registro.solicitudes.push(pathname);
    const definicion = rutas.get(pathname);
    if (definicion === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no existe');
      return;
    }
    const d = typeof definicion === 'string' ? { cuerpo: definicion } : definicion;
    res.writeHead(d.estado || 200, { 'Content-Type': d.tipo || 'text/calendar; charset=utf-8' });
    res.end(d.cuerpo ?? '');
  });

  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const { port } = servidor.address();
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    registro,
    /** Define (o redefine) lo que responde una ruta, p. ej. definir('/booking.ics', texto). */
    definir(ruta, definicion) { rutas.set(ruta, definicion); return `${url}${ruta}`; },
    cerrar() { return new Promise((resolver) => servidor.close(resolver)); },
  };
}
