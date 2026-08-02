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
 *   GET /alertas                        → alertas básicas de TODAS las
 *                                           categorías, rápido (~2-3s), sin
 *                                           Caudal. Pensado para la pantalla
 *                                           inicial del dashboard (conteos
 *                                           + mapa general).
 *   GET /alertas?detalle=1              → incluye Caudal/Precipitación de
 *                                           Roja+Amarilla juntas (comporta-
 *                                           miento histórico, sin ?color=).
 *   GET /alertas?detalle=1&color=Roja   → incluye Caudal SOLO de esa
 *   GET /alertas?detalle=1&color=Amarilla  categoría (Roja/Amarilla/Azul).
 *   GET /alertas?detalle=1&color=Azul      Pensado para el flujo de "3
 *                                           botones grandes" del dashboard:
 *                                           el detalle se pide recién
 *                                           cuando el usuario abre esa
 *                                           categoría específica.
 *
 * Todas las peticiones de detalle van EN SERIE (una a la vez, no en
 * paralelo) — ver la nota larga en fetchDetalleEnLotes() sobre la
 * condición de carrera que causaba paralelizarlas.
 *
 * Histórico y tendencia (Google Sheets): un Cron Trigger (ver
 * wrangler.toml) ejecuta scheduled() cada 30 minutos, SIN que ningún
 * usuario visite la web — guarda un snapshot de Nivel de Agua de todas las
 * estaciones en alerta en una Google Sheet (ver sheets.js). Cuando el
 * dashboard pide el detalle de una categoría, el Worker además lee esa
 * Sheet y le agrega a cada estación un campo `tendencia` con la
 * comparación contra su lectura anterior — así el usuario puede ver
 * "subió 8% en 30 min" sin que el navegador tenga que saber nada de
 * Sheets ni de credenciales.
 */

