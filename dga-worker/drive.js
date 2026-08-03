/**
 * drive.js — Subida de archivos a Google Drive desde el Worker.
 *
 * Reusa la misma Service Account y el mismo mecanismo de autenticación que
 * ya usa sheets.js (JWT firmado a mano con crypto.subtle, sin librerías de
 * Node) — ver getAccessToken() en sheets.js, que ahora pide un scope
 * combinado de Sheets + Drive.
 *
 * IMPORTANTE — por qué la carpeta la crea la propia Service Account:
 * las Service Accounts de Google NO tienen cuota de almacenamiento propia
 * en Drive (confirmado con el error real: "Service Accounts do not have
 * storage quota"). Esto significa que NO pueden crear archivos nuevos
 * dentro de una carpeta que pertenece a una cuenta de Gmail personal, aun
 * con permiso de Editor — solo pueden editar/leer archivos que ya
 * existen. La solución sin Google Workspace (que sí tendría "Unidades
 * compartidas", inexistentes en cuentas Gmail normales) es que la carpeta
 * sea PROPIA de la Service Account: ahí sí tiene cuota, porque es su
 * propio Drive. Para que el dueño real (persona) pueda verla, la Service
 * Account la comparte automáticamente con su email la primera vez.
 *
 * Requiere estos secrets:
 *   wrangler secret put GOOGLE_DRIVE_SHARE_WITH_EMAIL
 *     (tu email personal — a quien se comparte la carpeta la primera vez)
 *
 * GOOGLE_DRIVE_FOLDER_ID ya NO hace falta — la carpeta se busca/crea sola
 * la primera corrida y su ID se cachea en memoria del Worker después.
 */

import { getAccessToken } from "./sheets.js";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const NOMBRE_CARPETA = "Informes DGA — Alertas de Ríos";

// Cachea el ID de la carpeta en memoria del propio Worker mientras dure la
// ejecución — mismo criterio que cachedToken en sheets.js. Evita repetir
// la búsqueda/creación en cada corrida del cron una vez que ya se sabe
// cuál es.
let cachedFolderId = null;

// Busca una carpeta con nombre NOMBRE_CARPETA que ya pertenezca a la
// Service Account (no una compartida — "not in Trash and 'me' owns it").
// Si no existe, la crea y la comparte con GOOGLE_DRIVE_SHARE_WITH_EMAIL.
async function obtenerOCrearCarpeta(env, token) {
  if (cachedFolderId) return cachedFolderId;

  const query = `name = '${NOMBRE_CARPETA.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and 'me' in owners and trashed = false`;
  const searchUrl = `${DRIVE_FILES_URL}?q=${encodeURIComponent(query)}&fields=files(id,name)`;
  const searchResp = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!searchResp.ok) {
    const text = await searchResp.text();
    throw new Error(`Google Drive búsqueda de carpeta falló (HTTP ${searchResp.status}): ${text}`);
  }
  const searchData = await searchResp.json();
  if (searchData.files && searchData.files.length > 0) {
    cachedFolderId = searchData.files[0].id;
    return cachedFolderId;
  }

  // No existe todavía — se crea. Al crearla la Service Account queda como
  // dueña automáticamente (es su propio Drive), así que acá sí hay cuota
  // disponible.
  const createResp = await fetch(DRIVE_FILES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: NOMBRE_CARPETA,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!createResp.ok) {
    const text = await createResp.text();
    throw new Error(`Google Drive creación de carpeta falló (HTTP ${createResp.status}): ${text}`);
  }
  const created = await createResp.json();
  cachedFolderId = created.id;

  // Comparte la carpeta recién creada con el email de la persona — así
  // aparece en su Drive (pestaña "Compartido conmigo", o puede agregarla
  // a "Mi unidad" con un clic). Si esto falla, no se revierte la creación
  // de la carpeta: el archivo igual se sube ahí, y el error de compartir
  // queda registrado para resolverlo aparte (compartir a mano una vez
  // desde el propio Drive de la Service Account no es posible sin acceso
  // a esa cuenta, pero si el share automático falla se puede reintentar
  // en la próxima corrida ya que cachedFolderId igual se guardó).
  const shareEmail = env.GOOGLE_DRIVE_SHARE_WITH_EMAIL;
  if (shareEmail) {
    try {
      const shareResp = await fetch(`${DRIVE_FILES_URL}/${cachedFolderId}/permissions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "user",
          role: "writer", // "writer" = Editor en la terminología de la API
          emailAddress: shareEmail,
        }),
      });
      if (!shareResp.ok) {
        const text = await shareResp.text();
        console.error(`[drive] No se pudo compartir la carpeta con ${shareEmail} (HTTP ${shareResp.status}): ${text}`);
      } else {
        console.log(`[drive] Carpeta "${NOMBRE_CARPETA}" creada y compartida con ${shareEmail}.`);
      }
    } catch (e) {
      console.error("[drive] Error compartiendo la carpeta:", e.message || e);
    }
  } else {
    console.error("[drive] Falta el secret GOOGLE_DRIVE_SHARE_WITH_EMAIL — la carpeta se creó pero no se compartió con nadie. Buscala manualmente desde una cuenta con acceso al proyecto de Google Cloud, o configurá el secret y esperá a la próxima corrida (la carpeta ya existe, así que no se vuelve a crear, pero el share si falta se puede reintentar a mano vía la API).");
  }

  return cachedFolderId;
}

// Sube un archivo a la carpeta de informes (buscándola o creándola si
// hace falta), usando el protocolo "multipart" de la API de Drive: un
// único POST con dos partes (metadata JSON + contenido binario),
// separadas por un boundary — evita tener que hacer dos peticiones (crear
// + subir contenido) como pediría el protocolo "resumable".
export async function subirArchivoADrive(env, { nombre, bytes, mimeType }) {
  const token = await getAccessToken(env);
  const folderId = await obtenerOCrearCarpeta(env, token);

  const metadata = {
    name: nombre,
    parents: [folderId],
    mimeType,
  };

  // Boundary arbitrario — solo tiene que ser un string que no aparezca
  // dentro del contenido binario del archivo. Se usa uno suficientemente
  // largo y específico para que la probabilidad de colisión sea nula.
  const boundary = "----dga-worker-informe-boundary-7f3a9c";
  const encoder = new TextEncoder();

  const preamble = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const closing = encoder.encode(`\r\n--${boundary}--`);

  // Concatena preámbulo + bytes del archivo + cierre en un solo body
  // binario — la API de Drive espera el multipart completo como un único
  // stream, no como FormData (que generaría un boundary distinto al que
  // controlamos acá).
  const body = new Uint8Array(preamble.length + bytes.length + closing.length);
  body.set(preamble, 0);
  body.set(bytes, preamble.length);
  body.set(closing, preamble.length + bytes.length);

  const resp = await fetch(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Drive upload falló (HTTP ${resp.status}): ${text}`);
  }

  return resp.json(); // { id, name, ... }
}
