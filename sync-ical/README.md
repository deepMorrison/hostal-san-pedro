# Sincronizador de reservas iCal → Firestore · Hostal San Pedro

> **En el repositorio `hostal-san-pedro`** esta carpeta ya va incluida y la tarea programada está en `.github/workflows/sync-ical.yml`, en la raíz del repositorio (corre dentro de `sync-ical/`). Haz los pasos 1, 2, 3, 5 y 6: el paso 4 queda hecho al subir el repositorio. Si la carpeta `.github` no se subió, en GitHub: **Add file → Create new file**, escribe como nombre `.github/workflows/sync-ical.yml` y pega el contenido de ese archivo.

Una tarea programada de **GitHub Actions** que, **cada hora**, lee los calendarios iCal
de Booking.com, Airbnb, Hostelworld, Expedia u otra plataforma, y deja cada estadía
futura como una reserva en la colección `reservas` de Firestore, la misma que usa la
app de recepción. No hay que instalar nada ni mantener un servidor: GitHub ejecuta el
script gratis.

```
Booking.com ──┐
Airbnb ───────┤  cada hora (GitHub Actions)  ┌────────────────────┐
Hostelworld ──┼──────── sync.mjs ───────────►│ Firestore: reservas│──► app de recepción
Expedia ──────┤                              └────────────────────┘
Otro ─────────┘
```

## Qué hay en esta carpeta

| Archivo | Para qué sirve |
|---|---|
| `sync.mjs` | El sincronizador. Solo necesita Node 20; no instala ningún paquete. |
| `.github/workflows/sync-ical.yml` | La tarea programada de GitHub (cada hora en el minuto 17, y a mano con "Run workflow"). |
| `README.md` | Esta guía. |
| `package.json`, `.gitignore` | Apoyo: `npm test` ejecuta las pruebas; el `.gitignore` evita subir credenciales por error. |
| `test/run.mjs` | Pruebas automáticas: `node test/run.mjs` (no necesita internet ni cuenta de Firebase). |
| `test/muestras/*.ics` | Calendarios de ejemplo (estilo Booking, estilo Airbnb, con zonas horarias, Hostelworld). |
| `test/firestore-doble.mjs`, `test/servidor-ics.mjs`, `test/oauth-doble.mjs` | Servidores locales que imitan Firestore, las plataformas y el login de Google durante las pruebas. |

## Cómo funciona (en dos minutos)

1. Lee la lista de calendarios del secreto `ICAL_SOURCES` (plataforma + habitación + URL).
2. Descarga cada `.ics`. Si una plataforma falla, las demás siguen igual.
3. Convierte cada evento **vigente** (con salida hoy o después, según la hora de Chile,
   `America/Santiago`) en una reserva con estos campos:

   | Campo | Valor que escribe la sincronización |
   |---|---|
   | `plataforma` | La de la fuente: `Booking.com`, `Airbnb`, `Hostelworld`, `Expedia` u `Otro`. |
   | `nombre`, `nombreCompleto` | El título del evento sin el prefijo "Reserved -" / "Reserva -". Si el título dice *CLOSED - Not available*, *Not available*, *No disponible*, *Bloqueo* o *Unavailable* (y no dice "reserv"), se guarda **`Bloqueo`**. Si queda vacío, `Reserva <plataforma>`. |
   | `llegada`, `salida` | Fechas `YYYY-MM-DD` (las fechas-hora con zona horaria se convierten a la hora de Chile). |
   | `habitacion` | La de la fuente. |
   | `personas` | `1` |
   | `notas` | La descripción del evento, recortada a 300 caracteres (en Airbnb trae el enlace de la reserva y los últimos 4 dígitos del teléfono). |
   | `estado` | `reservada` |
   | `origen` | `ics-auto` (así se distingue de las reservas que crea recepción a mano). |
   | `uid` | El UID del evento (o `plataforma|habitacion|llegada|salida` si no trae), máximo 180 caracteres. |
   | `codigo`, `apellido`, `nacionalidad`, `telefono`, `email` | `""` (vacíos, para que recepción los complete). |
   | `total` | `0` |
   | `creadoEn`, `actualizadoEn` | Fecha-hora ISO. |
   | `icsDatos` | Campo auxiliar de la sincronización: copia de lo último que leyó del calendario (ver reglas más abajo). La app puede ignorarlo. |

