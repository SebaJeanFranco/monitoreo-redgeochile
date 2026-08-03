/**
 * drive.js — Subida de archivos a Google Drive desde el Worker.
 *
 * Reusa la misma Service Account y el mismo mecanismo de autenticación que
 * ya usa sheets.js (JWT firmado a mano con crypto.subtle, sin librerías de
 * Node) — ver getAccessToken() en sheets.js, que ahora pide un scope
 * combinado de Sheets + Drive.
 *
 * Requiere el secret adicional:
 *   wrangler secret put GOOGLE_DRIVE_FOLDER_ID
 * (el ID de la carpeta de Drive, sacado de su URL:
 *  https://drive.google.com/drive/u/0/folders/ESTE_ES_EL_ID)
 *
 * La carpeta debe estar compartida con el email de la Service Account
 * (GOOGLE_CLIENT_EMAIL) con permiso de Editor — si no, la subida falla con
 * un error 403/404 de "File not found" (Drive oculta la carpeta si no
 * tiene acceso, en vez de decir explícitamente "sin permiso").
 */

import { getAccessToken } from "./sheets.js";

const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

// Sube un archivo a la carpeta de Drive configurada, usando el protocolo
// "multipart" de la API de Drive: un único POST con dos partes (metadata
// JSON + contenido binario), separadas por un boundary — evita tener que
// hacer dos peticiones (crear + subir contenido) como pediría el protocolo
// "resumable".
export async function subirArchivoADrive(env, { nombre, bytes, mimeType }) {
  const folderId = env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("Falta el secret GOOGLE_DRIVE_FOLDER_ID.");

  const token = await getAccessToken(env);

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
