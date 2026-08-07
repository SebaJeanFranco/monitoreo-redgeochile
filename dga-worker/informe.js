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

// -----------------------------------------------------------------------
// Resumen ejecutivo: indicadores generales de la corrida — totales por
// color, cobertura de Caudal (cuántas estaciones lo tienen vs. cuántas
// no), y cuántas estaciones están subiendo/bajando/estables en cada
// magnitud. Todo calculado sobre el mismo array `stations` que ya recibe
// generarInformeTexto(), sin pedir nada nuevo.
// -----------------------------------------------------------------------
function calcularResumenEjecutivo(stations) {
  const porColor = { Roja: 0, Amarilla: 0, Azul: 0 };
  let conCaudal = 0;
  const alturaDireccion = { subiendo: 0, bajando: 0, estable: 0, sinDato: 0 };
  const caudalDireccion = { subiendo: 0, bajando: 0, estable: 0, sinDato: 0 };

  for (const s of stations) {
    if (porColor[s.tipoAlerta] != null) porColor[s.tipoAlerta]++;
    if (s.detalle?.caudalM3s != null) conCaudal++;

    if (s.tendencia?.direccion) alturaDireccion[s.tendencia.direccion]++;
    else alturaDireccion.sinDato++;

    if (s.tendenciaCaudal?.direccion) caudalDireccion[s.tendenciaCaudal.direccion]++;
    else caudalDireccion.sinDato++;
  }

  const regionesAfectadas = new Set(stations.map(s => s.regionNombreAprox || "Región no identificada")).size;

  return { total: stations.length, porColor, regionesAfectadas, conCaudal, alturaDireccion, caudalDireccion };
}

function lineasResumenEjecutivo(resumen) {
  const { total, porColor, regionesAfectadas, conCaudal, alturaDireccion, caudalDireccion } = resumen;
  const lineas = ["📊 RESUMEN EJECUTIVO", ""];

  lineas.push(
    `Total de estaciones en alerta: ${total} (🔴 ${porColor.Roja} Roja · 🟡 ${porColor.Amarilla} Amarilla · 🔵 ${porColor.Azul} Azul), distribuidas en ${regionesAfectadas} ${regionesAfectadas === 1 ? "región" : "regiones"}.`
  );

  const sinCobertura = total - conCaudal;
  lineas.push(
    `Caudal disponible: ${conCaudal} de ${total} estaciones${sinCobertura > 0 ? ` (${sinCobertura} sin dato de la DGA esta corrida)` : ""}.`
  );

  lineas.push(
    `Altura de agua — tendencia: ↑ ${alturaDireccion.subiendo} subiendo · ↓ ${alturaDireccion.bajando} bajando · → ${alturaDireccion.estable} estable${alturaDireccion.sinDato > 0 ? ` · ${alturaDireccion.sinDato} sin histórico previo` : ""}.`
  );

  lineas.push(
    `Caudal — tendencia: ↑ ${caudalDireccion.subiendo} subiendo · ↓ ${caudalDireccion.bajando} bajando · → ${caudalDireccion.estable} estable${caudalDireccion.sinDato > 0 ? ` · ${caudalDireccion.sinDato} sin histórico previo` : ""}.`
  );

  lineas.push("");
  return lineas;
}

// -----------------------------------------------------------------------
// Ranking de mayores variaciones, agrupado por región (no un top nacional
// único, a pedido) — separa Altura y Caudal, cada uno con hasta 5
// estaciones ordenadas por magnitud de variación (valor absoluto del %),
// sin importar si suben o bajan. Se omiten estaciones sin variación
// calculable (primera corrida, sin histórico previo) y regiones que no
// tengan ninguna estación con variación — no tiene sentido mostrar una
// sección vacía.
// -----------------------------------------------------------------------
const TOP_VARIACIONES_POR_REGION = 5;

function calcularTopVariacionesPorRegion(stations) {
  const porRegion = new Map();
  for (const s of stations) {
    const key = s.regionNombreAprox || "Región no identificada";
    if (!porRegion.has(key)) porRegion.set(key, []);
    porRegion.get(key).push(s);
  }

  const resultado = [];
  for (const [region, estaciones] of porRegion.entries()) {
    const conVariacionAltura = estaciones
      .filter(s => s.tendencia?.porcentaje != null && s.tendencia.direccion !== "estable")
      .sort((a, b) => Math.abs(b.tendencia.porcentaje) - Math.abs(a.tendencia.porcentaje))
      .slice(0, TOP_VARIACIONES_POR_REGION);

    const conVariacionCaudal = estaciones
      .filter(s => s.tendenciaCaudal?.porcentaje != null && s.tendenciaCaudal.direccion !== "estable")
      .sort((a, b) => Math.abs(b.tendenciaCaudal.porcentaje) - Math.abs(a.tendenciaCaudal.porcentaje))
      .slice(0, TOP_VARIACIONES_POR_REGION);

    if (conVariacionAltura.length === 0 && conVariacionCaudal.length === 0) continue;
    resultado.push({ region, conVariacionAltura, conVariacionCaudal });
  }
  return resultado;
}

