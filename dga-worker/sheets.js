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
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

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

async function getAccessToken(env) {
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
    scope: SHEETS_SCOPE,
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

// Cachea en memoria del propio Worker si ya se confirmó que la cabecera
// está puesta, para no consultar A1 en cada corrida del cron una vez que
// ya se sabe que está bien.
let headerConfirmed = false;

// Se fija si A1:H1 ya tiene la cabecera puesta; si está vacía (hoja nueva)
// o tiene otra cosa, escribe HEADER_ROW ahí. Usa `update` (PUT) apuntando
// directo a la fila 1 — así siempre queda ahí sin desplazar los datos que
// ya haya debajo, y nunca se duplica con sucesivas corridas del cron.
async function ensureHeaderRow(env, token, sheetId) {
  if (headerConfirmed) return;

  const range = "DATOS!A1:H1";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Sheets lectura de cabecera falló (HTTP ${resp.status}): ${text}`);
  }
  const data = await resp.json();
  const currentFirstRow = (data.values && data.values[0]) || [];
  const yaTieneCabecera = HEADER_ROW.every((h, i) => currentFirstRow[i] === h);

  if (yaTieneCabecera) {
    headerConfirmed = true;
    return;
  }

  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const putResp = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [HEADER_ROW] }),
  });
  if (!putResp.ok) {
    const text = await putResp.text();
    throw new Error(`Google Sheets escritura de cabecera falló (HTTP ${putResp.status}): ${text}`);
  }
  headerConfirmed = true;
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
    await ensureHeaderRow(env, token, sheetId);
  } catch (e) {
    console.error("[sheets] No se pudo confirmar/escribir la cabecera:", e.message || e);
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
// Lectura: trae TODAS las filas de la hoja (simple pero funcional para el
// volumen esperado — ver nota de límites en worker.js). Se usa para
// encontrar, por cada estación, su snapshot más reciente ANTERIOR a la
// corrida actual, y así calcular la diferencia.
// ---------------------------------------------------------------------------
export async function readAllSnapshotRows(env) {
  const sheetId = env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Falta el secret GOOGLE_SHEET_ID.");

  const token = await getAccessToken(env);
  const range = "DATOS!A:H";
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
  // ensureHeaderRow) — si está, se descarta acá para que no se procese
  // como si fuera una lectura real (rompería Number() en las columnas
  // numéricas, ya que "valorMedicion" no es un número válido).
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

  const result = new Map();
  for (const [codigo, rows] of byCode.entries()) {
    // Más reciente primero
    rows.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    // rows[0] es la corrida más reciente del cron — el punto de
    // comparación correcto. Si no hay ninguna fila todavía para esta
    // estación (el cron nunca corrió, o esta estación nunca estuvo en
    // alerta antes), no hay nada con qué comparar — se deja sin entrada
    // en el Map, y calcularTendencia() ya maneja ese caso devolviendo
    // null.
    if (rows.length >= 1) {
      result.set(codigo, rows[0]);
    }
  }
  return result;
}
