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
    border: "border-[#E14B3D]",
    borderSoft: "border-[#E14B3D]/40",
    bg: "bg-[#E14B3D]/[0.07]",
    bar: "bg-[#E14B3D]",
    text: "text-[#FF8A7A]",
    chip: "bg-[#E14B3D]/20 text-[#FF8A7A] border-[#E14B3D]/50",
    label: "ROJA — CRÍTICA",
    pulse: true,
  },
  Amarilla: {
    border: "border-[#E0A83E]",
    borderSoft: "border-[#E0A83E]/40",
    bg: "bg-[#E0A83E]/[0.05]",
    bar: "bg-[#E0A83E]",
    text: "text-[#F0C877]",
    chip: "bg-[#E0A83E]/15 text-[#F0C877] border-[#E0A83E]/40",
    label: "AMARILLA",
    pulse: false,
  },
  Azul: {
    border: "border-[#3E8FD4]",
    borderSoft: "border-[#3E8FD4]/35",
    bg: "bg-[#3E8FD4]/[0.04]",
    bar: "bg-[#3E8FD4]",
    text: "text-[#7FBCEE]",
    chip: "bg-[#3E8FD4]/15 text-[#7FBCEE] border-[#3E8FD4]/40",
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

// URL del Worker de Cloudflare que hace de intermediario con la DGA (ver
// carpeta dga-worker/ para desplegarlo). Se configura en un archivo .env
// local (VITE_DGA_WORKER_URL=https://tu-worker.workers.dev) para no dejar
// la URL hardcodeada en el código fuente.
const WORKER_URL = import.meta.env.VITE_DGA_WORKER_URL || null;
const INCLUDE_DETALLE = true; // pide Caudal/Precipitación (más lento, ~15-25s)

// Estimado de cuánto tarda una carga típica con --detalle (basado en las
// pruebas reales: ~11-15 estaciones en alerta, ~0.9s de pausa entre cada
// una más el tiempo de red = 15-25s). No es exacto — el número real de
// estaciones en alerta varía día a día — así que esto es una ESTIMACIÓN
// para darle al usuario una referencia, no una cuenta regresiva precisa.
const ESTIMATED_LOAD_MS = 20000;

// Convierte tiempo transcurrido en progreso de barra (0-100) usando una
// curva de desaceleración: avanza rápido al principio y se frena cerca del
// tope en vez de llegar a 100% y quedarse "pegada" si la carga real tarda
// más que el estimado (lo cual puede pasar: no controlamos cuántas
// estaciones habrá en alerta ni la velocidad de respuesta de la DGA).
function estimateProgress(elapsedMs) {
  const ratio = elapsedMs / ESTIMATED_LOAD_MS;
  // Ease-out: se acerca a 92% asintóticamente, nunca llega a "trabado en 100%"
  const progress = 92 * (1 - Math.exp(-2.2 * ratio));
  return Math.min(progress, 97);
}

function estimateSecondsLeft(elapsedMs) {
  const remainingMs = ESTIMATED_LOAD_MS - elapsedMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

async function loadAlerts() {
  if (WORKER_URL) {
    const endpoint = `${WORKER_URL.replace(/\/$/, "")}/alertas${INCLUDE_DETALLE ? "?detalle=1" : ""}`;
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

export default function CentroMando() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  async function refresh() {
    setLoading(true);
    setError(null);
    setElapsedMs(0);
    try {
      const json = await loadAlerts();
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

  const sorted = useMemo(() => {
    if (!data?.estaciones) return [];
    return sortByUrgency(data.estaciones);
  }, [data]);

  const counts = useMemo(() => {
    const c = { Roja: 0, Amarilla: 0, Azul: 0 };
    sorted.forEach(s => { if (c[s.tipoAlerta] != null) c[s.tipoAlerta]++; });
    return c;
  }, [sorted]);

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#F2F0EA]" style={{ fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');
        .font-mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        .font-display { font-family: 'Space Grotesk', sans-serif; }
        @keyframes urgent-pulse {
          0%, 100% { background-color: rgba(225,75,61,0.08); border-color: rgba(225,75,61,0.5); }
          50% { background-color: rgba(225,75,61,0.32); border-color: rgba(255,120,100,1); }
        }
        .urgent-pulse { animation: urgent-pulse 1.4s ease-in-out infinite; }
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
          animation: rise-in 0.3s ease-out both, urgent-pulse 1.4s ease-in-out 0.3s infinite;
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
          <div className="w-12 h-12 rounded-lg bg-[#141920] border border-[#232A33] flex items-center justify-center">
            <RefreshCw className="w-5 h-5 text-[#7FBCEE] animate-spin" />
          </div>
          <div>
            <p className="font-display font-semibold text-lg text-[#F2F0EA]">Actualizando datos... un momento por favor</p>
            <p className="font-mono text-[12px] text-[#9BA3B0] mt-2 max-w-sm">
              {WORKER_URL
                ? "Consultando estaciones de la DGA en vivo, incluyendo Caudal y Precipitación."
                : "Cargando el último registro disponible."}
            </p>
          </div>

          {WORKER_URL && !error && (
            <div className="w-full max-w-xs">
              <div className="h-1.5 rounded-full bg-[#1B1F26] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#3E8FD4] transition-[width] duration-200 ease-linear"
                  style={{ width: `${estimateProgress(elapsedMs)}%` }}
                />
              </div>
              <p className="font-mono text-[11px] text-[#88909C] mt-2">
                {estimateSecondsLeft(elapsedMs) > 0
                  ? `Tiempo estimado restante: ~${estimateSecondsLeft(elapsedMs)}s`
                  : "Ya casi — algunas estaciones están tardando un poco más de lo habitual."}
              </p>
            </div>
          )}

          {error && (
            <div className="mt-2 rounded-lg border border-[#232A33] bg-[#12161C] px-5 py-4 max-w-md">
              <AlertTriangle className="w-4 h-4 text-[#9BA3B0] mx-auto mb-2" />
              <p className="text-[13px] text-[#C4CAD4] mb-2">{error}</p>
              {!WORKER_URL && (
                <code className="text-[11px] font-mono text-[#7FBCEE] bg-[#0B0D10] px-2 py-1 rounded block">
                  python scripts/fetch_alertas_dga.py --out public/alertas-rios.json --detalle
                </code>
              )}
              <button
                onClick={refresh}
                className="block mx-auto mt-3 text-[12px] font-mono text-[#9BA3B0] hover:text-[#7FBCEE] underline"
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
      <header className="border-b border-[#1B1F26] sticky top-0 z-30 bg-[#0B0D10]/95 backdrop-blur">
        <div className="max-w-[1180px] mx-auto px-6 py-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="w-9 h-9 rounded-md bg-[#141920] border border-[#232A33] flex items-center justify-center flex-shrink-0">
                <Waves className="w-4.5 h-4.5 text-[#7FBCEE]" strokeWidth={2} />
              </div>
              <div>
                <h1 className="font-display font-bold text-[22px] leading-none tracking-tight text-white">Alertas de Ríos</h1>
                <p className="font-mono text-[12px] font-semibold text-[#9BA3B0] uppercase tracking-widest mt-1.5">DGA · Chile en vivo</p>
              </div>
            </div>

            {/* Logo de la ONG, centrado en el espacio libre del header */}
            <div className="hidden md:flex flex-col items-center justify-center flex-1 gap-1.5">
              <img
                src={`${import.meta.env.BASE_URL}logo-ong.png`}
                alt="REDGEO Chile"
                className="h-16 object-contain"
              />
              <p className="font-mono text-[11px] font-bold text-[#B8C0CC] uppercase tracking-widest text-center">
                Centro Monitoreo Red Geo Chile
              </p>
            </div>

            <div className="flex-1 flex justify-end">
              <button
                onClick={refresh}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2.5 rounded-md border border-[#2A323D] text-[#E4E7EB] hover:text-white hover:border-[#3E8FD4]/60 text-[14px] font-semibold transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </button>
            </div>
          </div>

          {/* Urgency summary strip */}
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <CountChip color="Roja" count={counts.Roja} />
            <CountChip color="Amarilla" count={counts.Amarilla} />
            <CountChip color="Azul" count={counts.Azul} />
            {data && (
              <span className="font-mono text-[12px] font-medium text-[#9BA3B0] ml-auto">
                {data.totalEnAlerta} en alerta de {data.totalEstacionesConsultadas} estaciones
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1180px] mx-auto px-6 py-7">
        {!error && sorted.length === 0 && !loading && (
          <div className="text-center py-24 border border-dashed border-[#1B1F26] rounded-lg">
            <Waves className="w-7 h-7 text-[#6B7280] mx-auto mb-3" />
            <p className="text-[#B8C0CC] text-[15px] font-medium">Ninguna estación de la DGA está en alerta en este momento.</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sorted.map((station, i) => (
            <StationCard
              key={station.codigo}
              station={station}
              index={i}
              onOpen={() => setSelected(station)}
            />
          ))}
        </div>

        {sorted.length > 0 && (
          <section className="mt-8">
            <div className="flex items-center gap-2 mb-3">
              <MapIcon className="w-4 h-4 text-[#9BA3B0]" />
              <h2 className="font-display font-semibold text-sm text-[#C4CAD4]">Mapa de estaciones en alerta</h2>
              <span className="font-mono text-[11px] text-[#88909C] ml-auto">Vista general — abrí una ficha para ver su ubicación exacta</span>
            </div>
            <StationsMap stations={sorted} />
          </section>
        )}

        <footer className="mt-8 pt-5 border-t border-[#1B1F26] flex items-center justify-between flex-wrap gap-2">
          <p className="font-mono text-[12px] font-medium text-[#88909C]">
            Actualizado {new Date(data.generadoEn).toLocaleString("es-CL")}
            {data.duplicadosRemovidos > 0 && ` · ${data.duplicadosRemovidos} duplicados filtrados`}
          </p>
          <a
            href={SNIA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono text-[12px] font-medium text-[#9BA3B0] hover:text-[#7FBCEE] transition-colors"
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

function CountChip({ color, count }) {
  const s = ALERT_STYLES[color];
  if (count === 0) {
    return (
      <span className="font-mono text-[12px] font-medium px-2.5 py-1 rounded-full border border-[#2A323D] text-[#6B7280]">
        {color} 0
      </span>
    );
  }
  return (
    <span className={`flex items-center gap-1.5 font-mono text-[12px] font-bold px-2.5 py-1 rounded-full border ${s.chip}`}>
      {color === "Roja" && <span className="w-1.5 h-1.5 rounded-full bg-[#FF8A7A] dot-pulse" />}
      {color} {count}
    </span>
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
        borderColor: s.pulse ? "rgba(225,75,61,0.7)" : undefined,
      }}
      className={`rise-in group relative text-left rounded-xl border-2 overflow-hidden flex flex-col transition-transform hover:-translate-y-0.5 ${
        s.pulse ? "urgent-pulse" : `${s.borderSoft} ${s.bg} hover:border-opacity-90`
      }`}
    >
      {/* Cabecera de severidad */}
      <div className={`flex items-center justify-between px-4 py-3 border-b ${s.pulse ? "border-[#E14B3D]/50" : s.borderSoft} bg-black/25`}>
        <span className={`flex items-center gap-1.5 font-mono text-[12px] font-bold tracking-widest ${s.text}`}>
          {station.tipoAlerta === "Roja" && <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2.5} />}
          {s.label}
        </span>
        <span className="font-mono text-[12px] font-medium text-[#B8C0CC]">{station.regionNombreAprox}</span>
      </div>

      {/* Cuerpo */}
      <div className="px-4 pt-4 pb-4 flex-1 flex flex-col">
        <h3 className="font-display font-bold text-[17px] text-[#FFFFFF] leading-snug mb-3 min-h-[2.5em] line-clamp-2">
          {station.nombre}
        </h3>

        {/* Medición principal */}
        <div className="rounded-lg bg-[#0B0D10]/70 border border-white/[0.08] px-3.5 py-3 mb-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[#B8C0CC]">{station.parametro}</span>
            {exceso != null && exceso > 0 && (
              <span className={`font-mono text-[11px] font-bold ${s.text}`}>+{exceso}% umbral</span>
            )}
          </div>
          <div className="flex items-end justify-between">
            <p className={`font-mono text-3xl font-bold ${s.text} leading-none`}>
              {station.valorMedicion}<span className="text-[14px] font-medium text-[#9BA3B0] ml-1">{station.unidad}</span>
            </p>
            <p className="font-mono text-[12px] font-medium text-[#9BA3B0]">umbral {station.umbral}{station.unidad}</p>
          </div>
        </div>

        {/* Caudal, si está disponible — bloque propio para que se note tanto como el nivel de agua */}
        {caudal != null && (
          <div className="rounded-lg bg-[#0B0D10]/40 border border-white/[0.06] px-3.5 py-2.5 mb-2.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[#B8C0CC]">Caudal</span>
            <span className="font-mono text-lg font-bold text-[#F2F0EA]">
              {caudal} <span className="text-[12px] text-[#9BA3B0] font-medium">m³/seg</span>
            </span>
          </div>
        )}

        <div className="mt-auto pt-2.5 flex items-center justify-between text-[11px] font-mono font-medium text-[#88909C] border-t border-white/[0.08]">
          <span>{station.fecha}</span>
          <span className="flex items-center gap-1 font-semibold group-hover:text-[#7FBCEE]">Detalle →</span>
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
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-[#232A33] bg-[#12161C] shadow-2xl"
      >
        <div className={`flex items-start justify-between gap-4 px-8 py-6 border-b border-[#1B1F26] ${s.bg}`}>
          <div>
            <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded border ${s.chip} tracking-wide`}>
              {s.label}
            </span>
            <h2 className="font-display font-bold text-xl text-white mt-2 leading-tight">{station.nombre}</h2>
            <p className="text-[14px] font-medium text-[#B8C0CC] mt-1">{station.regionNombreAprox}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-md text-[#9BA3B0] hover:text-[#F2F0EA] hover:bg-[#1B1F26] transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 py-6">
          {/* Medición principal */}
          <div className="rounded-lg bg-[#0B0D10] border border-[#1B1F26] px-5 py-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-[#B8C0CC] uppercase tracking-wide">{station.parametro || "Medición"}</span>
              {station.fecha && <span className="font-mono text-[11px] text-[#88909C]">{station.fecha}</span>}
            </div>
            <div className="flex items-end justify-between">
              <p className={`font-mono text-4xl font-bold ${s.text}`}>
                {station.valorMedicion}<span className="text-base font-normal text-[#9BA3B0] ml-1">{station.unidad}</span>
              </p>
              <div className="text-right">
                <p className="text-[11px] text-[#88909C] uppercase tracking-wide mb-1">Umbral DGA</p>
                <p className="font-mono text-lg text-[#C4CAD4]">
                  {station.umbral}<span className="text-xs font-normal text-[#9BA3B0] ml-1">{station.unidad}</span>
                </p>
              </div>
            </div>
          </div>

          {/* Ubicación exacta de la estación */}
          <div className="mb-4">
            <p className="text-[11px] text-[#88909C] uppercase tracking-wide mb-1.5">Ubicación</p>
            <StationMiniMap station={station} />
          </div>

          {/* Caudal / Precipitación / Nieve / Volumen — solo si el JSON se generó con --detalle */}
          {d && (
            <div className="grid grid-cols-2 gap-2.5 mb-4">
              {d.caudalM3s != null && <Stat label="Caudal" value={d.caudalM3s} unit="m³/seg" />}
              {d.precipitacion24hMm != null && <Stat label="Pptación últimas 24h" value={d.precipitacion24hMm} unit="mm" />}
              {d.precipitacionAcumMm != null && <Stat label="Pptación acumulada" value={d.precipitacionAcumMm} unit="mm" />}
              {d.alturaNieveCm != null && <Stat label="Altura de nieve" value={d.alturaNieveCm} unit="cm" />}
              {d.volumenLagoMillM3 != null && <Stat label="Volumen de lago" value={d.volumenLagoMillM3} unit="Mill.m³" />}
            </div>
          )}
          {!d && (
            <div className="flex items-start gap-2 rounded-lg bg-[#0B0D10] border border-[#1B1F26] px-4 py-3 mb-4">
              <Radio className="w-3.5 h-3.5 text-[#88909C] flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-[#9BA3B0] leading-relaxed">
                Sin datos de Caudal/Precipitación — corré el script con <code className="text-[#7FBCEE] font-mono">--detalle</code> para incluirlos.
              </p>
            </div>
          )}

          {/* Ficha técnica */}
          <div className="space-y-2 mb-5">
            {facts.map(f => (
              <div key={f.label} className="flex items-center justify-between text-[13px] border-b border-[#181D24] pb-2">
                <span className="text-[#B8C0CC]">{f.label}</span>
                <span className="text-[#C4CAD4] font-mono text-right">{f.value}</span>
              </div>
            ))}
          </div>

          <a
            href={SNIA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-2 px-4 py-3 rounded-lg bg-[#0B0D10] border border-[#1B1F26] hover:border-[#3E8FD4]/40 text-sm text-[#B8C0CC] hover:text-[#F2F0EA] transition-colors"
          >
            Ver gráfico histórico en el visor oficial de la DGA
            <ExternalLink className="w-4 h-4 flex-shrink-0 text-[#88909C]" />
          </a>

          <p className="text-[11px] text-[#88909C] font-mono mt-4 pt-4 border-t border-[#1B1F26]">
            Fuente: Dirección General de Aguas (DGA) — Sistema Nacional de Información del Agua (SNIA). Dato de estación física real, no modelo.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, unit }) {
  return (
    <div className="rounded-lg bg-[#0B0D10] border border-[#1B1F26] px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-[#B8C0CC] mb-1">{label}</p>
      <p className="font-mono text-base font-semibold text-[#7FBCEE]">
        {value}<span className="text-[11px] text-[#9BA3B0] font-normal ml-1">{unit}</span>
      </p>
    </div>
  );
}
