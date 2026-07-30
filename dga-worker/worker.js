/**
 * Worker de Cloudflare — Alertas de Ríos DGA
 *
 * Traducción a JavaScript de scripts/fetch_alertas_dga.py. Corre en la nube
 * (no en tu PC), así que el dashboard puede llamarlo directo al cargar la
 * página, sin que tengas que ejecutar nada manualmente.
 *
 * Por qué existe este Worker en vez de llamar a la DGA directo desde el
 * navegador: el sitio de la DGA no manda cabeceras CORS, así que el
 * navegador bloquea la petición si se hace desde otro dominio (confirmado
 * con pruebas reales en la consola de Chrome). Este Worker corre
 * servidor-a-servidor (Cloudflare → DGA), donde CORS no aplica, y le agrega
 * los headers CORS a SU PROPIA respuesta para que tu dashboard sí pueda
 * leerla.
 *
 * Endpoints:
 *   GET /alertas             → alertas básicas, rápido (~2-3s)
 *   GET /alertas?detalle=1   → incluye Caudal/Precipitación (~15-25s,
 *                               una petición extra por estación en alerta)
 */

const SNIA_URL = "https://snia.mop.gob.cl/sat/site/informes/mapas/mapas.xhtml";

// Mismo mapeo aproximado que en fetch_alertas_dga.py — ver ese archivo para
// la explicación completa de por qué estos códigos no son el código oficial
// de región de Chile.
const REGION_NAMES = {
  1: "Arica y Parinacota", 2: "Tarapacá", 3: "Antofagasta",
  4: "Atacama / Coquimbo", 5: "Coquimbo / Valparaíso", 6: "Valparaíso",
  7: "O'Higgins / Maule", 8: "Ñuble / Biobío", 9: "La Araucanía",
  10: "Los Ríos / Los Lagos", 11: "Aysén", 12: "Magallanes",
  13: "Metropolitana de Santiago", 14: "Los Ríos", 15: "Arica y Parinacota",
  16: "Ñuble",
};

const VALOR_TRANSMISION_LABELS = { 1: "Transmitiendo", 3: "Transmitiendo con anomalía", 4: "Transmitiendo con anomalía" };

// Headers que imitan un navegador real — la DGA devuelve 403 Forbidden con
// un User-Agent mínimo (confirmado en pruebas reales).
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
};

// Límite de estaciones a las que se les pide detalle en una sola ejecución.
// Protege contra timeouts del Worker si algún día hay muchísimas alertas a
// la vez. Con 20 estaciones y ~1s de pausa entre cada una, el peor caso
// ronda los 20-25s, dentro del límite de duración de un Worker gratuito.
const MAX_DETALLE_STATIONS = 20;
const DETALLE_DELAY_MS = 900;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

// -----------------------------------------------------------------------
// Extracción del array de estaciones — misma lógica que extract_stations()
// en fetch_alertas_dga.py: hay que ubicar el bloque REAL de initialize([...])
// (dentro de addEventListener('load', ...)), no el bloque viejo que queda
// comentado más arriba en el HTML, y balancear corchetes manualmente porque
// el array es demasiado grande e irregular para un regex simple.
// -----------------------------------------------------------------------
function extractStations(html) {
  let anchor = html.indexOf("addEventListener('load'");
  if (anchor === -1) anchor = 0;

  const searchFrom = html.slice(anchor);
  const match = searchFrom.match(/initialize\(\s*(\[)/);
  if (!match) {
    throw new Error("No se encontró el bloque de datos esperado en la página de la DGA. El sitio puede haber cambiado de formato.");
  }
  const start = anchor + match.index + match[0].indexOf("[");

  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error("El array de estaciones parece truncado (corchetes sin cerrar).");

  const raw = html.slice(start, end);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`El bloque encontrado no es JSON válido: ${e.message}`);
  }
}

