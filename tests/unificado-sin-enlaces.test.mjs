// PDF unificado (variante DGN): índice con saltos internos, ningún enlace al SCW.
// Uso: node tests/unificado-sin-enlaces.test.mjs <ruta absoluta a src/lib/unificador.js>
// En Node el UMD de pdf-lib se carga como CommonJS: se cuelga a mano de globalThis.
import { createRequire } from 'module';
import path from 'path';
const require = createRequire(import.meta.url);
globalThis.PDFLib = require(path.resolve(path.dirname(process.argv[2]), '../../vendor/pdf-lib.min.js'));
const { generarPdfUnificado } = await import(process.argv[2]);
const { PDFDocument, PDFName } = globalThis.PDFLib;

async function pdfDe(paginas) {
  const d = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) d.addPage([595, 842]);
  return d.save();
}
const url = 'https://scw.pjn.gov.ar/scw/viewer.seam?id=PRUEBA';
const actuaciones = [
  { numero: 1, titulo: 'ESCRITO DE PRUEBA', fecha: '03/11/2021', urlPublica: url + '1', bytes: await pdfDe(2) },
  { numero: 2, titulo: 'DESPACHO DE PRUEBA', fecha: '10/11/2021', urlPublica: url + '2', bytes: await pdfDe(1) },
  { numero: 3, titulo: 'NO DESCARGADA', fecha: '25/11/2021', urlPublica: url + '3', bytes: null, error: 'HTTP 500' },
];
const bytes = await generarPdfUnificado({ tituloExpediente: 'CIV 000001/2021 PRUEBA', actuaciones });
const pdf = await PDFDocument.load(bytes);
let internos = 0, uri = 0;
for (const p of pdf.getPages()) {
  const annots = p.node.Annots();
  if (!annots) continue;
  for (let i = 0; i < annots.size(); i++) {
    const a = pdf.context.lookup(annots.get(i));
    if (a.get(PDFName.of('Dest'))) internos++;
    if (a.get(PDFName.of('A'))) uri++;
  }
}
// Texto de todas las páginas: los content streams vienen comprimidos (Flate)
// y pdf-lib escribe el texto como <hex>; se descomprime y se busca en hex.
const zlib = await import('zlib');
let crudo = '';
for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
  if (!obj || typeof obj.getContents !== 'function') continue;
  let datos = Buffer.from(obj.getContents());
  try { datos = zlib.inflateSync(datos); } catch (e) { /* sin comprimir */ }
  crudo += datos.toString('latin1').toUpperCase();
}
const texto = { includes: t => crudo.includes(Buffer.from(t, 'latin1').toString('hex').toUpperCase()) || crudo.includes(t.toUpperCase()) };
const ok = internos === 3 && uri === 0 && !texto.includes('viewer.seam');
console.log((ok ? 'OK   ' : 'FALLA') + ` páginas=${pdf.getPageCount()} enlaces internos del índice=${internos} enlaces al SCW=${uri} URL en el texto=${texto.includes('viewer.seam')}`);
process.exit(ok ? 0 : 1);
