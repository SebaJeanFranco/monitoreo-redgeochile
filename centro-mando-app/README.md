# Alertas de Ríos — DGA Chile

Feed de guardia con las estaciones fluviométricas de la Dirección General de Aguas (DGA) que están actualmente en alerta (Azul / Amarilla / Roja), ordenadas por urgencia — Roja primero, siempre. Datos reales de estación física (nivel de agua, caudal, precipitación), no un modelo meteorológico. Se extraen con un script Python (`scripts/fetch_alertas_dga.py`) porque el sitio de la DGA no expone CORS para consultarlo directo desde el navegador.

> Nota: este proyecto tuvo antes un panel de viento/lluvia por ciudad vía Open-Meteo. Se sacó para dejar el dashboard enfocado solo en alertas oficiales de la DGA.

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior (incluye npm)
- [Python](https://www.python.org/) 3.8+ con la librería `requests` (ver instalación abajo)

## Instalación

Abre esta carpeta en Visual Studio Code, abre una terminal integrada (**Terminal > New Terminal**) y ejecuta:

```bash
npm install
```

## Ejecutar en desarrollo

```bash
npm run dev
```

Esto levanta el servidor local (por defecto en `http://localhost:5173`). Ábrelo en el navegador — Vite recarga automáticamente al guardar cambios.

## Compilar para producción

```bash
npm run build
```

Genera la carpeta `dist/` con los archivos estáticos listos para desplegar (Netlify, Vercel, GitHub Pages, un hosting propio, etc.). Para previsualizar ese build localmente:

```bash
npm run preview
```

## Estructura

```
├── index.html                     # HTML raíz
├── public/
│   └── alertas-rios.json          # Datos de alertas DGA (generado por el script Python)
├── scripts/
│   └── fetch_alertas_dga.py       # Script que extrae alertas reales de estaciones DGA
├── src/
│   ├── main.jsx                   # Punto de entrada de React
│   ├── index.css                  # Directivas de Tailwind
│   └── CentroMando.jsx            # Componente principal del panel
├── tailwind.config.js
├── postcss.config.js
├── vite.config.js
└── package.json
```

## Cómo funciona

- Estaciones fluviométricas oficiales de la Dirección General de Aguas, vía su Sistema Nacional de Información del Agua (SNIA): `https://snia.mop.gob.cl/sat/site/informes/mapas/mapas.xhtml`.
- **Esto es la lectura directa de un instrumento en terreno**, con el sistema de alerta oficial de la DGA (Azul / Amarilla / Roja) — no un modelo meteorológico.
- El navegador no puede consultar ese sitio directamente (no expone CORS para peticiones externas). Hay **dos formas** de resolver esto — elegí una:

### Opción A — Actualización automática al abrir la página (recomendada)
Un **Worker de Cloudflare** (carpeta `../dga-worker/`, gratis, corre en la nube, no en tu PC) hace de intermediario: le pide los datos a la DGA servidor-a-servidor (ahí CORS no aplica) y se los entrega a tu dashboard. Configurando la variable `VITE_DGA_WORKER_URL` en un archivo `.env` (ver `.env.example`), el dashboard llama al Worker automáticamente cada vez que se abre o se aprieta "Actualizar" — sin tocar la terminal.

**Guía completa de despliegue:** `dga-worker/README.md`.

### Opción B — Script manual (sin desplegar nada)
Sin el Worker configurado, el dashboard lee `public/alertas-rios.json`, un archivo estático que generás vos a mano cada vez con `scripts/fetch_alertas_dga.py`. Funciona igual de bien, solo que no se actualiza solo.
- **Orden de las tarjetas**: por urgencia — Roja primero, luego Amarilla, luego Azul. Sin agrupar por región: es un feed único de todo Chile. Las estaciones en Roja pulsan visualmente para llamar la atención.
- **Caudal en la tarjeta**: si el JSON se generó con `--detalle`, el Caudal (m³/seg) se muestra directo en la fila, sin necesidad de abrir el detalle.
- **Roja parpadea de verdad**: el fondo y el borde de la tarjeta laten entre dos tonos de rojo (animación CSS con `!important`, para que no compita con las clases de color de Tailwind). Amarilla y Azul quedan estáticas — el contraste visual es la señal.
- **Mapa general** (abajo de las tarjetas): todas las estaciones en alerta con coordenadas, sobre OpenStreetMap (`react-leaflet`, sin API key). Punto rojo/amarillo/azul según severidad. Es puramente referencial — el popup al pasar el clic solo muestra nombre y región, sin acciones.
- **Mapa de ubicación en el detalle**: cada ficha de estación (clic en cualquier tarjeta) incluye un mini-mapa centrado y con zoom sobre esa estación puntual, para ver exactamente dónde queda.

**Para actualizar las alertas de ríos:**
```bash
python3 scripts/fetch_alertas_dga.py --out public/alertas-rios.json
```

**Para incluir además Caudal, Precipitación 24h/acumulada, Altura de nieve y Volumen de lago** (los mismos datos que muestra el popup del sitio oficial de la DGA al hacer clic en un pin, que no vienen en la carga inicial del mapa):

Primero instalá la librería `requests` (una sola vez):

**Windows (PowerShell):**
```powershell
.\scripts\install.ps1
```
(o directo: `python -m pip install requests` si `pip` no está reconocido como comando suelto)

> Si PowerShell responde con un error de "no se puede cargar porque la ejecución de scripts está deshabilitada", corré primero (una sola vez, en esa misma terminal): `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` y después repetí `.\scripts\install.ps1`. O saltate el script y corré directo `python -m pip install requests`.

**Mac / Linux:**
```bash
bash scripts/install.sh
```
(o directo: `pip install requests --break-system-packages`)

Luego, en cualquier sistema:
```bash
python3 scripts/fetch_alertas_dga.py --out public/alertas-rios.json --detalle
```
Esto hace una petición AJAX adicional por cada estación en alerta (con una pausa de ~1.5s entre cada una, para no sobrecargar el servidor de la DGA), reproduciendo la misma petición que dispara el sitio oficial al hacer clic en un pin del mapa. Es más lento pero trae el detalle completo. Si esa petición falla para alguna estación (por ejemplo si la DGA cambia el sitio), esa estación simplemente queda sin el campo `detalle` — el resto del panel sigue funcionando igual.

Corré cualquiera de los dos comandos cada vez que quieras refrescar los datos (mientras `npm run dev` esté corriendo, Vite lo recarga solo). Para producción, corré el script antes de cada `npm run build`, o automatizalo con un cron / GitHub Action que lo ejecute periódicamente y actualice el archivo en el repo.

**Nota técnica:** el JSON de estaciones no proviene de una API pública documentada por la DGA — está embebido en el HTML de la página tal como está construida hoy. Si la DGA cambia el sitio, el script puede dejar de funcionar; en ese caso avisa el error por consola y no rompe el resto del panel (simplemente no muestra la sección de alertas de ríos).

**Corrección importante (2026-07-19):** la página tiene *dos* bloques `initialize([...])` — uno real (dentro de `window.addEventListener('load', ...)`) y uno viejo dejado comentado (`/* ... */`) más arriba en el HTML con datos obsoletos. El script ahora ubica específicamente el bloque real y balancea corchetes manualmente para extraerlo completo (antes se corría el riesgo de capturar el bloque equivocado). De paso se agregó:
- `utmEste` / `utmNorte` (ya venían en el JSON crudo, pero no se estaban copiando al resultado).
- `estadoTransmision`: texto legible derivado de `valorTransmision` (el popup del sitio oficial lo muestra como "Estado Tx", pero es un valor calculado en el JS del cliente, no viene como texto en el dato crudo).
- Deduplicación por código de estación — la fuente de la DGA repite algunos códigos varias veces (hasta 6 veces vistas) con datos idénticos; el script ahora se queda con una sola ocurrencia y reporta cuántas quitó en `duplicadosRemovidos`.
- El campo `alerta` de salida ahora es `true` si el dato crudo trae `alerta: true` **o** `nivelAlerta > 0` (en la práctica ambos coinciden siempre en las muestras revisadas, pero se deja así por seguridad ante variaciones futuras del feed).

**Detalle por estación — Caudal y Precipitación (2026-07-19):** el popup del sitio oficial también muestra Caudal (m³/seg), Precipitación últimas 24h (mm), Precipitación acumulada (mm), Altura de nieve (cm) y Volumen de lago (Mill.m³) para algunas estaciones. Estos valores **no están** en el array `initialize([...])` de la carga inicial — se obtienen recién cuando el usuario hace clic en un pin, mediante una petición AJAX propia de JSF/RichFaces (`medicionesByTypeFunctions`) que le pasa el código de la estación al servidor, y este responde con los valores ya calculados como texto plano dentro de un bloque `<script>`. El flag `--detalle` reproduce esa petición para cada estación en alerta. Esto se reconstruyó a partir de una captura real de Chrome DevTools (Network → Payload) — no es una API documentada por la DGA, así que si el sitio cambia los nombres internos de sus componentes JSF, la función `fetch_station_detail()` en el script puede dejar de funcionar y hay que volver a capturar el payload real desde el navegador.

**Nota sobre regiones:** el código de región que usa el sistema SNIA de la DGA no corresponde 1:1 al código oficial de región de Chile (agrupa algunas regiones juntas, como Ñuble y Biobío). El nombre de región mostrado es aproximado — el nombre de la estación y sus coordenadas son la referencia más confiable.

## Notas

- El script `fetch_alertas_dga.py` hace scraping de una página pública gubernamental. Es responsabilidad de quien lo use revisar los términos de uso del sitio de la DGA y no abusar de la frecuencia de consultas.
- El link al visor oficial de la DGA (SNIA) queda disponible al pie del panel y dentro de cada tarjeta, para ver el histórico completo de una estación — algo que este panel no muestra, ya que el dato crudo del feed es una foto puntual, no una serie de tiempo.
