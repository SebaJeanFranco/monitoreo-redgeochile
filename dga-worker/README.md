# Worker DGA — Alertas de Ríos en la nube

Este es el intermediario que resuelve el bloqueo de CORS del sitio de la DGA.
Corre en Cloudflare (gratis, sin tarjeta), no en tu PC. El dashboard le pide
los datos a este Worker en vez de al sitio de la DGA directamente.

## Por qué existe esto

El sitio de la DGA (`snia.mop.gob.cl`) no manda cabeceras CORS — confirmado
con pruebas reales en la consola del navegador: el `GET` funciona, pero
cualquier petición desde un dominio distinto (como tu dashboard) es
bloqueada por el navegador con el error *"No 'Access-Control-Allow-Origin'
header is present"*. Este Worker vive en su propio dominio, le pide los
datos a la DGA servidor-a-servidor (ahí CORS no aplica), y le agrega los
headers CORS a su propia respuesta para que tu dashboard sí pueda leerla.

## Paso a paso — primera vez

### 1. Crear cuenta de Cloudflare (gratis, sin tarjeta)
Andá a **https://dash.cloudflare.com/sign-up**, creá la cuenta con tu correo.
No pide tarjeta de crédito para el plan gratuito de Workers.

### 2. Instalar Wrangler (la herramienta de línea de comandos de Cloudflare)
Necesitás Node.js instalado (el mismo que ya usás para `npm run dev` del
dashboard). En la terminal, dentro de esta carpeta (`dga-worker`):

```powershell
npm install -g wrangler
```

### 3. Iniciar sesión
```powershell
wrangler login
```
Esto abre el navegador para que autorices Wrangler con tu cuenta de
Cloudflare. Aceptá y volvé a la terminal.

### 4. Desplegar el Worker
```powershell
wrangler deploy
```
Al terminar, la terminal te va a mostrar una URL parecida a:
```
https://alertas-rios-dga.TU-USUARIO.workers.dev
```
**Copiá esa URL** — es la que necesitás pegar en el dashboard (paso siguiente,
fuera de esta carpeta, en `src/CentroMando.jsx`).

### 5. Probar que funciona
Abrí en el navegador:
```
https://alertas-rios-dga.TU-USUARIO.workers.dev/alertas
```
Deberías ver un JSON con las alertas actuales (tarda 2-3 segundos). Para
probar con detalle de Caudal/Precipitación (tarda 15-25 segundos):
```
https://alertas-rios-dga.TU-USUARIO.workers.dev/alertas?detalle=1
```

## Actualizar el Worker después de un cambio
Si en el futuro modificás `worker.js`, solo hace falta volver a correr:
```powershell
wrangler deploy
```
La URL no cambia entre despliegues.

## Histórico y tendencia (Google Sheets)

Además de traer los datos en vivo de la DGA, este Worker guarda un snapshot
cada 30 minutos en una Google Sheet (vía un Cron Trigger — corre solo, sin
que nadie visite la web). Cuando el dashboard abre una categoría, el Worker
compara la lectura actual contra la anterior guardada y calcula si el
Nivel de Agua está subiendo, bajando, o estable.

### Por qué las credenciales van como Secrets, nunca en el código

`worker.js` y `sheets.js` se suben a GitHub como respaldo — y ese
repositorio es público. Si las credenciales de Google estuvieran escritas
en esos archivos, cualquiera con acceso al repo podría usarlas para leer o
modificar cualquier Sheet compartida con esa cuenta de servicio. Los
**Secrets de Cloudflare** existen justo para esto: se configuran una vez
por comando, quedan cifrados del lado de Cloudflare, y el código los lee
en tiempo de ejecución sin que su valor aparezca nunca en ningún archivo.

### Paso a paso — configurar Sheets desde cero

**1. Crear el proyecto en Google Cloud y habilitar la API**
- Andá a **https://console.cloud.google.com/**, creá un proyecto nuevo (o
  usá uno existente).
- Menú → **APIs y servicios → Biblioteca** → buscá **"Google Sheets API"**
  → **Habilitar**.

**2. Crear la cuenta de servicio**
- Menú → **APIs y servicios → Credenciales** → **Crear credenciales →
  Cuenta de servicio**.
- Ponele un nombre (ej. `dgaapi`), no hace falta darle ningún rol especial
  a nivel de proyecto.
- Entrá a la cuenta creada → pestaña **Claves** → **Agregar clave → Crear
  clave nueva → JSON**. Se descarga un archivo — **guardalo en un lugar
  seguro y fuera de este repositorio** (no lo pongas en `dga-worker/` ni
  en `centro-mando-app/`, para que nunca quede en un `git add .` por
  accidente).

**3. Crear la Sheet y compartirla**
- Creá una hoja de cálculo nueva en Google Sheets.
- Renombrá la pestaña de abajo a **`DATOS`** (el Worker escribe ahí
  específicamente — ver `sheets.js`, constante `range`).
