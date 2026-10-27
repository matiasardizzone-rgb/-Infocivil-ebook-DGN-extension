// seleccion.js — Módulo «PDF de actuaciones seleccionadas».
//
// Muestra las actuaciones de un expediente con casillas y filtros, y arma
// un PDF solo con las elegidas: portada con la nota «Selección de N de M
// actuaciones» e índice hipervinculado interno — sin enlaces al SCW, regla
// de la DGN (mismo generador que el PDF unificado con índice, unificador.js).
// Cada actuación conserva su número en el expediente completo (orden
// cronológico), para que coincida con lo que se cita y con el libro.
//
// Se abre de dos formas:
//   seleccion.html?cid=<cid>[&banderitas=1]  → expediente de Mis expedientes
//     (usa los PDF guardados; no toca el SCW). banderitas=1 llega desde el
//     lector y deja tildadas las actuaciones con banderitas.
//   seleccion.html?origen=consulta           → resultado de una consulta en
//     vivo: inicio.js deja la lista en chrome.storage.local ('seleccionDatos')
//     y acá se bajan del SCW solo las actuaciones elegidas.
//
// Lo propio de cada extensión (de dónde sale cada PDF y qué enlace va al
// pie) está concentrado en ORIGEN, abajo: es lo único que cambia al portar
// este módulo a Infocivil Ebook Lex100 o DGN.

import * as db from '../lib/db.js';
import { ordenarPorFechaAsc, generarPdfUnificado } from '../lib/unificador.js';

