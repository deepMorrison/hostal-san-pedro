# Hostal San Pedro · Recepción

La app de recepción del hostal, en tu propio sitio web y con tu propia base de datos:

- **Pre-registro por enlace**: el pasajero completa sus datos desde el celular y quedan guardados al instante en la base.
- **Llegada**: en recepción se escanea el pasaporte o la cédula; el sistema encuentra el pre-registro por el número de documento y llena el formulario solo.
- **Habitaciones**: al hacer el check-in se ve qué habitaciones están libres en las fechas del pasajero (y cuántas camas quedan en los dormitorios).
- **Reservas**: las de Booking.com, Airbnb y otras entran solas cada hora desde sus calendarios (carpeta `sync-ical`).
- Libro de pasajeros, estadísticas, exportación CSV/PDF, información para el pasajero (WiFi, normas, emergencias) en 4 idiomas.

## Qué hay en esta carpeta

| Carpeta / archivo | Para qué sirve |
|---|---|
| `docs/` | El sitio. GitHub Pages lo publica tal cual. |
| `docs/config.js` | **Aquí se pega la configuración de Firebase** (paso 1.6). |
| `firestore.rules` | Las reglas de seguridad de la base. Se pegan en la consola de Firebase (paso 1.5). |
| `sync-ical/` | El sincronizador de calendarios de Booking/Airbnb. Su guía está en `sync-ical/README.md`. |
| `.github/workflows/sync-ical.yml` | La tarea de GitHub que ejecuta el sincronizador cada hora. |

---

## Puesta en marcha (una sola vez)

### 1. Firebase: base de datos y acceso

1. Entra a <https://console.firebase.google.com> con tu cuenta de Google → **Agregar proyecto** → nombre `hostal-san-pedro` → desactiva Google Analytics → **Crear proyecto**.
2. Menú izquierdo **Compilación → Firestore Database → Crear base de datos** → ubicación **`southamerica-east1` (São Paulo)** → **modo de producción** → **Habilitar**.
3. **Compilación → Authentication → Comenzar → Método de acceso**: activa **Correo electrónico/contraseña** (solo el primer interruptor) y **Anónimo**. Guarda cada uno.
4. **Authentication → Usuarios → Agregar usuario**: el correo del personal (por ejemplo `recepcion@hostalsanpedro.cl`) y una contraseña segura. Esa cuenta es la que se usa en los equipos de la recepción.
5. **Firestore Database → Reglas**: borra todo lo que hay, pega el contenido completo de `firestore.rules` y **cambia el correo** de esta línea por el del paso 4:
   ```
   && request.auth.token.email in ['recepcion@hostalsanpedro.cl'];
   ```
   Si tienes más de una cuenta del personal: `['recepcion@hostalsanpedro.cl', 'otra@hostalsanpedro.cl']`. Pulsa **Publicar**: si algo quedó mal escrito, la consola lo marca en rojo y no deja publicar.
6. **⚙ Configuración del proyecto → General → Tus apps →** icono **`</>`** (Web) → apodo `recepcion` → **Registrar app**. Aparece un bloque `const firebaseConfig = { apiKey: "...", ... }`. Copia los valores y reemplaza los `PEGA_AQUI` de `docs/config.js`.
   Estos valores son públicos por diseño (van dentro de la página); lo que protege los datos son las reglas del paso 5.
7. (Recomendado) **Authentication → Configuración → Dominios autorizados → Agregar dominio**: `TU-USUARIO.github.io`.

### 2. GitHub: publicar el sitio

