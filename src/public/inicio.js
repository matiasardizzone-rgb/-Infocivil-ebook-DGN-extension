// inicio.js — Pantalla de inicio de la extensión: consulta de un expediente
// sin pasar por el SCW, y acciones sobre el resultado (libro, PDF
// unificado, ZIP, Mis expedientes). La consulta la hace
// src/background/consulta.js en una ventana minimizada del SCW, que queda
// abierta mientras esta pantalla esté abierta (las descargas la usan).

import { JURISDICCIONES, valorPorSigla } from '../lib/jurisdicciones.js';
import { ordenarPorFechaAsc, generarPdfUnificado, generarPdfUnificadoSimple } from '../lib/unificador.js';
import { crearZip } from '../lib/zip.js';
import { registrar, instalarCaptura } from '../lib/registro.js';

instalarCaptura('inicio');

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');
import * as db from '../lib/db.js';

const $ = id => document.getElementById(id);
let puerto = null;
let exp = null;          // resultado de la consulta
let ocupado = false;
// Viniendo de "Mis expedientes" con un expediente sin documentos (respaldo
// liviano): se busca en el SCW y, al llegar el resultado, se guarda solo.
let restaurando = false;

// ─── Utilidades de pantalla ───────────────────────────────────────────
function estadoEn(id, texto, tipo) {
  if (tipo === 'error' && texto) registrar('error', 'inicio', texto);
  const el = $(id);
  el.textContent = texto || '';
  el.className = 'estado' + (tipo ? ' estado--' + tipo : '');
}
const estadoBuscar = (t, tipo) => estadoEn('estadoBuscar', t, tipo);
const estado = (t, tipo) => estadoEn('estado', t, tipo);

function bloquearAcciones(si) {
  ocupado = si;
  document.querySelectorAll('#vistaExpediente button').forEach(b => { b.disabled = si; });
}

// ─── Formulario ───────────────────────────────────────────────────────
(function cargarJurisdicciones() {
  const sel = $('jurisdiccion');
  sel.innerHTML = '<option value="">Seleccione una jurisdicción</option>';
  for (const j of JURISDICCIONES) {
    const o = document.createElement('option');
    o.value = j.value;
    o.dataset.sigla = j.sigla;
    o.textContent = j.sigla + ' - ' + j.nombre;
    if (j.sigla === 'CIV') o.selected = true;   // caso de uso principal
    sel.appendChild(o);
  }
})();

// Cada consulta abre SU PROPIA conexión, no reusa una vieja: el service
// worker de una extensión Manifest V3 se apaga solo tras un rato sin
// actividad, y un puerto conectado a un worker ya apagado se queda
// "vivo" del lado del cliente pero no llega a ningún lado — visto en la
// práctica al abrir un vinculado después de que la búsqueda inicial ya
// había terminado y la pantalla llevaba un rato quieta: postMessage no
// tiraba error, pero el mensaje nunca llegaba al fondo.
// Mientras dura la búsqueda se manda un "ping" cada 15 s por el puerto: un
// mensaje entrante mantiene despierto al proceso de fondo (Chrome y Firefox
// lo apagan tras ~30 s sin recibir nada, y una búsqueda con muchas
// actuaciones o un SCW lento puede tardar más). Si igual se corta durante
// la búsqueda, se reintenta una vez sola antes de mostrar el error.
let latido = null;
function pararLatido() { if (latido) { clearInterval(latido); latido = null; } }

function iniciarBusqueda(datos, reintento = false) {
  if (puerto) puerto.disconnect();
  pararLatido();
  const p = chrome.runtime.connect({ name: 'consulta' });
  puerto = p;
  latido = setInterval(() => { try { p.postMessage({ tipo: 'ping' }); } catch (e) { pararLatido(); } }, 15000);
  p.onMessage.addListener(msg => { if (msg && (msg.tipo === 'listo' || msg.tipo === 'error')) pararLatido(); recibir(msg); });
  p.onDisconnect.addListener(() => {
    if (puerto === p) pararLatido();
    // Si 'puerto' ya no es ESTE puerto, es porque se reemplazó por una
    // conexión más nueva (iniciarBusqueda de vuelta): este disconnect es
    // el de la conexión vieja cerrándose a propósito, no un corte real.
    if (puerto !== p) return;
    puerto = null;
    // Si hay algo en curso (ejecutar() puso ocupado=true), NO lo
    // interrumpimos: este puerto solo hace falta durante la búsqueda en
    // sí y para abrir vinculados — un módulo como Exportar EPUB hace su
    // propio trabajo (fetch directo a cada actuación), completamente
    // aparte, y puede tardar varios minutos; en ese lapso el service
    // worker se apaga solo por inactividad (nada raro: no le llega
    // ningún mensaje por ESTE puerto durante todo ese tiempo) y este
    // disconnect dispara igual, aunque no tenga nada que ver con lo que
    // está corriendo. Tapar su progreso real y bloquear los botones acá
    // sería peor que no avisar nada: el operador ve "se perdió la
    // conexión" y da por perdido un EPUB que en realidad sigue armándose
    // bien. Si lo que está en curso SÍ necesitaba este puerto, va a
    // fallar por su cuenta con su propio mensaje al intentar usarlo.
    if (ocupado) return;
    // Con los resultados ya mostrados (vistaExpediente visible) y nada en
    // curso, este disconnect case normalmente NO es más que el service
    // worker durmiéndose por inactividad — pasa apenas el operador tarda
    // un rato en tocar algo después de la búsqueda, y antes esto tiraba
    // "se perdió la conexión" y bloqueaba TODOS los botones, aunque nada
    // estuviera roto: las acciones (Leer como libro, Agregar a Mis
    // expedientes, etc.) no usan este puerto — le mandan el mensaje
    // directo a la pestaña del SCW (accionEnPestana(), vía
    // chrome.tabs.sendMessage a exp.tabId), que sigue viva y responde
    // igual, despertando el service worker si hace falta. El fondo
    // (consulta.js) ya no cierra esa pestaña solo porque este puerto se
    // cayó — así que acá no hay nada que avisar ni bloquear.
    if (!$('vistaExpediente').hidden) return;
    const motivo = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'sin detalle';
    if (!reintento) {
      registrar('aviso', 'inicio', 'Se cortó la conexión con el proceso de fondo durante la búsqueda; se reintenta', { motivo });
      estadoBuscar('Se cortó la conexión con la extensión; reintentando…', 'cargando');
      setTimeout(() => iniciarBusqueda(datos, true), 800);
      return;
    }
    registrar('error', 'inicio', 'Se perdió la conexión con el proceso de fondo durante la búsqueda (después de reintentar)', { motivo });
    const msg = 'Se perdió la conexión con la extensión. Volvé a consultar el expediente.';
    estadoBuscar(msg, 'error');
    $('btnConsultar').disabled = false;
  });
  p.postMessage({ tipo: 'consultar', ...datos });
}

