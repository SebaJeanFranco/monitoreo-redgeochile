import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, RefreshCw, ExternalLink, X, Radio, Waves, Map as MapIcon, FileText, Copy, Check } from "lucide-react";
import StationsMap from "./StationsMap.jsx";
import StationMiniMap from "./StationMiniMap.jsx";

// ---------------------------------------------------------------------------
// Centro de Mando — Alertas de ríos (DGA)
//
// Enfoque único: estaciones fluviométricas de la Dirección General de Aguas
// (SNIA) que están actualmente en alerta. Sin Open-Meteo, sin buscador de
// ciudades — esto es un feed de guardia, no un dashboard general de clima.
// Los datos vienen de public/alertas-rios.json, generado por
// scripts/fetch_alertas_dga.py (correr con --detalle para incluir Caudal).
// ---------------------------------------------------------------------------

const SNIA_URL = "https://snia.mop.gob.cl/sat/site/informes/mapas/mapas.xhtml";

// Orden de urgencia: Roja siempre primero, luego Amarilla, luego Azul.
// Dentro de cada color, no reordenamos más — el orden en que la DGA entrega
// las estaciones ya viene agrupado de forma razonable, y agregar un segundo
// criterio (ej. % sobre umbral) fue explícitamente descartado a favor de
// simplicidad: rojo-amarillo-azul es todo lo que importa de un vistazo.
const URGENCY_ORDER = { Roja: 0, Amarilla: 1, Azul: 2 };

const ALERT_STYLES = {
  Roja: {
    border: "border-[#E8492E]",
    borderSoft: "border-[#E8492E]/40",
    bg: "bg-[#E8492E]/[0.07]",
    hoverBg: "hover:bg-[#E8492E]/[0.07]",
    bar: "bg-[#E8492E]",
    text: "text-[#FF8B6B]",
    chip: "bg-[#E8492E]/20 text-[#FF8B6B] border-[#E8492E]/50",
    dot: "bg-[#FF8B6B]",
    label: "ROJA — CRÍTICA",
    pulse: true,
  },
  Amarilla: {
    border: "border-[#E8A33D]",
    borderSoft: "border-[#E8A33D]/40",
    bg: "bg-[#E8A33D]/[0.05]",
    hoverBg: "hover:bg-[#E8A33D]/[0.05]",
    bar: "bg-[#E8A33D]",
    text: "text-[#F5C876]",
    chip: "bg-[#E8A33D]/15 text-[#F5C876] border-[#E8A33D]/40",
    dot: "bg-[#F5C876]",
    label: "AMARILLA",
    pulse: false,
  },
  Azul: {
    border: "border-[#3B8FA3]",
    borderSoft: "border-[#3B8FA3]/35",
    bg: "bg-[#3B8FA3]/[0.06]",
    hoverBg: "hover:bg-[#3B8FA3]/[0.06]",
    bar: "bg-[#3B8FA3]",
    text: "text-[#7ECBDE]",
    chip: "bg-[#3B8FA3]/15 text-[#7ECBDE] border-[#3B8FA3]/40",
    dot: "bg-[#7ECBDE]",
    label: "AZUL",
    pulse: false,
  },
};

function sortByUrgency(stations) {
  return [...stations].sort((a, b) => {
    const ua = URGENCY_ORDER[a.tipoAlerta] ?? 9;
    const ub = URGENCY_ORDER[b.tipoAlerta] ?? 9;
    if (ua !== ub) return ua - ub;
    // Empate de color: la más reciente primero (fecha viene "DD/MM/YYYY HH:mm")
    return (b.fecha || "").localeCompare(a.fecha || "");
  });
}

// Distancia en km entre dos coordenadas (fórmula de Haversine, radio
// terrestre promedio 6371km) — suficiente precisión para "estación más
// cercana", no hace falta nada más elaborado para este caso de uso.
function distanciaKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Busca, dentro del mismo listado de estaciones ya cargado (la categoría
// abierta), la más cercana a `station` que SÍ tenga Caudal disponible —
// para sugerirla cuando la estación actual no lo reportó. Requiere
// coordenadas válidas en ambas puntas; si la estación actual no tiene
// lat/lon, o ninguna otra estación del listado tiene Caudal, devuelve null
// y el diálogo cae en el mensaje genérico de siempre.
function estacionCercanaConCaudal(station, todasLasEstaciones) {
  if (station.latitud == null || station.longitud == null) return null;
  let mejor = null;
  let mejorDistancia = Infinity;
  for (const otra of todasLasEstaciones) {
    if (otra.codigo === station.codigo) continue;
    if (otra.detalle?.caudalM3s == null) continue;
    if (otra.latitud == null || otra.longitud == null) continue;
    const d = distanciaKm(station.latitud, station.longitud, otra.latitud, otra.longitud);
    if (d < mejorDistancia) {
      mejorDistancia = d;
      mejor = otra;
    }
  }
  return mejor ? { estacion: mejor, distanciaKm: mejorDistancia } : null;
}

// Agrupa estaciones por región para el panorama general del tablero.
// Cada región lleva su propio conteo por severidad, y las regiones se
// ordenan por urgencia: la que tenga alguna Roja primero, luego la que
// tenga más Amarillas, etc. — así el vistazo rápido va de lo más grave a
// lo menos grave, igual que las tarjetas individuales.
function groupByRegion(stations) {
  const byRegion = new Map();
  for (const s of stations) {
    const key = s.regionNombreAprox || "Región no identificada";
    if (!byRegion.has(key)) {
      byRegion.set(key, { region: key, Roja: 0, Amarilla: 0, Azul: 0, total: 0 });
    }
    const entry = byRegion.get(key);
    if (entry[s.tipoAlerta] != null) entry[s.tipoAlerta]++;
    entry.total++;
  }
  return [...byRegion.values()].sort((a, b) => {
    if (a.Roja !== b.Roja) return b.Roja - a.Roja;
    if (a.Amarilla !== b.Amarilla) return b.Amarilla - a.Amarilla;
    if (a.Azul !== b.Azul) return b.Azul - a.Azul;
    return a.region.localeCompare(b.region);
  });
}

// Emoji de severidad para el informe de texto — mismo criterio de color
// que el resto del dashboard, en formato que se pueda pegar directo en
// Instagram/WhatsApp/lo que sea (no HTML, no Markdown — texto plano con
// emojis, como el ejemplo que armaron a mano).
const EMOJI_ALERTA = { Roja: "🔴", Amarilla: "🟡", Azul: "🔵" };

// Arma el texto del informe: agrupado por región (pin 📍), con las
// estaciones de cada región ordenadas por urgencia (Roja primero), y
// dentro de cada una el mismo texto descriptivo que el ejemplo armado a
// mano: "Superó el umbral X con un nivel de aguas de Y m, lo que equivale
// a Z% sobre el umbral." — calculado con la misma fórmula que ya usa
// StationCard (`exceso`), para que el número siempre coincida con lo que
// se ve en las tarjetas.
// Nombre del umbral en masculino para que la frase concuerde ("el umbral
// rojo", no "el umbral roja") — tipoAlerta se usa en femenino en el resto
// del dashboard ("Alerta Roja") pero acá la palabra que acompaña es
// "umbral", que es masculino.
const UMBRAL_MASCULINO = { Roja: "rojo", Amarilla: "amarillo", Azul: "azul" };

function generarInformeTexto(stations, generadoEn) {
  const porRegion = new Map();
  for (const s of stations) {
    const key = s.regionNombreAprox || "Región no identificada";
    if (!porRegion.has(key)) porRegion.set(key, []);
    porRegion.get(key).push(s);
  }

  // Mismo orden de regiones que el panorama general: la que tenga más
  // urgencia primero — se reusa groupByRegion solo para el orden, no para
  // los conteos (que acá no hacen falta).
  const ordenRegiones = groupByRegion(stations).map(r => r.region);

  // Zona horaria forzada a Chile continental — así el informe queda igual
  // sin importar en qué huso horario esté configurado el navegador de
  // quien lo genera (relevante porque esto puede compartirse tal cual,
  // y la hora debe reflejar la hora chilena real del dato, no la local
  // de quien lo generó).
  const fecha = generadoEn ? new Date(generadoEn) : new Date();
  const fechaTexto = fecha.toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  const lineas = [
    `⚠️ Estado de estaciones hidrométricas que han superado los umbrales de alerta de la DGA (${fechaTexto} h), en ríos o esteros en situación de crecida o desborde:`,
    "",
  ];

  for (const region of ordenRegiones) {
    const estaciones = sortByUrgency(porRegion.get(region) || []);
    if (estaciones.length === 0) continue;

    lineas.push(`📍 ${region}`, "");
    for (const s of estaciones) {
      const exceso = s.umbral ? Math.round(((s.valorMedicion - s.umbral) / s.umbral) * 100) : null;
      const emoji = EMOJI_ALERTA[s.tipoAlerta] || "⚪";
      const excesoTexto = exceso != null ? `${exceso >= 0 ? "" : "-"}${Math.abs(exceso)}%` : "s/d";
      const colorUmbral = UMBRAL_MASCULINO[s.tipoAlerta] || (s.tipoAlerta || "").toLowerCase();
      lineas.push(
        `${emoji} ${s.nombre}: Superó el umbral ${colorUmbral} con un nivel de aguas de ${s.valorMedicion} ${s.unidad || "m"}, lo que equivale a ${excesoTexto} sobre el umbral.`
      );
    }
    lineas.push("");
  }

  lineas.push("Fuente: Dirección General de Aguas (DGA) — Sistema Nacional de Información del Agua (SNIA).");

  return lineas.join("\n");
}

// URL del Worker de Cloudflare que hace de intermediario con la DGA (ver
// carpeta dga-worker/ para desplegarlo). Se configura en un archivo .env
// local (VITE_DGA_WORKER_URL=https://tu-worker.workers.dev) para no dejar
// la URL hardcodeada en el código fuente.
const WORKER_URL = import.meta.env.VITE_DGA_WORKER_URL || null;

// Estimado para la carga INICIAL (sin detalle, todas las categorías) — esto
// es rápido (~2-3s reales medidos contra el Worker), muy distinto al
// estimado de ~20s que existía cuando la carga inicial pedía Caudal de
// Roja+Amarilla de una sola vez.
const ESTIMATED_LOAD_MS = 3500;

// Estimado para abrir UNA categoría (al pinchar un botón grande) — ahora
// es básicamente lo mismo que la carga inicial (Nivel de Agua + tendencia,
// sin Caudal), ya no los ~18s de cuando esto pedía Caudal de hasta 30
// estaciones de una. El Caudal ahora se pide aparte, por estación
// individual — ver ESTIMATED_CAUDAL_LOAD_MS.
const ESTIMATED_CATEGORIA_LOAD_MS = 3500;

// Estimado para pedir el Caudal de UNA sola estación (botón "Obtener
// Caudal" en la tarjeta). Basado en el mismo costo por-estación medido
// antes (~0.7-1s de la propia petición JSF, más el GET inicial para
// ViewState/cookie) — sigue siendo una sola estación, no un lote, así que
// es rápido.
const ESTIMATED_CAUDAL_LOAD_MS = 2500;

// Convierte tiempo transcurrido en progreso de barra (0-100) usando una
// curva de desaceleración: avanza rápido al principio y se frena cerca del
// tope en vez de llegar a 100% y quedarse "pegada" si la carga real tarda
// más que el estimado (lo cual puede pasar: no controlamos cuántas
// estaciones habrá en alerta ni la velocidad de respuesta de la DGA).
// `totalMs` es configurable porque hay dos escenarios con duraciones muy
// distintas: la carga inicial (~3.5s) y la carga de una categoría con
// detalle (~18s).
function estimateProgress(elapsedMs, totalMs) {
  const ratio = elapsedMs / totalMs;
  // Ease-out: se acerca a 92% asintóticamente, nunca llega a "trabado en 100%"
  const progress = 92 * (1 - Math.exp(-2.2 * ratio));
  return Math.min(progress, 97);
}

function estimateSecondsLeft(elapsedMs, totalMs) {
  const remainingMs = totalMs - elapsedMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

// Carga rápida inicial: SIN Caudal, todas las categorías. Es lo primero
// que se pide al abrir la página — solo conteos, ubicaciones y nivel de
// agua, ~2-3s en vez de ~15-20s.
async function loadAlertasBasicas() {
  if (WORKER_URL) {
    const endpoint = `${WORKER_URL.replace(/\/$/, "")}/alertas`;
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) throw new Error(`El Worker respondió con error (HTTP ${res.status}).`);
    return res.json();
  }
  // Sin Worker configurado: usa el archivo estático generado manualmente
  // con scripts/fetch_alertas_dga.py — sigue funcionando, solo que no se
  // actualiza solo al abrir la página.
  const res = await fetch(`${import.meta.env.BASE_URL}alertas-rios.json`, { cache: "no-store" });
  if (!res.ok) throw new Error("No se pudo cargar alertas-rios.json");
  return res.json();
}

// Carga básica de UNA categoría específica — Nivel de Agua + tendencia
// (subió/bajó), SIN Caudal. Se llama al pinchar uno de los 3 botones
// grandes ("Ver alertas Rojas", etc.). Antes esto pedía también el Caudal
// de hasta 30 estaciones de una (?detalle=1), lo que hacía tardar ~15-25s
// en abrir una categoría entera. Ahora el Caudal se pide aparte, estación
// por estación, recién cuando el usuario aprieta "Obtener Caudal" en la
// tarjeta puntual que le interesa (ver loadCaudalEstacion) — esto es
// rápido (unos segundos, un solo GET al Worker) porque el Worker igual
// calcula la tendencia contra Sheets en esta misma llamada (no depende del
// Caudal, ver worker.js → calcularTendencia).
async function loadAlertasCategoria(color) {
  if (WORKER_URL) {
    const endpoint = `${WORKER_URL.replace(/\/$/, "")}/alertas?color=${encodeURIComponent(color)}`;
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) throw new Error(`El Worker respondió con error (HTTP ${res.status}).`);
    return res.json();
  }
  // Sin Worker, el archivo estático ya trae (o no) el detalle que tenga
  // guardado — se filtra localmente por color en vez de volver a pedir nada.
  const res = await fetch(`${import.meta.env.BASE_URL}alertas-rios.json`, { cache: "no-store" });
  if (!res.ok) throw new Error("No se pudo cargar alertas-rios.json");
  const json = await res.json();
  return { ...json, estaciones: (json.estaciones || []).filter(s => s.tipoAlerta === color) };
}

