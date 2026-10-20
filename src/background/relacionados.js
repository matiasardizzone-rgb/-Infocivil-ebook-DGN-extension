// relacionados.js — Variante DGN: guardado por tandas desde "Lista de
// Expedientes Relacionados" del SCW (sesión iniciada por el propio usuario).
//
// Flujo por causa, siempre SECUENCIAL y en UNA pestaña aparte en segundo
// plano. El SCW usa conversaciones de Seam (conversationPropagation=join):
// el cid de cada expediente es efímero y abrir varias causas en paralelo
// puede pisar la conversación. Por eso no se guarda el cid para volver más
// tarde: cada vez se reabre la causa desde la lista, por su número.
//
//   lista (página k) → ojo de la fila → expediente.seam?cid=…
//     → históricas (si el año < 2019) y actuaciones (consulta.js)
//     → guardarEnBiblioteca (scw-content.js, el mismo de siempre)
//     → vuelta a la lista → siguiente causa
//
// El progreso se publica en chrome.storage.local ('dgnLote') para el panel
// del content script (relacionados-content.js).

import * as db from '../lib/db.js';
import { pedir, esperarEstado, leerHistoricasYActuaciones } from './consulta.js';

const SCW = 'https://scw.pjn.gov.ar';
const RUTAS_PERMITIDAS = ['/scw/consultaListaRelacionados.seam', '/scw/consultaListaFavoritos.seam'];
const TOPE_LOTE = 25;

const esperar = ms => new Promise(r => setTimeout(r, ms));

let loteActivo = null;

// "8/04/2026" → "2026-04-08" (null si no se entiende)
function fechaISO(texto) {
  const m = String(texto || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
}

// Estado de cada fila de la lista contra la biblioteca local, sin abrir
// ninguna causa: alcanza con comparar "Últ. Act." del SCW con lo guardado.
async function estadosBiblioteca(filas) {
  const guardados = await db.listarExpedientes();
  const porClave = new Map();
  for (const e of guardados) {
    const k = db.normalizarClaveExpediente(e.numero);
    if (!k) continue;
    const previo = porClave.get(k);
    if (!previo || (e.fechaDescarga || '') > (previo.fechaDescarga || '')) porClave.set(k, e);
  }
  const estados = {};
  for (const f of filas || []) {
    const reg = porClave.get(f.clave);
    let estado = 'no-guardado';
    if (reg) {
      const actSCW = fechaISO(f.ultimaActualizacion);
      if (reg.estado === 'descargando' || reg.estado === 'nuevo') estado = 'novedades';
      else if (reg.ultimaActualizacionSCW) estado = fechaISO(reg.ultimaActualizacionSCW) === actSCW ? 'al-dia' : 'novedades';
      else estado = actSCW && actSCW > String(reg.fechaDescarga || '').slice(0, 10) ? 'novedades' : 'al-dia';
    }
    estados[f.clave] = { estado, cid: reg ? reg.cid : null };
  }
  return estados;
}

function publicar(lote) {
  const { detener, tabId, ...visible } = lote;
  return chrome.storage.local.set({ dgnLote: { ...visible, actualizado: new Date().toISOString() } });
}

async function asegurarPestanaViva(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('Se cerró la pestaña de trabajo del SCW.');
  if (/sso\.pjn\.gov\.ar|portalpjn\.pjn\.gov\.ar/.test(tab.url || tab.pendingUrl || '')) {
    throw new Error('La sesión del SCW venció: volvé a iniciar sesión y reintentá.');
  }
  return tab;
}

async function esperarLista(tabId, timeoutMs = 45000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const tab = await asegurarPestanaViva(tabId);
    if (tab.status === 'complete') {
      const e = await pedir(tabId, { action: 'relacionadosEstadoPagina' });
      if (e && e.esLista && e.filas > 0) return e;
    }
    await esperar(400);
  }
  throw new Error('La lista de relacionados no terminó de cargar.');
}

async function esperarGuardado(tabId, timeoutMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await asegurarPestanaViva(tabId);
    const { descargaProgreso: p } = await chrome.storage.local.get('descargaProgreso');
    if (p && p.terminado) return p;
    await esperar(1000);
  }
  throw new Error('El guardado tardó demasiado.');
}