4. Escribe en Firestore con la API REST usando la cuenta de servicio del secreto
   `FIREBASE_SERVICE_ACCOUNT` (el script firma un JWT RS256 y lo canjea por un token de
   Google; no necesita el SDK de Firebase ni paquetes npm). Las escrituras van en lotes
   de hasta 400.
5. Al final imprime un resumen por calendario: eventos leídos, vigentes, nuevas,
   actualizadas, reactivadas, canceladas, sin cambios y errores. En GitHub, ese resumen
   aparece como tabla en la página del run.

### Reglas que protegen el trabajo de recepción

- **Nunca se duplica una reserva.** El id del documento es un hash (sha1, 28 caracteres)
  del `uid` del evento. La misma reserva siempre cae en el mismo documento; si cambian
  las fechas, se actualiza ese mismo documento.
- **El `estado` no se pisa.** Si recepción pasó una reserva a `checkin`, `cancelada` o
  cualquier otro estado, la sincronización no lo toca (solo actualiza fechas/nombre si
  cambiaron en la plataforma).
- **Las correcciones a mano se respetan.** La sincronización solo vuelve a escribir un
  campo (nombre, fechas, notas, habitación, plataforma) cuando **ese dato cambió en el
  calendario** respecto a lo que leyó la última vez (eso guarda en `icsDatos`). Por
  ejemplo, si a un `Bloqueo` de Booking le ponen el nombre real del huésped, el nombre
  se mantiene hora tras hora. Teléfono, email, personas, total, código, apellido y
  nacionalidad nunca los escribe salvo al crear el documento (vacíos).
- **Cancelaciones.** Si un evento con origen `ics-auto` desaparece del calendario y su
  llegada es hoy o futura, la reserva pasa a `estado: "cancelada"` con `canceladoEn` y
  `canceladoPor: "ics-auto"`. No se borra nada.
- **Reaparición.** Si una reserva que canceló la propia sincronización vuelve a aparecer
  en el calendario (por ejemplo, un fallo pasajero de la plataforma), vuelve a
  `reservada` y se quitan `canceladoEn`/`canceladoPor`. Las canceladas **por recepción**
  (sin `canceladoPor: "ics-auto"`) se quedan canceladas.
- **Un calendario caído no cancela nada.** Si Booking no responde (error 500, URL
  caducada, página de login…), sus reservas quedan tal cual y el run muestra un aviso.
- Las reservas con llegada pasada nunca se cancelan automáticamente.

## Antes de empezar: qué necesitas

- Una cuenta de **GitHub** (gratis).
- Acceso de administrador al proyecto de **Firebase** de la app.
- Acceso a la extranet de **Booking.com** y/o a la cuenta de **Airbnb** del hostal.

Tiempo estimado: 20–30 minutos la primera vez.

## Paso 1 · Crear la cuenta de servicio en Firebase

La cuenta de servicio es la "llave" con la que el script escribe en Firestore.

