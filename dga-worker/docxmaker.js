import { makeZip } from "./zipmaker.js";

// Escapa caracteres especiales de XML — imprescindible porque los nombres
// de estaciones/regiones pueden traer &, <, >, comillas, etc.
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Un "run" de texto de Word (<w:r>) — opcionalmente en negrita y/o con
// color de fuente (hex sin #, ej. "E8492E").
function run(text, { bold, color, size } = {}) {
  const props = [];
  if (bold) props.push("<w:b/>");
  if (color) props.push(`<w:color w:val="${color}"/>`);
  if (size) props.push(`<w:sz w:val="${size}"/>`); // tamaño en half-points (24 = 12pt)
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  // xml:space="preserve" para no perder espacios al inicio/fin del run.
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

// Un párrafo (<w:p>) hecho de uno o más runs ya armados.
function paragraph(runsXml, { spacingAfter } = {}) {
  const pPr = spacingAfter != null ? `<w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr>` : "";
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

// Construye el documento completo a partir de `lineas`: array de objetos
// { texto, tipo } donde tipo es "titulo" | "region" | "estacion" | "fuente" | "vacio".
// El color se decide acá según el emoji al inicio del texto de estación
// (🔴/🟡/🔵), reusando la misma convención que ya usa generarInformeTexto()
// en el frontend — así el .docx tiene el mismo color-coding que el texto
// plano y las tarjetas del dashboard.
const COLOR_ROJA = "E8492E";
const COLOR_AMARILLA = "C98A1B";
const COLOR_AZUL = "2E6E8E";
const COLOR_TITULO = "1A2C26";
const COLOR_REGION = "0F4C3A";

function colorParaLinea(texto) {
  if (texto.startsWith("🔴")) return COLOR_ROJA;
  if (texto.startsWith("🟡")) return COLOR_AMARILLA;
  if (texto.startsWith("🔵")) return COLOR_AZUL;
  return null;
}

export function construirDocumentoXml(lineasInforme) {
  const parrafos = [];

  for (const linea of lineasInforme) {
    const texto = linea;
    if (texto === "") {
      parrafos.push(paragraph("", { spacingAfter: 60 }));
      continue;
    }
    if (texto.startsWith("⚠️")) {
      // Título/encabezado del informe
      parrafos.push(paragraph(run(texto, { bold: true, size: 24 }), { spacingAfter: 200 }));
      continue;
    }
    if (texto.startsWith("📍")) {
      // Nombre de región
      parrafos.push(paragraph(run(texto, { bold: true, color: COLOR_REGION, size: 26 }), { spacingAfter: 120 }));
      continue;
    }
    if (texto.startsWith("Fuente:")) {
      parrafos.push(paragraph(run(texto, { size: 18 })));
      continue;
    }
    // Línea de estación — coloreada según su emoji inicial
    const color = colorParaLinea(texto);
    parrafos.push(paragraph(run(texto, { color }), { spacingAfter: 100 }));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${parrafos.join("\n    ")}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

// Genera los bytes completos de un .docx a partir de las líneas del
// informe (mismo array que produce generarInformeTexto().split("\n") en
// el frontend). Devuelve un Uint8Array listo para subir a Drive.
export async function generarDocx(lineasInforme) {
  const documentXml = construirDocumentoXml(lineasInforme);
  const files = [
    { name: "[Content_Types].xml", content: CONTENT_TYPES_XML },
    { name: "_rels/.rels", content: RELS_XML },
    { name: "word/document.xml", content: documentXml },
    { name: "word/_rels/document.xml.rels", content: DOCUMENT_RELS_XML },
  ];
  return makeZip(files);
}