- **Compartila** con el `client_email` que aparece en el JSON descargado
  (algo como `dgaapi@tu-proyecto.iam.gserviceaccount.com`), con permiso de
  **Editor**.
- Copiá el ID de la Sheet de la URL: en
  `https://docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit`, es la parte
  entre `/d/` y `/edit`.

**4. Configurar los Secrets en Cloudflare**

Dentro de la carpeta `dga-worker`:
```powershell
wrangler secret put GOOGLE_CLIENT_EMAIL
```
Te va a pedir pegar un valor — pegá el `client_email` del JSON descargado.

```powershell
wrangler secret put GOOGLE_PRIVATE_KEY
```
Pegá el valor completo de `private_key` del JSON (incluye los
`-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` y los saltos
de línea `\n` tal cual vienen en el archivo).

```powershell
wrangler secret put GOOGLE_SHEET_ID
```
Pegá el ID de la Sheet que copiaste en el paso 3.

**4b. Informe automático a Google Drive (opcional)**

Si además querés que cada corrida del cron genere un informe `.docx` y lo
suba a Drive:

- **No hace falta crear ni compartir ninguna carpeta a mano.** Las
  Service Accounts no tienen cuota de almacenamiento propia para crear
  archivos en una carpeta ajena (aunque tenga permiso de Editor) — la
  única forma de que funcione sin Google Workspace es que la propia
  Service Account cree SU carpeta, donde sí tiene cuota, y te la comparta
  a vos automáticamente la primera vez que corre (ver drive.js si querés
  el detalle completo). La carpeta se llama **"Informes DGA — Alertas de
  Ríos"** y aparece en Drive, en la sección **"Compartido conmigo"** (podés
  agregarla a "Mi unidad" con un clic para que se vea junto al resto).

```powershell
wrangler secret put GOOGLE_DRIVE_SHARE_WITH_EMAIL
```
Pegá tu email personal de Google — a esa dirección se comparte la carpeta
con permiso de Editor, la primera vez que corre el cron.

```powershell
wrangler secret put WORKER_SELF_URL
```
Pegá la URL pública de este mismo Worker una vez desplegado (paso 5), algo
como `https://alertas-rios-dga.TU-SUBDOMINIO.workers.dev` — el Worker la
necesita para pedirse Caudal a sí mismo, estación por estación, sin
acumular todas esas peticiones contra el límite de subrequests de una sola
corrida del cron (ver el comentario largo en `worker.js`,
`generarYSubirInformeAutomatico()`, si querés el detalle completo).

Si no configurás `GOOGLE_DRIVE_SHARE_WITH_EMAIL`/`WORKER_SELF_URL`, el
resto del Worker sigue funcionando normal — el cron simplemente deja
constancia en los logs de que no pudo generar el informe automático (o que
creó la carpeta pero no pudo compartirla con nadie), sin afectar el
guardado de Nivel de Agua en Sheets ni ninguna otra parte del dashboard.

**5. Desplegar**
```powershell
wrangler deploy
```

### Confirmar que el cron está corriendo
En **https://dash.cloudflare.com** → tu Worker → pestaña **"Triggers"** o
**"Cron Triggers"**, deberías ver el horario configurado
(`*/30 * * * *` = cada 30 minutos). En **"Logs"** podés ver si cada
corrida guardó filas correctamente o tiró algún error — el cron nunca
rompe el resto del sistema si falla (queda solo en los logs, y reintenta
en la corrida siguiente).

### Si necesitás rotar la clave
Si en algún momento la clave privada quedó expuesta (por ejemplo,
compartida sin querer), rotarla no rompe nada del lado del dashboard:
1. Google Cloud Console → la cuenta de servicio → pestaña **Claves** →
   inhabilitá/eliminá la clave vieja → creá una nueva.
2. `wrangler secret put GOOGLE_PRIVATE_KEY` de nuevo, con el valor nuevo.
3. `wrangler deploy`.
El `client_email` no cambia, así que no hace falta volver a compartir la
Sheet.

## Límites del plan gratuito
- 100.000 peticiones por día — más que suficiente para uso personal.
- Duración máxima por petición: sobrada para este caso (~20-25s en el peor
  caso con `?detalle=1`); si la DGA responde más lento de lo normal en algún
  momento, el Worker puede cortar la petición de detalle — en ese caso
  simplemente devuelve las alertas sin detalle en vez de fallar del todo.
- No requiere tarjeta de crédito para este nivel de uso.
- **Google Sheets API** (gratis): 60 escrituras/minuto y 60 lecturas/minuto
  por usuario, muy por encima de lo que este Worker necesita (una
  escritura cada 30 min, una lectura por cada vez que alguien abre una
  categoría en el dashboard).

## Nota sobre el scraping
Igual que el script Python, este Worker hace scraping de una página pública
gubernamental que no ofrece una API oficial. Es responsabilidad de quien lo
use revisar los términos de uso del sitio de la DGA y no abusar de la
frecuencia de consultas — el límite de `MAX_DETALLE_STATIONS` en
`worker.js` existe justamente para eso.
