/**
 * Doble del endpoint OAuth de Google (https://oauth2.googleapis.com/token).
 * Recibe el JWT firmado por sync.mjs, verifica la firma RS256 con la clave pública
 * de la cuenta de servicio de prueba y las claims, y devuelve un access_token.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export async function crearDobleOauth({ clavePublica, clientEmail, alcance = 'https://www.googleapis.com/auth/datastore', token = 'token-de-prueba' }) {
  const registro = { solicitudes: 0, ultimoJwt: null, rechazos: [] };
  let urlPropia = '';

  const servidor = http.createServer((req, res) => {
    const trozos = [];
    req.on('data', (t) => trozos.push(t));
    req.on('end', () => {
      registro.solicitudes++;
      const responder = (codigo, cuerpo) => {
        res.writeHead(codigo, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cuerpo));
      };
      try {
        if (req.method !== 'POST') throw new Error('se esperaba POST');
        if (!/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) throw new Error('content-type incorrecto');
        const form = new URLSearchParams(Buffer.concat(trozos).toString('utf8'));
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') throw new Error('grant_type incorrecto');
        const jwt = form.get('assertion') || '';
        const [cab, cuerpo, firma] = jwt.split('.');
        if (!cab || !cuerpo || !firma) throw new Error('JWT mal formado');
        const cabecera = JSON.parse(Buffer.from(cab, 'base64url').toString('utf8'));
        const claims = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
        if (cabecera.alg !== 'RS256' || cabecera.typ !== 'JWT') throw new Error('cabecera JWT incorrecta');
        const valida = crypto.verify('sha256', Buffer.from(`${cab}.${cuerpo}`), clavePublica, Buffer.from(firma, 'base64url'));
        if (!valida) throw new Error('firma RS256 inválida');
        if (claims.iss !== clientEmail) throw new Error(`iss incorrecto: ${claims.iss}`);
        if (claims.scope !== alcance) throw new Error(`scope incorrecto: ${claims.scope}`);
        if (claims.aud !== urlPropia) throw new Error(`aud incorrecto: ${claims.aud}`);
        const ahora = Math.floor(Date.now() / 1000);
        if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') throw new Error('iat/exp ausentes');
        if (claims.exp <= claims.iat || claims.exp - claims.iat > 3600) throw new Error('exp fuera de rango');
        if (Math.abs(claims.iat - ahora) > 300) throw new Error('iat muy lejos del reloj');
        registro.ultimoJwt = { cabecera, claims };
        responder(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      } catch (e) {
        registro.rechazos.push(e.message);
        responder(400, { error: 'invalid_grant', error_description: e.message });
      }
    });
  });

  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  urlPropia = `http://127.0.0.1:${servidor.address().port}/token`;
  return { url: urlPropia, registro, cerrar: () => new Promise((resolver) => servidor.close(resolver)) };
}
