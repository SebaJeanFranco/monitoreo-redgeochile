# Centro de Control — Alertas de Ríos DGA

Este proyecto tiene dos partes, en dos carpetas separadas dentro de este mismo repositorio:

```
centro-control/
├── centro-mando-app/    ← el dashboard (lo que ves en el navegador)
└── dga-worker/          ← el intermediario que trae los datos desde la nube
```

## Estado actual (para retomar rápido después de un tiempo sin tocar esto)

- **Dashboard en producción:** https://centrol-redgeochile.pages.dev (Cloudflare Pages, conectado a este repo)
- **Worker en producción:** https://alertas-rios-dga.redgeochile-monitor.workers.dev (Cloudflare Workers)
- Ambos ya están desplegados y funcionando. Este repositorio es la copia de respaldo/edición — **no hace falta volver a desplegar nada desde cero**, solo actualizar lo que cambie (ver abajo cómo, según qué carpeta toques).

## ⚠️ Importante: las dos carpetas se despliegan DISTINTO

**Cambios en `centro-mando-app/`** (React, estilos, componentes):
Basta con subir el archivo actualizado a este repositorio de GitHub (commit). Cloudflare Pages está conectado a este repo y **recompila y publica solo**, automáticamente, en 1-2 minutos. No hay que tocar nada más.

**Cambios en `dga-worker/worker.js`** (lógica que trae datos de la DGA):
GitHub **no está conectado a Cloudflare Workers** — este repo es solo respaldo del código. Si cambiás algo acá, además de subirlo a GitHub, hay que desplegarlo a mano:
```bash
cd dga-worker
wrangler deploy
```
(necesita `wrangler login` la primera vez en cada PC nueva — ver `dga-worker/README.md`)

## Si perdiste la carpeta local y necesitás retomar

1. Descargá este repositorio completo desde GitHub (botón "Code" → "Download ZIP").
2. Dentro de `centro-mando-app/`, creá un archivo `.env` (no viene en GitHub a propósito) con:
   ```
   VITE_DGA_WORKER_URL=https://alertas-rios-dga.redgeochile-monitor.workers.dev
   ```
3. `npm install` dentro de `centro-mando-app/`, y ya podés seguir trabajando con `npm run dev`.
4. El Worker no necesita reinstalación — sigue vivo en Cloudflare independientemente de tu PC. Solo necesitás `wrangler login` de nuevo si vas a desplegar un cambio nuevo desde esta PC.

## ¿Por dónde empiezo si es la primera vez?

**Para correr el dashboard (obligatorio):**
Andá a `centro-mando-app/`, seguí las instrucciones de `centro-mando-app/README.md`.

**Para que los datos se actualicen solos al abrir la página (opcional, recomendado):**
Andá a `dga-worker/`, seguí las instrucciones de `dga-worker/README.md`. Es un despliegue de una sola vez a Cloudflare (gratis, sin tarjeta) — después de eso, el dashboard se conecta solo.

Sin el paso del Worker, el dashboard igual funciona: solo que en vez de actualizarse solo, tenés que correr manualmente `centro-mando-app/scripts/fetch_alertas_dga.py` cada vez que quieras datos frescos.