import { appendSnapshotRows, appendLogRows, readAllSnapshotRows, findLatestPreviousByCode } from "./sheets.js";

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
// Protege contra timeouts del Worker si algún día hay muchísimas alertas de
// una categoría a la vez. Las peticiones son EN SERIE (~0.7-1s cada una,
// ver DETALLE_DELAY_MS más abajo), así que 30 estaciones son ~20-30s en el
// peor caso — el límite de tiempo de un Worker de Cloudflare da margen de
// sobra para eso. Se subió de 20 a 30 respecto a la versión anterior porque
// ahora el detalle se pide por categoría (?color=Roja/Amarilla/Azul) en vez
// de Roja+Amarilla combinadas, y Azul sola puede superar fácilmente las 20
// estaciones en un día con muchas alertas menores.
const MAX_DETALLE_STATIONS = 30;

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
// Colector de logs de diagnóstico: junta los mensajes de una corrida en un
// array simple para mandarlos todos juntos a la hoja "LOG" al final (ver
// appendLogRows() en sheets.js) — una sola petición HTTP a Sheets por
// corrida, en vez de una por mensaje. También escribe cada mensaje a
// console.log/console.error como antes, así el stream de Logs de
// Cloudflare (para quien lo tenga abierto en vivo) sigue mostrando todo
// igual que antes; Sheets es un respaldo consultable después, no un
// reemplazo del stream en vivo.
// -----------------------------------------------------------------------
function makeLogCollector() {
  const entries = [];
  return {
    log(mensaje) {
      console.log(mensaje);
      entries.push({ nivel: "info", mensaje });
    },
    error(mensaje) {
      console.error(mensaje);
      entries.push({ nivel: "error", mensaje });
    },
    entries,
  };
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
    tipoEstacion: (s.tipoEstacion ?? "").trim() || null,
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

async function requestStationDetail(viewState, cookie, codigo, param2, logger) {
  const body = new URLSearchParams({
    "medicionesByTypeFunctions": "medicionesByTypeFunctions",
    "javax.faces.ViewState": viewState,
    "javax.faces.source": "medicionesByTypeFunctions:j_idt162",
    "javax.faces.partial.execute": "medicionesByTypeFunctions:j_idt162 @component",
    "javax.faces.partial.render": "@component",
    "param1": codigo,
    "param2": param2 || "",
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
  if (!resp.ok) {
    logger.log(`[detalle] ${codigo}: HTTP ${resp.status} en el POST de detalle (param2="${param2 || ""}")`);
    return null;
  }
  const text = await resp.text();

  const result = {};
  let anyFound = false;
  for (const [key, pattern] of Object.entries(DETALLE_PATTERNS)) {
    const m = text.match(pattern);
    if (m) { anyFound = true; result[key] = parseClNumber(m[1]); }
    else { result[key] = null; }
  }
  if (!anyFound) {
    logger.log(`[detalle] ${codigo}: respuesta OK pero sin ninguna variable esperada en el <script> (param2="${param2 || ""}", ${text.length} bytes recibidos)`);
  } else if (result.caudalM3s == null) {
    // Puede ser normal (la estación no mide Caudal, solo Precipitación/Nieve/etc.)
    // o puede ser el mismo problema de "no calzó" pero afectando solo esta
    // variable puntual — se deja registrado para poder diferenciarlo con
    // varias corridas en los logs, en vez de asumir una causa sin dato.
    logger.log(`[detalle] ${codigo}: trajo detalle pero SIN Caudal (otros campos: ${JSON.stringify(result)})`);
  }
  return anyFound ? result : null;
}

// Envoltorio con reintento. Se observó que algunas estaciones devuelven
// TODOS los campos de detalle en null en el primer intento (ej. "RIO
// CHOLCHOL EN CHOLCHOL", que sí tiene Caudal real en el sitio oficial),
// mientras que otras con tipoEstacion "simple" funcionan a la primera. La
// sospecha es que el servidor de la DGA hace una comparación exacta de
// string contra param2 (tipoEstacion) y algunas combinaciones largas o con
// variaciones de formato no calzan. En vez de perseguir cada caso de
// formato uno por uno, si el primer intento no trae ningún dato, se
// reintenta una vez sin param2 (vacío) — que en las capturas de red
// originales no siempre resultó estrictamente necesario para que el
// servidor identifique la estación por su código.
async function fetchStationDetail(viewState, cookie, codigo, tipoEstacion, logger) {
  const first = await requestStationDetail(viewState, cookie, codigo, tipoEstacion, logger);
  if (first != null) return first;
  logger.log(`[detalle] ${codigo}: primer intento (param2="${tipoEstacion || ""}") sin datos, reintentando con param2 vacío...`);
  const second = await requestStationDetail(viewState, cookie, codigo, "", logger);
  if (second == null) {
    logger.log(`[detalle] ${codigo}: reintento también sin datos — la estación queda sin detalle esta corrida.`);
  }
  return second;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pausa entre peticiones de detalle. IMPORTANTE: estas peticiones se hacen
// EN SERIE (una a la vez), no en paralelo — ver la nota larga en
// fetchDetalleEnLotes() más abajo sobre por qué se intentó paralelizar y
// tuvo que revertirse.
const DETALLE_DELAY_MS = 700;

async function fetchDetalleEnLotes(stations, viewState, cookie, logger) {
  // Nota histórica importante: esta función se llamó "EnLotes" porque en un
  // momento pedía el detalle de varias estaciones EN PARALELO (lotes de 5,
  // con Promise.allSettled) para acelerar la carga de ~20-25s a ~5-8s. Se
  // revirtió a secuencial tras confirmar con datos reales de producción que
  // la paralelización introducía un bug de datos, no solo un problema de
  // velocidad:
  //
  // Se analizaron 16 estaciones Roja/Amarilla en una respuesta real: 10 de
  // 16 volvían con TODOS los campos de detalle en null, sin ningún patrón
  // por región, código de estación, ni tipoEstacion (la misma estación con
  // el mismo tipoEstacion "Fluviometricas" a veces traía el dato y a veces
  // no). Lo único que explicaba el patrón era la posición de cada estación
  // dentro de su lote de 5 peticiones simultáneas — y esa posición ganadora
  // cambiaba de un lote a otro sin ningún orden fijo.
  //
  // La explicación técnica: el servidor de la DGA usa JSF/RichFaces, un
  // framework donde el javax.faces.ViewState representa el estado de UNA
  // vista de servidor en un momento dado. Cuando 5 peticiones AJAX llegan
  // casi al mismo tiempo compartiendo el mismo ViewState y la misma cookie
  // de sesión, el servidor las procesa como si fueran ediciones concurrentes
  // sobre el mismo estado — no está diseñado para eso. La petición que
  // "gana la carrera" en el servidor devuelve el dato real; el resto recibe
  // una respuesta de un estado ya pisado/inválido, que nuestro código
  // interpreta correctamente como "sin datos" (por eso vuelve null en vez
  // de un error o un dato incorrecto — RichFaces no rompe, solo no entrega
  // nada útil).
  //
  // La única forma confiable de evitar la condición de carrera es no crear
  // la carrera: pedir el detalle de una estación a la vez, esperando a que
  // la respuesta completa vuelva antes de pedir la siguiente. Es lo que
  // hace este bucle. Vuelve a ser más lento (~15-20s para 20 estaciones en
  // vez de ~5-8s), pero es la diferencia entre datos correctos y datos
  // silenciosamente incorrectos — para un panel de alertas de crecidas de
  // ríos, esa prioridad no es negociable.
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    try {
      s.detalle = await fetchStationDetail(viewState, cookie, s.codigo, s.tipoEstacion, logger);
    } catch (e) {
      // Fallo de red/excepción real (timeout, conexión cortada, etc.) — no
      // el caso de "respuesta vacía sin error" que ya maneja el reintento
      // de param2 dentro de fetchStationDetail(). Un solo reintento extra
      // acá cubre errores transitorios puntuales sin alargar demasiado el
      // resto de la carga si es un fallo persistente.
      logger.log(`[detalle] ${s.codigo}: excepción de red en el primer intento (${e.message || e}), reintentando...`);
      try {
        s.detalle = await fetchStationDetail(viewState, cookie, s.codigo, s.tipoEstacion, logger);
      } catch (e2) {
        logger.log(`[detalle] ${s.codigo}: excepción de red también en el reintento (${e2.message || e2}) — queda sin detalle.`);
        s.detalle = null;
      }
    }
    if (i < stations.length - 1) await sleep(DETALLE_DELAY_MS);
  }

  // Resumen final de la corrida — visible en Logs de Cloudflare sin tener
  // que contar manualmente entre todas las líneas de arriba. Distingue
  // "sin detalle en absoluto" (ninguna variable, ver mensaje de arriba)
  // de "detalle sí, pero sin Caudal puntual" (la estación puede no medir
  // Caudal, o el servidor no lo entregó esta vez).
  const totalPedidas = stations.length;
  const sinDetalleAlguno = stations.filter(s => s.detalle == null).length;
  const conDetalleSinCaudal = stations.filter(s => s.detalle != null && s.detalle.caudalM3s == null).length;
  const conCaudal = stations.filter(s => s.detalle?.caudalM3s != null).length;
  logger.log(`[detalle] Resumen: ${totalPedidas} estaciones consultadas · ${conCaudal} con Caudal · ${conDetalleSinCaudal} con detalle pero sin Caudal · ${sinDetalleAlguno} sin detalle alguno.`);
}

const COLORES_VALIDOS = ["Roja", "Amarilla", "Azul"];

// Compara la lectura actual de una estación contra su snapshot anterior
// guardado en Sheets (si existe) y arma un objeto simple que el dashboard
// puede mostrar directo: "subió/bajó/estable" + el % de cambio + hace
// cuánto fue esa lectura anterior. Si no hay snapshot previo (primera vez
// que esta estación aparece en el histórico), devuelve null — el
// dashboard debe manejar la ausencia de tendencia sin problema, no todos
// los casos van a tener con qué comparar.
function calcularTendencia(estacionActual, snapshotPrevio) {
  if (!snapshotPrevio || snapshotPrevio.valorMedicion == null || estacionActual.valorMedicion == null) {
    return null;
  }
  const actual = estacionActual.valorMedicion;
  const previo = snapshotPrevio.valorMedicion;
  const diferencia = actual - previo;
  // Umbral pequeño para "estable": diferencias de redondeo/ruido de sensor
  // no deberían anunciarse como "subiendo" o "bajando".
  const direccion = Math.abs(diferencia) < 0.01 ? "estable" : diferencia > 0 ? "subiendo" : "bajando";
  const porcentaje = previo !== 0 ? (diferencia / previo) * 100 : null;

  return {
    direccion,
    diferenciaMetros: Math.round(diferencia * 100) / 100,
    porcentaje: porcentaje != null ? Math.round(porcentaje * 10) / 10 : null,
    valorAnterior: previo,
    tipoAlertaAnterior: snapshotPrevio.tipoAlerta,
    timestampAnterior: snapshotPrevio.timestamp,
  };
}

async function handleAlertas(url, env) {
  const wantDetalle = url.searchParams.get("detalle") === "1";
  const wantAll = url.searchParams.get("all") === "1";
  // ?color=Roja (o Amarilla/Azul) pide el detalle SOLO de esa categoría —
  // pensado para el flujo de "3 botones grandes" del dashboard: se pide
  // detalle únicamente de la categoría que el usuario decidió abrir, no de
  // todas las Roja+Amarilla de una vez. Si no viene color, se mantiene el
  // comportamiento anterior (Roja+Amarilla juntas) para no romper llamadas
  // existentes que no pasen este parámetro.
  const colorParam = url.searchParams.get("color");
  const colorFiltro = COLORES_VALIDOS.includes(colorParam) ? [colorParam] : null;

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

  // Con ?color=Roja (o Amarilla/Azul), el dashboard pidió el detalle de UNA
  // categoría específica (uno de los 3 botones grandes) — el array de
  // salida debe traer SOLO esa categoría, si no el frontend recibe todas
  // las alertas mezcladas (bug detectado: "Ver alertas Rojas" mostraba
  // también Amarillas, porque este filtro faltaba acá y el frontend confía
  // en que el Worker ya filtró). Sin ?color= (ej. wantAll, o llamadas
  // viejas sin este parámetro), se mantiene el comportamiento histórico de
  // devolver todas las alertas juntas.
  if (colorFiltro) {
    outputStations = outputStations.filter(s => colorFiltro.includes(s.tipoAlerta));
  }

  // Sin ?color=, el criterio histórico sigue siendo Roja+Amarilla (Azul
  // excluida por defecto, ver nota más abajo). Con ?color=, se usa
  // exactamente esa categoría — incluyendo Azul si se pide explícitamente,
  // ya que ahí sí tiene sentido: el usuario decidió abrir esa categoría a
  // propósito, así que ya aceptó el costo de esa consulta.
  const detalleAplicaA = colorFiltro || ["Roja", "Amarilla"];
  const elegiblesParaDetalle = outputStations.filter(s => detalleAplicaA.includes(s.tipoAlerta));
  const sinDetallePorNivel = outputStations.length - elegiblesParaDetalle.length;

  // Tendencia contra el histórico de Sheets: solo cuando el usuario abrió
  // una categoría específica (?color=), que es el único caso donde el
  // dashboard realmente pide y muestra esto. Depende SOLO de valorMedicion
  // (Nivel de Agua, ya viene en la carga básica) — no depende del Caudal en
  // absoluto, así que se calcula acá afuera de `wantDetalle`: antes vivía
  // adentro de ese bloque porque el dashboard viejo siempre pedía Caudal y
  // tendencia juntos, pero ahora el Caudal se pide aparte, por estación
  // individual (ver /caudal más abajo), y la tendencia debe seguir
  // llegando de inmediato con la carga básica de la categoría.
  if (colorFiltro && outputStations.length > 0) {
    try {
      const allRows = await readAllSnapshotRows(env);
      const codigos = outputStations.map(s => s.codigo);
      const previos = findLatestPreviousByCode(allRows, codigos);
      for (const s of outputStations) {
        const previo = previos.get(s.codigo);
        s.tendencia = calcularTendencia(s, previo);
      }
    } catch (e) {
      // Si Sheets falla (credenciales, cuota, etc.), no tiene sentido
      // romper toda la respuesta por un dato secundario — las
      // estaciones simplemente quedan sin `tendencia`, el dashboard ya
      // maneja su ausencia sin problema.
    }
  }

  if (wantDetalle) {
    const logger = makeLogCollector();
    const target = elegiblesParaDetalle.slice(0, MAX_DETALLE_STATIONS);
    const cortadasPorLimite = elegiblesParaDetalle.length - target.length;
    if (cortadasPorLimite > 0) {
      logger.log(`[detalle] Límite de ${MAX_DETALLE_STATIONS} alcanzado: ${cortadasPorLimite} estaciones elegibles quedaron SIN consultar Caudal esta corrida (categoría: ${colorFiltro ? colorFiltro[0] : "Roja+Amarilla"}).`);
    }
    try {
      const { viewState, cookie } = await getViewState();
      await fetchDetalleEnLotes(target, viewState, cookie, logger);
    } catch (e) {
      // Si falla obtener el ViewState (p.ej. la DGA cambió el sitio), se
      // sigue devolviendo las alertas básicas sin detalle, en vez de fallar
      // toda la respuesta.
      logger.error(`[detalle] No se pudo obtener el ViewState: ${e.message || e}`);
    }

    // Manda todos los mensajes juntados durante esta corrida a la hoja
    // "LOG" en una sola petición. Si esto falla (Sheets caído, cuota,
    // etc.), no debe romper la respuesta al dashboard — el usuario ya
    // tiene sus datos de Caudal, perder el log de diagnóstico de ESTA
    // corrida puntual no es motivo para fallar toda la petición.
    if (logger.entries.length > 0) {
      try {
        await appendLogRows(env, logger.entries);
      } catch (e) {
        console.error("[sheets] No se pudo escribir el log de diagnóstico en LOG:", e.message || e);
      }
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
    // Metadatos para que el dashboard pueda explicarle al usuario por qué
    // algunas estaciones no tienen Caudal, sin que parezca un dato faltante
    // por error.
    detalleCriterio: wantDetalle
      ? (colorFiltro ? `${colorFiltro[0]} únicamente (por categoría solicitada)` : "Roja y Amarilla únicamente")
      : null,
    detalleOmitidoPorNivel: wantDetalle ? sinDetallePorNivel : null,
    estaciones: outputStations,
  };
}

// -----------------------------------------------------------------------
// Detalle (Caudal, Precipitación, etc.) de UNA sola estación, bajo demanda
// — endpoint /caudal. Antes esto solo existía empaquetado dentro de
// /alertas?detalle=1, que consultaba hasta 30 estaciones de una categoría
// entera en cada apertura (~15-25s, y le pegaba a la DGA 30 veces aunque
// el usuario solo quisiera ver 2 o 3 tarjetas). Con este endpoint, el
// dashboard pide el Caudal de una tarjeta puntual recién cuando el usuario
// aprieta el botón "Obtener Caudal" en ESA tarjeta — mucho más rápido de
// entrada (la grilla se pinta con Nivel de Agua + tendencia al toque) y
// muchísimas menos peticiones a la DGA en total.
// -----------------------------------------------------------------------
async function handleCaudalEstacion(url, env) {
  const codigo = url.searchParams.get("codigo");
  if (!codigo) {
    throw new Error("Falta el parámetro codigo.");
  }
  const tipoEstacion = url.searchParams.get("tipoEstacion") || "";

  const logger = makeLogCollector();
  const { viewState, cookie } = await getViewState();
  const detalle = await fetchStationDetail(viewState, cookie, codigo, tipoEstacion, logger);

  if (logger.entries.length > 0) {
    try {
      await appendLogRows(env, logger.entries);
    } catch (e) {
      console.error("[sheets] No se pudo escribir el log de diagnóstico en LOG:", e.message || e);
    }
  }

  return { codigo, detalle };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse({
        servicio: "Alertas de Ríos DGA — Worker",
        endpoints: [
          "/alertas",
          "/alertas?color=Roja",
          "/alertas?color=Amarilla",
          "/alertas?color=Azul",
          "/alertas?detalle=1",
          "/alertas?detalle=1&color=Roja",
          "/alertas?detalle=1&color=Amarilla",
          "/alertas?detalle=1&color=Azul",
          "/alertas?all=1",
          "/caudal?codigo=XXXXXXX-X&tipoEstacion=Fluviometricas",
        ],
      });
    }

    if (url.pathname === "/alertas") {
      try {
        const data = await handleAlertas(url, env);
        return jsonResponse(data);
      } catch (e) {
        return jsonResponse({ error: e.message || "Error desconocido" }, 502);
      }
    }

    if (url.pathname === "/caudal") {
      try {
        const data = await handleCaudalEstacion(url, env);
        return jsonResponse(data);
      } catch (e) {
        return jsonResponse({ error: e.message || "Error desconocido" }, 502);
      }
    }

    return jsonResponse({ error: "Ruta no encontrada" }, 404);
  },

  // Se invoca automáticamente por el Cron Trigger (ver wrangler.toml),
  // cada 30 minutos, SIN que ningún usuario visite la web. Guarda un
  // snapshot de Nivel de Agua de todas las estaciones en alerta en Google
  // Sheets — es el histórico contra el que se calcula la tendencia cuando
  // alguien abre una categoría en el dashboard.
  async scheduled(controller, env, ctx) {
    try {
      const pageResp = await fetch(SNIA_URL, { headers: BROWSER_HEADERS });
      if (!pageResp.ok) {
        console.error(`[scheduled] No se pudo descargar la página de la DGA: HTTP ${pageResp.status}`);
        return;
      }
      const html = await pageResp.text();
      const rawStations = extractStations(html);
      const stations = dedupeStations(rawStations.map(normalizeStation));
      const enAlerta = stations.filter(s => s.alerta);

      if (enAlerta.length === 0) {
        console.log("[scheduled] Ninguna estación en alerta — no se escribe nada.");
        return;
      }

      await appendSnapshotRows(env, enAlerta);
      console.log(`[scheduled] Guardadas ${enAlerta.length} filas en Sheets.`);
    } catch (e) {
      // El cron no tiene a quién devolverle un error — se deja constancia
      // en los logs de Cloudflare (visibles en el dashboard del Worker) y
      // se sigue. Un fallo puntual del cron no debe romper nada del resto
      // del sistema: la próxima corrida en 30 min lo intenta de nuevo.
      console.error("[scheduled] Error guardando snapshot:", e.message || e);
    }
  },
};
