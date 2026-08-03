/**
 * informe.js — Generación del texto del informe de alertas.
 *
 * Esta es una réplica fiel de generarInformeTexto() y sus funciones
 * auxiliares (tituloLegible, sortByUrgency, groupByRegion) que ya existen
 * en centro-mando-app/src/CentroMando.jsx, para el botón "Generar informe"
 * manual. Se porta acá para que el CRON (scheduled() en worker.js) pueda
 * generar el mismo informe sin depender del navegador — ambos deben
 * producir el mismo formato de texto.
 *
 * IMPORTANTE: si se edita el formato del informe en un lado (frontend o
 * acá), hay que replicar el cambio en el otro para que no queden
 * desincronizados. No se comparte código entre ambos directamente porque
 * viven en paquetes/entornos distintos (React vs Worker puro).
 */

const URGENCY_ORDER = { Roja: 0, Amarilla: 1, Azul: 2 };

function sortByUrgency(stations) {
  return [...stations].sort((a, b) => {
    const ua = URGENCY_ORDER[a.tipoAlerta] ?? 9;
    const ub = URGENCY_ORDER[b.tipoAlerta] ?? 9;
    if (ua !== ub) return ua - ub;
    return (b.fecha || "").localeCompare(a.fecha || "");
  });
}

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

const EMOJI_ALERTA = { Roja: "🔴", Amarilla: "🟡", Azul: "🔵" };
const UMBRAL_MASCULINO = { Roja: "rojo", Amarilla: "amarillo", Azul: "azul" };
const PALABRAS_MINUSCULA = new Set(["en", "de", "del", "la", "las", "el", "los", "y", "a", "ex"]);
const SIGLAS_LITERALES = new Set(["pcf"]);

function tituloLegible(nombre) {
  if (!nombre) return nombre;
  return nombre
    .toLowerCase()
    .split(" ")
    .map((palabra, i) => {
      if (!palabra) return palabra;
      if (SIGLAS_LITERALES.has(palabra)) return palabra.toUpperCase();
      if (i > 0 && PALABRAS_MINUSCULA.has(palabra)) return palabra;
      return palabra.charAt(0).toUpperCase() + palabra.slice(1);
    })
    .join(" ");
}

// `stations` debe venir ya filtrada a Roja/Amarilla (Azul se excluye antes
// de llegar acá, igual que en el frontend). Cada estación puede traer
// `detalle.caudalM3s` (si se consultó) y `tendencia` (si se pudo comparar
// contra Sheets) — ambos opcionales, el texto se arma igual sin ellos.
export function generarInformeTexto(stations, generadoEn) {
  const porRegion = new Map();
  for (const s of stations) {
    const key = s.regionNombreAprox || "Región no identificada";
    if (!porRegion.has(key)) porRegion.set(key, []);
    porRegion.get(key).push(s);
  }

  const ordenRegiones = groupByRegion(stations).map(r => r.region);

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
      const caudal = s.detalle?.caudalM3s;
      const caudalTexto = caudal != null ? ` Caudal: ${caudal} m³/seg.` : "";
      let variacionTexto = "";
      if (s.tendencia && s.tendencia.direccion !== "estable" && s.tendencia.porcentaje != null) {
        const flecha = s.tendencia.direccion === "subiendo" ? "↑" : "↓";
        const minutos = s.tendencia.timestampAnterior
          ? Math.max(1, Math.round((Date.now() - new Date(s.tendencia.timestampAnterior).getTime()) / 60000))
          : null;
        variacionTexto = ` ${flecha} ${Math.abs(s.tendencia.porcentaje)}% ${s.tendencia.direccion}${minutos != null ? ` (últimos ${minutos} min)` : ""}.`;
      }
      const nombreLegible = tituloLegible(s.nombre);
      lineas.push(
        `${emoji} ${nombreLegible}: Superó el umbral ${colorUmbral} con un nivel de aguas de ${s.valorMedicion} ${s.unidad || "m"}, lo que equivale a ${excesoTexto} sobre el umbral.${caudalTexto}${variacionTexto}`
      );
    }
    lineas.push("");
  }

  lineas.push("Fuente: Dirección General de Aguas (DGA) — Sistema Nacional de Información del Agua (SNIA).");

  return lineas.join("\n");
}