1. En <https://github.com> → **New repository** → nombre `hostal-san-pedro` → **Public** (GitHub Pages gratis lo exige) → **Create repository**.
2. En la página del repositorio vacío, pulsa **uploading an existing file** y arrastra **todo el contenido** de esta carpeta (`docs`, `sync-ical`, `.github`, `firestore.rules`, `README.md`, `.gitignore`) → **Commit changes**.
   Si `.github` no se subió, no importa para el sitio; solo hace falta para las reservas automáticas y se crea a mano en un minuto (ver la nota al inicio de `sync-ical/README.md`).
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, carpeta `/docs` → Save**. En 1 o 2 minutos el sitio queda en `https://TU-USUARIO.github.io/hostal-san-pedro/`.
4. Si pegaste `config.js` después de subir: en GitHub abre `docs/config.js` → lápiz ✏️ → pega → **Commit changes**. El sitio se actualiza solo en 1 o 2 minutos.

### 3. Primer uso

1. En el computador o la tablet de la recepción abre el enlace del sitio → al final de la página, **Acceso del personal** → correo y contraseña del paso 1.4. El equipo queda recordado; desde ahí solo se pide el PIN.
2. Pestaña **Recepción** → PIN `1234` → **Configuración**: nombre, dirección, teléfono/WhatsApp del hostal, WiFi, precio, habitaciones → **Guardar información** (esto es lo que ven los pasajeros). En **Ajustes de recepción** cambia el PIN.
3. Prueba: abre el enlace en tu celular (sin iniciar sesión) → haz un pre-registro de prueba → en la recepción aparece en **Hoy** con la etiqueta **Pre-registro**.

### 4. Reservas automáticas (opcional)

Sigue `sync-ical/README.md`: crear una cuenta de servicio en Firebase y guardar dos secretos en GitHub (`FIREBASE_SERVICE_ACCOUNT` e `ICAL_SOURCES`).

---

## Día a día

**Enviar el pre-registro a un pasajero**
- Desde una reserva: **Recepción → Reservas → Link pre-registro** → **WhatsApp** (si la reserva tiene teléfono) o **Copiar mensaje** (para pegarlo en el correo o el chat de la plataforma). El enlace lleva el nombre, las fechas y la habitación de la reserva ya cargados, y el pre-registro queda ligado a esa reserva.
- Enlace general: el del sitio, o el QR de **Configuración → Enlace público** (sirve para imprimir).

**Cuando llega**
- **Hoy → + Nuevo registro → Tomar foto del documento** (o la cámara en vivo). Si el pasajero hizo su pre-registro, aparece «Pre-registro encontrado» y el formulario se completa solo. Elige la habitación tocando una ficha verde (libre), firma y **Registrar check-in**. No se crea un registro duplicado: se completa el mismo.
- Si llegó por una reserva: **Reservas → Check-in** en su fila; si ya hizo el pre-registro, se cargan sus datos.
- También se puede confirmar directo en **Hoy**: elige la habitación en la lista (se sugiere la primera libre según el orden de Configuración) y **Confirmar**. Si falta la firma, **Firmar**.
- En la tablet de la recepción (modo kiosco) el pasajero puede escanear su documento y firmar él mismo; queda «por confirmar» y recepción le asigna la habitación en **Hoy**.

**Habitaciones** (Configuración → Habitaciones)
- Formato `nombre:capacidad`, separadas por coma: `1:2, 2:2, 3:3, 4:2, 5:2, 6:2, 7:3, 8:4, Dorm A:6, Dorm B:8`.
- Si se deja vacío se usan 10 habitaciones (1 a 10).
- Una habitación privada está libre solo si nadie la ocupa esas noches. Las que se llaman «Dorm…» (o con `c`, como `Mixto:8c`) se venden por cama y muestran cuántas camas quedan.

## Seguridad y datos personales

- El pasajero (sin cuenta) solo puede **crear** su pre-registro: no puede leer ni cambiar ningún registro, ni ver reservas ni el PIN.
- Solo las cuentas del personal que estén en la lista de `firestore.rules` ven los datos. Aunque alguien cree otra cuenta, no entra.
- No se guardan tarjetas de crédito en ninguna parte del sistema.
- Desde el 1 de diciembre de 2026 rige en Chile la Ley 21.719 de protección de datos personales: conviene informar al pasajero para qué se usan sus datos (las normas de la casa son un buen lugar) y borrar lo que ya no se necesite.