$('formBuscar').addEventListener('submit', async ev => {
  ev.preventDefault();
  const sel = $('jurisdiccion');
  const valorJurisdiccion = sel.value;
  const sigla = sel.selectedOptions[0] && sel.selectedOptions[0].dataset.sigla;
  const numero = $('numero').value.trim().replace(/^0+(?=\d)/, '');
  const anio = $('anio').value.trim();
  const incidente = $('incidente').value.trim();

  if (!valorJurisdiccion) return estadoBuscar('Elegí una jurisdicción.', 'error');
  if (!/^\d+$/.test(numero) || !/^\d{4}$/.test(anio)) return estadoBuscar('Completá número y año (el año con 4 cifras).', 'error');
  if (incidente && !/^\d+$/.test(incidente)) return estadoBuscar('El incidente tiene que ser un número.', 'error');

  // Antes de salir a buscarlo al SCW (varios segundos), nos fijamos si ya
  // está en Mis expedientes: si está, preguntamos — no lo abrimos directo
  // sin avisar, porque puede haber novedades que el operador sí quiera
  // traer, pero tampoco tiene sentido repetir siempre la búsqueda completa
  // si lo único que quiere es volver a mirar algo que ya tiene.
  const clave = db.normalizarClaveExpediente(
    sigla + ' ' + numero + '/' + anio + (incidente ? '/' + incidente : ''));
  const guardado = clave && await db.buscarExpedientePorNumero(clave);
  // Sin documentos (respaldo liviano) no tiene sentido ofrecer "abrir lo
  // guardado": no hay nada que mostrar.
  if (guardado && !restaurando && await db.contarDocumentos(guardado.cid)) {
    const fecha = guardado.fechaVerificacion ? new Date(guardado.fechaVerificacion).toLocaleString('es-AR') : 'desconocida';
    const usarGuardado = confirm(
      'Ya tenés "' + guardado.numero + '" en Mis expedientes (última verificación: ' + fecha + ').\n\n' +
      'Aceptar: abrirlo al instante, sin tocar el SCW.\n' +
      'Cancelar: buscarlo de nuevo en el SCW (por si hay actuaciones nuevas).');
    if (usarGuardado) { await mostrarExpedienteGuardado(guardado); return; }
  }

  $('btnConsultar').disabled = true;
  estadoBuscar('Buscando el expediente en el SCW… puede demorar unos segundos.', 'cargando');
  iniciarBusqueda({ valorJurisdiccion, sigla, numero, anio, incidente });
});

function recibir(msg) {
  if (msg.tipo === 'etapa') {
    estadoBuscar(msg.texto, 'cargando');
  } else if (msg.tipo === 'error') {
    estadoBuscar(msg.texto, 'error');
    $('btnConsultar').disabled = false;
    // Por si el error vino de abrir un vinculado (con vistaExpediente
    // visible, no vistaBuscar): sin esto, las acciones quedaban
    // bloqueadas para siempre (mismo motivo que en el 'listo' de abajo).
    bloquearAcciones(false);
    if (!vistaExpediente.hidden) estado(msg.texto, 'error');
  } else if (msg.tipo === 'listo') {
    exp = msg;
    mostrarExpediente();
    if (restaurando) {
      restaurando = false;
      // Guardar dispara fusionarDuplicadosPorNumero (background/index.js):
      // la ficha restaurada se reemplaza por esta y conserva sus banderitas.
      setTimeout(() => $('btnGuardar').click(), 0);
    }
    // bloquearAcciones(true) al abrir un vinculado (más arriba) no tiene su
    // propio 'false': lo pone acá, en el punto de llegada común a la
    // búsqueda inicial y a abrir un vinculado.
    bloquearAcciones(false);
  }
}

// ─── Vista del expediente ─────────────────────────────────────────────
async function mostrarExpediente() {
  $('vistaBuscar').hidden = true;
  $('vistaExpediente').hidden = false;
  $('linkNueva').hidden = false;

  const nHist = exp.archivos.filter(a => a.esHistorica).length;
  $('expId').textContent = exp.nombre;
  $('expCaratula').textContent = exp.caratula || exp.tituloExpediente || exp.nombre;
  $('expMeta').textContent = exp.archivos.length + ' actuaciones' +
    (nHist ? ' (' + nHist + ' históricas)' : '');

  const avisos = [];
  if (exp.aviso && !exp.desdeGuardado) avisos.push(exp.aviso);
  if (exp.paginacionIncompleta) avisos.push('El recorrido de páginas se cortó antes de tiempo (demora del sistema). Pueden faltar actuaciones más viejas. Conviene volver a consultar el expediente.');
  if (exp.historicasFaltantes) avisos.push('No se pudieron leer las actuaciones históricas: pueden faltar las más viejas (por ejemplo, la demanda).');
  $('avisos').innerHTML = '';
  for (const a of avisos) {
    const d = document.createElement('div');
    d.className = 'aviso';
    d.textContent = a;
    $('avisos').appendChild(d);
  }
  // Mostrado desde Mis expedientes (sin tocar el SCW): mismo botón de
  // actualizar que ya existe en la biblioteca (bibliotecaVerificarEnVivo /
  // bibliotecaActualizarEnVivo), pero acá al lado, para no tener que ir a
  // "Mis expedientes" solo para chequear novedades.
  if (exp.desdeGuardado) renderAvisoGuardado();

  const r = await new Promise(res => chrome.runtime.sendMessage({ action: 'bibliotecaListar' }, res));
  const guardado = r && r.ok && (r.expedientes || []).some(e => e.cid === exp.cid);
  $('btnGuardarTexto').textContent = guardado ? 'Actualizar en Mis expedientes' : 'Agregar a Mis expedientes';

  // Sin pestaña del SCW (expediente abierto desde Mis expedientes o con
  // "← Volver" del libro) los módulos ya NO se deshabilitan: arman el
  // archivo con los PDFs guardados en la biblioteca (ver bytesDeActuaciones).
  // bloquearAcciones(false) puede haberlos dejado como estaban; se
  // normalizan acá por si una versión anterior los dejó deshabilitados.
  document.querySelectorAll('[data-formato]').forEach(b => { b.disabled = false; b.title = ''; });

  renderVinculados();
}

// Aviso "mostrando la versión guardada" con botón de actualizar in situ —
// mismos dos mensajes que ya usa biblioteca.js (bibliotecaVerificarEnVivo /
// bibliotecaActualizarEnVivo, background/index.js), no un mecanismo nuevo.
function renderAvisoGuardado() {
  const d = document.createElement('div');
  d.className = 'aviso';
  const texto = document.createElement('span');
  texto.textContent = exp.aviso || 'Mostrando la versión guardada.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'boton-secundario';
  btn.textContent = '🔄 Actualizar';
  btn.style.marginLeft = '10px';
  btn.addEventListener('click', () => actualizarDesdeResultados(btn, texto));
  d.append(texto, btn);
  $('avisos').appendChild(d);
}

