/**
 * docs.js — Escribe el informe en un Google Doc fijo, reemplazando su
 * contenido completo cada vez (no crea archivos nuevos — por eso esto SÍ
 * funciona con una Service Account sin cuota propia: estamos EDITANDO un
 * documento que ya existe y pertenece a una cuenta con cuota real, mismo
 * principio por el que ya funciona el guardado en Sheets).
 *
 * Requiere el secret:
 *   wrangler secret put GOOGLE_DOC_ID
 * (el ID del documento, sacado de su URL:
 *  https://docs.google.com/document/d/ESTE_ES_EL_ID/edit)
 *
 * El documento debe estar compartido con el email de la Service Account
 * (GOOGLE_CLIENT_EMAIL) con permiso de Editor.
 */

import { getAccessToken } from "./sheets.js";

const DOCS_BASE_URL = "https://docs.googleapis.com/v1/documents";

// Colores en formato RGB 0-1 (el que espera la Docs API), mismos valores
// hex que ya se usaban para el intento anterior con .docx — se mantienen
// para que el Doc quede visualmente coherente con el resto del dashboard
// (mismo color-coding que las tarjetas: rojo/amarillo/azul por severidad).
function hexToRgb01(hex) {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return { red: r, green: g, blue: b };
}

const COLOR_ROJA = hexToRgb01("E8492E");
const COLOR_AMARILLA = hexToRgb01("C98A1B");
const COLOR_AZUL = hexToRgb01("2E6E8E");
const COLOR_REGION = hexToRgb01("0F4C3A");
const COLOR_FUENTE = hexToRgb01("6B7280");

function colorParaLinea(texto) {
  if (texto.startsWith("🔴")) return COLOR_ROJA;
  if (texto.startsWith("🟡")) return COLOR_AMARILLA;
  if (texto.startsWith("🔵")) return COLOR_AZUL;
  if (texto.startsWith("📍")) return COLOR_REGION;
  if (texto.startsWith("Fuente:")) return COLOR_FUENTE;
  return null;
}

// Trae el documento completo para saber su longitud actual — necesario
// para poder borrar TODO el contenido anterior antes de escribir el
// nuevo. La Docs API no tiene un "reemplazar todo" directo; hay que armar
// el rango de borrado a mano.
async function obtenerLongitudDocumento(token, documentId) {
  const resp = await fetch(`${DOCS_BASE_URL}/${documentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Docs lectura falló (HTTP ${resp.status}): ${text}`);
  }
  const data = await resp.json();
  // El endIndex del último elemento del body es la longitud total del
  // documento — incluye el párrafo final "vacío" que Google Docs siempre
  // deja (no se puede borrar el último carácter de un documento, la API
  // lo rechaza), por eso se resta 1 más abajo al armar el rango a borrar.
  const content = data.body?.content || [];
  const last = content[content.length - 1];
  return last ? last.endIndex : 1;
}

// Reemplaza el contenido completo del documento con `lineas` (mismo array
// que produce generarInformeTexto().split("\n")), coloreando cada línea
// según su emoji inicial.
export async function escribirInformeEnDoc(env, lineas) {
  const documentId = env.GOOGLE_DOC_ID;
  if (!documentId) throw new Error("Falta el secret GOOGLE_DOC_ID.");

  const token = await getAccessToken(env);

  const longitudActual = await obtenerLongitudDocumento(token, documentId);

  const requests = [];

  // Paso 1: borrar todo el contenido existente, si hay más de un
  // carácter (documento no vacío). El rango va de 1 (después del inicio
  // implícito del body) hasta longitudActual - 1, porque el último
  // carácter del documento nunca se puede borrar vía la API.
  if (longitudActual > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: longitudActual - 1 },
      },
    });
  }

  // Paso 2: insertar todo el texto nuevo de una — más simple y más
  // rápido que insertar línea por línea. Se arma como un solo bloque con
  // saltos de línea reales, en el índice 1 (justo después del inicio).
  const textoCompleto = lineas.join("\n") + "\n";
  requests.push({
    insertText: {
      location: { index: 1 },
      text: textoCompleto,
    },
  });

  // Paso 3: colorear cada línea según su tipo — se calculan los rangos
  // ANTES de mandar la petición, recorriendo `lineas` y acumulando el
  // offset de caracteres (igual que se acumularon al construir
  // textoCompleto), porque una vez que el texto ya está en el documento
  // los índices son fijos y conocidos de antemano.
  let offset = 1;
  for (const linea of lineas) {
    const color = colorParaLinea(linea);
    const longitudLinea = linea.length;
    if (color && longitudLinea > 0) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: offset, endIndex: offset + longitudLinea },
          textStyle: { foregroundColor: { color: { rgbColor: color } } },
          fields: "foregroundColor",
        },
      });
    }
    offset += longitudLinea + 1; // +1 por el "\n" que separa cada línea
  }

  const resp = await fetch(`${DOCS_BASE_URL}/${documentId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Docs batchUpdate falló (HTTP ${resp.status}): ${text}`);
  }

  return resp.json();
}
