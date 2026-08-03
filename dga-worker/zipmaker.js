// Generador de ZIP minimalista, sin dependencias externas — usa solo
// CompressionStream (deflate-raw), disponible tanto en Node 18+ como en
// Cloudflare Workers. Un .docx es un ZIP con esta estructura interna, así
// que este mismo código corre sin cambios en ambos entornos.

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
  const dosDate = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
  return { time, dosDate };
}

function writeUint16LE(arr, offset, value) { arr[offset] = value & 0xFF; arr[offset + 1] = (value >>> 8) & 0xFF; }
function writeUint32LE(arr, offset, value) {
  arr[offset] = value & 0xFF;
  arr[offset + 1] = (value >>> 8) & 0xFF;
  arr[offset + 2] = (value >>> 16) & 0xFF;
  arr[offset + 3] = (value >>> 24) & 0xFF;
}

// Crea un archivo ZIP a partir de una lista de { name, content (string|Uint8Array) }.
// Usa compresión deflate para todos los archivos (STORE no se usa, para
// mantener el código más simple — no importa demasiado el tamaño acá).
export async function makeZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const { time, dosDate } = dosDateTime(now);

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const crc = crc32(contentBytes);
    const compressed = await deflateRaw(contentBytes);

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    writeUint32LE(local, 0, 0x04034b50); // local file header signature
    writeUint16LE(local, 4, 20); // version needed
    writeUint16LE(local, 6, 0); // flags
    writeUint16LE(local, 8, 8); // method = deflate
    writeUint16LE(local, 10, time);
    writeUint16LE(local, 12, dosDate);
    writeUint32LE(local, 14, crc);
    writeUint32LE(local, 18, compressed.length);
    writeUint32LE(local, 22, contentBytes.length);
    writeUint16LE(local, 26, nameBytes.length);
    writeUint16LE(local, 28, 0); // extra field length
    local.set(nameBytes, 30);

    localParts.push(local, compressed);
    const localSize = local.length + compressed.length;

    // Central directory header
    const central = new Uint8Array(46 + nameBytes.length);
    writeUint32LE(central, 0, 0x02014b50); // central dir signature
    writeUint16LE(central, 4, 20); // version made by
    writeUint16LE(central, 6, 20); // version needed
    writeUint16LE(central, 8, 0); // flags
    writeUint16LE(central, 10, 8); // method
    writeUint16LE(central, 12, time);
    writeUint16LE(central, 14, dosDate);
    writeUint32LE(central, 16, crc);
    writeUint32LE(central, 20, compressed.length);
    writeUint32LE(central, 24, contentBytes.length);
    writeUint16LE(central, 28, nameBytes.length);
    writeUint16LE(central, 30, 0); // extra length
    writeUint16LE(central, 32, 0); // comment length
    writeUint16LE(central, 34, 0); // disk number
    writeUint16LE(central, 36, 0); // internal attrs
    writeUint32LE(central, 38, 0); // external attrs
    writeUint32LE(central, 42, offset); // local header offset
    central.set(nameBytes, 46);

    centralParts.push(central);
    offset += localSize;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralParts) centralSize += c.length;

  const end = new Uint8Array(22);
  writeUint32LE(end, 0, 0x06054b50); // end of central dir signature
  writeUint16LE(end, 4, 0); // disk number
  writeUint16LE(end, 6, 0); // disk with central dir
  writeUint16LE(end, 8, files.length); // entries on this disk
  writeUint16LE(end, 10, files.length); // total entries
  writeUint32LE(end, 12, centralSize);
  writeUint32LE(end, 16, centralStart);
  writeUint16LE(end, 20, 0); // comment length

  const allParts = [...localParts, ...centralParts, end];
  const totalSize = allParts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of allParts) { result.set(p, pos); pos += p.length; }
  return result;
}
