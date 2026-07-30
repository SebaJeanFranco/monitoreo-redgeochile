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

## Límites del plan gratuito
- 100.000 peticiones por día — más que suficiente para uso personal.
- Duración máxima por petición: sobrada para este caso (~20-25s en el peor
  caso con `?detalle=1`); si la DGA responde más lento de lo normal en algún
  momento, el Worker puede cortar la petición de detalle — en ese caso
  simplemente devuelve las alertas sin detalle en vez de fallar del todo.
- No requiere tarjeta de crédito para este nivel de uso.

## Nota sobre el scraping
Igual que el script Python, este Worker hace scraping de una página pública
gubernamental que no ofrece una API oficial. Es responsabilidad de quien lo
use revisar los términos de uso del sitio de la DGA y no abusar de la
frecuencia de consultas — el límite de `MAX_DETALLE_STATIONS` en
`worker.js` existe justamente para eso.
