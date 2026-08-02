import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, RefreshCw, ExternalLink, X, Radio, Waves, Map as MapIcon } from "lucide-react";
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

// Estimado para la carga de UNA categoría con detalle (al pinchar un botón
// grande). Basado en pruebas reales: peticiones en serie a ~0.7-1s cada
// una, con hasta MAX_DETALLE_STATIONS (30) estaciones en el peor caso.
const ESTIMATED_CATEGORIA_LOAD_MS = 18000;

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

// Carga de detalle (con Caudal) para UNA categoría específica — se llama
// recién cuando el usuario pincha uno de los 3 botones grandes ("Ver
// alertas Rojas", etc.), no en la carga inicial.
async function loadAlertasCategoria(color) {
  if (WORKER_URL) {
    const endpoint = `${WORKER_URL.replace(/\/$/, "")}/alertas?detalle=1&color=${encodeURIComponent(color)}`;
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
  // tarjetas. `detalleCategoria` es la respuesta CON Caudal de esa
  // categoría, pedida recién al pinchar el botón — no antes.
  const [categoriaAbierta, setCategoriaAbierta] = useState(null);
  const [detalleCategoria, setDetalleCategoria] = useState(null);
  const [loadingCategoria, setLoadingCategoria] = useState(false);
  const [errorCategoria, setErrorCategoria] = useState(null);
  const [elapsedCategoriaMs, setElapsedCategoriaMs] = useState(0);

  async function refresh() {
    setLoading(true);
    setError(null);
    setElapsedMs(0);
    // Un refresh general también cierra cualquier categoría abierta — sus
    // datos de detalle quedarían basados en la carga anterior.
    setCategoriaAbierta(null);
    setDetalleCategoria(null);
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
  }

  async function abrirCategoria(color) {
    setCategoriaAbierta(color);
    setDetalleCategoria(null);
    setErrorCategoria(null);
    setLoadingCategoria(true);
    setElapsedCategoriaMs(0);
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

  // Estaciones CON Caudal de la categoría actualmente abierta (si hay una).
  const sortedCategoria = useMemo(() => {
    if (!detalleCategoria?.estaciones) return [];
    return sortByUrgency(detalleCategoria.estaciones);
  }, [detalleCategoria]);

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

            <div className="flex-1 flex justify-end">
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
            uno de los 3 botones. Acá sí vive la grilla de tarjetas con
            Caudal, igual que el diseño anterior — solo que ahora es
            "bajo demanda" en vez de cargarse siempre de entrada. */}
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

      {selected && <StationDialog station={selected} onClose={() => setSelected(null)} />}
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
// Rojas/Amarillas/Azules"). Al pincharlo se pide recién ahí el detalle
// (con Caudal) de esa categoría — antes de eso solo se sabe el conteo,
// que viene de la carga básica inicial.
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
          {active ? "Tocá para cerrar ↑" : "Tocá para ver detalle y Caudal →"}
        </p>
      )}
      {blocked && active && (
        <p className={`font-mono text-[11px] mt-3 flex items-center gap-1.5 ${s.text}`}>
          <RefreshCw className="w-3 h-3 animate-spin" />
          Consultando Caudal...
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
function CategoriaExpandida({ color, loading, error, elapsedMs, estaciones, onRetry, onClose, onOpenStation }) {
  const s = ALERT_STYLES[color];
  return (
    <div className={`rounded-xl border ${s.borderSoft} ${s.bg} p-5`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className={`font-display font-bold text-lg ${s.text}`}>Alertas {color} — detalle con Caudal</h2>
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
          <p className="font-mono text-[12px] text-[#9BAEA8]">Consultando Caudal en la DGA, estación por estación...</p>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Station Card ----------
function StationCard({ station, index, onOpen }) {
  const s = ALERT_STYLES[station.tipoAlerta] || ALERT_STYLES.Azul;
  const caudal = station.detalle?.caudalM3s;
  const exceso = station.umbral ? Math.round(((station.valorMedicion - station.umbral) / station.umbral) * 100) : null;

  return (
    <button
      onClick={onOpen}
      style={{
        animationDelay: `${Math.min(index, 14) * 35}ms`,
        borderColor: s.pulse ? "rgba(232,73,46,0.7)" : undefined,
      }}
      className={`rise-in group relative text-left rounded-xl border-2 overflow-hidden flex flex-col transition-transform hover:-translate-y-0.5 ${
        s.pulse ? "urgent-pulse" : `${s.borderSoft} ${s.bg} hover:border-opacity-90`
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
        </div>

        {/* Caudal, si está disponible — bloque propio para que se note tanto como el nivel de agua */}
        {caudal != null && (
          <div className="rounded-lg bg-[#0A1210]/40 border border-white/[0.06] px-3.5 py-2.5 mb-2.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[#C7D3CE]">Caudal</span>
            <span className="font-mono text-lg font-bold text-[#EDF2F0]">
              {caudal} <span className="text-[12px] text-[#9BAEA8] font-medium">m³/seg</span>
            </span>
          </div>
        )}

        {/* En Azul no se pide Caudal (ver worker.js) — se aclara para que no
            parezca un dato faltante por error de red. */}
        {caudal == null && station.tipoAlerta === "Azul" && (
          <p className="text-[10px] text-[#5C726A] mb-2.5 leading-relaxed">
            Caudal no calculado para alertas Azul
          </p>
        )}

        <div className="mt-auto pt-2.5 flex items-center justify-between text-[11px] font-mono font-medium text-[#7C8F88] border-t border-white/[0.08]">
          <span title="Hora de generación del mapa de la DGA — no es la hora exacta de medición de este río en particular.">
            DGA: {station.fecha}
          </span>
          <span className="flex items-center gap-1 font-semibold group-hover:text-[#7ECBDE]">Detalle →</span>
        </div>
      </div>
    </button>
  );
}

// ---------- Station Detail Dialog ----------
function StationDialog({ station, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const s = ALERT_STYLES[station.tipoAlerta] || ALERT_STYLES.Azul;
  const d = station.detalle;
  // El objeto `detalle` puede existir pero con sus 5 campos en null (la DGA
  // consultó la estación pero no reportó ningún valor) — eso es distinto a
  // que `detalle` no exista en absoluto (nunca se pidió, o falló la
  // petición). hayAlgunDetalle distingue ambos casos para mostrar un
  // mensaje preciso en vez de una grilla vacía y silenciosa.
  const hayAlgunDetalle = d && [d.caudalM3s, d.precipitacion24hMm, d.precipitacionAcumMm, d.alturaNieveCm, d.volumenLagoMillM3].some(v => v != null);

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
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-[#1E332C] bg-[#0F1B18] shadow-2xl"
      >
        <div className={`flex items-start justify-between gap-4 px-8 py-6 border-b border-[#1E332C] ${s.bg}`}>
          <div>
            <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded border ${s.chip} tracking-wide`}>
              {s.label}
            </span>
            <h2 className="font-display font-bold text-xl text-white mt-2 leading-tight">{station.nombre}</h2>
            <p className="text-[14px] font-medium text-[#C7D3CE] mt-1">{station.regionNombreAprox}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-md text-[#9BAEA8] hover:text-[#EDF2F0] hover:bg-[#1E332C] transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 py-6">
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
          </div>

          {/* Ubicación exacta de la estación */}
          <div className="mb-4">
            <p className="text-[11px] text-[#7C8F88] uppercase tracking-wide mb-1.5">Ubicación</p>
            <StationMiniMap station={station} />
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
            <div className="flex items-start gap-2 rounded-lg bg-[#0A1210] border border-[#1E332C] px-4 py-3 mb-4">
              <Radio className="w-3.5 h-3.5 text-[#7C8F88] flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-[#9BAEA8] leading-relaxed">
                {station.tipoAlerta === "Azul"
                  ? "Esta estación está en alerta Azul — el Caudal solo se calcula para alertas Roja y Amarilla, para mantener la carga rápida."
                  : d
                    ? "La DGA consultó esta estación pero no reportó Caudal ni Precipitación — es posible que no tenga esos sensores instalados."
                    : <>Sin datos de Caudal/Precipitación — corré el script con <code className="text-[#7ECBDE] font-mono">--detalle</code> para incluirlos.</>}
              </p>
            </div>
          )}

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