1. Entra a <https://console.firebase.google.com> y abre el proyecto de la app.
2. Haz clic en el **ícono de engranaje** (arriba a la izquierda, junto a "Descripción
   general del proyecto") → **Configuración del proyecto**.
3. Ve a la pestaña **Cuentas de servicio**.
4. Deja marcada la opción **Node.js** y pulsa **Generar nueva clave privada** → en el
   aviso, **Generar clave**.
5. Se descarga un archivo con un nombre parecido a
   `mi-hostal-firebase-adminsdk-ab12c-3456789abc.json`. Guárdalo en un lugar seguro:
   **da acceso total a tu base de datos**. No lo subas al repositorio ni lo mandes por
   WhatsApp/correo.
6. Ábrelo con el Bloc de notas (o cualquier editor de texto). Verás algo así:

   ```json
   {
     "type": "service_account",
     "project_id": "mi-hostal",
     "private_key_id": "…",
     "private_key": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
     "client_email": "firebase-adminsdk-ab12c@mi-hostal.iam.gserviceaccount.com",
     "client_id": "…",
     "token_uri": "https://oauth2.googleapis.com/token",
     …
   }
   ```

   En el Paso 5 copiarás **todo** este contenido, desde la primera `{` hasta la última `}`.

> No hace falta cambiar las reglas de seguridad de Firestore: la cuenta de servicio
> escribe con permisos de administrador y las reglas no se le aplican.

## Paso 2 · Conseguir la URL iCal de cada habitación en cada plataforma

Cada habitación tiene su propio enlace iCal en cada plataforma. Con 10 habitaciones en
Booking y Airbnb tendrás hasta 20 enlaces. Los enlaces son **privados** (quien los tenga
ve tu ocupación): no los publiques.

### Booking.com (Extranet)

1. Entra a <https://admin.booking.com> con tu cuenta del hostal.
2. Menú superior **Tarifas y disponibilidad** → **Sincronizar calendarios**
   (en algunas cuentas aparece como "Sincronización de calendarios").
3. Elige la **habitación** (tipo de habitación) que quieres sincronizar.
4. En la sección **Exportar calendario** pulsa **Exportar** / **Copiar enlace**. El
   enlace tiene esta pinta: `https://ical.booking.com/v1/export?t=XXXXXXXX-XXXX-…`
5. Repite por cada habitación y anota a qué habitación corresponde cada enlace.

> Si no ves la opción "Sincronizar calendarios", Booking puede tenerla desactivada para
> tu tipo de propiedad; escríbele a tu contacto de Booking para activarla.

### Airbnb

1. Entra a <https://www.airbnb.cl/hosting> (o airbnb.com) → **Calendario**.
2. Elige el **anuncio** (cada habitación debe ser un anuncio distinto).
3. En el panel derecho, **Disponibilidad** → baja hasta **Sincronización de calendarios**
   (también puede decir "Conectar calendarios") → **Exportar calendario**.
4. Copia el enlace. Tiene esta pinta:
   `https://www.airbnb.com/calendar/ical/123456789.ics?s=abcdef0123456789…`
5. Repite por cada anuncio.

### Hostelworld, Expedia y otras

No todas las cuentas de estas plataformas ofrecen exportación iCal. Busca en tu extranet
la sección de **calendario / disponibilidad** una opción llamada **Exportar calendario**,
**Sincronizar calendarios** o **iCal** y copia el enlace (debe terminar en `.ics` o
devolver un archivo de calendario). Si no existe, consulta al soporte de la plataforma;
si solo ofrecen "channel manager", este sincronizador no les sirve.

Cualquier otro calendario iCal (Google Calendar compartido, un motor de reservas propio,
etc.) también funciona: usa `"plataforma": "Otro"`.

## Paso 3 · Armar la lista de calendarios (`ICAL_SOURCES`)

Es un texto en formato JSON: una lista con un elemento por calendario. Ejemplo con tres
calendarios (sustituye las URL por las tuyas):

```json
[
  {"plataforma": "Booking.com", "habitacion": "1", "url": "https://ical.booking.com/v1/export?t=PEGA-AQUI-TU-ENLACE"},
  {"plataforma": "Airbnb",      "habitacion": "1", "url": "https://www.airbnb.com/calendar/ical/PEGA-AQUI-TU-ENLACE.ics?s=XXXX"},
  {"plataforma": "Booking.com", "habitacion": "2", "url": "https://ical.booking.com/v1/export?t=PEGA-AQUI-TU-ENLACE"}
]
```

- `plataforma`: `Booking.com`, `Airbnb`, `Hostelworld`, `Expedia` u `Otro`
  (no importa mayúsculas; "booking" también vale).
- `habitacion`: el mismo nombre o número de habitación que usa la app (`"1"`, `"2"`,
  `"Suite"`, …). Va entre comillas.
- `url`: el enlace iCal de esa habitación en esa plataforma.

Cuida las comas: entre elementos hay coma, después del último no. Puedes comprobar que
el JSON está bien pegándolo en <https://jsonlint.com>.

## Paso 4 · Crear el repositorio en GitHub y subir los archivos

1. Entra a <https://github.com> → botón **+** (arriba a la derecha) → **New repository**.
2. Nombre: por ejemplo `hostal-sync-ical`. Puede ser **Private** (recomendado; GitHub da
   2.000 minutos gratis al mes y esta tarea usa unos 750) o **Public** (minutos
   ilimitados, pero GitHub pausa las tareas programadas si el repositorio pasa 60 días
   sin actividad). En ninguno de los dos casos se suben credenciales: van en los secretos.
3. Pulsa **Create repository**.
4. Sube los archivos de esta carpeta **respetando las subcarpetas**:
   `sync.mjs`, `README.md`, `package.json`, `.gitignore`, la carpeta `test/` y, sobre
   todo, `.github/workflows/sync-ical.yml`. La forma más simple es con
   [GitHub Desktop](https://desktop.github.com) o con git:

   ```bash
   cd carpeta-sync-ical
   git init
   git add .
   git commit -m "Sincronizador de reservas iCal"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/hostal-sync-ical.git
   git push -u origin main
   ```

   (Si subes archivos desde la web con "Add file → Upload files", la carpeta
   `.github/workflows` hay que crearla escribiendo la ruta completa
   `.github/workflows/sync-ical.yml` en el nombre del archivo.)
5. Comprueba que en la pestaña **Actions** del repositorio aparece el flujo
   **"Sincronizar reservas iCal"**. Si GitHub pregunta si quieres habilitar los
   workflows, acepta.

## Paso 5 · Guardar los dos secretos en GitHub

1. En el repositorio: **Settings** (pestaña con el engranaje) → en el menú izquierdo
   **Secrets and variables** → **Actions**.
2. Pulsa **New repository secret**.
3. Primer secreto:
   - **Name:** `FIREBASE_SERVICE_ACCOUNT`
   - **Secret:** pega **todo** el contenido del archivo JSON del Paso 1 (desde `{`
     hasta `}`).
   - **Add secret**.
4. Segundo secreto (otra vez **New repository secret**):
   - **Name:** `ICAL_SOURCES`
   - **Secret:** pega la lista JSON del Paso 3.
   - **Add secret**.
5. Deberías ver los dos nombres en la lista "Repository secrets". GitHub no vuelve a
   mostrar su contenido; para cambiarlos usa **Update**.

Secreto opcional: `FIREBASE_PROJECT_ID`, solo si quieres forzar otro proyecto distinto
del que viene en el JSON (normalmente no hace falta). Si lo usas, agrégalo también al
bloque `env:` del workflow.

## Paso 6 · Probar a mano y leer el resultado

1. Pestaña **Actions** → en la lista de la izquierda, **Sincronizar reservas iCal**.
2. Botón **Run workflow** (a la derecha) → confirma **Run workflow**.
3. En unos segundos aparece una corrida nueva. Haz clic en ella.
4. Verás el job **"Sincronizar calendarios con Firestore"**. Un **check verde** significa
   que terminó bien. Debajo, en la sección **Summary**, aparece la tabla con los
   resultados por calendario (leídos, nuevas, actualizadas, canceladas, errores…).
5. Para ver el detalle, entra al job y despliega el paso **Sincronizar**: verás líneas
   como `[1/3] Booking.com · hab. 1: 5 evento(s) leído(s)` y el resumen final.
6. Abre la app de recepción (o la consola de Firebase → Firestore → colección
   `reservas`): las reservas nuevas tienen `origen: "ics-auto"`.

Si un calendario falla, el run sigue en verde pero con un **aviso amarillo** (warning)
que dice qué calendario falló y por qué; sus reservas no se tocan. El run queda en
**rojo** solo cuando no se pudo escribir en Firestore, cuando ningún calendario se pudo
descargar o cuando un secreto está mal: en ese caso GitHub te envía un correo.

A partir de aquí la tarea corre sola **cada hora** (en el minuto 17). No hay que hacer
nada más.

## Problemas frecuentes

| Qué ves | Qué significa / qué hacer |
|---|---|
| `ERROR FATAL: Falta el secreto ICAL_SOURCES` | No existe el secreto o está vacío. Revisa el nombre exacto (mayúsculas) en Settings → Secrets. |
| `ICAL_SOURCES no es JSON válido` | Falta o sobra una coma, comillas, corchete. Valida el texto en jsonlint.com. |
| `FIREBASE_SERVICE_ACCOUNT no trae el campo "private_key"` | Se pegó el JSON incompleto. Vuelve a pegar el archivo entero. |
| `No se pudo obtener el token de Google (HTTP 400): invalid_grant` | La clave está dañada o fue revocada. Genera una clave nueva (Paso 1) y actualiza el secreto. |
| `Firestore POST :runQuery → HTTP 403` | La cuenta de servicio no tiene permiso en ese proyecto (¿es de otro proyecto?). |
| `HTTP 404 al descargar el calendario` / `la respuesta no es un calendario iCal` | El enlace iCal es incorrecto o caducó. Cópialo de nuevo en la plataforma y actualiza `ICAL_SOURCES`. |
| Las reservas de Booking aparecen como **Bloqueo** | Ver "Limitaciones": el iCal de Booking no trae nombres. |
| La tarea dejó de correr sola | En repositorios **públicos**, GitHub desactiva las tareas programadas tras 60 días sin actividad en el repositorio (te avisa por correo). En Actions → el workflow → **Enable workflow**. Hacer cualquier commit también la reactiva. Con un repositorio privado no pasa. |
| Hay reservas que no se cancelan al borrarlas en la plataforma | Solo se cancelan las de llegada hoy o futura con estado `reservada`; las que recepción ya cambió de estado no se tocan. Y si ese calendario falló en la corrida, no se cancela nada hasta que vuelva a responder. |

## Limitaciones conocidas

- **Retraso de hasta una hora** (más unos minutos de cola de GitHub): una reserva hecha
  en Booking tarda hasta ~60–70 minutos en aparecer en la app. Si necesitas verla antes,
  lanza el workflow a mano (Paso 6).
- **Booking.com no incluye el nombre del huésped en su iCal**: habitualmente todos los
  eventos vienen como "CLOSED - Not available", también las reservas reales. Por eso
  aparecen como `Bloqueo` (la habitación queda ocupada en las fechas correctas, que es lo
  importante). Recepción puede ponerle el nombre real a mano: la sincronización lo
  respeta. Airbnb trae el enlace de la reserva y los últimos 4 dígitos del teléfono en
  `notas`, pero tampoco el nombre completo.
- **Nada de datos de pago ni número de personas**: las plataformas no los exponen por
  iCal. `personas` queda en 1 y `total` en 0 para que recepción los complete.
- **Sincronización cruzada**: si además conectaste Booking ↔ Airbnb entre sí, cada
  reserva aparece también como bloqueo "espejo" en la otra plataforma, y aquí se verá
  una reserva más un `Bloqueo` para las mismas fechas. Es normal; no se duplican entre
  corridas.
- **Fechas-hora**: los eventos con hora y zona horaria se convierten a la fecha en
  Chile (`America/Santiago`). Los que vienen "sin zona" se interpretan como hora de
  Chile. Un TZID que Node no reconozca se trata también como hora de Chile.
- **Eventos sin UID**: se identifican por plataforma + habitación + fechas, así que si
  cambian las fechas se crean como reserva nueva y la anterior se cancela.
- **Eventos repetitivos (RRULE)** no se expanden; las plataformas de reservas no los usan.
- Solo se leen de Firestore las reservas con `salida` ≥ hoy (para no leer todo el
  historial cada hora). Una reserva ya terminada no se modifica nunca.
- Si GitHub tiene mucha carga, una corrida programada puede atrasarse varios minutos.
  Una corrida típica dura menos de un minuto.

## Probar en tu computador (opcional)

Requiere Node 20 o superior. No necesita internet ni cuenta de Firebase: usa servidores
locales de prueba.

```bash
node test/run.mjs      # o: npm test
```

Debe terminar con `RESULTADO: TODO OK` y código 0. Las pruebas cubren: parser iCal
(líneas plegadas, escapes, VALARM anidado, fechas con zona horaria), creación,
idempotencia (segunda corrida sin cambios), actualización de fechas y nombre, respeto
del estado `checkin` y de las correcciones de recepción, cancelación de eventos
desaparecidos, reactivación, tolerancia a un calendario que responde 500 o HTML, lotes
de 400 escrituras y la autenticación JWT RS256 con una cuenta de servicio de prueba.

Para ejecutar el sincronizador de verdad desde tu computador (contra Firestore real):

```bash
export FIREBASE_SERVICE_ACCOUNT="$(cat ruta/al/archivo-firebase-adminsdk.json)"
export ICAL_SOURCES='[{"plataforma":"Booking.com","habitacion":"1","url":"https://…"}]'
node sync.mjs
```

## Seguridad

- Los dos secretos viven cifrados en GitHub y solo el workflow los ve. GitHub oculta su
  contenido en los logs.
- El script nunca imprime las URL iCal ni la clave privada; en el log solo salen
  plataforma y habitación.
- Si sospechas que la clave de la cuenta de servicio se filtró: Firebase →
  Configuración del proyecto → Cuentas de servicio → enlace "Administrar permisos de
  cuentas de servicio" (Google Cloud) → la cuenta `firebase-adminsdk-…` → pestaña
  **Claves** → eliminar la clave antigua; luego genera una nueva y actualiza el secreto.
- Si un enlace iCal se filtró, en la plataforma puedes regenerarlo (Booking: eliminar y
  volver a exportar; Airbnb: "Exportar calendario" genera uno nuevo al desconectar) y
  actualizar `ICAL_SOURCES`.