async function actualizarDesdeResultados(btn, texto) {
  const cid = exp.cid;
  btn.disabled = true;
  texto.textContent = '⏳ Verificando en el SCW...';
  try {
    const v = await new Promise(res => chrome.runtime.sendMessage({ action: 'bibliotecaVerificarEnVivo', cid }, res));
    if (!v || !v.ok) throw new Error((v && v.error) || 'No se pudo verificar.');
    if (!v.cambio) {
      texto.textContent = 'Ya está al día (verificado recién).';
      btn.disabled = false;
      return;
    }
    texto.textContent = '⏳ Actualizando (' + (v.nuevasDetectadas || 0) + ' actuación(es) nueva(s))...';
    const a = await new Promise(res => chrome.runtime.sendMessage({ action: 'bibliotecaActualizarEnVivo', cid }, res));
    if (!a || !a.ok) throw new Error((a && a.error) || 'No se pudo actualizar.');
    // Progreso real vía chrome.storage.local — mismo canal que usa biblioteca.js.
    await new Promise(resolve => {
      const poll = setInterval(() => {
        chrome.storage.local.get(['descargaProgreso'], data => {
          const p = data.descargaProgreso;
          if (!p) return;
          const pct = p.total ? Math.round((p.descargados / p.total) * 100) : 0;
          texto.textContent = '⏳ Actualizando... ' + p.descargados + ' / ' + p.total + ' (' + pct + '%)';
          if (p.terminado) { clearInterval(poll); resolve(); }
        });
      }, 500);
      setTimeout(() => { clearInterval(poll); resolve(); }, 120000); // tope de seguridad
    });
    // Recarga la pantalla entera desde lo recién actualizado en IndexedDB.
    const actualizado = await db.obtenerExpediente(cid);
    if (actualizado) await mostrarExpedienteGuardado(actualizado);
    else { texto.textContent = 'Actualizado.'; btn.disabled = false; }
  } catch (err) {
    texto.textContent = '❌ ' + err.message;
    btn.disabled = false;
  }
}

// Incidentes y expedientes vinculados del principal (estilo del portal web).
function renderVinculados() {
  const cont = $('listaVinculados');
  cont.innerHTML = '';
  const lista = exp.vinculados || [];
  $('seccionVinculados').hidden = !lista.length;
  for (const v of lista) {
    const fila = document.createElement('div');
    fila.className = 'vinculado';

    const datos = document.createElement('div');
    datos.className = 'vinculado-datos';
    const idEl = document.createElement('div'); idEl.className = 'vinculado-id'; idEl.textContent = v.expediente;
    const car = document.createElement('div'); car.className = 'vinculado-caratula'; car.textContent = v.caratula || '';
    const meta = document.createElement('div'); meta.className = 'vinculado-meta';
    meta.textContent = [v.dependencia, v.situacion, v.ultimaActuacion ? 'últ. act. ' + v.ultimaActuacion : '']
      .filter(Boolean).join(' · ');
    datos.append(idEl, car, meta);

    const boton = document.createElement('button');
    boton.className = 'boton-secundario';
    boton.textContent = 'Abrir';
    boton.addEventListener('click', () => abrirVinculadoDesdeResultado(boton, v.expediente));

    fila.append(datos, boton);
    cont.appendChild(fila);
  }
}