// Caudal de UNA estación puntual — se llama al apretar "Obtener Caudal" en
// una tarjeta de la grilla. Sin Worker configurado no hay forma de pedir
// esto bajo demanda (el archivo estático es fijo), así que devuelve null y
// el botón queda deshabilitado en ese modo (ver CategoryButton/StationCard).
async function loadCaudalEstacion(codigo, tipoEstacion) {
  if (!WORKER_URL) return null;
  const endpoint = `${WORKER_URL.replace(/\/$/, "")}/caudal?codigo=${encodeURIComponent(codigo)}&tipoEstacion=${encodeURIComponent(tipoEstacion || "")}`;
  const res = await fetch(endpoint, { cache: "no-store" });
  if (!res.ok) throw new Error(`El Worker respondió con error (HTTP ${res.status}).`);
  return res.json();
}

// Histórico de Nivel de Agua de UNA estación — se llama al abrir su ficha
// de detalle, para graficar la evolución reciente contra el umbral. Igual
// que el Caudal, requiere Worker configurado (necesita leer Sheets).
async function loadHistoricoEstacion(codigo) {
  if (!WORKER_URL) return null;
  const endpoint = `${WORKER_URL.replace(/\/$/, "")}/historico?codigo=${encodeURIComponent(codigo)}`;
  const res = await fetch(endpoint, { cache: "no-store" });
  if (!res.ok) throw new Error(`El Worker respondió con error (HTTP ${res.status}).`);
  return res.json();
}

// Resumen nacional por corrida del cron (total + desglose por color en las
// últimas horas) — se pide una vez al cargar el dashboard, junto con la
// carga básica. Requiere Worker configurado (necesita leer Sheets); sin
// Worker el panel de tendencia nacional simplemente no se muestra.
async function loadResumenNacional() {
  if (!WORKER_URL) return null;
  const endpoint = `${WORKER_URL.replace(/\/$/, "")}/resumen`;
  const res = await fetch(endpoint, { cache: "no-store" });
  if (!res.ok) throw new Error(`El Worker respondió con error (HTTP ${res.status}).`);
  return res.json();
}

