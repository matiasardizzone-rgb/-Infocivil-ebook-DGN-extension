// respaldo.js — Exportar / importar "Mis expedientes" a un archivo .infocivil.
//
// Todo lo de la biblioteca vive en IndexedDB de ESTE perfil de Chrome: si
// se cambia de PC, se reinstala Chrome o se borran los datos del
// navegador, se pierde. El respaldo es un ZIP (STORED, mismo armador que
// el resto de la extensión) con:
//   respaldo.json            metadatos de expedientes, documentos y banderitas
//   docs/<n>.pdf             (solo en el respaldo completo) el PDF de cada actuación
//
// Dos modalidades:
//   - liviana: sin PDFs (pesa KB). Al importar, el expediente aparece "sin
//     documentos" y se vuelve a descargar del SCW con un clic (búsqueda por
//     número: el cid viejo no sirve, identifica una consulta, no el expediente).
//   - completa: con los PDFs. Restaura todo sin tocar el SCW.
//
// Al importar se FUSIONA con lo que ya hay (no se duplica nada):
//   - el expediente se reconoce por cid o por número normalizado;
//   - un documento que ya está (mismo enlace público) no se vuelve a cargar;
//   - una banderita en una foja que ya tiene banderita no se pisa.

import * as db from './db.js';
import { crearZip } from './zip.js';

const FORMATO = 'infocivil-respaldo';
const VERSION_FORMATO = 1;

// ─── Exportar ─────────────────────────────────────────────────────────────
// Tamaño de los PDFs guardados (para avisar cuánto pesaría el completo).
export async function tamanioPdfs() {
  let total = 0, documentos = 0;
  for (const e of await db.listarExpedientes()) {
    for (const d of await db.obtenerDocumentos(e.cid)) {
      if (d.blob) { total += d.blob.size; documentos++; }
    }
  }
  return { bytes: total, documentos };
}

// onProgreso(hechos, total, texto)
export async function exportarRespaldo({ conPdfs, onProgreso } = {}) {
  const expedientes = await db.listarExpedientes();
  const archivos = [];
  const salida = [];
  let nArchivo = 0;

  for (let i = 0; i < expedientes.length; i++) {
    const e = expedientes[i];
    if (onProgreso) onProgreso(i, expedientes.length, e.numero || e.cid);
    const docs = await db.obtenerDocumentos(e.cid);
    const documentos = [];
    for (const d of docs) {
      let archivo = null;
      if (conPdfs && d.blob) {
        archivo = 'docs/' + String(++nArchivo).padStart(6, '0') + (d.extension || '.pdf');
        archivos.push({ name: archivo, data: new Uint8Array(await d.blob.arrayBuffer()) });
      }
      documentos.push({
        indice: d.indice, titulo: d.titulo, fecha: d.fecha, tipo: d.tipo, descripcion: d.descripcion,
        esHistorica: !!d.esHistorica, extension: d.extension || '.pdf', urlHiper: d.urlHiper || '',
        eliminadaEnSCW: !!d.eliminadaEnSCW, archivo,
      });
    }
    const marcadores = (await db.obtenerMarcadores(e.cid)).map(m => m.actuacionId
      ? { actuacionId: m.actuacionId, pagina: m.pagina, label: m.label, color: m.color }
      : { page: m.page, label: m.label, color: m.color });
    const { cid, numero, caratula, folderName, cantidadActuaciones, cantidadFojas, hash,
      fechaDescarga, fechaVerificacion, estado, nuevasDetectadas, vinculados } = e;
    salida.push({ cid, numero, caratula, folderName, cantidadActuaciones, cantidadFojas, hash,
      fechaDescarga, fechaVerificacion, estado, nuevasDetectadas, vinculados: vinculados || [],
      documentos, marcadores });
  }

  const json = {
    formato: FORMATO, version: VERSION_FORMATO,
    creado: new Date().toISOString(),
    versionExtension: chrome.runtime.getManifest().version,
    conPdfs: !!conPdfs,
    expedientes: salida,
  };
  archivos.unshift({ name: 'respaldo.json', data: new TextEncoder().encode(JSON.stringify(json, null, 1)) });
  if (onProgreso) onProgreso(expedientes.length, expedientes.length, 'Armando el archivo…');
  return {
    blob: crearZip(archivos, 'application/zip'),
    expedientes: salida.length,
    documentos: salida.reduce((s, e) => s + e.documentos.length, 0),
    marcadores: salida.reduce((s, e) => s + e.marcadores.length, 0),
  };
}