function normalizeStation(s) {
  const regionCode = s.regionResponsable?.codigo ?? null;
  const valorTx = s.valorTransmision ?? null;
  return {
    codigo: s.codigo ?? null,
    nombre: (s.nombre || "").trim(),
    alerta: Boolean(s.alerta) || (s.nivelAlerta || 0) > 0,
    tipoAlerta: s.tipoAlerta ?? null,
    nivelAlerta: s.nivelAlerta ?? null,
    valorMedicion: s.valorMedicion ?? null,
    umbral: s.umbral ?? null,
    umbralSuperado: s.umbralSuperado ?? null,
    unidad: (s.parametro?.glsUnidad || "").trim() || null,
    parametro: (s.parametro?.glsParametro || "").trim() || null,
    fuenteEstacion: s.fuenteEstacion ?? null,
    tipoEstacion: s.tipoEstacion ?? null,
    fecha: s.fecha ?? null,
    regionCodigo: regionCode,
    regionNombreAprox: REGION_NAMES[regionCode] || `Región ${regionCode}`,
    latitud: s.latitud != null && s.latitud !== "" ? parseFloat(s.latitud) : null,
    longitud: s.longitud != null && s.longitud !== "" ? parseFloat(s.longitud) : null,
    utmEste: s.utmEste ?? null,
    utmNorte: s.utmNorte ?? null,
    altitud: s.altitud ?? null,
    error: Boolean(s.error),
    mensajeError: s.mensajeError ?? null,
    valorTransmision: valorTx,
    estadoTransmision: VALOR_TRANSMISION_LABELS[valorTx] || (valorTx != null ? `Código ${valorTx}` : null),
  };
}

function dedupeStations(stations) {
  const seen = new Set();
  const result = [];
  for (const s of stations) {
    if (seen.has(s.codigo)) continue;
    seen.add(s.codigo);
    result.push(s);
  }
  return result;
}

// -----------------------------------------------------------------------
// Detalle por estación (Caudal, Precipitación) — misma lógica que
// get_session_and_viewstate() + fetch_station_detail() en el script Python.
// Reconstruido a partir de una captura real de Chrome DevTools (Network →
// Payload). Si la DGA cambia los ids de componente JSF, esto deja de andar.
// -----------------------------------------------------------------------
const DETALLE_PATTERNS = {
  caudalM3s: /var ultimoCaudalReg = "([^"]*)"/,
  precipitacion24hMm: /var dif24PptacionAcum = "([^"]*)"/,
  precipitacionAcumMm: /var ultimaPptacionAcumuladaReg = "([^"]*)"/,
  alturaNieveCm: /var ultimaAlturaNieveReg = "([^"]*)"/,
  volumenLagoMillM3: /var ultimoVolumenReg = "([^"]*)"/,
};