function lineasTopVariaciones(topPorRegion) {
  if (topPorRegion.length === 0) return [];

  const lineas = ["📈 MAYORES VARIACIONES POR REGIÓN (desde la corrida anterior)", ""];

  // Muestra la hora exacta del registro anterior contra el que se
  // comparó (no cuántos minutos pasaron desde entonces hasta AHORA, sino
  // la hora de reloj de esa lectura) — así el ranking queda anclado a un
  // momento concreto, útil para cruzar contra otras fuentes o el propio
  // histórico en Sheets.
  function horaDelRegistro(timestampAnterior) {
    if (!timestampAnterior) return "";
    const hora = new Date(timestampAnterior).toLocaleString("es-CL", {
      timeZone: "America/Santiago",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    return ` (vs. ${hora} h)`;
  }

  for (const { region, conVariacionAltura, conVariacionCaudal } of topPorRegion) {
    lineas.push(`📍 ${region}`);

    if (conVariacionAltura.length > 0) {
      lineas.push("  Altura:");
      for (const s of conVariacionAltura) {
        const flecha = s.tendencia.direccion === "subiendo" ? "↑" : "↓";
        lineas.push(`    ${flecha} ${Math.abs(s.tendencia.porcentaje)}% — ${tituloLegible(s.nombre)}${horaDelRegistro(s.tendencia.timestampAnterior)}`);
      }
    }
    if (conVariacionCaudal.length > 0) {
      lineas.push("  Caudal:");
      for (const s of conVariacionCaudal) {
        const flecha = s.tendenciaCaudal.direccion === "subiendo" ? "↑" : "↓";
        lineas.push(`    ${flecha} ${Math.abs(s.tendenciaCaudal.porcentaje)}% — ${tituloLegible(s.nombre)}${horaDelRegistro(s.tendenciaCaudal.timestampAnterior)}`);
      }
    }
    lineas.push("");
  }

  return lineas;
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

  // Resumen ejecutivo + ranking de variaciones — arriba de la lista
  // detallada, que queda exactamente igual que antes debajo de esto.
  lineas.push(...lineasResumenEjecutivo(calcularResumenEjecutivo(stations)));
  lineas.push(...lineasTopVariaciones(calcularTopVariacionesPorRegion(stations)));
  lineas.push("📋 DETALLE POR ESTACIÓN", "");

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

      // Variación de altura (Nivel de Agua) — etiquetada explícitamente
      // como "Altura" para no confundirla con la de Caudal que sigue justo
      // después. Ambas comparan contra la lectura anterior de esa misma
      // magnitud (Altura contra "DATOS", Caudal contra "DATOS INFORME" —
      // ver worker.js), así que pueden mostrar direcciones distintas entre
      // sí sin que sea un error (ej. el nivel del río puede estar bajando
      // mientras el caudal todavía sube, según el tramo y el momento).
      let variacionAlturaTexto = "";
      if (s.tendencia && s.tendencia.direccion !== "estable" && s.tendencia.porcentaje != null) {
        const flecha = s.tendencia.direccion === "subiendo" ? "↑" : "↓";
        const minutos = s.tendencia.timestampAnterior
          ? Math.max(1, Math.round((Date.now() - new Date(s.tendencia.timestampAnterior).getTime()) / 60000))
          : null;
        variacionAlturaTexto = ` Altura: ${flecha} ${Math.abs(s.tendencia.porcentaje)}% ${s.tendencia.direccion}${minutos != null ? ` (últimos ${minutos} min)` : ""}.`;
      }

      // Caudal: valor absoluto + variación fusionados en UNA sola frase
      // "Caudal: X m³/seg (↑Y% subiendo, últimos N min)." — evita repetir
      // la palabra "Caudal" dos veces seguidas (una para el valor, otra
      // para la variación), que quedaba confuso de leer. Solo aparece la
      // parte de variación si hay una corrida anterior con Caudal válido
      // para comparar (ver calcularTendenciaCaudal en worker.js) — las
      // primeras corridas de cada estación no la van a tener todavía, no
      // es un error.
      let caudalTexto = "";
      if (caudal != null) {
        let variacionInline = "";
        if (s.tendenciaCaudal && s.tendenciaCaudal.direccion !== "estable" && s.tendenciaCaudal.porcentaje != null) {
          const flecha = s.tendenciaCaudal.direccion === "subiendo" ? "↑" : "↓";
          const minutos = s.tendenciaCaudal.timestampAnterior
            ? Math.max(1, Math.round((Date.now() - new Date(s.tendenciaCaudal.timestampAnterior).getTime()) / 60000))
            : null;
          variacionInline = ` (${flecha} ${Math.abs(s.tendenciaCaudal.porcentaje)}% ${s.tendenciaCaudal.direccion}${minutos != null ? `, últimos ${minutos} min` : ""})`;
        }
        caudalTexto = ` Caudal: ${caudal} m³/seg${variacionInline}.`;
      }

      const nombreLegible = tituloLegible(s.nombre);
      lineas.push(
        `${emoji} ${nombreLegible}: Superó el umbral ${colorUmbral} con un nivel de aguas de ${s.valorMedicion} ${s.unidad || "m"}, lo que equivale a ${excesoTexto} sobre el umbral.${variacionAlturaTexto}${caudalTexto}`
      );
    }
    lineas.push("");
  }

  lineas.push("Fuente: Dirección General de Aguas (DGA) — Sistema Nacional de Información del Agua (SNIA).");

  return lineas.join("\n");
}