export default function CentroMando() {
  // `data`: resultado de la carga básica inicial (todas las categorías,
  // SIN Caudal) — es lo que alimenta los conteos, el desglose regional y
  // el mapa general. Se pide una sola vez al abrir la página (o al
  // apretar "Actualizar").
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // `categoriaAbierta`: null | "Roja" | "Amarilla" | "Azul" — cuál de los 3
  // botones grandes está expandido ahora mismo mostrando su grilla de
  // tarjetas. `detalleCategoria` es la respuesta básica (Nivel de Agua +
  // tendencia, SIN Caudal) de esa categoría, pedida al pinchar el botón.
  // El Caudal de cada estación se pide aparte — ver caudalPorEstacion.
  const [categoriaAbierta, setCategoriaAbierta] = useState(null);
  const [detalleCategoria, setDetalleCategoria] = useState(null);
  const [loadingCategoria, setLoadingCategoria] = useState(false);
  const [errorCategoria, setErrorCategoria] = useState(null);
  const [elapsedCategoriaMs, setElapsedCategoriaMs] = useState(0);

  // Caudal pedido bajo demanda, por estación — clave: código de estación,
  // valor: { loading, error, detalle }. Vive aparte de `detalleCategoria`
  // porque cada tarjeta pide su propio Caudal de forma independiente (al
  // apretar "Obtener Caudal"), no las 30 de una categoría juntas como
  // antes. Se resetea entero cada vez que se abre/cierra una categoría o
  // se hace un refresh general, para no arrastrar Caudal de una corrida
  // vieja a datos de estaciones nuevos.
  const [caudalPorEstacion, setCaudalPorEstacion] = useState({});

  // Resumen nacional por corrida del cron — total + desglose por color en
  // las últimas horas, para el gráfico de tendencia debajo del panorama
  // nacional. Se carga en paralelo con la carga básica, sin bloquearla: si
  // esto falla (Sheets caído, sin Worker, etc.), el resto del dashboard
  // sigue funcionando igual — el gráfico simplemente no aparece.
  const [resumenNacional, setResumenNacional] = useState(null);
  const [resumenNacionalError, setResumenNacionalError] = useState(null);

  // Diálogo grande de tendencia nacional — se abre al pinchar el gráfico
  // chico del panorama general. Solo necesita saber si está abierto: los
  // datos (`corridas`) son los mismos que ya tiene resumenNacional, no se
  // vuelven a pedir.
  const [tendenciaExpandida, setTendenciaExpandida] = useState(false);

  // Generador de informe de texto (agrupado por región, listo para
  // copiar/pegar) — se arma en el momento con los datos ya cargados en
  // `data.estaciones`, sin pedir nada nuevo al Worker ni a la DGA. El
  // "generando" es deliberadamente artificial (ver generarInforme más
  // abajo): la construcción del texto es instantánea, pero se simula una
  // pausa breve con el overlay de bloqueo para que quede claro que la
  // acción se registró — evita que alguien pinche el botón varias veces
  // pensando que no funcionó.
  const [informeTexto, setInformeTexto] = useState(null);
  const [generandoInforme, setGenerandoInforme] = useState(false);
  const [informeCopiado, setInformeCopiado] = useState(false);

  function generarInforme() {
    setGenerandoInforme(true);
    setInformeCopiado(false);
    setTimeout(() => {
      const texto = generarInformeTexto(sorted, data?.generadoEn);
      setInformeTexto(texto);
      setGenerandoInforme(false);
    }, 600);
  }

  async function copiarInforme() {
    if (!informeTexto) return;
    try {
      await navigator.clipboard.writeText(informeTexto);
      setInformeCopiado(true);
      setTimeout(() => setInformeCopiado(false), 2500);
    } catch (e) {
      // Si el navegador bloquea el acceso al portapapeles (permisos,
      // contexto no seguro, etc.), no hay mucho más que hacer del lado
      // del cliente — el texto sigue visible en pantalla para seleccionar
      // y copiar a mano como respaldo.
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    setElapsedMs(0);
    // Un refresh general también cierra cualquier categoría abierta — sus
    // datos de detalle quedarían basados en la carga anterior.
    setCategoriaAbierta(null);
    setDetalleCategoria(null);
    setCaudalPorEstacion({});
    try {
      const json = await loadAlertasBasicas();
      setData(json);
    } catch (e) {
      setError(
        WORKER_URL
          ? `No se pudo conectar con el Worker (${e.message}). Verificá que esté desplegado: ver dga-worker/README.md.`
          : "No se encontró alertas-rios.json y no hay un Worker configurado (VITE_DGA_WORKER_URL). Corré scripts/fetch_alertas_dga.py, o desplegá dga-worker/ para actualización automática."
      );
    } finally {
      setLoading(false);
    }

    // Resumen nacional: independiente de la carga básica de arriba, no
    // comparte try/catch ni estado de loading con ella — un fallo acá no
    // debe mostrarse como error general del dashboard.
    setResumenNacional(null);
    setResumenNacionalError(null);
    try {
      const json = await loadResumenNacional();
      setResumenNacional(json);
    } catch (e) {
      setResumenNacionalError(e.message || "Error desconocido");
    }
  }

  async function abrirCategoria(color) {
    setCategoriaAbierta(color);
    setDetalleCategoria(null);
    setErrorCategoria(null);
    setLoadingCategoria(true);
    setElapsedCategoriaMs(0);
    setCaudalPorEstacion({});
    try {
      const json = await loadAlertasCategoria(color);
      setDetalleCategoria(json);
    } catch (e) {
      setErrorCategoria(`No se pudo cargar el detalle de ${color} (${e.message}).`);
    } finally {
      setLoadingCategoria(false);
    }
  }

  function cerrarCategoria() {
    setCategoriaAbierta(null);
    setDetalleCategoria(null);
    setErrorCategoria(null);
    setCaudalPorEstacion({});
  }

  // Pide el Caudal de UNA estación puntual — se llama al apretar "Obtener
  // Caudal" en su tarjeta. No toca `detalleCategoria` ni recarga nada más;
  // solo guarda el resultado en caudalPorEstacion[codigo], y StationCard /
  // StationDialog lo leen de ahí para mostrarlo junto al Nivel de Agua que
  // ya tenían de la carga básica.
  async function obtenerCaudal(station) {
    const codigo = station.codigo;
    setCaudalPorEstacion(prev => ({ ...prev, [codigo]: { loading: true, error: null, detalle: null } }));
    try {
      const json = await loadCaudalEstacion(codigo, station.tipoEstacion);
      setCaudalPorEstacion(prev => ({ ...prev, [codigo]: { loading: false, error: null, detalle: json?.detalle ?? null } }));
    } catch (e) {
      setCaudalPorEstacion(prev => ({ ...prev, [codigo]: { loading: false, error: e.message || "Error desconocido", detalle: null } }));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Cronómetro para la pantalla de carga inicial (solo corre mientras no
  // hay datos todavía). Se usa para derivar tanto la barra de progreso
  // como el "tiempo restante estimado" — ver ESTIMATED_LOAD_MS más abajo.
  useEffect(() => {
    if (!loading || data) return;
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [loading, data]);

  // Mismo cronómetro, pero para la carga de una categoría específica al
  // pinchar un botón grande.
  useEffect(() => {
    if (!loadingCategoria) return;
    const start = Date.now();
    const id = setInterval(() => setElapsedCategoriaMs(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [loadingCategoria]);

  // Estaciones básicas (sin Caudal) de la carga inicial, ordenadas por
  // urgencia — alimentan el mapa general y los conteos.
  const sorted = useMemo(() => {
    if (!data?.estaciones) return [];
    return sortByUrgency(data.estaciones);
  }, [data]);

  const counts = useMemo(() => {
    const c = { Roja: 0, Amarilla: 0, Azul: 0 };
    sorted.forEach(s => { if (c[s.tipoAlerta] != null) c[s.tipoAlerta]++; });
    return c;
  }, [sorted]);

  // Estaciones de la categoría actualmente abierta (Nivel de Agua +
  // tendencia, de la carga básica), con el Caudal mezclado adentro si ya
  // se pidió para esa estación puntual (ver caudalPorEstacion/
  // obtenerCaudal). `caudalEstado` viaja aparte de `detalle` para que
  // StationCard pueda distinguir "todavía no se pidió", "cargando" y
  // "error" sin confundirlos con "se pidió y la DGA no tiene el dato" (que
  // sigue siendo detalle.caudalM3s == null, igual que antes).
  const sortedCategoria = useMemo(() => {
    if (!detalleCategoria?.estaciones) return [];
    const conCaudal = detalleCategoria.estaciones.map(s => {
      const estado = caudalPorEstacion[s.codigo];
      if (!estado) return s;
      return {
        ...s,
        detalle: estado.detalle ?? s.detalle,
        caudalEstado: { loading: estado.loading, error: estado.error },
      };
    });
    return sortByUrgency(conCaudal);
  }, [detalleCategoria, caudalPorEstacion]);

  const byRegion = useMemo(() => groupByRegion(sorted), [sorted]);

  return (
    <div className="min-h-screen bg-[#0A1210] text-[#EDF2F0]" style={{ fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');
        .font-mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        .font-display { font-family: 'Barlow Condensed', sans-serif; letter-spacing: 0.01em; }
        @keyframes urgent-pulse {
          0%, 100% { background-color: rgba(232,73,46,0.06); border-color: rgba(232,73,46,0.55); }
          50% { background-color: rgba(232,73,46,0.16); border-color: rgba(255,140,110,1); }
        }
        .urgent-pulse { animation: urgent-pulse 1.6s ease-in-out infinite; }
        @keyframes dot-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
        .dot-pulse { animation: dot-pulse 1.3s ease-in-out infinite; }
        @keyframes rise-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .rise-in { animation: rise-in 0.3s ease-out both; }
        /* Una tarjeta Roja necesita las DOS animaciones a la vez (entrada +
           parpadeo). Como cada clase declara la propiedad shorthand
           "animation" completa, aplicar .rise-in y .urgent-pulse juntas en
           el mismo className NO las combina — la que aparece después en
           esta hoja de estilos gana y pisa a la otra por completo. Por eso
           esta clase compuesta declara ambas animaciones juntas, separadas
           por coma, que es la sintaxis válida de CSS para animarlas en
           paralelo sobre el mismo elemento. */
        .rise-in.urgent-pulse {
          animation: rise-in 0.3s ease-out both, urgent-pulse 1.6s ease-in-out 0.3s infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .urgent-pulse, .dot-pulse, .rise-in, .rise-in.urgent-pulse { animation: none !important; }
        }
      `}</style>

      {/* Mientras no hay datos todavía (primera carga, o un refresh que
          falló y se está reintentando desde cero), no se muestra NADA del
          panel — ni el header con contadores en cero ni una grilla vacía.
          Solo esta pantalla de carga, para evitar el efecto "parpadeo" de
          ver la interfaz en blanco antes de que lleguen los datos reales. */}
      {!data && (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="w-12 h-12 rounded-lg bg-[#0F1B18] border border-[#1E332C] flex items-center justify-center">
            <RefreshCw className="w-5 h-5 text-[#7ECBDE] animate-spin" />
          </div>
          <div>
            <p className="font-display font-semibold text-xl text-[#EDF2F0]">Actualizando datos... un momento por favor</p>
            <p className="font-mono text-[12px] text-[#9BAEA8] mt-2 max-w-sm">
              {WORKER_URL
                ? "Consultando estaciones de la DGA en vivo."
                : "Cargando el último registro disponible."}
            </p>
          </div>

          {WORKER_URL && !error && (
            <div className="w-full max-w-xs">
              <div className="h-1.5 rounded-full bg-[#1E332C] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#3B8FA3] transition-[width] duration-200 ease-linear"
                  style={{ width: `${estimateProgress(elapsedMs, ESTIMATED_LOAD_MS)}%` }}
                />
              </div>
              <p className="font-mono text-[11px] text-[#7C8F88] mt-2">
                {estimateSecondsLeft(elapsedMs, ESTIMATED_LOAD_MS) > 0
                  ? `Tiempo estimado restante: ~${estimateSecondsLeft(elapsedMs, ESTIMATED_LOAD_MS)}s`
                  : "Ya casi — la DGA está tardando un poco más de lo habitual."}
              </p>
            </div>
          )}

          {error && (
            <div className="mt-2 rounded-lg border border-[#1E332C] bg-[#0F1B18] px-5 py-4 max-w-md">
              <AlertTriangle className="w-4 h-4 text-[#9BAEA8] mx-auto mb-2" />
              <p className="text-[13px] text-[#C7D3CE] mb-2">{error}</p>
              {!WORKER_URL && (
                <code className="text-[11px] font-mono text-[#7ECBDE] bg-[#0A1210] px-2 py-1 rounded block">
                  python scripts/fetch_alertas_dga.py --out public/alertas-rios.json --detalle
                </code>
              )}
              <button
                onClick={refresh}
                className="block mx-auto mt-3 text-[12px] font-mono text-[#9BAEA8] hover:text-[#7ECBDE] underline"
              >
                Reintentar
              </button>
            </div>
          )}
        </div>
      )}

      {data && (
      <>
      {/* Masthead */}
      <header className="border-b border-[#1E332C] bg-[#0A1210]">
        <div className="max-w-[1180px] mx-auto px-6 pt-6 pb-0">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="w-9 h-9 rounded-md bg-[#0F1B18] border border-[#1E332C] flex items-center justify-center flex-shrink-0">
                <Waves className="w-4.5 h-4.5 text-[#7ECBDE]" strokeWidth={2} />
              </div>
              <div>
                <h1 className="font-display font-bold text-[26px] leading-none tracking-tight text-white">Alertas de Ríos</h1>
                <p className="font-mono text-[11px] font-semibold text-[#7C8F88] uppercase tracking-widest mt-1.5">DGA · Chile en vivo</p>
              </div>
            </div>

            {/* Logo de la ONG, centrado en el espacio libre del header */}
            <div className="hidden md:flex flex-col items-center justify-center flex-1 gap-1.5">
              <img
                src={`${import.meta.env.BASE_URL}logo-ong.png`}
                alt="REDGEO Chile"
                className="h-14 object-contain"
              />
              <p className="font-mono text-[10px] font-bold text-[#8FA39D] uppercase tracking-widest text-center">
                Centro Monitoreo Red Geo Chile
              </p>
            </div>

            <div className="flex-1 flex justify-end gap-2.5">
              <button
                onClick={generarInforme}
                disabled={loading || sorted.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-md border border-[#2A4038] text-[#DCE7E3] hover:text-white hover:border-[#3B8FA3]/60 text-[14px] font-semibold transition-colors disabled:opacity-50"
              >
                <FileText className="w-4 h-4" />
                Generar informe
              </button>
              <button
                onClick={refresh}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2.5 rounded-md border border-[#2A4038] text-[#DCE7E3] hover:text-white hover:border-[#3B8FA3]/60 text-[14px] font-semibold transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </button>
            </div>
          </div>
        </div>

        {/* Panorama nacional — resumen general para leer de un vistazo */}
        <div className="max-w-[1180px] mx-auto px-6 pt-6 pb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NationalStat label="Roja — crítica" value={counts.Roja} styleKey="Roja" />
            <NationalStat label="Amarilla" value={counts.Amarilla} styleKey="Amarilla" />
            <NationalStat label="Azul" value={counts.Azul} styleKey="Azul" />
            <div className="rounded-lg border border-[#1E332C] bg-[#0F1B18] px-4 py-3 flex flex-col justify-center">
              <p className="text-[10px] uppercase tracking-widest text-[#7C8F88] font-semibold mb-1">Total nacional</p>
              <p className="font-display font-bold text-[32px] leading-none text-white">
                {data.totalEnAlerta}
                <span className="font-mono text-[12px] font-normal text-[#7C8F88] ml-2">/ {data.totalEstacionesConsultadas} estaciones</span>
              </p>
            </div>
          </div>

          {/* Tendencia nacional — total + desglose por color en las
              últimas horas, a partir del histórico que guarda el cron en
              Sheets cada 30 min. Independiente del resto: si falla o no
              hay Worker, no aparece, sin afectar nada más del panel. */}
          {(resumenNacional?.corridas?.length > 1 || resumenNacionalError) && (
            <div className="mt-5">
              <p className="text-[11px] uppercase tracking-widest text-[#9BAEA8] font-bold mb-3">Tendencia nacional — últimas 6 horas</p>
              <TendenciaNacionalChart
                corridas={resumenNacional?.corridas}
                error={resumenNacionalError}
                onExpand={() => setTendenciaExpandida(true)}
              />
            </div>
          )}

          {/* Desglose por región */}
          {byRegion.length > 0 && (
            <div className="mt-5">
              <p className="text-[11px] uppercase tracking-widest text-[#9BAEA8] font-bold mb-3">Por región</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {byRegion.map(r => (
                  <div
                    key={r.region}
                    className="rounded-lg border border-[#1E332C] bg-[#0F1B18] px-4 py-3"
                  >
                    <p className="font-display font-semibold text-[16px] text-[#EDF2F0] leading-tight mb-2.5 truncate" title={r.region}>
                      {r.region}
                    </p>
                    <div className="flex items-center gap-4">
                      <RegionFigure count={r.Roja} styleKey="Roja" />
                      <RegionFigure count={r.Amarilla} styleKey="Amarilla" />
                      <RegionFigure count={r.Azul} styleKey="Azul" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-[1180px] mx-auto px-6 py-7">
        {!error && sorted.length === 0 && !loading && (
          <div className="text-center py-24 border border-dashed border-[#1E332C] rounded-lg">
            <Waves className="w-7 h-7 text-[#3C5850] mx-auto mb-3" />
            <p className="text-[#C7D3CE] text-[15px] font-medium">Ninguna estación de la DGA está en alerta en este momento.</p>
          </div>
        )}

        {/* 3 botones grandes por categoría — el detalle (con Caudal) de
            cada una se pide recién al pincharlo, no de entrada. Mientras
            una categoría está cargando, los otros dos botones se bloquean
            para no disparar varias consultas a la DGA en paralelo. */}
        {sorted.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <CategoryButton
              styleKey="Roja"
              label="Revisar alertas Rojas"
              count={counts.Roja}
              active={categoriaAbierta === "Roja"}
              blocked={loadingCategoria}
              onClick={() => (categoriaAbierta === "Roja" ? cerrarCategoria() : abrirCategoria("Roja"))}
            />
            <CategoryButton
              styleKey="Amarilla"
              label="Revisar alertas Amarillas"
              count={counts.Amarilla}
              active={categoriaAbierta === "Amarilla"}
              blocked={loadingCategoria}
              onClick={() => (categoriaAbierta === "Amarilla" ? cerrarCategoria() : abrirCategoria("Amarilla"))}
            />
            <CategoryButton
              styleKey="Azul"
              label="Revisar alertas Azules"
              count={counts.Azul}
              active={categoriaAbierta === "Azul"}
              blocked={loadingCategoria}
              onClick={() => (categoriaAbierta === "Azul" ? cerrarCategoria() : abrirCategoria("Azul"))}
            />
          </div>
        )}

        {/* Mapa general — siempre visible con los datos básicos (todas las
            categorías juntas), para que la pantalla inicial no se sienta
            vacía con solo 3 botones. No tiene Caudal, es puramente
            referencial (igual que antes). */}
        {sorted.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <MapIcon className="w-4 h-4 text-[#9BAEA8]" />
              <h2 className="font-display font-semibold text-base text-[#C7D3CE]">Mapa de estaciones en alerta</h2>
              <span className="font-mono text-[11px] text-[#7C8F88] ml-auto">Vista general — abrí una ficha para ver su ubicación exacta</span>
            </div>
            <StationsMap stations={sorted} />
          </section>
        )}

        {/* Sección expandible: se muestra solo cuando el usuario pinchó
            uno de los 3 botones. La grilla trae Nivel de Agua + tendencia
            de inmediato; el Caudal de cada tarjeta se pide aparte, al
            apretar su botón "Obtener Caudal" (ver obtenerCaudal). */}
        {categoriaAbierta && (
          <section className="mb-8">
            <CategoriaExpandida
              color={categoriaAbierta}
              loading={loadingCategoria}
              error={errorCategoria}
              elapsedMs={elapsedCategoriaMs}
              estaciones={sortedCategoria}
              onRetry={() => abrirCategoria(categoriaAbierta)}
              onClose={cerrarCategoria}
              onOpenStation={setSelected}
              onObtenerCaudal={obtenerCaudal}
            />
          </section>
        )}

        <footer className="mt-8 pt-5 border-t border-[#1E332C] flex items-center justify-between flex-wrap gap-2">
          <p className="font-mono text-[12px] font-medium text-[#7C8F88]">
            Actualizado {new Date(data.generadoEn).toLocaleString("es-CL")}
            {data.duplicadosRemovidos > 0 && ` · ${data.duplicadosRemovidos} duplicados filtrados`}
          </p>
          <a
            href={SNIA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono text-[12px] font-medium text-[#9BAEA8] hover:text-[#7ECBDE] transition-colors"
          >
            Visor oficial DGA (SNIA)
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </footer>
      </main>

      {selected && (
        <StationDialog
          station={sortedCategoria.find(s => s.codigo === selected.codigo) || selected}
          estacionesCategoria={sortedCategoria}
          onClose={() => setSelected(null)}
          onOpenStation={setSelected}
          onObtenerCaudal={obtenerCaudal}
        />
      )}

      {tendenciaExpandida && (
        <TendenciaNacionalDialog
          corridas={resumenNacional?.corridas}
          onClose={() => setTendenciaExpandida(false)}
        />
      )}

      {/* Bloqueo de pantalla completa mientras se arma el informe — la
          construcción del texto es instantánea, pero el overlay confirma
          visualmente que el click se registró (evita doble click pensando
          que no pasó nada). No se puede cerrar ni interactuar con nada
          detrás mientras está activo. */}
      {generandoInforme && (
        <div
          className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-black/85 backdrop-blur-sm"
          style={{ zIndex: 10001 }}
          role="alert"
          aria-live="assertive"
        >
          <RefreshCw className="w-8 h-8 text-[#7ECBDE] animate-spin" />
          <p className="font-display font-semibold text-xl text-white">Generando informe, un momento por favor...</p>
        </div>
      )}

      {informeTexto && !generandoInforme && (
        <InformeDialog
          texto={informeTexto}
          copiado={informeCopiado}
          onCopiar={copiarInforme}
          onClose={() => setInformeTexto(null)}
        />
      )}
      </>
      )}
    </div>
  );
}

function NationalStat({ label, value, styleKey }) {
  const s = ALERT_STYLES[styleKey];
  return (
    <div className={`rounded-lg border px-4 py-3 flex flex-col justify-center ${value > 0 ? s.borderSoft : "border-[#1E332C]"} ${value > 0 ? s.bg : "bg-[#0F1B18]"}`}>
      <p className={`text-[10px] uppercase tracking-widest font-semibold mb-1 ${value > 0 ? s.text : "text-[#7C8F88]"}`}>{label}</p>
      <p className={`font-display font-bold text-[32px] leading-none ${value > 0 ? s.text : "text-[#4A6058]"}`}>{value}</p>
    </div>
  );
}

// Cifra de una severidad dentro de una tarjeta de región. Cuando el conteo
// es 0, se muestra apagado (no oculto del todo) para que las 3 columnas se
// mantengan alineadas entre tarjetas de distintas regiones — más fácil de
// escanear en grilla que si cada tarjeta tuviera un número distinto de
// columnas según qué colores tenga.
function RegionFigure({ count, styleKey }) {
  const s = ALERT_STYLES[styleKey];
  const active = count > 0;
  return (
    <div className="flex flex-col items-center min-w-[38px]">
      <p className={`font-display font-bold text-[22px] leading-none ${active ? s.text : "text-[#2A4038]"}`}>{count}</p>
      <p className={`font-mono text-[9px] uppercase tracking-wider font-bold mt-1 ${active ? s.text : "text-[#3C5850]"}`}>{styleKey}</p>
    </div>
  );
}

// ---------- Botón grande de categoría ----------
// Uno de los 3 botones principales de la pantalla ("Revisar alertas
// Rojas/Amarillas/Azules"). Al pincharlo se pide Nivel de Agua + tendencia
// de toda la categoría — rápido, sin Caudal (eso se pide aparte, por
// tarjeta, con el botón "Obtener Caudal" — ver StationCard).
function CategoryButton({ styleKey, label, count, active, blocked, onClick }) {
  const s = ALERT_STYLES[styleKey];
  const disabled = count === 0 || blocked;
  // El botón activo que está cargando su propia categoría se deshabilita
  // igual (no se puede cerrar a mitad de la consulta), pero mantiene su
  // color distintivo — apagarlo justo cuando el usuario más necesita ver
  // cuál categoría está cargando sería confuso.
  const colorApagado = disabled && !(blocked && active);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border-2 px-5 py-6 text-left transition-all ${
        colorApagado
          ? "border-[#1E332C] bg-[#0F1B18] opacity-50 cursor-not-allowed"
          : active
            ? `${s.border} ${s.bg} -translate-y-0.5 ${disabled ? "cursor-not-allowed" : ""}`
            : `${s.borderSoft} bg-[#0F1B18] hover:-translate-y-0.5 ${s.hoverBg}`
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className={`font-mono text-[11px] font-bold uppercase tracking-widest ${colorApagado ? "text-[#5C726A]" : s.text}`}>
          {styleKey}
        </span>
        {styleKey === "Roja" && count > 0 && <span className="w-2 h-2 rounded-full bg-[#FF8B6B] dot-pulse" />}
      </div>
      <p className="font-display font-bold text-[20px] text-white leading-tight mb-1">{label}</p>
      <p className={`font-display font-bold text-[36px] leading-none ${colorApagado ? "text-[#3C5850]" : s.text}`}>
        {count}
        <span className="font-mono text-[13px] font-normal text-[#7C8F88] ml-2">
          {count === 1 ? "estación" : "estaciones"}
        </span>
      </p>
      {!disabled && (
        <p className="font-mono text-[11px] text-[#7C8F88] mt-3">
          {active ? "Tocá para cerrar ↑" : "Tocá para ver detalle →"}
        </p>
      )}
      {blocked && active && (
        <p className={`font-mono text-[11px] mt-3 flex items-center gap-1.5 ${s.text}`}>
          <RefreshCw className="w-3 h-3 animate-spin" />
          Consultando Nivel de Agua...
        </p>
      )}
      {blocked && !active && (
        <p className="font-mono text-[11px] text-[#5C726A] mt-3">
          Esperá a que termine la consulta actual...
        </p>
      )}
    </button>
  );
}

// ---------- Sección expandida de una categoría ----------
// Vive debajo de los 3 botones + el mapa. Maneja sus propios estados de
// carga/error porque el detalle de esta categoría se pide de forma
// independiente a la carga básica inicial.
function CategoriaExpandida({ color, loading, error, elapsedMs, estaciones, onRetry, onClose, onOpenStation, onObtenerCaudal }) {
  const s = ALERT_STYLES[color];
  return (
    <div className={`rounded-xl border ${s.borderSoft} ${s.bg} p-5`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className={`font-display font-bold text-lg ${s.text}`}>Alertas {color}</h2>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-[#9BAEA8] hover:text-white hover:bg-black/20 transition-colors"
          aria-label="Cerrar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <RefreshCw className="w-5 h-5 text-[#7ECBDE] animate-spin" />
          <p className="font-mono text-[12px] text-[#9BAEA8]">Consultando Nivel de Agua en la DGA...</p>
          <div className="w-full max-w-xs">
            <div className="h-1.5 rounded-full bg-[#1E332C] overflow-hidden">
              <div
                className="h-full rounded-full bg-[#3B8FA3] transition-[width] duration-200 ease-linear"
                style={{ width: `${estimateProgress(elapsedMs, ESTIMATED_CATEGORIA_LOAD_MS)}%` }}
              />
            </div>
            <p className="font-mono text-[11px] text-[#7C8F88] mt-2">
              {estimateSecondsLeft(elapsedMs, ESTIMATED_CATEGORIA_LOAD_MS) > 0
                ? `Tiempo estimado restante: ~${estimateSecondsLeft(elapsedMs, ESTIMATED_CATEGORIA_LOAD_MS)}s`
                : "Ya casi — la DGA está tardando un poco más de lo habitual."}
            </p>
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="text-center py-8">
          <AlertTriangle className="w-5 h-5 text-[#9BAEA8] mx-auto mb-2" />
          <p className="text-[13px] text-[#C7D3CE] mb-3">{error}</p>
          <button
            onClick={onRetry}
            className="text-[12px] font-mono text-[#9BAEA8] hover:text-[#7ECBDE] underline"
          >
            Reintentar
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {estaciones.map((station, i) => (
            <StationCard
              key={station.codigo}
              station={station}
              index={i}
              onOpen={() => onOpenStation(station)}
              onObtenerCaudal={onObtenerCaudal}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Station Card ----------
function StationCard({ station, index, onOpen, onObtenerCaudal }) {
  const s = ALERT_STYLES[station.tipoAlerta] || ALERT_STYLES.Azul;
  const caudal = station.detalle?.caudalM3s;
  // `station.detalle` puede existir con caudalM3s en null porque la DGA
  // fue consultada y no lo reportó (ver worker.js) — eso es distinto de
  // "todavía no se pidió". Solo en el segundo caso mostramos el botón
  // "Obtener Caudal"; en el primero, el mensaje de "no disponible" (con
  // sugerencia cercana, si aplica, dentro del diálogo de detalle).
  const yaConsultado = station.detalle != null;
  const caudalLoading = station.caudalEstado?.loading;
  const caudalError = station.caudalEstado?.error;
  const exceso = station.umbral ? Math.round(((station.valorMedicion - station.umbral) / station.umbral) * 100) : null;

  // La ficha de detalle se abre recién cuando ya se intentó pedir el
  // Caudal de esta estación (con o sin éxito — lo que importa es que la
  // DGA ya fue consultada, no que haya dato) — así el usuario decide con
  // intención abrir la consulta puntual antes de ver el detalle completo,
  // en vez de que abrir cualquier tarjeta dispare la petición. Azul es la
  // excepción: nunca pide Caudal (ver worker.js), así que su ficha se
  // abre directo, sin bloqueo.
  const puedeAbrirse = yaConsultado || station.tipoAlerta === "Azul";

  function handleOpen() {
    if (!puedeAbrirse) return;
    onOpen();
  }

  function handleObtenerCaudal(e) {
    e.stopPropagation(); // no abrir la ficha de detalle al pinchar este botón puntual
    onObtenerCaudal(station);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={!puedeAbrirse}
      onClick={handleOpen}
      onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && puedeAbrirse) onOpen(); }}
      style={{
        animationDelay: `${Math.min(index, 14) * 35}ms`,
        borderColor: s.pulse ? "rgba(232,73,46,0.7)" : undefined,
      }}
      className={`rise-in group relative text-left rounded-xl border-2 overflow-hidden flex flex-col transition-transform ${
        puedeAbrirse ? "hover:-translate-y-0.5 cursor-pointer" : "cursor-default"
      } ${
        s.pulse ? "urgent-pulse" : `${s.borderSoft} ${s.bg} ${puedeAbrirse ? "hover:border-opacity-90" : ""}`
      }`}
    >
      {/* Cabecera de severidad */}
      <div className={`flex items-center justify-between px-4 py-3 border-b ${s.pulse ? "border-[#E8492E]/50" : `${s.borderSoft} bg-black/25`}`}>
        <span className={`flex items-center gap-1.5 font-mono text-[12px] font-bold tracking-widest ${s.text}`}>
          {station.tipoAlerta === "Roja" && <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2.5} />}
          {s.label}
        </span>
        <span className="font-mono text-[12px] font-medium text-[#C7D3CE]">{station.regionNombreAprox}</span>
      </div>

      {/* Cuerpo */}
      <div className="px-4 pt-4 pb-4 flex-1 flex flex-col">
        <h3 className="font-display font-bold text-[17px] text-[#FFFFFF] leading-snug mb-3 min-h-[2.5em] line-clamp-2">
          {station.nombre}
        </h3>

        {/* Medición principal */}
        <div className="rounded-lg bg-[#0A1210]/70 border border-white/[0.08] px-3.5 py-3 mb-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[#C7D3CE]">{station.parametro}</span>
            {exceso != null && exceso > 0 && (
              <span className={`font-mono text-[11px] font-bold ${s.text}`}>+{exceso}% umbral</span>
            )}
          </div>
          <div className="flex items-end justify-between">
            <p className={`font-mono text-3xl font-bold ${s.text} leading-none`}>
              {station.valorMedicion}<span className="text-[14px] font-medium text-[#9BAEA8] ml-1">{station.unidad}</span>
            </p>
            <p className="font-mono text-[12px] font-medium text-[#9BAEA8]">umbral {station.umbral}{station.unidad}</p>
          </div>
          {station.tendencia && (
            <div className="mt-2.5 pt-2.5 border-t border-white/[0.06]">
              <TendenciaChip tendencia={station.tendencia} />
            </div>
          )}
        </div>

        {/* Caudal: 4 estados posibles — ya lo tenemos, cargando, botón para
            pedirlo, o "no disponible" (la DGA fue consultada y no lo dio). */}
        {caudal != null && (
          <div className="rounded-lg bg-[#0A1210]/40 border border-white/[0.06] px-3.5 py-2.5 mb-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[#C7D3CE]">Caudal</span>
              <span className="font-mono text-lg font-bold text-[#EDF2F0]">
                {caudal} <span className="text-[12px] text-[#9BAEA8] font-medium">m³/seg</span>
              </span>
            </div>
          </div>
        )}

        {/* En Azul no se pide Caudal (ver worker.js) — se aclara para que no
            parezca un dato faltante por error de red, y no se ofrece el botón. */}
        {caudal == null && station.tipoAlerta === "Azul" && (
          <p className="text-[10px] text-[#5C726A] mb-2.5 leading-relaxed">
            Caudal no calculado para alertas Azul
          </p>
        )}

        {/* Ya se consultó pero la DGA no reportó Caudal — no tiene sentido
            reintentar automático (ver la nota de condición de carrera en
            worker.js), pero se deja el botón para que el usuario reintente
            si quiere. */}
        {caudal == null && station.tipoAlerta !== "Azul" && yaConsultado && !caudalLoading && (
          <div className="mb-2.5">
            <p className="text-[10px] text-[#5C726A] mb-1.5 leading-relaxed">
              {caudalError ? `No se pudo obtener: ${caudalError}` : "La DGA no reportó Caudal para esta estación."}
            </p>
            <button
              onClick={handleObtenerCaudal}
              disabled={!onObtenerCaudal || !WORKER_URL}
              className="w-full text-center font-mono text-[11px] font-semibold text-[#7ECBDE] border border-[#3B8FA3]/40 rounded-md py-1.5 hover:bg-[#3B8FA3]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Todavía no se pidió Caudal para esta estación — botón principal. */}
        {caudal == null && station.tipoAlerta !== "Azul" && !yaConsultado && !caudalLoading && (
          <button
            onClick={handleObtenerCaudal}
            disabled={!onObtenerCaudal || !WORKER_URL}
            title={!WORKER_URL ? "Requiere un Worker configurado (VITE_DGA_WORKER_URL) — ver README." : undefined}
            className={`mb-2.5 w-full text-center font-mono text-[12px] font-bold rounded-lg border py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${s.borderSoft} ${s.text} hover:bg-white/[0.04]`}
          >
            Obtener Caudal
          </button>
        )}

        {caudalLoading && (
          <div className="mb-2.5 w-full flex items-center justify-center gap-2 font-mono text-[12px] font-semibold text-[#9BAEA8] border border-white/10 rounded-lg py-2.5">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            Consultando Caudal...
          </div>
        )}

        <div className="mt-auto pt-2.5 flex items-center justify-between text-[11px] font-mono font-medium text-[#7C8F88] border-t border-white/[0.08]">
          <span title="Hora de generación del mapa de la DGA — no es la hora exacta de medición de este río en particular.">
            DGA: {station.fecha}
          </span>
          {puedeAbrirse ? (
            <span className="flex items-center gap-1 font-semibold group-hover:text-[#7ECBDE]">Detalle →</span>
          ) : (
            <span className="flex items-center gap-1 text-[#5C726A]" title="Obtené el Caudal primero para ver la ficha de detalle">
              Detalle bloqueado
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Station Detail Dialog ----------
function StationDialog({ station, estacionesCategoria, onClose, onOpenStation, onObtenerCaudal }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Histórico de Nivel de Agua para el gráfico — se pide cada vez que
  // cambia la estación mostrada (abrir una ficha nueva, o saltar a la
  // sugerencia cercana desde acá mismo). Vive en este componente, no en
  // CentroMando, porque solo el diálogo lo necesita — no tiene sentido
  // acarrearlo por toda la cadena de props como el Caudal.
  const [historico, setHistorico] = useState(null);
  const [historicoLoading, setHistoricoLoading] = useState(false);
  const [historicoError, setHistoricoError] = useState(null);

  useEffect(() => {
    let cancelado = false;
    setHistorico(null);
    setHistoricoError(null);
    setHistoricoLoading(true);
    loadHistoricoEstacion(station.codigo)
      .then(json => { if (!cancelado) setHistorico(json); })
      .catch(e => { if (!cancelado) setHistoricoError(e.message || "Error desconocido"); })
      .finally(() => { if (!cancelado) setHistoricoLoading(false); });
    // `cancelado` evita pisar el estado con la respuesta de una estación
    // vieja si el usuario salta a otra ficha (ej. sugerencia cercana)
    // antes de que la petición anterior termine.
    return () => { cancelado = true; };
  }, [station.codigo]);

  const s = ALERT_STYLES[station.tipoAlerta] || ALERT_STYLES.Azul;
  const d = station.detalle;
  // El objeto `detalle` puede existir pero con sus 5 campos en null (la DGA
  // consultó la estación pero no reportó ningún valor) — eso es distinto a
  // que `detalle` no exista en absoluto (nunca se pidió, o falló la
  // petición). hayAlgunDetalle distingue ambos casos para mostrar un
  // mensaje preciso en vez de una grilla vacía y silenciosa.
  const hayAlgunDetalle = d && [d.caudalM3s, d.precipitacion24hMm, d.precipitacionAcumMm, d.alturaNieveCm, d.volumenLagoMillM3].some(v => v != null);

  // Si esta estación no trajo Caudal (y sí se le pidió detalle — no es el
  // caso Azul, que ni siquiera lo intenta), busca la estación con Caudal
  // más cercana dentro de la misma categoría ya cargada, para sugerirla en
  // vez de dejar un "no disponible" seco.
  const sugerenciaCercana =
    d && d.caudalM3s == null && station.tipoAlerta !== "Azul" && estacionesCategoria
      ? estacionCercanaConCaudal(station, estacionesCategoria)
      : null;

  const facts = [
    { label: "Estado de transmisión", value: station.estadoTransmision },
    { label: "Fuente de la estación", value: station.fuenteEstacion },
    { label: "Tipo de estación", value: station.tipoEstacion },
    { label: "Código de estación", value: station.codigo },
    { label: "Altitud", value: station.altitud != null ? `${station.altitud} m` : null },
    { label: "Coordenadas", value: station.latitud != null ? `${station.latitud.toFixed(5)}, ${station.longitud.toFixed(5)}` : null },
    { label: "UTM Este / Norte", value: station.utmEste != null ? `${station.utmEste} / ${station.utmNorte}` : null },
    { label: "Aviso de la estación", value: station.mensajeError },
  ].filter(f => f.value);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-label={`Detalle de ${station.nombre}`}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-xl border border-[#1E332C] bg-[#0F1B18] shadow-2xl"
      >
        <div className={`flex items-start justify-between gap-4 px-8 py-6 border-b border-[#1E332C] ${s.bg}`}>
          <div>
            <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded border ${s.chip} tracking-wide`}>
              {s.label}
            </span>
            <h2 className="font-display font-bold text-2xl text-white mt-2 leading-tight">{station.nombre}</h2>
            <p className="text-[14px] font-medium text-[#C7D3CE] mt-1">{station.regionNombreAprox}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-md text-[#9BAEA8] hover:text-[#EDF2F0] hover:bg-[#1E332C] transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Layout de 2 columnas en pantallas anchas: izquierda concentra la
            medición viva (número actual, evolución, Caudal/detalle);
            derecha concentra el contexto espacial y técnico (mapa, ficha,
            sugerencia, link oficial). En mobile (una columna) el orden
            natural del DOM ya prioriza lo más importante primero. */}
        <div className="px-8 py-6 grid grid-cols-1 lg:grid-cols-2 gap-x-6">
          <div>
            {/* Medición principal */}
            <div className="rounded-lg bg-[#0A1210] border border-[#1E332C] px-5 py-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-[#C7D3CE] uppercase tracking-wide">{station.parametro || "Medición"}</span>
                {station.fecha && (
                  <span
                    className="font-mono text-[11px] text-[#7C8F88]"
                    title="Hora de generación del mapa de la DGA (todas las estaciones comparten esta misma hora) — no es la hora exacta en que se midió este río."
                  >
                    Mapa DGA: {station.fecha}
                  </span>
                )}
              </div>
              <div className="flex items-end justify-between">
                <p className={`font-mono text-4xl font-bold ${s.text}`}>
                  {station.valorMedicion}<span className="text-base font-normal text-[#9BAEA8] ml-1">{station.unidad}</span>
                </p>
                <div className="text-right">
                  <p className="text-[11px] text-[#7C8F88] uppercase tracking-wide mb-1">Umbral DGA</p>
                  <p className="font-mono text-lg text-[#C7D3CE]">
                    {station.umbral}<span className="text-xs font-normal text-[#9BAEA8] ml-1">{station.unidad}</span>
                  </p>
                </div>
              </div>
              {station.tendencia && <TendenciaTag tendencia={station.tendencia} />}
            </div>

            {/* Evolución del Nivel de Agua — gráfico de línea contra el
                umbral de alerta, usando el histórico guardado en Sheets por
                el cron (una lectura cada 30 min). */}
            <div className="mb-4">
              <p className="text-[11px] text-[#7C8F88] uppercase tracking-wide mb-1.5">Evolución reciente</p>
              <HistoricoChart
                puntos={historico?.puntos}
                loading={historicoLoading}
                error={historicoError}
                umbral={station.umbral}
                unidad={station.unidad}
                colorClass={s.text}
              />
            </div>

            {/* Caudal / Precipitación / Nieve / Volumen — solo si el JSON se generó con --detalle */}
            {d && hayAlgunDetalle && (
              <div className="grid grid-cols-2 gap-2.5 mb-4">
                {d.caudalM3s != null && <Stat label="Caudal" value={d.caudalM3s} unit="m³/seg" />}
                {d.precipitacion24hMm != null && <Stat label="Pptación últimas 24h" value={d.precipitacion24hMm} unit="mm" />}
                {d.precipitacionAcumMm != null && <Stat label="Pptación acumulada" value={d.precipitacionAcumMm} unit="mm" />}
                {d.alturaNieveCm != null && <Stat label="Altura de nieve" value={d.alturaNieveCm} unit="cm" />}
                {d.volumenLagoMillM3 != null && <Stat label="Volumen de lago" value={d.volumenLagoMillM3} unit="Mill.m³" />}
              </div>
            )}
            {(!d || !hayAlgunDetalle) && (
              <div className="mb-4">
                {station.tipoAlerta === "Azul" ? (
                  <div className="flex items-start gap-2 rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-3">
                    <Radio className="w-3.5 h-3.5 text-[#7C8F88] flex-shrink-0 mt-0.5" />
                    <p className="text-[12px] text-[#9BAEA8] leading-relaxed">
                      Esta estación está en alerta Azul — el Caudal solo se calcula para alertas Roja y Amarilla, para mantener la carga rápida.
                    </p>
                  </div>
                ) : d ? (
                  <div className="flex items-start gap-2 rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-3">
                    <Radio className="w-3.5 h-3.5 text-[#7C8F88] flex-shrink-0 mt-0.5" />
                    <p className="text-[12px] text-[#9BAEA8] leading-relaxed">
                      La DGA consultó esta estación pero no reportó Caudal ni Precipitación — es posible que no tenga esos sensores instalados.
                    </p>
                  </div>
                ) : !WORKER_URL ? (
                  <div className="flex items-start gap-2 rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-3">
                    <Radio className="w-3.5 h-3.5 text-[#7C8F88] flex-shrink-0 mt-0.5" />
                    <p className="text-[12px] text-[#9BAEA8] leading-relaxed">
                      Sin datos de Caudal/Precipitación — corré el script con <code className="text-[#7ECBDE] font-mono">--detalle</code> para incluirlos, o configurá <code className="text-[#7ECBDE] font-mono">VITE_DGA_WORKER_URL</code> para pedirlo bajo demanda.
                    </p>
                  </div>
                ) : station.caudalEstado?.loading ? (
                  <div className="w-full flex items-center justify-center gap-2 font-mono text-[12px] font-semibold text-[#9BAEA8] border border-white/10 rounded-lg py-3">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Consultando Caudal en la DGA...
                  </div>
                ) : (
                  <>
                    {station.caudalEstado?.error && (
                      <p className="text-[11px] text-[#9BAEA8] mb-2">No se pudo obtener: {station.caudalEstado.error}</p>
                    )}
                    <button
                      onClick={() => onObtenerCaudal(station)}
                      disabled={!onObtenerCaudal || !WORKER_URL}
                      className={`w-full text-center font-mono text-[13px] font-bold rounded-lg border py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${s.borderSoft} ${s.text} hover:bg-white/[0.04]`}
                    >
                      Obtener Caudal
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Estación con Caudal más cercana — se muestra solo cuando ESTA
                estación sí fue consultada por la DGA pero no reportó Caudal
                (no aplica al caso "nunca se pidió detalle", donde tampoco
                tiene sentido sugerir nada todavía). */}
            {sugerenciaCercana && (
              <button
                onClick={() => onOpenStation(sugerenciaCercana.estacion)}
                className="w-full text-left flex flex-col gap-1.5 rounded-lg bg-[#3B8FA3]/[0.08] border border-[#3B8FA3]/30 px-4 py-3 mb-4 hover:border-[#3B8FA3]/60 transition-colors"
              >
                <p className="text-[10px] font-bold uppercase tracking-widest text-[#7ECBDE]">Sugerencia cercana</p>
                <p className="text-[12px] text-[#C7D3CE] leading-relaxed">
                  La DGA no tiene Caudal para esta estación en este momento, pero a{" "}
                  <span className="font-mono font-semibold text-[#EDF2F0]">{sugerenciaCercana.distanciaKm.toFixed(1)} km</span>{" "}
                  está <span className="font-semibold text-[#EDF2F0]">{sugerenciaCercana.estacion.nombre}</span> con{" "}
                  <span className="font-mono font-semibold text-[#7ECBDE]">{sugerenciaCercana.estacion.detalle.caudalM3s} m³/seg</span>.
                </p>
                <span className="text-[11px] font-mono font-semibold text-[#7ECBDE] flex items-center gap-1">
                  Ver ficha de {sugerenciaCercana.estacion.nombre} <ExternalLink className="w-3 h-3" />
                </span>
              </button>
            )}
          </div>

          <div>
            {/* Ubicación exacta de la estación */}
            <div className="mb-4">
              <p className="text-[11px] text-[#7C8F88] uppercase tracking-wide mb-1.5">Ubicación</p>
              <StationMiniMap station={station} />
            </div>

            {/* Ficha técnica */}
            <div className="space-y-2 mb-5">
              {facts.map(f => (
                <div key={f.label} className="flex items-center justify-between text-[13px] border-b border-[#1A2C26] pb-2">
                  <span className="text-[#C7D3CE]">{f.label}</span>
                  <span className="text-[#C7D3CE] font-mono text-right">{f.value}</span>
                </div>
              ))}
            </div>

            <a
              href={SNIA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 px-4 py-3 rounded-lg bg-[#0A1210] border border-[#1E332C] hover:border-[#3B8FA3]/40 text-sm text-[#C7D3CE] hover:text-[#EDF2F0] transition-colors"
            >
              Ver gráfico histórico en el visor oficial de la DGA
              <ExternalLink className="w-4 h-4 flex-shrink-0 text-[#7C8F88]" />
            </a>

            <p className="text-[11px] text-[#7C8F88] font-mono mt-4 pt-4 border-t border-[#1E332C] leading-relaxed">
              Fuente: Dirección General de Aguas (DGA) — Sistema Nacional de Información del Agua (SNIA). Dato de estación física real, no modelo. La hora "Mapa DGA" es cuándo la DGA generó su mapa (igual para todas las estaciones), no la hora exacta de esta medición — la DGA no publica esa hora por estación.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Gráfico de histórico (Nivel de Agua vs. tiempo) ----------
// SVG hecho a mano (sin librería de gráficos: es solo una línea de tiempo
// con una recta de umbral, no justifica una dependencia nueva). Recibe
// `puntos` tal como los devuelve /historico: [{ timestamp, valorMedicion,
// umbral, ... }, ...] ordenados cronológicamente ascendente.
function HistoricoChart({ puntos, loading, error, umbral, unidad, colorClass }) {
  if (loading) {
    return (
      <div className="rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-8 flex items-center justify-center gap-2">
        <RefreshCw className="w-3.5 h-3.5 text-[#7ECBDE] animate-spin" />
        <p className="font-mono text-[12px] text-[#9BAEA8]">Cargando histórico...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-3">
        <p className="text-[12px] text-[#9BAEA8]">No se pudo cargar el histórico: {error}</p>
      </div>
    );
  }

  // Menos de 2 puntos no alcanza para trazar una línea con sentido — pasa
  // seguido con estaciones que recién empezaron a aparecer en alerta (el
  // cron todavía no acumuló varias corridas para ellas).
  const validos = (puntos || []).filter(p => p.valorMedicion != null);
  if (validos.length < 2) {
    return (
      <div className="rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-3">
        <p className="text-[12px] text-[#9BAEA8] leading-relaxed">
          Todavía no hay suficiente histórico guardado para graficar esta estación — el cron guarda una lectura cada 30 min, volvé a revisar más tarde.
        </p>
      </div>
    );
  }

  // Layout del SVG: viewBox fijo, se escala solo con el contenedor.
  const W = 600, H = 180, padL = 44, padR = 12, padT = 14, padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const valores = validos.map(p => p.valorMedicion);
  const umbralRef = umbral ?? validos[0].umbral;
  const minVal = Math.min(...valores, umbralRef ?? Infinity);
  const maxVal = Math.max(...valores, umbralRef ?? -Infinity);
  // Margen del 8% arriba/abajo para que la línea no quede pegada a los bordes.
  const rango = Math.max(maxVal - minVal, 0.01);
  const margen = rango * 0.08;
  const yMin = minVal - margen;
  const yMax = maxVal + margen;

  const times = validos.map(p => new Date(p.timestamp).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tRango = Math.max(tMax - tMin, 1);

  function x(i) { return padL + (plotW * (times[i] - tMin)) / tRango; }
  function y(v) { return padT + plotH - (plotH * (v - yMin)) / (yMax - yMin); }

  const linePath = validos.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.valorMedicion).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(validos.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  const yUmbral = umbralRef != null ? y(umbralRef) : null;

  // Etiquetas de tiempo: primera y última lectura, en hora local corta.
  const fmtHora = ts => new Date(ts).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 pt-4 pb-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none" style={{ height: 180 }}>
        {/* Grilla horizontal simple: min / medio / max del eje Y */}
        {[yMin, (yMin + yMax) / 2, yMax].map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#1E332C" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="#7C8F88" fontFamily="IBM Plex Mono, monospace">
              {v.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Línea de umbral — punteada, para distinguirla claramente de la medición real */}
        {yUmbral != null && (
          <>
            <line x1={padL} x2={W - padR} y1={yUmbral} y2={yUmbral} stroke="#E8A33D" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8" />
            <text x={W - padR} y={yUmbral - 4} textAnchor="end" fontSize="9" fill="#E8A33D" fontFamily="IBM Plex Mono, monospace">
              umbral {umbralRef}
            </text>
          </>
        )}

        {/* Área bajo la curva, sutil */}
        <path d={areaPath} fill="currentColor" className={colorClass} opacity="0.08" />

        {/* Línea de la serie */}
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth="2" className={colorClass} strokeLinejoin="round" strokeLinecap="round" />

        {/* Puntos */}
        {validos.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.valorMedicion)} r="2.5" fill="currentColor" className={colorClass} />
        ))}
      </svg>
      <div className="flex items-center justify-between mt-1 font-mono text-[10px] text-[#7C8F88]">
        <span>{fmtHora(validos[0].timestamp)}</span>
        <span>{unidad}</span>
        <span>{fmtHora(validos[validos.length - 1].timestamp)}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, unit }) {
  return (
    <div className="rounded-lg bg-[#0A1210] border border-[#1E332C] px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-[#C7D3CE] mb-1">{label}</p>
      <p className="font-mono text-base font-semibold text-[#7ECBDE]">
        {value}<span className="text-[11px] text-[#9BAEA8] font-normal ml-1">{unit}</span>
      </p>
    </div>
  );
}

// ---------- Tendencia nacional (panorama general) ----------
// Total de alertas + desglose por color, a partir de las corridas del
// cron guardadas en Sheets (ver /resumen en worker.js). Dos vistas
// comparten la misma lógica de dibujo (TendenciaSVG): una chica en el
// panorama general (6h, clickeable) y un diálogo grande con más espacio
// y más historial (24h) al pinchar la chica.
const HORAS_VENTANA_TENDENCIA_CHICA = 6;
const HORAS_VENTANA_TENDENCIA_GRANDE = 24;

const SERIES_TENDENCIA = [
  { key: "Total", color: "#EDF2F0", get: c => c.total },
  { key: "Roja", color: "#FF8B6B", get: c => c.Roja || 0 },
  { key: "Amarilla", color: "#F5C876", get: c => c.Amarilla || 0 },
  { key: "Azul", color: "#7ECBDE", get: c => c.Azul || 0 },
];

// Hook compartido: filtra `corridas` a la ventana de horas pedida y
// maneja qué series están visibles — usado tanto por la vista chica como
// por el diálogo grande, cada una con su propia ventana y su propio
// estado de filtro (aislar una serie en el diálogo no debe afectar la
// vista chica de atrás, y viceversa).
function useTendenciaData(corridas, horasVentana) {
  const [seriesActivas, setSeriesActivas] = useState({ Total: true, Roja: true, Amarilla: true, Azul: true });

  function toggleSerie(key) {
    setSeriesActivas(prev => {
      const next = { ...prev, [key]: !prev[key] };
      // No permitir apagar todas — evita un gráfico vacío sin pista de qué pasó.
      const quedanActivas = Object.values(next).some(Boolean);
      return quedanActivas ? next : prev;
    });
  }

  const ahora = Date.now();
  const ventanaMs = horasVentana * 60 * 60 * 1000;
  const enVentana = (corridas || []).filter(c => ahora - new Date(c.timestamp).getTime() <= ventanaMs);
  const seriesVisibles = SERIES_TENDENCIA.filter(s => seriesActivas[s.key]);

  return { enVentana, seriesActivas, seriesVisibles, toggleSerie };
}

// Dibuja el SVG en sí — recibe ya calculado `enVentana`/`seriesVisibles` y
// las dimensiones deseadas, para que la vista chica y el diálogo grande
// puedan pedir distinto tamaño y distinta cantidad de etiquetas de hora
// sin duplicar la lógica de escalas/paths.
function TendenciaSVG({ enVentana, seriesVisibles, width = 600, height = 140, maxEtiquetas = 5, puntoRadio = 2.5 }) {
  const W = width, H = height, padL = 32, padR = 12, padT = 10, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const times = enVentana.map(c => new Date(c.timestamp).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tRango = Math.max(tMax - tMin, 1);

  const maxY = Math.max(1, ...enVentana.flatMap(c => seriesVisibles.map(s => s.get(c))));

  function x(i) { return padL + (plotW * (times[i] - tMin)) / tRango; }
  function y(v) { return padT + plotH - (plotH * v) / maxY; }

  const paso = Math.max(1, Math.ceil((enVentana.length - 1) / (maxEtiquetas - 1)));
  const indicesEtiquetas = [];
  for (let i = 0; i < enVentana.length; i += paso) indicesEtiquetas.push(i);
  if (indicesEtiquetas[indicesEtiquetas.length - 1] !== enVentana.length - 1) indicesEtiquetas.push(enVentana.length - 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none" style={{ height: H }}>
      {[0, maxY / 2, maxY].map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#1E332C" strokeWidth="1" />
          <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="#7C8F88" fontFamily="IBM Plex Mono, monospace">
            {Math.round(v)}
          </text>
        </g>
      ))}
      {seriesVisibles.map(s => (
        <g key={s.key}>
          <path
            d={enVentana.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(s.get(c)).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Un punto por corrida — así se ve exactamente cuántas
              lecturas hay y dónde cae cada una en el tiempo. */}
          {enVentana.map((c, i) => (
            <circle key={i} cx={x(i)} cy={y(s.get(c))} r={puntoRadio} fill={s.color} />
          ))}
        </g>
      ))}
      {/* Etiquetas de hora en el eje X, espaciadas parejo. */}
      {indicesEtiquetas.map(i => (
        <text
          key={i}
          x={x(i)}
          y={H - 4}
          textAnchor={i === 0 ? "start" : i === enVentana.length - 1 ? "end" : "middle"}
          fontSize="9"
          fill="#7C8F88"
          fontFamily="IBM Plex Mono, monospace"
        >
          {new Date(enVentana[i].timestamp).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
        </text>
      ))}
    </svg>
  );
}

// Chips de filtro por serie — clickeables, prenden/apagan cada línea.
// Compartidos entre la vista chica y el diálogo grande.
function TendenciaChips({ seriesActivas, toggleSerie, ultimo, tamanoGrande }) {
  return (
    <div className={`flex items-center gap-2 flex-wrap ${tamanoGrande ? "mb-4" : "mb-3"}`}>
      {SERIES_TENDENCIA.map(s => {
        const activa = seriesActivas[s.key];
        return (
          <button
            key={s.key}
            onClick={() => toggleSerie(s.key)}
            className={`flex items-center gap-1.5 font-mono font-semibold rounded-md border transition-colors ${
              tamanoGrande ? "text-[12px] px-3 py-1.5" : "text-[10px] px-2 py-1"
            }`}
            style={{
              color: activa ? s.color : "#5C726A",
              borderColor: activa ? `${s.color}66` : "#1E332C",
              backgroundColor: activa ? `${s.color}14` : "transparent",
            }}
            aria-pressed={activa}
          >
            <span className={tamanoGrande ? "w-2.5 h-2.5 rounded-full" : "w-2 h-2 rounded-full"} style={{ backgroundColor: activa ? s.color : "#3C5850" }} />
            {s.key} {s.get(ultimo)}
          </button>
        );
      })}
    </div>
  );
}

// Vista chica del panorama general — clickeable, abre el diálogo grande
// con más historial. `corridas` viene tal cual de /resumen.
function TendenciaNacionalChart({ corridas, error, onExpand }) {
  const { enVentana, seriesActivas, seriesVisibles, toggleSerie } = useTendenciaData(corridas, HORAS_VENTANA_TENDENCIA_CHICA);

  if (error) {
    return (
      <div className="rounded-lg bg-[#0F1B18] border border-[#1E332C] px-4 py-3">
        <p className="text-[12px] text-[#9BAEA8]">No se pudo cargar la tendencia: {error}</p>
      </div>
    );
  }

  if (enVentana.length < 2) {
    return (
      <div className="rounded-lg bg-[#0F1B18] border border-[#1E332C] px-4 py-3">
        <p className="text-[12px] text-[#9BAEA8] leading-relaxed">
          Todavía no hay suficiente histórico guardado para mostrar la tendencia — el cron guarda una corrida cada 30 min, volvé a revisar más tarde.
        </p>
      </div>
    );
  }

  const primero = enVentana[0];
  const ultimo = enVentana[enVentana.length - 1];
  const variacionTotal = ultimo.total - primero.total;
  const fmtHora = ts => new Date(ts).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded-lg bg-[#0F1B18] border border-[#1E332C] px-4 py-4">
      {/* Total grande + variación en la ventana */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <p className="font-display font-bold text-[32px] leading-none text-white">{ultimo.total}</p>
          <p className="text-[10px] uppercase tracking-widest text-[#7C8F88] font-semibold mt-1">Total en alerta ahora</p>
        </div>
        {variacionTotal !== 0 && (
          <p className={`font-mono text-[13px] font-bold ${variacionTotal > 0 ? "text-[#F5C876]" : "text-[#7ECBDE]"}`}>
            {variacionTotal > 0 ? "↑" : "↓"} {Math.abs(variacionTotal)} desde las {fmtHora(primero.timestamp)}
          </p>
        )}
        {variacionTotal === 0 && (
          <p className="font-mono text-[13px] font-bold text-[#9BAEA8]">→ Estable desde las {fmtHora(primero.timestamp)}</p>
        )}
      </div>

      <TendenciaChips seriesActivas={seriesActivas} toggleSerie={toggleSerie} ultimo={ultimo} />

      {/* El SVG es clickeable — abre el diálogo grande con 24h. Un
          click en un chip de arriba no debe disparar esto (los chips
          son botones propios con su propio onClick, que no burbujea
          hasta acá porque no está dentro de este bloque clickeable). */}
      <button
        onClick={onExpand}
        className="w-full text-left cursor-pointer group"
        aria-label="Ver tendencia nacional en grande"
      >
        <TendenciaSVG enVentana={enVentana} seriesVisibles={seriesVisibles} height={140} />
        <p className="text-[10px] font-mono text-[#5C726A] mt-1 text-right group-hover:text-[#7ECBDE] transition-colors">
          Tocá el gráfico para ampliar →
        </p>
      </button>
    </div>
  );
}

// Diálogo grande — mismo gráfico, más espacio y más historial (24h en vez
// de 6h). Vive como overlay independiente, igual patrón que StationDialog.
function TendenciaNacionalDialog({ corridas, onClose }) {
  const { enVentana, seriesActivas, seriesVisibles, toggleSerie } = useTendenciaData(corridas, HORAS_VENTANA_TENDENCIA_GRANDE);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const suficientesDatos = enVentana.length >= 2;
  const ultimo = suficientesDatos ? enVentana[enVentana.length - 1] : null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-label="Tendencia nacional ampliada"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-[#1E332C] bg-[#0F1B18] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 px-8 py-6 border-b border-[#1E332C]">
          <div>
            <h2 className="font-display font-bold text-2xl text-white leading-tight">Tendencia nacional</h2>
            <p className="text-[13px] font-medium text-[#C7D3CE] mt-1">Últimas {HORAS_VENTANA_TENDENCIA_GRANDE} horas — una lectura cada 30 min</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-md text-[#9BAEA8] hover:text-[#EDF2F0] hover:bg-[#1E332C] transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 py-6">
          {!suficientesDatos && (
            <p className="text-[13px] text-[#9BAEA8] leading-relaxed">
              Todavía no hay suficiente histórico guardado para esta ventana — el cron guarda una corrida cada 30 min, volvé a revisar más tarde.
            </p>
          )}
          {suficientesDatos && (
            <>
              <TendenciaChips seriesActivas={seriesActivas} toggleSerie={toggleSerie} ultimo={ultimo} tamanoGrande />
              <TendenciaSVG enVentana={enVentana} seriesVisibles={seriesVisibles} height={340} maxEtiquetas={8} puntoRadio={3} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Diálogo de informe de texto ----------
// Muestra el texto armado por generarInformeTexto(), listo para copiar y
// pegar donde haga falta (Instagram, WhatsApp, etc.). El texto se
// selecciona completo con un click en el área (además del botón Copiar),
// para cubrir navegadores donde el acceso al portapapeles esté bloqueado.
function InformeDialog({ texto, copiado, onCopiar, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function seleccionarTodo(e) {
    const range = document.createRange();
    range.selectNodeContents(e.currentTarget);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-label="Informe generado"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-[#1E332C] bg-[#0F1B18] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 px-8 py-6 border-b border-[#1E332C]">
          <div>
            <h2 className="font-display font-bold text-2xl text-white leading-tight">Informe generado</h2>
            <p className="text-[13px] font-medium text-[#C7D3CE] mt-1">Copiá el texto y pegalo donde lo necesites</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-md text-[#9BAEA8] hover:text-[#EDF2F0] hover:bg-[#1E332C] transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 py-6">
          <button
            onClick={onCopiar}
            className={`w-full flex items-center justify-center gap-2 mb-4 px-4 py-3 rounded-lg border font-mono text-[13px] font-bold transition-colors ${
              copiado
                ? "border-[#3B8FA3]/50 bg-[#3B8FA3]/10 text-[#7ECBDE]"
                : "border-[#2A4038] text-[#DCE7E3] hover:text-white hover:border-[#3B8FA3]/60"
            }`}
          >
            {copiado ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiado ? "¡Copiado!" : "Copiar al portapapeles"}
          </button>

          <pre
            onClick={seleccionarTodo}
            className="whitespace-pre-wrap font-mono text-[13px] text-[#C7D3CE] leading-relaxed rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-4 cursor-text select-all"
          >
            {texto}
          </pre>
        </div>
      </div>
    </div>
  );
}

// Muestra "subió/bajó/estable X% desde hace N min", calculado por el
// Worker comparando contra el histórico guardado en Sheets (ver
// worker.js y sheets.js). El "ahora" siempre es un valor scrapeado en vivo
// de la DGA (nunca sale de Sheets); el "hace N min" es la corrida más
// reciente que el cron haya guardado — ese intervalo NO es un fijo de 30
// minutos, varía según en qué momento entre dos corridas del cron el
// usuario abrió el dashboard (puede ser 2 min, 18 min, 29 min...), por eso
// se calcula en tiempo real acá en vez de mostrar un texto fijo.
//
// Si `tendencia` es null (no había snapshot anterior con qué comparar —
// p.ej. el cron nunca corrió todavía para esta estación), no se renderiza
// nada, así que los componentes que lo usan ya chequean
// `station.tendencia &&` antes de pasarlo acá.
function TendenciaTag({ tendencia }) {
  const { direccion, porcentaje, diferenciaMetros, timestampAnterior } = tendencia;
  const config = {
    subiendo: { icon: "↑", color: "text-[#F5C876]", label: "Subiendo" },
    bajando: { icon: "↓", color: "text-[#7ECBDE]", label: "Bajando" },
    estable: { icon: "→", color: "text-[#9BAEA8]", label: "Estable" },
  }[direccion] || { icon: "→", color: "text-[#9BAEA8]", label: "Estable" };

  const minutosTranscurridos = timestampAnterior
    ? Math.max(1, Math.round((Date.now() - new Date(timestampAnterior).getTime()) / 60000))
    : null;

  return (
    <p className={`font-mono text-[11px] font-semibold mt-2 flex items-center gap-1 ${config.color}`}>
      <span className="text-[13px]">{config.icon}</span>
      {config.label}
      {porcentaje != null && ` ${Math.abs(porcentaje)}%`}
      {diferenciaMetros != null && direccion !== "estable" && (
        <span className="text-[#7C8F88] font-normal"> ({diferenciaMetros > 0 ? "+" : ""}{diferenciaMetros}m)</span>
      )}
      {minutosTranscurridos != null && (
        <span className="text-[#5C726A] font-normal">· hace {minutosTranscurridos} min</span>
      )}
    </p>
  );
}

// Variante "chip" de TendenciaTag — mismo dato, pero con fondo de color
// propio en vez de solo texto, para que no compita visualmente y se pierda
// al lado de números grandes (Nivel de Agua, Caudal) como pasaba antes en
// las tarjetas de la grilla. Se usa en StationCard; el diálogo de detalle
// sigue usando la versión de texto simple (TendenciaTag) porque ahí ya
// tiene su propio espacio dedicado y no compite con nada.
function TendenciaChip({ tendencia }) {
  const { direccion, porcentaje, diferenciaMetros, timestampAnterior } = tendencia;
  const config = {
    subiendo: { icon: "↑", text: "text-[#F5C876]", bg: "bg-[#E8A33D]/15", border: "border-[#E8A33D]/40", label: "Subiendo" },
    bajando: { icon: "↓", text: "text-[#7ECBDE]", bg: "bg-[#3B8FA3]/15", border: "border-[#3B8FA3]/40", label: "Bajando" },
    estable: { icon: "→", text: "text-[#9BAEA8]", bg: "bg-white/[0.04]", border: "border-white/10", label: "Estable" },
  }[direccion] || { icon: "→", text: "text-[#9BAEA8]", bg: "bg-white/[0.04]", border: "border-white/10", label: "Estable" };

  const minutosTranscurridos = timestampAnterior
    ? Math.max(1, Math.round((Date.now() - new Date(timestampAnterior).getTime()) / 60000))
    : null;

  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] font-bold ${config.bg} ${config.border} ${config.text}`}>
      <span className="text-[13px] leading-none">{config.icon}</span>
      {config.label}
      {porcentaje != null && ` ${Math.abs(porcentaje)}%`}
      {diferenciaMetros != null && direccion !== "estable" && (
        <span className="opacity-70 font-normal">({diferenciaMetros > 0 ? "+" : ""}{diferenciaMetros}m)</span>
      )}
      {minutosTranscurridos != null && (
        <span className="opacity-60 font-normal">· {minutosTranscurridos}m</span>
      )}
    </span>
  );
}