// ─── Lectura del ZIP ──────────────────────────────────────────────────────
// Lee el directorio central (no depende de los encabezados locales). Solo
// STORED: es lo que genera la extensión. Si alguien lo descomprime y lo
// vuelve a comprimir con Windows, queda con "deflate" y se avisa.
export function leerZip(buffer) {
  const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no es un respaldo de Infocivil Ebook.');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('El respaldo está dañado (directorio del ZIP inválido).');
    const metodo = dv.getUint16(p + 10, true);
    const tam = dv.getUint32(p + 20, true);
    const ln = dv.getUint16(p + 28, true), le = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nombre = dec.decode(u8.subarray(p + 46, p + 46 + ln));
    if (metodo !== 0) throw new Error('El respaldo fue recomprimido con otro programa ("' + nombre + '"). Usá el archivo .infocivil original, tal como lo generó la extensión.');
    const ini = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.set(nombre, u8.subarray(ini, ini + tam));
    p += 46 + ln + le + lc;
  }
  return out;
}

// ─── Importar ─────────────────────────────────────────────────────────────
// archivo: File/Blob. onProgreso(hechos, total, texto)
export async function importarRespaldo(archivo, { onProgreso } = {}) {
  const entradas = leerZip(await archivo.arrayBuffer());
  const crudo = entradas.get('respaldo.json');
  if (!crudo) throw new Error('El archivo no es un respaldo de Infocivil Ebook (falta respaldo.json).');
  let json;
  try { json = JSON.parse(new TextDecoder().decode(crudo)); }
  catch (e) { throw new Error('El respaldo está dañado (respaldo.json ilegible).'); }
  if (json.formato !== FORMATO) throw new Error('El archivo no es un respaldo de Infocivil Ebook.');
  if (json.version > VERSION_FORMATO) throw new Error('El respaldo es de una versión más nueva de la extensión. Actualizá Infocivil Ebook e intentá de nuevo.');

  const r = { expedientes: 0, nuevos: 0, fusionados: 0, documentos: 0, marcadores: 0, sinDocumentos: 0 };
  const lista = json.expedientes || [];

  for (let i = 0; i < lista.length; i++) {
    const e = lista[i];
    if (onProgreso) onProgreso(i, lista.length, e.numero || e.cid);

    // ¿Ya está? Primero por cid, después por número (el cid cambia en cada
    // sesión del SCW, el número no).
    let local = await db.obtenerExpediente(e.cid);
    if (!local) local = await db.buscarExpedientePorNumero(db.normalizarClaveExpediente(e.numero));
    const cid = local ? local.cid : e.cid;

    if (!local) {
      await db.guardarExpediente({
        cid, numero: e.numero, caratula: e.caratula, folderName: e.folderName,
        cantidadActuaciones: e.cantidadActuaciones, cantidadFojas: e.cantidadFojas, hash: e.hash,
        fechaDescarga: e.fechaDescarga, fechaVerificacion: e.fechaVerificacion,
        estado: e.estado === 'descargando' ? 'ok' : (e.estado || 'ok'),
        nuevasDetectadas: e.nuevasDetectadas || 0, vinculados: e.vinculados || [],
      });
      r.nuevos++;
    } else {
      r.fusionados++;
      if ((!local.vinculados || !local.vinculados.length) && e.vinculados && e.vinculados.length) {
        await db.actualizarEstadoExpediente(cid, { vinculados: e.vinculados });
      }
    }

    // Documentos: solo los que traen PDF y todavía no están.
    const existentes = await db.obtenerDocumentos(cid);
    const ids = new Set(existentes.map(db.idDeDocumento));
    let proximoIndice = existentes.reduce((m, d) => Math.max(m, d.indice || 0), 0) + 1;
    for (const d of e.documentos || []) {
      if (!d.archivo) continue;
      const bytes = entradas.get(d.archivo);
      if (!bytes) continue;
      const doc = {
        cid, indice: existentes.length ? proximoIndice++ : d.indice,
        titulo: d.titulo, fecha: d.fecha, tipo: d.tipo, descripcion: d.descripcion,
        esHistorica: !!d.esHistorica, extension: d.extension || '.pdf', urlHiper: d.urlHiper || '',
        blob: new Blob([bytes], { type: (d.extension || '.pdf') === '.pdf' ? 'application/pdf' : 'application/octet-stream' }),
      };
      if (ids.has(db.idDeDocumento(doc))) continue;
      await db.guardarDocumento(doc);
      ids.add(db.idDeDocumento(doc));
      r.documentos++;
    }
    if (!(await db.contarDocumentos(cid))) r.sinDocumentos++;

    // Banderitas: no se pisa una que ya esté en la misma foja.
    const actuales = await db.obtenerMarcadores(cid);
    for (const m of e.marcadores || []) {
      const yaEsta = actuales.some(a => m.actuacionId
        ? (a.actuacionId === m.actuacionId && a.pagina === m.pagina)
        : (!a.actuacionId && a.page === m.page));
      if (yaEsta) continue;
      await db.guardarMarcador({ cid, ...m });
      r.marcadores++;
    }
    r.expedientes++;
  }
  if (onProgreso) onProgreso(lista.length, lista.length, 'Listo');
  return r;
}