// "CIV 013719/2023/1" → { sigla, numero, anio, incidente }. Los ceros a la
// izquierda no importan (el SCW los muestra, el formulario no los pide).
function partirExpediente(texto) {
  const m = (texto || '').match(/([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/i);
  if (!m) return null;
  return { sigla: m[1].toUpperCase(), numero: String(Number(m[2])), anio: m[3], incidente: String(Number(m[4])) };
}

function abrirVinculadoDesdeResultado(boton, expedienteTexto) {
  if (ocupado) return;
  const partes = partirExpediente(expedienteTexto);
  if (!partes) return;
  const valorJurisdiccion = valorPorSigla(partes.sigla);
  if (valorJurisdiccion == null) {
    estado('No se reconoce la jurisdicción "' + partes.sigla + '".', 'error');
    return;
  }
  boton.disabled = true;
  boton.textContent = 'Abriendo…';
  bloquearAcciones(true);
  // Sin progreso en vivo acá (a diferencia del formulario inicial): los
  // mensajes de etapa van al estado de la pantalla de búsqueda, que queda
  // oculta mientras se ve el expediente. Al terminar, recibir() reemplaza
  // 'exp' y vuelve a llamar mostrarExpediente() con el incidente.
  estado('Abriendo ' + expedienteTexto + '… puede demorar unos segundos.', 'cargando');
  // sendMessage, no el puerto de la búsqueda inicial: acá no hace falta
  // progreso en vivo, y es más robusto para despertar el service worker
  // si lleva un rato inactivo (ver el comentario en
  // iniciarAperturaVinculados, background/consulta.js).
  chrome.runtime.sendMessage({
    action: 'consultarVinculado', valorJurisdiccion, ...partes,
    // Si la pestaña del expediente actual sigue abierta, se actúa directo
    // sobre ella (sin pasar por el SCW de nuevo, sin foco en ningún
    // momento); si ya no sirve, el fondo hace una búsqueda completa igual.
    tabIdExistente: exp && exp.tabId, expedienteVinculado: expedienteTexto,
  }, resp => {
    bloquearAcciones(false);
    if (chrome.runtime.lastError) {
      estado('Se perdió la conexión con la extensión. Probá de nuevo.', 'error');
      return;
    }
    if (resp && resp.tipo === 'listo') { exp = resp; mostrarExpediente(); }
    else estado((resp && resp.texto) || 'No se pudo abrir el incidente.', 'error');
  });
}

// Espera el fin de una descarga que informa por chrome.storage (mismo
// mecanismo que usa el popup).
// Devuelve { promesa, detener }: el unificado no marca 'terminado' (su fin
// llega por la respuesta del mensaje), así que hay que poder cortarlo.
function seguirProgreso(clave, textoEtapa) {
  let id = null;
  const promesa = new Promise(resolve => {
    id = setInterval(async () => {
      const d = await chrome.storage.local.get(clave);
      const p = d[clave];
      if (!p) return;
      if (p.error) { clearInterval(id); resolve({ ok: false, error: p.error }); return; }
      const pct = p.total > 0 ? Math.round((p.descargados / p.total) * 100) : 0;
      estado(textoEtapa(p) + ' ' + p.descargados + ' / ' + p.total + ' (' + pct + '%)' +
        (p.errores > 0 ? ' · con error: ' + p.errores : ''), 'cargando');
      if (p.terminado) { clearInterval(id); await chrome.storage.local.remove(clave); resolve({ ok: true, ...p }); }
    }, 700);
  });
  return { promesa, detener: () => clearInterval(id) };
}

async function accionEnPestana(accion) {
  await chrome.storage.local.set({
    descargaProgreso: { total: exp.archivos.length, descargados: 0, errores: 0, terminado: false },
  });
  // vinculados va acá (no se lee de nuevo en el content script: solo viaja
  // en la respuesta de una búsqueda en vivo) para que guardarEnBiblioteca
  // lo persista junto con el resto — si no, se perdían al volver del
  // libro con "← Volver" (esa pantalla lee todo de Mis expedientes, y sin
  // esto la sección de vinculados quedaba siempre vacía ahí).
  chrome.tabs.sendMessage(exp.tabId, { action: accion, archivos: exp.archivos, folderName: exp.folderName, startIndex: 1, vinculados: exp.vinculados || [] });
  return seguirProgreso('descargaProgreso', () =>
    accion === 'guardarEnBiblioteca' ? 'Guardando en Mis expedientes…' : 'Armando el ZIP…').promesa;
}

// ─── Bytes de cada actuación ────────────────────────────────────────────
// Dos orígenes posibles, mismo resultado ({ ...act, bytes, error }):
//  - expediente guardado (exp.desdeGuardado): el blob que ya está en
//    Mis expedientes (IndexedDB) — no toca el SCW, funciona offline.
//  - consulta en vivo: se baja del SCW con las cookies de la sesión, igual
//    que hacía el EPUB.
function urlDescarga(act) {
  let urlPdf = act.urlPdf || act.url || '';
  if (urlPdf && urlPdf.indexOf('http') !== 0) urlPdf = 'https://scw.pjn.gov.ar' + urlPdf;
  if (urlPdf.indexOf('/scw/viewer') !== -1 && urlPdf.indexOf('download=true') === -1)
    urlPdf += (urlPdf.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
  return urlPdf;
}
function esPdf(b) {
  return b && b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2D;
}
async function bytesDeActuacion(act) {
  if (act.blob) return new Uint8Array(await act.blob.arrayBuffer());
  if (exp.desdeGuardado) throw new Error('no está guardada en Mis expedientes');
  const url = urlDescarga(act);
  if (!url) throw new Error('sin enlace de descarga');
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return new Uint8Array(await resp.arrayBuffer());
}
async function bytesDeActuaciones(lista, textoEtapa) {
  const salida = [];
  let errores = 0;
  for (let i = 0; i < lista.length; i++) {
    const act = lista[i];
    estado(textoEtapa + ' ' + (i + 1) + ' / ' + lista.length + (errores ? ' · con error: ' + errores : ''), 'cargando');
    try {
      const bytes = await bytesDeActuacion(act);
      if (act.extension && act.extension !== '.pdf') { salida.push({ ...act, bytes }); continue; }
      if (!esPdf(bytes)) throw new Error('la respuesta no es un PDF válido (posible sesión vencida)');
      salida.push({ ...act, bytes, error: null });
    } catch (e) {
      errores++;
      salida.push({ ...act, bytes: null, error: e.message });
    }
  }
  return { lista: salida, errores };
}
function actuacionesDeExp() {
  return exp.actuaciones.length ? exp.actuaciones : exp.archivos;
}
function descargarBlob(blob, nombreArchivo) {
  const url = URL.createObjectURL(blob);
  return new Promise(res => chrome.downloads.download({ url, filename: nombreArchivo, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    res();
  }));
}

function confirmarCompletitud() {
  if (exp.historicasFaltantes && !confirm('No se pudieron leer las actuaciones históricas: el resultado puede arrancar más adelante en el tiempo, sin las más viejas.\n\n¿Continuar igual?')) return false;
  if (exp.paginacionIncompleta && !confirm('El recorrido de páginas se cortó antes de tiempo: pueden faltar actuaciones.\n\n¿Continuar igual?')) return false;
  return true;
}

async function guardar() {
  const r = await accionEnPestana('guardarEnBiblioteca');
  if (!r.ok) throw new Error(r.error || 'No se pudo guardar.');
  $('btnGuardarTexto').textContent = 'Actualizar en Mis expedientes';
  return r;
}

async function ejecutar(fn) {
  if (ocupado) return;
  bloquearAcciones(true);
  try { await fn(); }
  catch (e) { estado(e.message || String(e), 'error'); }
  finally { bloquearAcciones(false); }
}

// Abre el libro sin multiplicar pestañas:
// - si esta pantalla vino del libro ("← Volver", ?resultados=), vuelve al
//   libro en ESTA misma pestaña;
// - si ya hay una pestaña con el libro de este expediente, va a esa (y la
//   recarga si se acaba de actualizar desde el SCW, para que muestre lo nuevo);
// - si no, abre una pestaña nueva.
async function abrirLibro(cid, recargar) {
  const url = chrome.runtime.getURL('src/public/biblioteca.html?abrir=' + encodeURIComponent(cid));
  if (new URLSearchParams(location.search).get('resultados')) { location.href = url; return 'misma'; }
  const base = chrome.runtime.getURL('src/public/biblioteca.html');
  const tabs = await chrome.tabs.query({});
  // Se reconoce por cid o por número de expediente: al volver a consultarlo
  // en el SCW cambia el cid, pero el libro abierto sigue siendo el mismo.
  const claveNum = db.normalizarClaveExpediente((exp && (exp.nombre || exp.folderName)) || '');
  const existente = tabs.find(t => {
    if (!t.url || !t.url.startsWith(base)) return false;
    try {
      const q = new URL(t.url).searchParams;
      return q.get('abrir') === String(cid) || (claveNum && q.get('exp') === claveNum);
    } catch (e) { return false; }
  });
  if (existente) {
    await chrome.tabs.update(existente.id, recargar ? { active: true, url } : { active: true });
    if (chrome.windows && existente.windowId != null) await chrome.windows.update(existente.windowId, { focused: true }).catch(() => {});
    return 'existente';
  }
  await chrome.tabs.create({ url });
  return 'nueva';
}

$('btnEbook').addEventListener('click', () => ejecutar(async () => {
  // Sin pestaña del SCW (se llegó acá con "← Volver" o desde Mis
  // expedientes, no con una consulta en vivo): no hace falta guardar de
  // nuevo, ya está en Mis expedientes — abrir el libro directo.
  let detalle = '';
  if (exp.tabId) {
    const r = await guardar();
    detalle = ' (' + r.descargados + ' actuaciones' + (r.errores ? ', ' + r.errores + ' con error' : '') + ')';
  }
  const donde = await abrirLibro(exp.cid, !!exp.tabId);
  if (donde === 'misma') return; // esta pantalla se reemplaza por el libro
  volverABuscar(donde === 'existente'
    ? '✓ El libro ya estaba abierto: se pasó a esa pestaña' + detalle + '.'
    : '✓ Libro abierto en una pestaña nueva' + detalle + '.');
}));

function volverABuscar(mensaje) {
  exp = null;
  $('vistaExpediente').hidden = true;
  $('linkNueva').hidden = true;
  $('vistaBuscar').hidden = false;
  $('numero').value = '';
  $('anio').value = '';
  $('incidente').value = '';
  $('btnConsultar').disabled = false;
  estadoBuscar(mensaje || '', mensaje ? 'ok' : '');
  $('numero').focus();
}

$('btnGuardar').addEventListener('click', () => ejecutar(async () => {
  // Sin pestaña del SCW (se llegó acá mostrando lo ya guardado, no con
  // una consulta en vivo): no hay nada que volver a descargar — ya está
  // en Mis expedientes. Sin este chequeo, accionEnPestana() intentaba
  // chrome.tabs.sendMessage(null, ...) y tiraba "No matching signature".
  if (!exp.tabId) {
    estado('Ya está en Mis expedientes. Para traer novedades del SCW, usá el botón "Actualizar" de arriba.', 'ok');
    return;
  }
  const r = await guardar();
  estado('✓ Guardado en Mis expedientes (' + r.descargados + ' actuaciones' +
    (r.errores ? ', ' + r.errores + ' con error' : '') + ').', 'ok');
}));

document.querySelector('[data-formato="zip"]').addEventListener('click', () => ejecutar(async () => {
  if (!exp.tabId) {
    // Desde Mis expedientes: cada PDF guardado, tal cual (firma intacta).
    const { lista, errores } = await bytesDeActuaciones(actuacionesDeExp(), 'Armando el ZIP…');
    const carpeta = sanitizarNombreLocal(exp.folderName || exp.nombre);
    const ancho = Math.max(3, String(lista.length).length);
    const entradas = lista.filter(a => a.bytes).map((a, i) => ({
      name: carpeta + '/' + String(i + 1).padStart(ancho, '0') + ' - ' + sanitizarNombreLocal(a.titulo || 'documento').slice(0, 120) + (a.extension || '.pdf'),
      data: a.bytes,
    }));
    if (!entradas.length) throw new Error('No hay documentos guardados para armar el ZIP. Usá "Actualizar" para traerlos del SCW.');
    await descargarBlob(crearZip(entradas, 'application/zip'), carpeta.slice(0, 50) + '.zip');
    estado('✓ ZIP listo (' + entradas.length + ' documentos' + (errores ? ', ' + errores + ' no disponibles' : '') + '). Se abrió el diálogo para guardarlo.', 'ok');
    return;
  }
  const r = await accionEnPestana('crearYDescargarZip');
  if (!r.ok) throw new Error(r.error || 'No se pudo armar el ZIP.');
  estado('✓ ZIP listo: se abrió el diálogo para guardarlo.', 'ok');
}));

// A diferencia de PDF unificado y ZIP, no necesita pestaña del SCW: no
// vuelve a descargar ningún documento, solo arma una lista con lo que ya
// se tiene (título/fecha/enlace público) — funciona igual viniendo de una
// consulta en vivo o de "← Volver".
document.getElementById('btnIndiceHiper').addEventListener('click', () => ejecutar(async () => {
  const actuaciones = exp.actuaciones.length ? exp.actuaciones : exp.archivos;
  const r = await new Promise(res => chrome.runtime.sendMessage({
    action: 'descargarIndiceHipervinculado',
    actuaciones,
    tituloExpediente: exp.tituloExpediente || exp.folderName || exp.nombre,
    historicasFaltantes: exp.historicasFaltantes,
    paginacionIncompleta: exp.paginacionIncompleta,
  }, res));
  if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo generar el índice.');
  estado('✓ Índice hipervinculado listo (' + r.total + ' actuaciones). Se abrió el diálogo para guardarlo.', 'ok');
}));

// Versión HTML del mismo índice: no pasa por ningún visor de PDF (Adobe
// bloquea por defecto las conexiones salientes de un PDF recién
// descargado — "Bloqueo de seguridad"), abre directo en una pestaña del
// navegador, y al copiar y pegar el texto en Word los enlaces viajan con
// él (un PDF no lleva el link al copiar texto plano, solo el texto).
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function sanitizarNombreLocal(texto) {
  return String(texto || 'Expediente').replace(/[/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Datos comunes a las tres exportaciones del índice (HTML, Word, EPUB) —
// cada una arma su propio documento alrededor de este mismo fragmento, así
// las filas no se repiten tres veces con el riesgo de desalinearse entre sí.
// Datos por entrada, sin renderizar todavía — HTML (grilla con botones),
// Word y PDF arman su propio markup alrededor de esta misma lista, así
// ninguno puede desalinearse de los otros en cómo arma el título corto.
function entradasIndice(ordenadas) {
  return ordenadas.map((act, i) => {
    const tipo = (act.tipo || '').trim();
    const descripcion = (act.descripcion || '').trim();
    const tituloCorto = (tipo || descripcion) ? [tipo, descripcion].filter(Boolean).join(' - ') : (act.titulo || ('Actuación ' + (i + 1)));
    return {
      numLabel: String(i + 1).padStart(3, '0'),
      // tipo/descripcion por separado (para la grilla HTML, que los
      // muestra en líneas distintas) además de tituloCorto ya combinado
      // (para Word y el índice del PDF, que van en una sola línea).
      tipo, descripcion,
      tituloCorto: tituloCorto || (act.titulo || ('Actuación ' + (i + 1))),
      fecha: act.fecha || '', url: act.urlPublica || act.url || '',
    };
  });
}

function fragmentoIndice(tituloExpediente, ordenadas) {
  const entradas = entradasIndice(ordenadas);
  const filas = entradas.map(e => {
    const texto = escapeHtml(e.numLabel + '. ' + e.tituloCorto + (e.fecha ? '  (' + e.fecha + ')' : ''));
    return e.url
      ? '<li><a href="' + escapeHtml(e.url) + '" target="_blank" rel="noopener">' + texto + '</a></li>'
      : '<li>' + texto + '</li>';
  }).join('\n');
  return {
    titulo: escapeHtml(tituloExpediente),
    cantidad: ordenadas.length,
    generado: new Date().toLocaleDateString('es-AR'),
    filas,
    entradas,
  };
}
function bloqueEncabezado(f) {
  return '<h1>' + f.titulo + '</h1>'
    + '<div class="sub">Índice de actuaciones (' + f.cantidad + ')</div>'
    + '<div class="aviso">Generado ' + f.generado + ' · copia de trabajo, sin validez de firma electrónica</div>';
}

document.getElementById('btnIndiceHiperHTML').addEventListener('click', () => ejecutar(async () => {
  const actuaciones = exp.actuaciones.length ? exp.actuaciones : exp.archivos;
  const ordenadas = ordenarPorFechaAsc(actuaciones);
  const tituloExp = exp.tituloExpediente || exp.folderName || exp.nombre;
  const entradas = entradasIndice(ordenadas);
  // Los datos viajan por chrome.storage.local (no un blob: con el HTML
  // armado a mano): un blob: hereda la política de seguridad de la
  // extensión pero no cuenta como su mismo origen para cargar/ejecutar
  // JS propio — indice-grid.html es una página real de la extensión, que
  // arma la grilla y los botones (Copiar/Abrir) leyendo esto al cargar.
  await new Promise(res => chrome.storage.local.set({
    indiceGrid: { titulo: tituloExp, numero: exp.nombre || '', generado: new Date().toLocaleDateString('es-AR'), entradas }
  }, res));
  // chrome.tabs.create(), no window.open(): una pestaña abierta con
  // window.open() carga el HTML bien, pero queda en un contexto donde
  // chrome.storage (y el resto de la API de extensión) no está
  // disponible — comprobado directamente, no es un problema de timing.
  // chrome.tabs.create() es la forma canónica de abrir una pestaña de la
  // extensión con privilegios completos.
  await new Promise(res => chrome.tabs.create({ url: chrome.runtime.getURL('src/public/indice-grid.html') }, res));
  estado('✓ Índice abierto en una pestaña nueva.', 'ok');
}));

// Word (.doc): NO es un .docx real (eso pediría una librería para armar el
// paquete OOXML/zip) — es HTML disfrazado de .doc, un truco que Word
// reconoce y abre igual, con los hipervínculos intactos. Al abrirlo, Word
// puede avisar que el formato no coincide con la extensión: es esperado,
// "Sí" y abre normal.
function generarIndiceWord(tituloExpediente, ordenadas) {
  const f = fragmentoIndice(tituloExpediente, ordenadas);
  return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    + '<head><meta charset="UTF-8"><title>Índice — ' + f.titulo + '</title>'
    + '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->'
    + '<style>body{font-family:Georgia,serif}h1{font-size:20pt}.sub{font-size:11pt;color:#555}.aviso{font-size:9pt;color:#555}li{margin-bottom:8pt;font-size:11pt}a{color:#008c8c}</style>'
    + '</head><body>'
    + bloqueEncabezado(f)
    + '<ol>' + f.filas + '</ol>'
    + '</body></html>';
}
document.getElementById('btnIndiceHiperWord').addEventListener('click', () => ejecutar(async () => {
  const actuaciones = exp.actuaciones.length ? exp.actuaciones : exp.archivos;
  const ordenadas = ordenarPorFechaAsc(actuaciones);
  const tituloExp = exp.tituloExpediente || exp.folderName || exp.nombre;
  const docHtml = generarIndiceWord(tituloExp, ordenadas);
  const blob = new Blob(['\ufeff', docHtml], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const nombreArchivo = sanitizarNombreLocal(tituloExp).slice(0, 50) + '_INDICE.doc';
  await new Promise(res => chrome.downloads.download({ url, filename: nombreArchivo, saveAs: true }, res));
  estado('✓ Word descargado — al abrirlo puede avisar que el formato no coincide con la extensión (es normal, así conserva los enlaces): elegí "Sí".', 'ok');
}));

// ─── Exportar EPUB — módulo autónomo, al mismo nivel que "PDF unificado
// con índice": no es solo el índice, es el expediente completo (cada
// actuación con sus fojas, como en el libro), con un índice interno
// hipervinculado (el TOC del EPUB) y el enlace público visible al
// principio de cada actuación. Necesita re-descargar cada actuación
// (igual que PDF unificado/ZIP), por eso se deshabilita sin pestaña del
// SCW (ver el sweep de [data-formato] en mostrarExpediente()).
//
// Cada actuación se renderiza a imágenes (pdf.js, igual que el lector) en
// vez de embeber el PDF tal cual: un EPUB es HTML/XHTML por dentro, no
// puede mostrar páginas de un PDF como contenido de lectura — y buena
// parte de las actuaciones son escaneos sin texto, así que extraer texto
// tampoco serviría para todas por igual.
async function renderizarPdfComoImagenes(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
  const imagenes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const escala = Math.min(1.6, 1000 / base.width); // ancho ~1000px: legible, sin inflar el peso del epub
    const vp = page.getViewport({ scale: escala });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    imagenes.push(new Uint8Array(await blob.arrayBuffer()));
  }
  return imagenes;
}

async function generarEpubCompleto(tituloExpediente, ordenadas, onProgreso) {
  const enc = new TextEncoder();
  const uid = 'urn:uuid:infocivil-' + Date.now();
  const archivosContenido = [];
  const manifestItems = [];
  const spineItems = [];
  const navPoints = [];
  let numero = 1, playOrder = 1;

  for (const act of ordenadas) {
    const tipo = (act.tipo || '').trim();
    const descripcion = (act.descripcion || '').trim();
    const tituloCorto = (tipo || descripcion) ? [tipo, descripcion].filter(Boolean).join(' - ') : (act.titulo || ('Actuación ' + numero));
    const fecha = act.fecha || '';
    let urlPdf = act.urlPdf || act.url || '';
    if (urlPdf && urlPdf.indexOf('http') !== 0) urlPdf = 'https://scw.pjn.gov.ar' + urlPdf;
    if (urlPdf.indexOf('/scw/viewer') !== -1 && urlPdf.indexOf('download=true') === -1) {
      urlPdf += (urlPdf.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
    }
    const urlPublica = act.urlPublica || urlPdf.replace(/[&?]download=true/g, '') || '';
    const idCap = 'cap' + numero;
    const numLabel = String(numero).padStart(3, '0');

    if (onProgreso) onProgreso(numero, ordenadas.length, tituloCorto);

    let cuerpo;
    try {
      // Blob guardado si existe (Mis expedientes); si no, del SCW.
      const bytes = await bytesDeActuacion(act);
      const paginas = await renderizarPdfComoImagenes(bytes);
      cuerpo = paginas.map((data, i) => {
        const nombreImg = 'images/' + idCap + '-p' + (i + 1) + '.png';
        archivosContenido.push({ name: 'OEBPS/' + nombreImg, data });
        manifestItems.push('<item id="img-' + idCap + '-' + (i + 1) + '" href="' + nombreImg + '" media-type="image/png"/>');
        return '<div class="pagina"><img src="' + nombreImg + '" alt="foja ' + (i + 1) + '"/></div>';
      }).join('');
    } catch (e) {
      cuerpo = '<p class="error">ACTUACIÓN NO DISPONIBLE' + (e && e.message ? ' (' + escapeHtml(e.message) + ')' : '') + '.</p>'
        + '<p>Consultarla en el Sistema de Consulta Web con un usuario vinculado a la causa.</p>';
    }

    const capXhtml = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + escapeHtml(tituloCorto) + '</title>'
      + '<style>body{font-family:serif;margin:0 1em}.pagina{margin:1em 0;text-align:center}.pagina img{max-width:100%;height:auto}h2{font-size:1.15em}.meta{font-size:0.85em;color:#555;margin-bottom:0.3em}.enlace{font-size:0.8em;word-break:break-all}.enlace a{color:#008c8c}.error{color:#a00}</style>'
      + '</head><body>'
      + '<h2>' + numLabel + '. ' + escapeHtml(tituloCorto) + '</h2>'
      + (fecha ? '<div class="meta">' + escapeHtml(fecha) + '</div>' : '')
      // Variante DGN: sin enlace al SCW (causas restringidas, no le sirve a quien recibe el EPUB).
      + cuerpo
      + '</body></html>';

    const nombreCap = idCap + '.xhtml';
    archivosContenido.push({ name: 'OEBPS/' + nombreCap, data: enc.encode(capXhtml) });
    manifestItems.push('<item id="' + idCap + '" href="' + nombreCap + '" media-type="application/xhtml+xml"/>');
    spineItems.push('<itemref idref="' + idCap + '"/>');
    navPoints.push('<navPoint id="np' + playOrder + '" playOrder="' + playOrder + '"><navLabel><text>'
      + escapeHtml(numLabel + '. ' + tituloCorto) + '</text></navLabel><content src="' + nombreCap + '"/></navPoint>');
    numero++; playOrder++;
  }

  const tituloEsc = escapeHtml(tituloExpediente);
  const containerXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>'
    + '</container>';

  const contentOpf = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + '<dc:identifier id="bookid">' + uid + '</dc:identifier>'
    + '<dc:title>' + tituloEsc + '</dc:title>'
    + '<dc:language>es</dc:language>'
    + '<dc:date>' + new Date().toISOString().slice(0, 10) + '</dc:date>'
    + '</metadata>'
    + '<manifest>' + manifestItems.join('') + '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>'
    + '<spine toc="ncx">' + spineItems.join('') + '</spine>'
    + '</package>';

  const tocNcx = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
    + '<head><meta name="dtb:uid" content="' + uid + '"/></head>'
    + '<docTitle><text>' + tituloEsc + '</text></docTitle>'
    + '<navMap>' + navPoints.join('') + '</navMap>'
    + '</ncx>';

  const archivosFinales = [
    { name: 'mimetype', data: enc.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: enc.encode(containerXml) },
    { name: 'OEBPS/content.opf', data: enc.encode(contentOpf) },
    { name: 'OEBPS/toc.ncx', data: enc.encode(tocNcx) },
    ...archivosContenido,
  ];
  return crearZip(archivosFinales, 'application/epub+zip');
}

document.getElementById('btnExportarEpub').addEventListener('click', () => ejecutar(async () => {
  const actuaciones = actuacionesDeExp();
  const ordenadas = ordenarPorFechaAsc(actuaciones);
  const tituloExp = exp.tituloExpediente || exp.folderName || exp.nombre;
  const blob = await generarEpubCompleto(tituloExp, ordenadas, (n, total, titulo) => {
    estado('Armando EPUB… actuación ' + n + '/' + total + ': ' + String(titulo).slice(0, 45), 'cargando');
  });
  const url = URL.createObjectURL(blob);
  const nombreArchivo = sanitizarNombreLocal(tituloExp).slice(0, 50) + '.epub';
  await new Promise(res => chrome.downloads.download({ url, filename: nombreArchivo, saveAs: true }, res));
  estado('✓ EPUB listo (' + ordenadas.length + ' actuaciones). Se abrió el diálogo para guardarlo.', 'ok');
}));



document.querySelector('[data-formato="unificado-indice"]').addEventListener('click', () => ejecutar(async () => {
  if (!confirmarCompletitud()) return;
  if (!exp.tabId) {
    // Desde Mis expedientes: mismo unificador, con los PDFs guardados.
    const tituloExp = exp.tituloExpediente || exp.folderName || exp.nombre;
    const { lista, errores } = await bytesDeActuaciones(actuacionesDeExp(), 'Leyendo actuaciones guardadas…');
    estado('Armando el PDF unificado…', 'cargando');
    const bytes = await generarPdfUnificado({ tituloExpediente: tituloExp, actuaciones: lista, historicasFaltantes: false, paginacionIncompleta: false });
    await descargarBlob(new Blob([bytes], { type: 'application/pdf' }), sanitizarNombreLocal(tituloExp).slice(0, 50) + '_UNIFICADO.pdf');
    estado('✓ PDF unificado listo (' + (lista.length - errores) + '/' + lista.length + ' actuaciones' +
      (errores ? ', ' + errores + ' con página de error' : '') + '). Se abrió el diálogo para guardarlo.', 'ok');
    return;
  }
  const actuaciones = exp.actuaciones.length ? exp.actuaciones : exp.archivos;
  const seguimiento = seguirProgreso('unificadoProgreso', p =>
    p.etapa === 'armando' ? 'Armando el PDF unificado…' : 'Descargando actuaciones…');
  const r = await new Promise(res => chrome.runtime.sendMessage({
    action: 'descargarExpedienteUnificado',
    actuaciones,
    tituloExpediente: exp.tituloExpediente || exp.folderName || exp.nombre,
    historicasFaltantes: exp.historicasFaltantes,
    paginacionIncompleta: exp.paginacionIncompleta,
  }, res));
  seguimiento.detener();
  await chrome.storage.local.remove('unificadoProgreso');
  if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo generar el PDF unificado.');
  estado('✓ PDF unificado listo (' + r.descargados + '/' + r.total + ' actuaciones' +
    (r.errores ? ', ' + r.errores + ' con página de error' : '') + '). Se abrió el diálogo para guardarlo.', 'ok');
}));

// ─── PDF de actuaciones seleccionadas (módulo aparte: seleccion.html) ───
// Desde Mis expedientes basta el cid; de una consulta en vivo la lista
// viaja por chrome.storage.local (sin blobs) y el módulo baja del SCW
// solo las actuaciones que se elijan.
$('btnSeleccion').addEventListener('click', async () => {
  if (!exp) return;
  const base = chrome.runtime.getURL('src/public/seleccion.html');
  if (exp.desdeGuardado) {
    chrome.tabs.create({ url: base + '?cid=' + encodeURIComponent(exp.cid) });
    return;
  }
  await chrome.storage.local.set({ seleccionDatos: {
    cid: exp.cid,
    numero: exp.nombre,
    titulo: exp.caratula || exp.tituloExpediente || '',
    historicasFaltantes: !!exp.historicasFaltantes,
    paginacionIncompleta: !!exp.paginacionIncompleta,
    actuaciones: actuacionesDeExp().map(a => ({
      titulo: a.titulo, fecha: a.fecha, tipo: a.tipo, descripcion: a.descripcion,
      esHistorica: !!a.esHistorica, extension: a.extension,
      urlPdf: a.urlPdf, url: a.url, urlPublica: a.urlPublica,
    })),
  } });
  chrome.tabs.create({ url: base + '?origen=consulta' });
});

// ─── PDF unificado (simple): sin portada, índice, pie ni enlaces ────────
// Funciona igual en vivo (baja del SCW) o desde Mis expedientes (usa lo
// guardado). Para remitir el expediente a otra jurisdicción.
document.querySelector('[data-formato="unificado"]').addEventListener('click', () => ejecutar(async () => {
  if (!confirmarCompletitud()) return;
  const tituloExp = exp.tituloExpediente || exp.folderName || exp.nombre;
  const { lista, errores } = await bytesDeActuaciones(actuacionesDeExp(),
    exp.tabId ? 'Descargando actuaciones…' : 'Leyendo actuaciones guardadas…');
  estado('Armando el PDF unificado…', 'cargando');
  const bytes = await generarPdfUnificadoSimple({ tituloExpediente: tituloExp, actuaciones: lista });
  await descargarBlob(new Blob([bytes], { type: 'application/pdf' }), sanitizarNombreLocal(tituloExp).slice(0, 50) + '_UNIFICADO_SIMPLE.pdf');
  estado('✓ PDF unificado listo (' + (lista.length - errores) + '/' + lista.length + ' actuaciones' +
    (errores ? ', ' + errores + ' no disponibles' : '') + '). Se abrió el diálogo para guardarlo.', 'ok');
}));

// ─────────────────────────── "← Volver" desde el lector ───────────────────────────
// inicio.html?resultados=<cid>: en vez de una búsqueda nueva contra el
// SCW, arma la pantalla de resultados leyendo directo de lo que ya está
// guardado en Mis Expedientes (sin pasar por el SCW de nuevo). Los
// vinculados ahora se persisten junto con el resto en guardarEnBiblioteca
// (ver accionEnPestana más arriba) — antes se perdían acá porque solo
// viajaban en la respuesta de una búsqueda en vivo, y esta pantalla nunca
// los guardaba.
// Arma la pantalla de resultados leyendo directo de lo que ya está
// guardado en Mis Expedientes (sin pasar por el SCW). Comparte código
// entre "← Volver" (cargarDesdeGuardado, abajo) y el atajo de "Nueva
// consulta" cuando el operador elige abrir un expediente que ya tenía
// guardado en vez de repetir la búsqueda completa (ver formBuscar).
async function mostrarExpedienteGuardado(expediente) {
  const documentos = await db.obtenerDocumentos(expediente.cid);
  const fecha = expediente.fechaVerificacion ? new Date(expediente.fechaVerificacion).toLocaleString('es-AR') : 'desconocida';
  // exp.estado ('ok' | 'nuevo' | 'descargando') es lo último que se supo
  // la última vez que se chequeó contra el SCW (acá, o desde la
  // biblioteca) — no una verificación recién hecha, pero es lo mejor que
  // hay sin volver a tocar el SCW. 'nuevo' = ya se sabía de actuaciones
  // sin traer; cualquier otra cosa = al día según el último chequeo.
  const hayNovedadesConocidas = expediente.estado === 'nuevo';
  exp = {
    cid: expediente.cid,
    tabId: null, // no hay pestaña del SCW abierta en este camino: no vino de una búsqueda en vivo
    nombre: expediente.numero,
    caratula: expediente.caratula,
    folderName: expediente.folderName,
    tituloExpediente: expediente.caratula,
    archivos: documentos.map(d => ({ titulo: d.titulo, esHistorica: d.esHistorica, extension: d.extension, blob: d.blob })),
    // blob/extension: los módulos (ZIP, PDF unificado, EPUB) arman el
    // archivo con lo guardado, sin volver a pedirle nada al SCW.
    actuaciones: documentos.map(d => ({ titulo: d.titulo, fecha: d.fecha, tipo: d.tipo, descripcion: d.descripcion, esHistorica: d.esHistorica, urlPublica: d.urlHiper, extension: d.extension, blob: d.blob })),
    // Esto es lo que había guardado, no una consulta en vivo — el botón de
    // renderAvisoGuardado() (ver mostrarExpediente) trae novedades del SCW
    // sin salir de esta pantalla.
    desdeGuardado: true,
    aviso: hayNovedadesConocidas
      ? 'Hay actuaciones nuevas en el SCW sin traer' + (expediente.nuevasDetectadas ? ' (' + expediente.nuevasDetectadas + ')' : '') + ' — detectado el ' + fecha + '.'
      : 'Al día (última verificación: ' + fecha + ').',
    paginacionIncompleta: false, historicasFaltantes: false,
    // Ya no queda siempre vacío: se persiste desde guardarEnBiblioteca
    // (ver accionEnPestana() e index.js) — un expediente guardado ANTES
    // de este cambio no va a tenerlo hasta que se vuelva a guardar.
    vinculados: expediente.vinculados || [],
  };
  await mostrarExpediente();
}

// ─────────────────────────── "← Volver" desde el lector ───────────────────────────
// inicio.html?resultados=<cid>: mismo camino que mostrarExpedienteGuardado
// de arriba, pero disparado por la URL en vez de por una elección en el
// formulario de búsqueda.
(function restaurarDesdeRespaldo() {
  const numero = new URLSearchParams(location.search).get('restaurar');
  if (!numero) return;
  const clave = db.normalizarClaveExpediente(numero); // 'CIV|2425|2026|0'
  if (!clave) { estadoBuscar('No se reconoce el número "' + numero + '".', 'error'); return; }
  const [sigla, num, anio, inc] = clave.split('|');
  const valor = valorPorSigla(sigla);
  if (valor == null) { estadoBuscar('No se reconoce la jurisdicción "' + sigla + '".', 'error'); return; }
  $('jurisdiccion').value = String(valor);
  $('numero').value = num;
  $('anio').value = anio;
  $('incidente').value = inc !== '0' ? inc : '';
  restaurando = true;
  $('formBuscar').requestSubmit();
})();

(async function cargarDesdeGuardado() {
  const cid = new URLSearchParams(location.search).get('resultados');
  if (!cid) return;
  const expediente = await db.obtenerExpediente(cid);
  if (!expediente) { estadoBuscar('No se encontró "' + cid + '" en Mis expedientes.', 'error'); return; }
  await mostrarExpedienteGuardado(expediente);
})();

// Versión visible en el encabezado (sale del manifest: se actualiza sola en cada release).
document.querySelectorAll('[data-version-ext]').forEach(el => { el.textContent = 'v' + chrome.runtime.getManifest().version; });
