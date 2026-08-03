/**
 * sheets.js — Autenticación y acceso a Google Sheets desde un Worker.
 *
 * Cloudflare Workers corre en un entorno V8 aislado que NO soporta las
 * librerías oficiales de Google (`googleapis` depende de módulos de
 * Node.js como `crypto`/`fs` que no existen acá). Por eso esto está escrito
 * a mano usando `crypto.subtle`, la API web estándar que sí está
 * disponible: se arma un JWT firmado con la clave privada del Service
 * Account, se canjea por un token de acceso OAuth2, y con ese token se
 * llama a la API REST de Sheets directamente con fetch().
 *
 * Credenciales: SIEMPRE vía Cloudflare Secrets (env.GOOGLE_CLIENT_EMAIL,
 * env.GOOGLE_PRIVATE_KEY), nunca escritas en este archivo. Se configuran
 * con:
 *   wrangler secret put GOOGLE_CLIENT_EMAIL
 *   wrangler secret put GOOGLE_PRIVATE_KEY
 *   wrangler secret put GOOGLE_SHEET_ID
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Un solo scope combinado alcanza para ambas APIs (Sheets + Drive) con el
// mismo token — no hace falta pedir tokens separados por servicio. El
// scope de Drive es "drive.file", el más acotado posible: solo permite
// crear/editar archivos que la propia Service Account creó (o que se le
// compartieron explícitamente), no un acceso general a todo el Drive del
// usuario — coherente con que la Service Account solo necesita escribir
// en la carpeta puntual que se le compartió para los informes.
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const COMBINED_SCOPE = `${SHEETS_SCOPE} ${DRIVE_SCOPE} ${DOCS_SCOPE}`;

function base64UrlEncode(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// La clave privada viene en el secret como PEM (formato
// "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"), tal
// cual la entrega Google en el JSON de credenciales. crypto.subtle necesita
// el contenido binario puro (DER), así que hay que sacarle el encabezado,
// el pie, y decodificar el base64 del medio.
//
// Nota importante sobre el formato: al pegar el valor a mano en
// `wrangler secret put`, es fácil que los `\n` quedn como el TEXTO LITERAL
// backslash+n (dos caracteres) en vez de convertirse en saltos de línea
// reales — depende de cómo la terminal interprete el pegado. `\s` en una
// regex NO elimina ese texto literal, solo espacios/saltos reales, así que
// si esto no se maneja aparte, esos caracteres de más rompen el base64 con
// un error como "atob() called with invalid base64-encoded data". Por eso
// acá se reemplaza primero el string literal `\n` por un salto real, y
// además se filtra cualquier caracter que no sea válido en base64 como
// red de seguridad final.
async function importPrivateKey(pem) {
  const normalized = pem.replace(/\\n/g, "\n");
  const pemBody = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/[^A-Za-z0-9+/=]/g, ""); // solo deja caracteres válidos de base64
  if (!pemBody) {
    throw new Error("GOOGLE_PRIVATE_KEY quedó vacía después de limpiar el formato — revisá que el secret tenga el valor completo del private_key del JSON.");
  }
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// Cachea el token de acceso en memoria del propio Worker mientras dure la
// ejecución (un token OAuth2 de Google dura 1 hora) — evita pedir un token
// nuevo en cada llamada dentro de la misma invocación, aunque en la
// práctica cada invocación del Worker es de todas formas de vida corta.
let cachedToken = null;
let cachedTokenExpiry = 0;

export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiry - 60) return cachedToken;

  const clientEmail = env.GOOGLE_CLIENT_EMAIL;
  const privateKeyPem = env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKeyPem) {
    throw new Error("Faltan los secrets GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY.");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: clientEmail,
    scope: COMBINED_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const signingInput = `${encodedHeader}.${encodedClaimSet}`;

  const key = await importPrivateKey(privateKeyPem);
  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const encodedSignature = base64UrlEncode(new Uint8Array(signatureBuffer));
  const jwt = `${signingInput}.${encodedSignature}`;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google OAuth2 falló (HTTP ${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in || 3600);
  return cachedToken;
}

// Cabecera de columnas de la hoja "DATOS" — mismo orden que arma
// appendSnapshotRows() más abajo. Se define una sola vez acá para que
// ambas puntas (qué se escribe y qué dice la cabecera) no se desalineen.
const HEADER_ROW = [
  "timestamp", "codigo", "nombre", "tipoAlerta",
  "nivelAlerta", "valorMedicion", "umbral", "regionNombreAprox",
];

// Cabecera de la hoja "LOG" — una fila por mensaje de diagnóstico (ver
// worker.js, logToSheet()). Mismo criterio que HEADER_ROW: una sola fuente
// de verdad para lo que se escribe y lo que dice la cabecera.
const LOG_HEADER_ROW = ["timestamp", "nivel", "mensaje"];

// Cachea en memoria del propio Worker, por nombre de hoja, si ya se
// confirmó que su cabecera está puesta — para no consultar la fila 1 en
// cada corrida una vez que ya se sabe que está bien. DATOS y LOG se
// trackean por separado porque son hojas distintas dentro del mismo
// spreadsheet.
const headerConfirmedBySheet = { DATOS: false, LOG: false };

// Se fija si la fila 1 de `sheetName` ya tiene la cabecera esperada
// (`headerRow`); si está vacía (hoja nueva) o tiene otra cosa, la escribe
// ahí. Usa `update` (PUT) apuntando directo a la fila 1 — así siempre
// queda ahí sin desplazar los datos que ya haya debajo, y nunca se
// duplica con sucesivas corridas.
async function ensureSheetHeader(env, token, sheetId, sheetName, headerRow) {
  if (headerConfirmedBySheet[sheetName]) return;

  const lastCol = String.fromCharCode("A".charCodeAt(0) + headerRow.length - 1);
  const range = `${sheetName}!A1:${lastCol}1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Sheets lectura de cabecera (${sheetName}) falló (HTTP ${resp.status}): ${text}`);
  }
  const data = await resp.json();
  const currentFirstRow = (data.values && data.values[0]) || [];
  const yaTieneCabecera = headerRow.every((h, i) => currentFirstRow[i] === h);

  if (yaTieneCabecera) {
    headerConfirmedBySheet[sheetName] = true;
    return;
  }

  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const putResp = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [headerRow] }),
  });
  if (!putResp.ok) {
    const text = await putResp.text();
    throw new Error(`Google Sheets escritura de cabecera (${sheetName}) falló (HTTP ${putResp.status}): ${text}`);
  }
  headerConfirmedBySheet[sheetName] = true;
}

// ---------------------------------------------------------------------------
// Escritura: agrega filas al final de la hoja "DATOS" (una fila por
// estación por corrida del cron). Usa el endpoint `:append` de la API de
// Sheets, que agrega después de la última fila con datos sin que nosotros
// tengamos que llevar la cuenta de en qué fila vamos.
// ---------------------------------------------------------------------------
export async function appendSnapshotRows(env, stations) {
  const sheetId = env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Falta el secret GOOGLE_SHEET_ID.");

  const token = await getAccessToken(env);

  // Antes de agregar filas, asegura que la fila 1 tenga la cabecera — así
  // el append de abajo siempre cae debajo de un título, nunca mezclado con
  // datos crudos como en la captura que motivó este cambio. Si esto falla
  // (p.ej. problema puntual de permisos), no debe frenar el guardado del
  // snapshot en sí — se deja constancia y se sigue con el append normal.
  try {
    await ensureSheetHeader(env, token, sheetId, "DATOS", HEADER_ROW);
  } catch (e) {
    console.error("[sheets] No se pudo confirmar/escribir la cabecera de DATOS:", e.message || e);
  }

  const timestamp = new Date().toISOString();

  // Una fila por estación: [timestamp, codigo, nombre, tipoAlerta,
  // nivelAlerta, valorMedicion, umbral, regionNombreAprox]
  const values = stations.map(s => [
    timestamp,
    s.codigo,
    s.nombre,
    s.tipoAlerta,
    s.nivelAlerta,
    s.valorMedicion,
    s.umbral,
    s.regionNombreAprox,
  ]);

  const range = "DATOS!A:H";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Sheets append falló (HTTP ${resp.status}): ${text}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Escritura de diagnóstico: agrega mensajes a la hoja "LOG", una fila por
// mensaje — mismo mecanismo que appendSnapshotRows() pero para los
// mensajes que antes solo iban a console.log/console.error (visibles
// únicamente en el stream de Logs de Cloudflare mientras alguien lo tiene
// abierto). Guardarlos en Sheets los deja consultables después, sin tener
// que estar mirando el stream en vivo en el momento exacto en que ocurren.
//
// `entries` es un array de { nivel, mensaje } — se agrupan todos bajo el
// mismo timestamp de la llamada, igual que appendSnapshotRows agrupa todas
// las estaciones de una corrida bajo un solo timestamp.
// ---------------------------------------------------------------------------
export async function appendLogRows(env, entries) {
  if (!entries || entries.length === 0) return null;

  const sheetId = env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Falta el secret GOOGLE_SHEET_ID.");

  const token = await getAccessToken(env);

  try {
    await ensureSheetHeader(env, token, sheetId, "LOG", LOG_HEADER_ROW);
  } catch (e) {
    console.error("[sheets] No se pudo confirmar/escribir la cabecera de LOG:", e.message || e);
  }

  const timestamp = new Date().toISOString();
  const values = entries.map(e => [timestamp, e.nivel || "info", e.mensaje]);

  const range = "LOG!A:C";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Sheets append a LOG falló (HTTP ${resp.status}): ${text}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Lectura: trae las ÚLTIMAS `maxRows` filas de la hoja (no la hoja entera).
// Se usa para encontrar, por cada estación, su snapshot más reciente
// ANTERIOR a la corrida actual, y así calcular la diferencia — para eso
// alcanza con un tramo reciente del histórico, no hace falta traer todas
// las filas acumuladas desde que el cron empezó a correr.
//
// Por qué esto importa: la hoja "DATOS" crece sin límite (el cron agrega
// filas cada 30 min, para siempre). Traer TODA la hoja en cada apertura de
// categoría (lo que hacía la versión anterior de esta función) empezó
// rápido cuando la hoja tenía pocas filas, pero fue empeorando con el
// tiempo a medida que se acumulaban corridas — al punto de volver lenta
// la carga básica de una categoría (que debería ser rápida, ~3s, ya que
// ya no pide Caudal) simplemente por el peso de leer y transferir miles de
// filas de Sheets en cada clic. Limitar a un tramo reciente resuelve esto
// sin perder precisión: `findLatestPreviousByCode` solo necesita la
// corrida más reciente por código, que siempre está en las últimas filas.
//
// Se calcula el rango exacto a pedir (en vez de traer todo y cortar
// después) consultando primero cuántas filas tiene la hoja — así el
// ahorro es real en la petición a Sheets, no solo en el procesamiento
// posterior del lado del Worker.
export async function readAllSnapshotRows(env, maxRows = 500) {
  const sheetId = env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Falta el secret GOOGLE_SHEET_ID.");

  const token = await getAccessToken(env);

  // Paso 1: cuántas filas tiene la hoja ahora mismo. Se pide solo la
  // columna A (la más liviana posible) para este cálculo.
  const countUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent("DATOS!A:A")}`;
  const countResp = await fetch(countUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!countResp.ok) {
    const text = await countResp.text();
    throw new Error(`Google Sheets read (conteo) falló (HTTP ${countResp.status}): ${text}`);
  }
  const countData = await countResp.json();
  const totalRows = (countData.values || []).length;

  // Paso 2: traer solo el tramo final — últimas `maxRows` filas, sin
  // contar la fila 1 (cabecera, si existe). Si la hoja tiene menos filas
  // que maxRows, se trae desde la fila 2 (después de la cabecera) directo.
  const startRow = Math.max(2, totalRows - maxRows + 1);
  const range = `DATOS!A${startRow}:H${totalRows}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Sheets read falló (HTTP ${resp.status}): ${text}`);
  }

  const data = await resp.json();
  let rows = data.values || [];
  // La fila 1 puede ser la cabecera (["timestamp","codigo",...], ver
  // ensureSheetHeader) — si está, se descarta acá para que no se procese
  // como si fuera una lectura real (rompería Number() en las columnas
  // numéricas, ya que "valorMedicion" no es un número válido). Con el
  // rango acotado de arriba esto ya casi nunca debería pasar (startRow
  // parte en 2 como mucho), pero se deja como red de seguridad.
  if (rows.length > 0 && rows[0][0] === HEADER_ROW[0] && rows[0][1] === HEADER_ROW[1]) {
    rows = rows.slice(1);
  }
  // [timestamp, codigo, nombre, tipoAlerta, nivelAlerta, valorMedicion, umbral, region]
  return rows.map(r => ({
    timestamp: r[0],
    codigo: r[1],
    nombre: r[2],
    tipoAlerta: r[3],
    nivelAlerta: r[4] != null ? Number(r[4]) : null,
    valorMedicion: r[5] != null ? Number(r[5]) : null,
    umbral: r[6] != null ? Number(r[6]) : null,
    regionNombreAprox: r[7],
  }));
}

// Para cada código de estación pedido, busca en el histórico la lectura
// MÁS RECIENTE guardada en Sheets — es contra la que se calcula "subió/
// bajó desde la última vez".
//
// Punto importante que es fácil malentender: el valor "ahora" NUNCA sale
// de Sheets — sale de un scrape en vivo a la DGA, hecho en el mismo
// momento en que el usuario abre la categoría (ver fetchDetalleEnLotes()
// en worker.js, que corre ANTES de esta función). Por eso acá hay que usar
// la corrida MÁS reciente de Sheets, no la penúltima: esa fila más
// reciente y el valor recién scrapeado NUNCA son la misma lectura — una
// viene del cron (cada 30 min) y la otra de la visita del usuario (en
// cualquier momento intermedio). Usar la penúltima agregaría un retraso
// extra innecesario: si el cron corrió a las 3:00 y 3:30, y el usuario
// abre a las 3:40, comparar contra la de 3:00 sería un salto de 40
// minutos en vez de los 10 minutos reales desde la corrida de 3:30.
export function findLatestPreviousByCode(allRows, codigos) {
  const byCode = new Map();
  for (const row of allRows) {
    if (!codigos.includes(row.codigo)) continue;
    if (!byCode.has(row.codigo)) byCode.set(row.codigo, []);
    byCode.get(row.codigo).push(row);
  }

  // Ventana de "es la misma corrida actual, no una anterior real": si el
  // cron acaba de guardar un snapshot en los últimos 5 minutos, es
  // prácticamente seguro que sea la misma lectura que se está mostrando
  // ahora mismo (el cron corre cada 30 min) — comparar contra esa fila
  // da 0% de diferencia siempre y hace que la estación parezca "estable"
  // cuando en realidad no hay comparación real todavía. Se descarta esa
  // fila y se busca la anterior a ella.
  const MARGEN_MISMA_CORRIDA_MS = 5 * 60 * 1000;
  const ahora = Date.now();

  const result = new Map();
  for (const [codigo, rows] of byCode.entries()) {
    // Más reciente primero
    rows.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    // Se busca la primera fila que NO esté dentro del margen de "recién
    // guardada ahora" — así se compara contra una corrida genuinamente
    // anterior, no contra el mismo dato que se está mostrando.
    const previa = rows.find(r => ahora - new Date(r.timestamp).getTime() > MARGEN_MISMA_CORRIDA_MS);
    if (previa) {
      result.set(codigo, previa);
    }
  }
  return result;
}

// Histórico completo de UNA estación (todas sus filas dentro del tramo que
// trajo readAllSnapshotRows), ordenado cronológicamente ascendente — listo
// para graficar Nivel de Agua vs. tiempo. Se usa en el diálogo de detalle
// para mostrar la evolución reciente contra el umbral de alerta.
export function historicoPorCodigo(allRows, codigo) {
  return allRows
    .filter(r => r.codigo === codigo)
    .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
}

// Resumen nacional por corrida del cron: cuenta cuántas estaciones había
// en alerta de cada color en cada `timestamp` guardado. Todas las filas de
// una misma corrida comparten el mismo timestamp exacto (se genera una
// sola vez por llamada a appendSnapshotRows), así que agrupar por ese
// campo reconstruye "una fila por corrida" sin tener que guardar el
// conteo agregado aparte — se deriva del mismo histórico que ya existía.
// Devuelve un array ordenado cronológicamente ascendente:
// [{ timestamp, total, Roja, Amarilla, Azul }, ...]
export function resumenPorCorrida(allRows) {
  const porTimestamp = new Map();
  for (const r of allRows) {
    if (!r.timestamp) continue;
    if (!porTimestamp.has(r.timestamp)) {
      porTimestamp.set(r.timestamp, { timestamp: r.timestamp, total: 0, Roja: 0, Amarilla: 0, Azul: 0 });
    }
    const entry = porTimestamp.get(r.timestamp);
    entry.total++;
    if (entry[r.tipoAlerta] != null) entry[r.tipoAlerta]++;
  }
  return [...porTimestamp.values()].sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
}

// Mismo resumen que resumenPorCorrida(), pero separado por región — para
// cada región, su propia serie de corridas con total + desglose por
// color. Se usa para calcular la variación de cada región del panorama
// general ("+3 desde hace 30 min" por región, no solo a nivel nacional).
// Reusa las mismas filas que ya trajo readAllSnapshotRows (regionNombreAprox
// ya viene en cada fila, columna H de la hoja DATOS) — no hace falta una
// lectura extra a Sheets.
export function resumenPorRegionYCorrida(allRows) {
  const porRegion = new Map();
  for (const r of allRows) {
    if (!r.timestamp) continue;
    const region = r.regionNombreAprox || "Región no identificada";
    if (!porRegion.has(region)) porRegion.set(region, new Map());
    const porTimestamp = porRegion.get(region);
    if (!porTimestamp.has(r.timestamp)) {
      porTimestamp.set(r.timestamp, { timestamp: r.timestamp, total: 0, Roja: 0, Amarilla: 0, Azul: 0 });
    }
    const entry = porTimestamp.get(r.timestamp);
    entry.total++;
    if (entry[r.tipoAlerta] != null) entry[r.tipoAlerta]++;
  }

  const resultado = {};
  for (const [region, porTimestamp] of porRegion.entries()) {
    resultado[region] = [...porTimestamp.values()].sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  }
  return resultado;
}