// ─── Lo propio de esta extensión ────────────────────────────────────────
const ORIGEN = {
  // URL para bajar el PDF de una actuación de una consulta en vivo (SCW).
  urlDescarga(act) {
    let url = act.urlPdf || act.url || '';
    if (url && url.indexOf('http') !== 0) url = 'https://scw.pjn.gov.ar' + url;
    if (url.indexOf('/scw/viewer') !== -1 && url.indexOf('download=true') === -1)
      url += (url.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
    return url;
  },
  // DGN: sin enlaces al SCW (en causas restringidas no le sirven a quien
  // recibe el PDF). El índice conserva los saltos internos.
  enlacePie() {
    return '';
  },
  sufijoArchivo: '_SELECCION.pdf',
};

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

let exp = null;            // { cid, numero, titulo, historicasFaltantes, paginacionIncompleta }
let actuaciones = [];      // [{ numero, id, fecha, tipo, descripcion, titulo, esHistorica, extension, urlPublica, urlPdf, blob, conBanderita }]
const marcadas = new Set(); // índices en 'actuaciones'
const tiposActivos = new Set();
let ultimoClic = null;     // para Shift + clic
let ocupado = false;

document.querySelectorAll('[data-version-ext]').forEach(el => { el.textContent = 'v' + chrome.runtime.getManifest().version; });

function estado(texto, tipo) {
  const el = $('estado');
  el.textContent = texto || '';
  el.className = 'estado' + (tipo ? ' estado--' + tipo : '');
}
function aviso(texto) {
  const d = document.createElement('div');
  d.className = 'aviso';
  d.textContent = texto;
  $('avisos').appendChild(d);
}

// ─── Carga ──────────────────────────────────────────────────────────────
async function cargarGuardado(cid) {
  const e = await db.obtenerExpediente(cid);
  if (!e) throw new Error('No se encontró el expediente en Mis expedientes.');
  const docs = await db.obtenerDocumentos(cid);
  exp = { cid, numero: e.numero, titulo: e.caratula || e.folderName || e.numero };
  return docs.map(d => ({
    id: db.idDeDocumento(d),
    titulo: d.titulo, fecha: d.fecha, tipo: d.tipo, descripcion: d.descripcion,
    esHistorica: d.esHistorica, extension: d.extension,
    urlPublica: d.urlHiper || '', blob: d.blob || null,
  }));
}

async function cargarConsulta() {
  const r = await chrome.storage.local.get('seleccionDatos');
  const datos = r && r.seleccionDatos;
  if (!datos) throw new Error('No llegaron los datos de la consulta. Cerrá esta pestaña y volvé a abrir el módulo desde el expediente.');
  exp = {
    cid: datos.cid, numero: datos.numero, titulo: datos.titulo,
    historicasFaltantes: !!datos.historicasFaltantes, paginacionIncompleta: !!datos.paginacionIncompleta,
  };
  const lista = (datos.actuaciones || []).map(a => ({ ...a, id: db.idActuacion(a.urlPublica || a.urlPdf || a.url || ''), blob: null }));
  // Si el expediente también está en Mis expedientes, se usan esos PDF y
  // no se vuelven a bajar.
  if (exp.cid) {
    try {
      const guardados = new Map((await db.obtenerDocumentos(exp.cid)).map(d => [db.idDeDocumento(d), d.blob]));
      lista.forEach(a => { if (a.id && guardados.get(a.id)) a.blob = guardados.get(a.id); });
    } catch (e) { /* sin Mis expedientes: se baja todo del SCW */ }
  }
  return lista;
}

async function idsConBanderita(cid) {
  if (!cid) return new Set();
  try {
    const marcadores = await db.obtenerMarcadores(cid);
    return new Set(marcadores.map(m => m.actuacionId).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

async function iniciar() {
  try {
    const cid = params.get('cid');
    const lista = cid ? await cargarGuardado(cid) : await cargarConsulta();
    const conFlag = await idsConBanderita(exp.cid);
    // Número = posición en el expediente completo, en orden cronológico
    // (el mismo que usan el PDF unificado y el libro).
    actuaciones = ordenarPorFechaAsc(lista).map((a, i) => ({ ...a, numero: i + 1, conBanderita: !!(a.id && conFlag.has(a.id)) }));
  } catch (e) {
    $('expCaratula').textContent = e.message;
    return;
  }

  $('expId').textContent = exp.numero || '';
  $('expCaratula').textContent = exp.titulo || exp.numero || '';
  document.title = 'Selección — ' + (exp.numero || exp.titulo || 'Expediente');
  if (exp.historicasFaltantes) aviso('No se pudieron leer las actuaciones históricas: pueden faltar las más viejas, y la numeración arrancaría más adelante.');
  if (exp.paginacionIncompleta) aviso('El recorrido de páginas se cortó antes de tiempo: pueden faltar actuaciones y la numeración puede no coincidir con el expediente completo.');

  const nFlag = actuaciones.filter(a => a.conBanderita).length;
  if (!nFlag) { $('fBanderitas').disabled = true; $('fBanderitas').parentElement.title = 'Este expediente no tiene banderitas'; }
  if (params.get('banderitas') === '1' && nFlag) {
    actuaciones.forEach((a, i) => { if (a.conBanderita) marcadas.add(i); });
  }

  armarTipos();
  armarFilas();
  aplicarFiltros();
}

// ─── Filtros ────────────────────────────────────────────────────────────
function armarTipos() {
  const cuenta = new Map();
  actuaciones.forEach(a => { const t = (a.tipo || '').trim() || 'Sin tipo'; cuenta.set(t, (cuenta.get(t) || 0) + 1); });
  const tipos = [...cuenta.entries()].sort((x, y) => y[1] - x[1]);
  const cont = $('fTipos');
  cont.innerHTML = '';
  if (actuaciones.some(a => a.esHistorica)) tipos.push(['__hist', actuaciones.filter(a => a.esHistorica).length]);
  for (const [t, n] of tipos) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sel-chip';
    b.setAttribute('aria-pressed', 'false');
    b.textContent = (t === '__hist' ? 'Históricas' : t) + ' (' + n + ')';
    b.addEventListener('click', () => {
      if (tiposActivos.has(t)) tiposActivos.delete(t); else tiposActivos.add(t);
      b.setAttribute('aria-pressed', tiposActivos.has(t) ? 'true' : 'false');
      aplicarFiltros();
    });
    cont.appendChild(b);
  }
}

function fechaISO(fecha) {
  const m = String(fecha || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : '';
}

function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function visible(a) {
  const q = normalizar($('fTexto').value.trim());
  if (q && normalizar((a.tipo || '') + ' ' + (a.descripcion || '') + ' ' + (a.titulo || '')).indexOf(q) === -1) return false;
  const f = fechaISO(a.fecha);
  if ($('fDesde').value && f && f < $('fDesde').value) return false;
  if ($('fHasta').value && f && f > $('fHasta').value) return false;
  if ($('fBanderitas').checked && !a.conBanderita) return false;
  if (tiposActivos.size) {
    const t = (a.tipo || '').trim() || 'Sin tipo';
    if (!tiposActivos.has(t) && !(tiposActivos.has('__hist') && a.esHistorica)) return false;
  }
  return true;
}

function aplicarFiltros() {
  const filas = $('filas').rows;
  for (let i = 0; i < actuaciones.length; i++) filas[i].classList.toggle('oculta', !visible(actuaciones[i]));
  actualizarCuenta();
}

['fTexto', 'fDesde', 'fHasta'].forEach(id => $(id).addEventListener('input', aplicarFiltros));
$('fBanderitas').addEventListener('change', aplicarFiltros);

// ─── Filas y selección ──────────────────────────────────────────────────
function celda(tr, clase, texto) {
  const td = document.createElement('td');
  if (clase) td.className = clase;
  if (texto != null) td.textContent = texto;
  tr.appendChild(td);
  return td;
}

function armarFilas() {
  const tbody = $('filas');
  tbody.innerHTML = '';
  actuaciones.forEach((a, i) => {
    const tr = document.createElement('tr');
    const tdC = celda(tr, 'check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = marcadas.has(i);
    cb.setAttribute('aria-label', 'Incluir la actuación ' + a.numero);
    tdC.appendChild(cb);
    celda(tr, 'num', String(a.numero));
    celda(tr, 'fecha', a.fecha || '');
    celda(tr, 'tipo', a.tipo || '');
    const tdD = celda(tr, 'desc', a.descripcion || (a.tipo ? '' : a.titulo || ''));
    if (a.esHistorica) { const s = document.createElement('span'); s.className = 'sel-marca sel-marca--hist'; s.textContent = 'histórica'; tdD.appendChild(s); }
    if (a.conBanderita) { const s = document.createElement('span'); s.className = 'sel-marca sel-marca--flag'; s.textContent = 'banderita'; tdD.appendChild(s); }
    tr.classList.toggle('marcada', marcadas.has(i));
    tr.addEventListener('click', ev => {
      const nuevo = ev.target === cb ? cb.checked : !marcadas.has(i);
      if (ev.shiftKey && ultimoClic != null) {
        const [d, h] = ultimoClic < i ? [ultimoClic, i] : [i, ultimoClic];
        for (let k = d; k <= h; k++) if (visible(actuaciones[k])) fijar(k, nuevo);
      } else {
        fijar(i, nuevo);
      }
      ultimoClic = i;
      actualizarCuenta();
    });
    tbody.appendChild(tr);
  });
}

function fijar(i, si) {
  if (si) marcadas.add(i); else marcadas.delete(i);
  const tr = $('filas').rows[i];
  tr.classList.toggle('marcada', si);
  tr.querySelector('input').checked = si;
}

function sobreVisibles(fn) {
  actuaciones.forEach((a, i) => { if (visible(a)) fn(i); });
  actualizarCuenta();
}
$('btnTodas').addEventListener('click', () => sobreVisibles(i => fijar(i, true)));
$('btnNinguna').addEventListener('click', () => sobreVisibles(i => fijar(i, false)));
$('btnInvertir').addEventListener('click', () => sobreVisibles(i => fijar(i, !marcadas.has(i))));

function actualizarCuenta() {
  const visibles = actuaciones.filter(visible).length;
  $('cuenta').textContent = marcadas.size + ' de ' + actuaciones.length + ' seleccionadas' +
    (visibles !== actuaciones.length ? ' · ' + visibles + ' visibles con estos filtros' : '');
  $('btnGenerar').disabled = ocupado || !marcadas.size;
  $('btnGenerar').textContent = 'Generar PDF con índice' + (marcadas.size ? ' (' + marcadas.size + ')' : '');
}

// ─── PDF ────────────────────────────────────────────────────────────────
function esPdf(b) {
  return b && b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2D;
}

async function bytesDe(a) {
  if (a.blob) return new Uint8Array(await a.blob.arrayBuffer());
  const url = ORIGEN.urlDescarga(a);
  if (!url) throw new Error('no está guardada en Mis expedientes');
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

function nombreArchivo(t) {
  return String(t || 'expediente').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 50);
}

$('btnGenerar').addEventListener('click', async () => {
  if (ocupado || !marcadas.size) return;
  ocupado = true;
  actualizarCuenta();
  try {
    const elegidas = [...marcadas].sort((x, y) => x - y).map(i => actuaciones[i]);
    const lista = [];
    let errores = 0;
    for (let k = 0; k < elegidas.length; k++) {
      const a = elegidas[k];
      estado('Leyendo actuaciones ' + (k + 1) + ' / ' + elegidas.length + (errores ? ' · con error: ' + errores : ''), 'cargando');
      try {
        const bytes = await bytesDe(a);
        if (!esPdf(bytes)) throw new Error('la respuesta no es un PDF válido (posible sesión vencida)');
        lista.push({ ...a, urlPublica: ORIGEN.enlacePie(a), bytes, error: null });
      } catch (e) {
        errores++;
        lista.push({ ...a, urlPublica: ORIGEN.enlacePie(a), bytes: null, error: e.message });
      }
    }
    estado('Armando el PDF…', 'cargando');
    const bytes = await generarPdfUnificado({
      tituloExpediente: [exp.numero, exp.titulo].filter(Boolean).join(' — '),
      actuaciones: lista,
      historicasFaltantes: false, paginacionIncompleta: false,
      conservarNumeros: true,
      nota: 'Selección de ' + lista.length + ' de ' + actuaciones.length + ' actuaciones',
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    chrome.downloads.download({ url, filename: nombreArchivo(exp.numero || exp.titulo) + ORIGEN.sufijoArchivo, saveAs: true },
      () => setTimeout(() => URL.revokeObjectURL(url), 60000));
    estado('✓ PDF listo (' + (lista.length - errores) + '/' + lista.length + ' actuaciones' +
      (errores ? ', ' + errores + ' con página de error' : '') + '). Se abrió el diálogo para guardarlo.', 'ok');
  } catch (e) {
    estado('No se pudo generar el PDF: ' + (e.message || e), 'error');
  } finally {
    ocupado = false;
    actualizarCuenta();
  }
});

iniciar();