async function guardarCausa(lote, item, urlLista) {
  const tabId = lote.tabId;
  const etapa = texto => { lote.etapa = texto; publicar(lote); };

  etapa('abriendo la lista');
  await chrome.tabs.update(tabId, { url: urlLista });
  await esperarLista(tabId);

  etapa('abriendo la causa');
  const r = await pedir(tabId, { action: 'relacionadosAbrir', clave: item.clave, pagina: item.pagina });
  if (r && !r.ok) throw new Error(r.error);
  const exp = await esperarEstado(tabId, e => e.esExpediente && !!e.cid, 45000, 'abriendo ' + item.expediente);
  if (exp.vencido) { await asegurarPestanaViva(tabId); throw new Error('El expediente no terminó de abrir.'); }

  // ¿Abrió la causa pedida? (si la lista cambió de orden entre la lectura y
  // el clic, el ojo podría corresponder a otra fila)
  const actual = await pedir(tabId, { action: 'relacionadosClaveActual' });
  if (actual && actual.clave && actual.clave !== item.clave) {
    throw new Error('Se abrió otra causa (' + actual.clave.replace(/\|/g, ' ') + '); no se guardó.');
  }

  const anio = (item.clave.split('|')[2]) || '';
  const { act } = await leerHistoricasYActuaciones(tabId, exp.cid, etapa, anio);
  const archivos = act.archivos || [];
  if (!archivos.length) throw new Error('No se encontraron actuaciones.');

  etapa('descargando ' + archivos.length + ' actuación(es)');
  await chrome.storage.local.remove('descargaProgreso');
  pedir(tabId, { action: 'guardarEnBiblioteca', archivos, folderName: act.folderName, startIndex: 1 });
  const fin = await esperarGuardado(tabId, 5 * 60000 + archivos.length * 30000);
  if (fin.error) throw new Error(fin.error);

  // Datos de la lista que el expediente no trae y sirven para detectar
  // novedades sin abrir la causa.
  // La carátula de la lista solo se usa si la del expediente no se pudo leer.
  const previo = await db.obtenerExpediente(exp.cid);
  await db.actualizarEstadoExpediente(exp.cid, {
    origen: 'relacionados',
    dependencia: item.dependencia || '',
    situacion: item.situacion || '',
    ultimaActualizacionSCW: item.ultimaActualizacion || '',
    ...(previo && !previo.caratula && item.caratula ? { caratula: item.caratula } : {}),
  });

  return { descargados: fin.descargados, errores: fin.errores };
}

async function correrLote(items, ruta, pestanaOrigen) {
  const urlLista = SCW + ruta;
  const lote = loteActivo = {
    total: items.length, hechos: 0, errores: [], actual: null, etapa: '',
    terminado: false, detenido: false, inicio: new Date().toISOString(),
    detener: false, tabId: null,
  };
  await publicar(lote);
  let tab = null;
  try {
    tab = await chrome.tabs.create({
      url: urlLista, active: false,
      ...(pestanaOrigen ? { windowId: pestanaOrigen.windowId, index: pestanaOrigen.index + 1 } : {}),
    });
    lote.tabId = tab.id;
    for (const item of items) {
      if (lote.detener) { lote.detenido = true; break; }
      lote.actual = item.expediente;
      try {
        const r = await guardarCausa(lote, item, urlLista);
        lote.hechos++;
        if (r.errores) lote.errores.push({ expediente: item.expediente, error: r.errores + ' actuación(es) sin descargar' });
      } catch (e) {
        console.warn('[Infocivil DGN] No se pudo guardar ' + item.expediente + ':', e);
        lote.errores.push({ expediente: item.expediente, error: e.message || String(e) });
        if (/sesión del SCW venció|Se cerró la pestaña/.test(e.message || '')) break;
      }
      await publicar(lote);
    }
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    lote.terminado = true;
    lote.actual = null;
    lote.etapa = '';
    await publicar(lote);
    loteActivo = null;
  }
}

export function iniciarRelacionados() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.action === 'relacionadosEstado') {
      estadosBiblioteca(msg.filas)
        .then(estados => sendResponse({ ok: true, estados }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (msg.action === 'relacionadosGuardarLote') {
      if (loteActivo) { sendResponse({ ok: false, error: 'Ya hay una tanda en curso.' }); return false; }
      const ruta = RUTAS_PERMITIDAS.includes(msg.ruta) ? msg.ruta : RUTAS_PERMITIDAS[0];
      const items = (msg.items || []).filter(i => i && i.clave).slice(0, TOPE_LOTE);
      if (!items.length) { sendResponse({ ok: false, error: 'No hay causas seleccionadas.' }); return false; }
      correrLote(items, ruta, sender && sender.tab).catch(err => console.error('[Infocivil DGN] Lote:', err));
      sendResponse({ ok: true, total: items.length });
      return false;
    }

    if (msg.action === 'relacionadosDetenerLote') {
      if (loteActivo) loteActivo.detener = true;
      sendResponse({ ok: true });
      return false;
    }
  });
}