function parseClNumber(text) {
  if (text == null) return null;
  const t = text.trim();
  if (t === "") return null;
  const n = parseFloat(t.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

async function getViewState() {
  const resp = await fetch(SNIA_URL, { headers: BROWSER_HEADERS });
  if (!resp.ok) throw new Error(`GET página principal falló: HTTP ${resp.status}`);
  const html = await resp.text();
  const match = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
  if (!match) throw new Error("No se pudo obtener javax.faces.ViewState de la página.");

  // A diferencia de requests.Session() en Python, fetch() en un Worker NO
  // mantiene cookies entre llamadas automáticamente — cada fetch() es
  // independiente. Sin la cookie de sesión (JSESSIONID) que la DGA entrega
  // en este primer GET, el POST siguiente puede fallar o devolver un
  // ViewState "no encontrado" en el servidor. Se captura acá y se reenvía
  // manualmente en fetchStationDetail().
  // getSetCookie() es el método estándar moderno para leer múltiples
  // cabeceras Set-Cookie (headers.get() solo devolvería la primera).
  const setCookieHeaders = typeof resp.headers.getSetCookie === "function"
    ? resp.headers.getSetCookie()
    : (resp.headers.get("Set-Cookie") ? [resp.headers.get("Set-Cookie")] : []);
  const cookie = setCookieHeaders
    .map(c => c.split(";")[0])
    .filter(Boolean)
    .join("; ");

  return { viewState: match[1], cookie };
}

async function fetchStationDetail(viewState, cookie, codigo, tipoEstacion) {
  const body = new URLSearchParams({
    "medicionesByTypeFunctions": "medicionesByTypeFunctions",
    "javax.faces.ViewState": viewState,
    "javax.faces.source": "medicionesByTypeFunctions:j_idt162",
    "javax.faces.partial.execute": "medicionesByTypeFunctions:j_idt162 @component",
    "javax.faces.partial.render": "@component",
    "param1": codigo,
    "param2": tipoEstacion || "",
    "org.richfaces.ajax.component": "medicionesByTypeFunctions:j_idt162",
    "medicionesByTypeFunctions:j_idt162": "medicionesByTypeFunctions:j_idt162",
    "AJAX:EVENTS_COUNT": "1",
    "javax.faces.partial.ajax": "true",
  });

  const headers = {
    ...BROWSER_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Faces-Request": "partial/ajax",
    "Referer": SNIA_URL,
    "Origin": "https://snia.mop.gob.cl",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookie) headers["Cookie"] = cookie;

  const resp = await fetch(SNIA_URL, { method: "POST", headers, body: body.toString() });

  if (!resp.ok) return null;
  const text = await resp.text();

  const result = {};
  let anyFound = false;
  for (const [key, pattern] of Object.entries(DETALLE_PATTERNS)) {
    const m = text.match(pattern);
    if (m) { anyFound = true; result[key] = parseClNumber(m[1]); }
    else { result[key] = null; }
  }
  return anyFound ? result : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleAlertas(url) {
  const wantDetalle = url.searchParams.get("detalle") === "1";
  const wantAll = url.searchParams.get("all") === "1";

  const pageResp = await fetch(SNIA_URL, { headers: BROWSER_HEADERS });
  if (!pageResp.ok) {
    throw new Error(`No se pudo descargar la página de la DGA: HTTP ${pageResp.status}`);
  }
  const html = await pageResp.text();

  const rawStations = extractStations(html);
  const rawCount = rawStations.length;
  let stations = dedupeStations(rawStations.map(normalizeStation));
  const duplicadosRemovidos = rawCount - stations.length;

  const enAlerta = stations.filter(s => s.alerta);
  let outputStations = wantAll ? stations : enAlerta;

  if (wantDetalle) {
    const target = outputStations.slice(0, MAX_DETALLE_STATIONS);
    try {
      const { viewState, cookie } = await getViewState();
      for (let i = 0; i < target.length; i++) {
        const s = target[i];
        try {
          s.detalle = await fetchStationDetail(viewState, cookie, s.codigo, s.tipoEstacion);
        } catch (e) {
          s.detalle = null;
        }
        if (i < target.length - 1) await sleep(DETALLE_DELAY_MS);
      }
    } catch (e) {
      // Si falla obtener el ViewState (p.ej. la DGA cambió el sitio), se
      // sigue devolviendo las alertas básicas sin detalle, en vez de fallar
      // toda la respuesta.
    }
  }

  return {
    generadoEn: new Date().toISOString(),
    fuente: SNIA_URL,
    totalEstacionesConsultadas: stations.length,
    totalEnAlerta: enAlerta.length,
    duplicadosRemovidos,
    soloAlertas: !wantAll,
    incluyeDetalle: wantDetalle,
    detalleLimitadoA: wantDetalle ? MAX_DETALLE_STATIONS : null,
    estaciones: outputStations,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse({
        servicio: "Alertas de Ríos DGA — Worker",
        endpoints: ["/alertas", "/alertas?detalle=1", "/alertas?all=1"],
      });
    }

    if (url.pathname === "/alertas") {
      try {
        const data = await handleAlertas(url);
        return jsonResponse(data);
      } catch (e) {
        return jsonResponse({ error: e.message || "Error desconocido" }, 502);
      }
    }

    return jsonResponse({ error: "Ruta no encontrada" }, 404);
  },
};
