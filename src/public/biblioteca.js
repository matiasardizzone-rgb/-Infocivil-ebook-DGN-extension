// biblioteca.js — Pantalla de biblioteca + visor libro, con datos reales.
// Corre como script type="module" dentro de biblioteca.html (origen de la
// extensión), así que puede importar db.js directamente sin pasar por
// background.js — solo lo usamos para orquestar tabs del SCW (verificar/actualizar).

import * as db from '../lib/db.js';
import { registrar, instalarCaptura } from '../lib/registro.js';
import { verificarFirmaPDF } from '../lib/firma.js';
import { exportarRespaldo, importarRespaldo, tamanioPdfs } from '../lib/respaldo.js';
import { buscarEnPaginas, normalizarConMapa, normalizarConsulta, ocurrencias, rangoOriginal, esFojaSinTexto } from '../lib/busqueda.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');

// Registro técnico local: errores no atrapados de esta pantalla. Los errores
// que se le muestran al usuario se registran donde ocurren, sin títulos de
// actuaciones (pueden traer nombres de partes).
instalarCaptura('biblioteca');

const FLAG_COLORS = [
  { id: 'rojo', hex: '#c0392b' }, { id: 'ambar', hex: '#c78a1e' }, { id: 'verde', hex: '#2f7d4f' },
  { id: 'azul', hex: '#008080' }, { id: 'violeta', hex: '#6b4ba8' },
];

let expActivo = null;   // registro de db.js del expediente abierto
let docsDb = [];         // documentos crudos de IndexedDB (con blob)
// PDFs abiertos con pdf.js, solo los que se están mirando (y vecinos): un
// expediente de cientos de MB no entra entero en memoria. Ver obtenerPdf().
let cachePdf = new Map(); // di → Promise<PDFDocumentProxy>, en orden de uso (el último es el más reciente)
const MAX_PDF_ABIERTOS = 12;
let paginasPorDoc = [];   // di → cantidad de fojas (guardada en la base o contada una vez)
let generacionExp = 0;    // cambia al abrir otro expediente: corta tareas en segundo plano del anterior
let pages = [];          // aplanado: { di, p, doc, canvas:null } — en el orden de lectura ACTUAL
let pagesAsc = [];        // el mismo armado, siempre en orden cronológico real (para poder invertir sin rearmar nada)
let ordenInvertido = false; // false = cronológico (más vieja primero); true = de la más nueva a la más vieja
let flags = [];
let firmasPorDoc = [];   // { estado, firmas, detalle } | null (todavía no verificado) — indexado por di
let cur = 0, animating = false, selColor = FLAG_COLORS[0].id;
// Una página a la vez o dos enfrentadas — elegible por el operador
// (algunos monitores del fuero son cuadrados, no todos anchos).
let modoUnaPagina = false;
// Modo continuo: las fojas una debajo de la otra, con scroll, en vez del
// libro con paso de hoja. Se mantiene al abrir otro expediente.
let modoContinuo = false;
// Ajuste automático por defecto (null), no un porcentaje fijo: en una
// pantalla ancha, "100%" (tamaño real del PDF) deja la hoja chica con
// mucho margen vacío a los costados — lo pidió el operador explícitamente
// ("aprovechar al máximo la pantalla") después de ver el lector real en
// un monitor grande. El operador puede elegir 100% a mano desde el
// selector si lo prefiere en su pantalla — solo cambia el valor inicial.
let zoomManual = null;

// ─────────────────────────── BIBLIOTECA (grilla) ───────────────────────────
const libraryEl = document.getElementById('library');
const sceneEl   = document.getElementById('scene');
const libGrid   = document.getElementById('libGrid');

// Fichas "fantasma": las creaba una lectura fallida del SCW (sesión vencida,
// página que no era un expediente) — sin número reconocible y sin ningún
// documento. No hay nada que rescatar: se borran al listar. Una ficha con
// número válido pero sin PDFs (respaldo liviano importado) NO entra acá.
async function limpiarFichasVacias(expedientes) {
  const validos = [];
  for (const exp of expedientes) {
    const sinNumero = !db.normalizarClaveExpediente(exp.numero);
    if (sinNumero && exp.estado !== 'descargando' && !(await db.contarDocumentos(exp.cid))) {
      await db.eliminarExpediente(exp.cid).catch(() => {});
      continue;
    }
    validos.push(exp);
  }
  return validos;
}

async function cargarBiblioteca() {
  const expedientes = await limpiarFichasVacias(await db.listarExpedientes());
  mostrarEspacioTotal();
  document.getElementById('libCount').textContent =
    expedientes.length + ' guardado' + (expedientes.length !== 1 ? 's' : '');
  libGrid.innerHTML = '';

  if (!expedientes.length) {
    libGrid.innerHTML = `<div class="lib-empty">Todavía no guardaste ningún expediente.<br>
      Abrí uno en el SCW y usá "💾 Guardar en biblioteca" desde el popup de la extensión.</div>`;
    return;
  }

  expedientes.forEach(exp => {
    const card = document.createElement('div');
    card.className = 'lib-card' + (exp.estado === 'nuevo' ? ' new' : '');
    const avisoIni = textoEstado(exp.estado === 'nuevo' ? exp.nuevasDetectadas : 0, exp.eliminadasDetectadas || 0);
    card.innerHTML = `
      <div class="lib-card-info">
        <div class="lc-num">${esc(exp.numero || exp.cid)}</div>
        <div class="lc-title">${esc(exp.caratula || '(sin carátula detectada)')}</div>
        <div class="lc-meta">
          <span>${exp.cantidadActuaciones || 0} actuaciones</span>
          <span>· visto por última vez el ${fechaCorta(exp.fechaVerificacion || exp.fechaDescarga)}</span>
          <span class="lc-peso" data-peso>· …</span>
          <span class="lc-badge" data-badge${avisoIni ? '' : ' hidden'}>${esc(avisoIni)}</span>
        </div>
        <div class="lib-bar" style="display:none"><div class="lib-bar-fill" data-bar></div></div>
      </div>
      <div class="lc-actions">
        <button data-verify class="lc-icon" title="${exp.estado === 'nuevo' ? 'Actualizar biblioteca' : 'Chequear si hay novedades en el SCW'}">${exp.estado === 'nuevo' ? '⬇️' : '🔄'}</button>
        <button data-zip class="lc-icon" title="Exportar como ZIP">📦</button>
        <button data-open>Abrir</button>
        <button data-liberar class="lc-texto" title="Borrar los PDF guardados para liberar espacio. Se conservan la ficha y las banderitas; se vuelve a descargar del SCW al abrirlo." hidden>Liberar espacio</button>
        <button data-del class="lc-texto" title="Eliminar de la biblioteca">Quitar</button>
      </div>
    `;
    // Peso en este navegador. Sin documentos = respaldo liviano o espacio
    // liberado: hay ficha y banderitas, pero no PDFs.
    db.tamanioExpediente(exp.cid).then(t => {
      const peso = card.querySelector('[data-peso]');
      peso.textContent = '· ' + tamanioLegible(t.bytes);
      peso.title = 'PDF: ' + tamanioLegible(t.pdfs) + ' · texto para búsqueda: ' + tamanioLegible(t.texto);
      peso.classList.toggle('grande', t.bytes >= 100 * 1024 * 1024);
      card.querySelector('[data-liberar]').hidden = !t.documentos;
      if (t.documentos) return;
      fijarAviso(card.querySelector('[data-badge]'), 'Sin documentos — tocá Abrir para descargarlo del SCW');
      card.classList.add('new');
    });
    card.querySelector('[data-liberar]').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('¿Liberar el espacio de "' + (exp.caratula || exp.numero) + '"?\n\nSe borran los PDF guardados en este navegador. Se conservan la ficha y las banderitas, y al abrirlo se vuelve a descargar del SCW.')) return;
      await db.liberarDocumentos(exp.cid);
      cargarBiblioteca();
    });
    card.querySelector('[data-open]').addEventListener('click', e => { e.stopPropagation(); abrirExpediente(exp.cid); });
    card.addEventListener('click', () => abrirExpediente(exp.cid));
    card.querySelector('[data-verify]').addEventListener('click', e => {
      e.stopPropagation();
      exp.estado === 'nuevo' ? actualizarExpediente(exp, card) : verificarExpediente(exp, card);
    });
    card.querySelector('[data-zip]').addEventListener('click', async e => {
      e.stopPropagation();
      const btnZip = card.querySelector('[data-zip]');
      const original = btnZip.textContent;
      btnZip.textContent = '⏳'; btnZip.disabled = true;
      try { await exportarZip(exp); } catch (err) {
        registrar('error', 'biblioteca', 'No se pudo exportar el ZIP', { expediente: exp.numero, error: err.message });
        alert('No se pudo exportar: ' + err.message);
      }
      btnZip.textContent = original; btnZip.disabled = false;
    });
    card.querySelector('[data-del]').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('¿Eliminar "' + (exp.caratula || exp.numero) + '" de la biblioteca? Esto borra los PDFs guardados localmente.')) return;
      await db.eliminarExpediente(exp.cid);
      cargarBiblioteca();
    });
    libGrid.appendChild(card);
  });
}

// Uso real del almacenamiento de la extensión (lo que informa Chrome, incluye
// índices y espacio todavía no compactado — por eso puede diferir un poco de
// la suma de las tarjetas).
async function mostrarEspacioTotal() {
  const el = document.getElementById('libEspacio');
  try {
    const { usage } = await navigator.storage.estimate();
    el.textContent = '· ocupa ' + tamanioLegible(usage || 0);
  } catch (e) { el.textContent = ''; }
}

// Texto del aviso de novedades de una tarjeta. Las eliminadas se informan
// aparte: no son "nuevas", pero el operador tiene que enterarse.
function textoEstado(nuevas, eliminadas) {
  const partes = [];
  if (nuevas > 0) partes.push('🔴 ' + nuevas + (nuevas === 1 ? ' actuación nueva' : ' actuaciones nuevas'));
  if (eliminadas > 0) partes.push('⚠️ ' + eliminadas + (eliminadas === 1 ? ' ya no figura' : ' ya no figuran') + ' en el SCW');
  return partes.join(' · '); // vacío = al día, no se muestra nada (el aviso de novedades es la excepción, no el estado normal)
}

function fechaCorta(iso) {
  if (!iso) return '?';
  try { return new Date(iso).toLocaleDateString('es-AR'); } catch (e) { return iso; }
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Muestra/oculta el aviso de novedades de una tarjeta (texto vacío = al
// día, no se muestra nada — la excepción es la novedad, no el estado normal).
function fijarAviso(badge, texto) {
  badge.textContent = texto;
  badge.hidden = !texto;
}

// Verificar: abre (o reusa) la pestaña del SCW, escanea liviano, compara.
async function verificarExpediente(exp, card) {
  const badge = card.querySelector('[data-badge]');
  const btn = card.querySelector('[data-verify]');
  fijarAviso(badge, '⏳ Verificando en el SCW...');
  btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ action: 'bibliotecaVerificarEnVivo', cid: exp.cid });
    if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo verificar.');
    exp.estado = r.cambio ? 'nuevo' : 'ok';
    exp.nuevasDetectadas = r.nuevasDetectadas || 0;
    card.classList.toggle('new', r.cambio);
    exp.eliminadasDetectadas = r.eliminadasDetectadas || 0;
    fijarAviso(badge, textoEstado(r.nuevasDetectadas || 0, r.eliminadasDetectadas || 0));
    if (r.criterio === 'cantidad') badge.title = 'Comparado por cantidad de actuaciones (los links públicos no coincidieron).';
    btn.textContent = r.cambio ? '⬇️' : '🔄';
    btn.title = r.cambio ? 'Actualizar biblioteca' : 'Chequear si hay novedades en el SCW';
  } catch (err) {
    fijarAviso(badge, '❌ ' + err.message);
  }
  btn.disabled = false;
}

// Actualizar: igual que verificar, pero además dispara la descarga real
// de las actuaciones faltantes (reutiliza el flujo "guardarEnBiblioteca").
async function actualizarExpediente(exp, card) {
  const badge = card.querySelector('[data-badge]');
  const btn = card.querySelector('[data-verify]');
  const barWrap = card.querySelector('.lib-bar');
  const barFill = card.querySelector('[data-bar]');
  fijarAviso(badge, '⏳ Actualizando biblioteca...');
  btn.disabled = true;
  barWrap.style.display = 'block';

  try {
    const r = await chrome.runtime.sendMessage({ action: 'bibliotecaActualizarEnVivo', cid: exp.cid });
    if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo actualizar.');

    // Progreso real vía chrome.storage.local (el mismo canal que usa el popup)
    await new Promise(resolve => {
      const poll = setInterval(() => {
        chrome.storage.local.get(['descargaProgreso'], data => {
          const p = data.descargaProgreso;
          if (!p) return;
          const pct = p.total ? Math.round((p.descargados / p.total) * 100) : 0;
          barFill.style.width = pct + '%';
          if (p.terminado) { clearInterval(poll); resolve(); }
        });
      }, 500);
      setTimeout(() => { clearInterval(poll); resolve(); }, 120000); // tope de seguridad
    });

    const actualizado = await db.obtenerExpediente(exp.cid);
    exp.estado = 'ok'; exp.nuevasDetectadas = 0;
    exp.cantidadActuaciones = actualizado ? actualizado.cantidadActuaciones : exp.cantidadActuaciones;
    exp.fechaDescarga = actualizado ? actualizado.fechaDescarga : exp.fechaDescarga;
    exp.fechaVerificacion = actualizado ? actualizado.fechaVerificacion : exp.fechaVerificacion;
    card.classList.remove('new');
    fijarAviso(badge, '');
    btn.textContent = '🔄';
    btn.title = 'Chequear si hay novedades en el SCW';
    const meta = card.querySelector('.lc-meta');
    meta.querySelector('span:first-child').textContent = exp.cantidadActuaciones + ' actuaciones';
    meta.querySelectorAll('span')[1].textContent = '· visto por última vez el ' + fechaCorta(exp.fechaVerificacion || exp.fechaDescarga);
  } catch (err) {
    fijarAviso(badge, '❌ ' + err.message);
  }
  btn.disabled = false;
  barWrap.style.display = 'none';
}

document.getElementById('btnHome').addEventListener('click', () => { cargarBiblioteca(); mostrarBiblioteca(); });
document.getElementById('expteSwitch').addEventListener('click', () => { cargarBiblioteca(); mostrarBiblioteca(); });
document.getElementById('btnNuevaConsulta').addEventListener('click', async () => {
  // Vuelve al panel de opciones de ESTE expediente (Leer como libro / PDF
  // unificado / ZIP / vinculados) — no a una búsqueda en blanco. Lee de
  // Mis expedientes, sin pasar por el SCW de nuevo (ver cargarDesdeGuardado
  // en inicio.js).
  // En ESTA misma pestaña: el libro y su menú se turnan en la misma
  // pestaña ("Leer como libro" desde ese menú vuelve acá mismo, ver
  // abrirLibro en inicio.js). Antes buscaba otra pestaña de consulta con
  // chrome.tabs.query({ url: 'chrome-extension://…' }), que no matchea
  // (los patrones de URL no admiten ese esquema): abría una pestaña nueva
  // en cada "Volver" y se iban apilando.
  location.href = chrome.runtime.getURL('src/public/inicio.html') + '?resultados=' + encodeURIComponent(expActivo.cid);
});
// Módulo «PDF de actuaciones seleccionadas» (seleccion.html), en otra
// pestaña para no perder la hoja que se está leyendo. Llega con las
// actuaciones que tienen banderitas ya tildadas.
document.getElementById('btnSeleccion').addEventListener('click', () => {
  if (!expActivo) return;
  chrome.tabs.create({ url: chrome.runtime.getURL('src/public/seleccion.html') + '?cid=' + encodeURIComponent(expActivo.cid) + '&banderitas=1' });
});
document.getElementById('zoomSel').addEventListener('change', async function () {
  zoomManual = parseFloat(this.value);
  pages.forEach(p => { p.canvas = null; });
  await render(cur);
});
document.getElementById('btnFit').addEventListener('click', async () => {
  zoomManual = null; // vuelve al ajuste automático — SIEMPRE recalcula al tocarlo, sea cual sea el estado anterior
  pages.forEach(p => { p.canvas = null; });
  await render(cur);
});
document.getElementById('btnPaginas').addEventListener('click', async function () {
  // El ancho de la hoja cambia (una sola pasa a ocupar lo que antes
  // ocupaban dos): los canvases ya renderizados quedan con el tamaño
  // viejo, hay que recalcularlos contra el nuevo espacio disponible.
  pages.forEach(p => { p.canvas = null; });
  await cambiarModoPaginas(!modoUnaPagina);
  this.textContent = modoUnaPagina ? '📄 1 página' : '📖 2 páginas';
});
document.getElementById('btnDescargarDoc').addEventListener('click', () => {
  if (!pages[cur]) return;
  const doc = pages[cur].doc;
  const numero = String(pages[cur].di + 1).padStart(4, '0');
  const nombre = numero + ' - ' + sanitizarNombre(doc.titulo || 'documento') + (doc.extension || '.pdf');
  const url = URL.createObjectURL(doc.blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
document.getElementById('btnLimpiar').addEventListener('click', async () => {
  const expedientes = await db.listarExpedientes();
  if (!expedientes.length) return;
  if (!confirm('¿Eliminar TODOS los ' + expedientes.length + ' expedientes guardados en la biblioteca? Esto borra todos los PDFs locales y no se puede deshacer.')) return;
  for (const exp of expedientes) await db.eliminarExpediente(exp.cid);
  cargarBiblioteca();
});

// ─────────────────────────── RESPALDO ───────────────────────────
function estadoRespaldo(texto, error) {
  if (error && texto) registrar('error', 'respaldo', texto);
  const el = document.getElementById('respaldoEstado');
  el.textContent = texto || '';
  el.hidden = !texto;
  el.classList.toggle('error', !!error);
}
function tamanioLegible(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',') + ' GB';
}

const dlgRespaldo = document.getElementById('dlgRespaldo');
document.getElementById('btnExportarRespaldo').addEventListener('click', async () => {
  const expedientes = await db.listarExpedientes();
  if (!expedientes.length) { estadoRespaldo('No hay expedientes guardados para respaldar.', true); return; }
  document.getElementById('dlgTamanio').textContent = 'calculando…';
  dlgRespaldo.showModal();
  const t = await tamanioPdfs();
  document.getElementById('dlgTamanio').textContent = t.documentos + ' documentos, unos ' + tamanioLegible(t.bytes);
});
document.getElementById('dlgCancelar').addEventListener('click', () => dlgRespaldo.close());
document.getElementById('dlgExportar').addEventListener('click', async () => {
  const conPdfs = dlgRespaldo.querySelector('input[name="modoRespaldo"]:checked').value === 'completo';
  dlgRespaldo.close();
  const btn = document.getElementById('btnExportarRespaldo');
  btn.disabled = true;
  try {
    const r = await exportarRespaldo({
      conPdfs,
      onProgreso: (h, total, texto) => estadoRespaldo('⏳ Preparando respaldo… ' + Math.min(h + 1, total) + ' / ' + total + ' — ' + texto),
    });
    const hoy = new Date();
    const fecha = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');
    const nombre = 'infocivil-respaldo-' + fecha + (conPdfs ? '-completo' : '') + '.infocivil';
    const url = URL.createObjectURL(r.blob);
    await new Promise(res => chrome.downloads.download({ url, filename: nombre, saveAs: true }, res));
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    estadoRespaldo('✓ Respaldo ' + (conPdfs ? 'completo' : 'liviano') + ' listo: ' + r.expedientes + ' expedientes, ' +
      r.marcadores + ' banderitas' + (conPdfs ? ', ' + r.documentos + ' documentos' : '') + ' (' + tamanioLegible(r.blob.size) + '). Elegí dónde guardarlo.');
  } catch (err) {
    estadoRespaldo('❌ No se pudo exportar: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnImportarRespaldo').addEventListener('click', () => {
  const input = document.getElementById('archivoRespaldo');
  input.value = '';
  input.click();
});
document.getElementById('archivoRespaldo').addEventListener('change', async ev => {
  const archivo = ev.target.files && ev.target.files[0];
  if (!archivo) return;
  const btn = document.getElementById('btnImportarRespaldo');
  btn.disabled = true;
  try {
    const r = await importarRespaldo(archivo, {
      onProgreso: (h, total, texto) => estadoRespaldo('⏳ Importando… ' + Math.min(h + 1, total) + ' / ' + total + ' — ' + texto),
    });
    let msg = '✓ Respaldo importado: ' + r.expedientes + ' expedientes (' + r.nuevos + ' nuevos, ' + r.fusionados + ' ya estaban), ' +
      r.documentos + ' documentos y ' + r.marcadores + ' banderitas agregados.';
    if (r.sinDocumentos) msg += ' ' + r.sinDocumentos + ' quedaron sin documentos: abrilos para descargarlos del SCW.';
    estadoRespaldo(msg);
    cargarBiblioteca();
  } catch (err) {
    estadoRespaldo('❌ No se pudo importar: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

function mostrarBiblioteca() {
  libraryEl.style.display = 'flex'; sceneEl.style.display = 'none';
  try { if (location.search) history.replaceState(null, '', location.pathname); } catch (e) {}
  // Fuera del libro no hace falta tener PDFs abiertos ni seguir verificando firmas.
  generacionExp++;
  cerrarPdfsAbiertos();
}
function mostrarLibro()      { libraryEl.style.display = 'none'; sceneEl.style.display = 'flex'; }

// ─────────────────────────── ABRIR EXPEDIENTE (real) ───────────────────────────
async function abrirExpediente(cid) {
  try {
    expActivo = await db.obtenerExpediente(cid);
    if (!expActivo) { alert('No se encontró ese expediente en la biblioteca (cid=' + cid + ').'); return; }
    docsDb = await db.obtenerDocumentos(cid);
    if (!docsDb.length) {
      // Típico de un respaldo liviano importado: la ficha y las banderitas
      // están, los PDFs no. El cid guardado no sirve para volver al SCW
      // (identifica una consulta vieja), así que se busca de nuevo por
      // número; al guardarlo, fusionarDuplicadosPorNumero le pasa las
      // banderitas al expediente recién descargado.
      if (confirm('"' + (expActivo.numero || expActivo.caratula) + '" no tiene los documentos guardados en esta PC (por ejemplo, porque se restauró de un respaldo liviano).\n\n¿Buscarlo ahora en el SCW para descargarlo? Las banderitas se conservan.')) {
        location.href = chrome.runtime.getURL('src/public/inicio.html?restaurar=' + encodeURIComponent(expActivo.numero || ''));
      }
      return;
    }

    // Las fojas se dibujan recién cuando se ven (renderCanvas → obtenerPdf).
    // Un documento con blob vacío o dañado no tira abajo el expediente: se
    // anota en erroresParse y se avisa después de mostrar el libro.
    cerrarPdfsAbiertos();
    const generacion = ++generacionExp;
    paginasPorDoc = new Array(docsDb.length).fill(0);
    pages = [];
    const erroresParse = []; // { di, doc, mensaje }
    // Cantidad de fojas: se guarda al sincronizar (background) o la primera
    // vez que se abre el libro. Solo los documentos que todavía no la tienen
    // se leen con pdf.js acá, de a 4, y se cierran enseguida (no quedan en
    // memoria). Antes se leían y quedaban abiertos TODOS los PDF del
    // expediente en cada apertura — con 850 MB eso eran minutos.
    const faltan = [];
    docsDb.forEach((d, di) => {
      if (!d.blob) erroresParse.push({ di, doc: d, mensaje: 'sin contenido guardado (blob vacío)' });
      else if (Number.isInteger(d.numPaginas) && d.numPaginas > 0) paginasPorDoc[di] = d.numPaginas;
      else faltan.push(di);
    });
    if (faltan.length) {
      let hechos = 0, sig = 0;
      async function workerContar() {
        while (sig < faltan.length) {
          const di = faltan[sig++], doc = docsDb[di];
          try {
            const buffer = await doc.blob.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: buffer, isEvalSupported: false, useSystemFonts: true }).promise;
            paginasPorDoc[di] = pdf.numPages;
            doc.numPaginas = pdf.numPages;
            pdf.destroy();
            if (doc.id != null) db.guardarMetaDocumento(doc.id, { numPaginas: pdf.numPages }).catch(() => {});
          } catch (err) {
            console.error('[PJN Biblioteca] No se pudo parsear el documento', di, doc && doc.titulo, err);
            erroresParse.push({ di, doc, mensaje: (err && err.message) || String(err) });
          }
          hechos++;
          avisoApertura('Preparando el expediente (solo la primera vez)… ' + hechos + ' / ' + faltan.length + ' actuaciones');
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, faltan.length) }, workerContar));
      avisoApertura('');
    }
    if (generacion !== generacionExp) return; // se abrió otro expediente mientras tanto
    for (let di = 0; di < docsDb.length; di++) {
      const n = paginasPorDoc[di], doc = docsDb[di];
      for (let p = 1; p <= n; p++) pages.push({ di, p, doc, canvas: null, textLayer: null });
    }
    if (!pages.length) {
      throw new Error('Ningún documento de este expediente se pudo leer (' + erroresParse.length +
        ' con error). El primero: "' + (erroresParse[0].doc.titulo || erroresParse[0].doc.tipo || 'sin título') +
        '" — ' + erroresParse[0].mensaje);
    }
    // Cada expediente se abre siempre en orden cronológico, aunque el
    // anterior haya quedado invertido — pagesAsc es la referencia para
    // poder ir y volver sin rearmar nada (ver invertirOrdenLectura()).
    pagesAsc = pages;
    ordenInvertido = false;
    const btnInv = document.getElementById('btnInvertir');
    btnInv.classList.remove('on');
    btnInv.title = 'Leer de la actuación más nueva a la más vieja';

    flags = await cargarBanderitas(cid);
    reiniciarBusqueda();
    cur = 0;
    firmasPorDoc = docsDb.map(() => null);

    document.getElementById('expteNum').textContent = expActivo.numero || expActivo.cid;
    // La dirección de esta pestaña dice qué expediente muestra (cid + número
    // normalizado): así "Leer como libro" desde el menú encuentra esta
    // pestaña aunque el expediente se haya vuelto a consultar en el SCW y
    // tenga otro cid.
    try {
      const claveNum = db.normalizarClaveExpediente(expActivo.numero || '');
      history.replaceState(null, '', '?abrir=' + encodeURIComponent(cid) + (claveNum ? '&exp=' + encodeURIComponent(claveNum) : ''));
    } catch (e) {}
    buildIndex();
    mostrarLibro();
    await render(0);
    renderFlags();
    verificarFirmasEnSegundoPlano(); // no bloquea: actualiza badges a medida que termina cada una

    // Falla parcial (al menos un documento se pudo leer): se avisa después
    // de mostrar el libro, sin bloquear la apertura de los que sí andan.
    if (erroresParse.length) {
      registrar('aviso', 'biblioteca', 'Documentos que no se pudieron leer al abrir el expediente',
        { expediente: expActivo && expActivo.numero, cantidad: erroresParse.length, errores: erroresParse.map(e => e.mensaje) });
      const lista = erroresParse.map(e => '· ' + (e.doc.titulo || e.doc.tipo || 'sin título') + ': ' + e.mensaje).join('\n');
      alert('⚠️ Se abrió el expediente, pero ' + erroresParse.length + ' documento(s) no se pudieron leer ' +
        'y quedaron afuera del libro:\n\n' + lista +
        '\n\nProbá "🔄 Chequear novedades" desde la biblioteca para volver a descargarlos.');
    }
  } catch (err) {
    console.error('[PJN Biblioteca] Error al abrir expediente:', err);
    registrar('error', 'biblioteca', 'No se pudo abrir el expediente', { cid, error: err && err.message ? err.message : String(err) });
    alert('❌ No se pudo abrir el expediente:\n\n' + (err && err.message ? err.message : err) +
      '\n\nRevisá la consola (clic derecho → Inspeccionar → Console) para más detalle.');
  }
}

// ─────────────────────────── ÍNDICE ───────────────────────────
// El riel angosto de pestañas (una por actuación, con el cordón rojo
// decorativo al lado) se sacó: quedaba redundante con el panel de
// índice, que ya hace lo mismo con más información (título completo,
// fecha) y siempre visible.
const idxList = document.getElementById('idxList');
function buildIndex() {
  idxList.innerHTML = '';
  document.getElementById('idxCount').textContent = docsDb.length + ' actuaciones · ' + pages.length + ' fojas';
  docsDb.forEach((d, di) => {
    const it = document.createElement('div');
    it.className = 'index-item' + (d.esHistorica ? ' hist' : '');
    it.dataset.di = di;
    it.dataset.buscar = (String(di + 1) + ' ' + (d.tipo || '') + ' ' + (d.titulo || '') + ' ' + (d.fecha || '')).toLowerCase();
    it.innerHTML = `<span class="index-num">${String(di + 1).padStart(3, '0')}</span>` +
      `<div class="index-body">` +
      (d.tipo ? `<div class="index-tipo">${esc(d.tipo)}</div>` : '') +
      `<div class="index-desc">${esc(d.titulo)}</div>` +
      (d.fecha ? `<div class="index-fecha">${esc(d.fecha)}</div>` : '') +
      `</div>`;
    it.addEventListener('click', () => irADoc(di)); // el panel es fijo ahora: no se cierra solo al navegar
    idxList.appendChild(it);
  });
}

// Buscador del índice: filtra por número, tipo, título o fecha a medida
// que se escribe — no hace falta salir del índice ni pasar de página.
document.getElementById('idxSearch').addEventListener('input', function () {
  const q = this.value.trim().toLowerCase();
  document.querySelectorAll('.index-item').forEach(it => {
    it.classList.toggle('filtrado', !!q && !it.dataset.buscar.includes(q));
  });
});

// ─────────────────────────── FIRMA ELECTRÓNICA ───────────────────────────
// Abre (o reusa) el PDF de una actuación. Se mantienen abiertos los últimos
// MAX_PDF_ABIERTOS usados; el más viejo se cierra unos segundos después de
// salir de la lista (por si todavía se está dibujando una foja suya).
function obtenerPdf(di) {
  let p = cachePdf.get(di);
  if (p) { cachePdf.delete(di); cachePdf.set(di, p); return p; }
  const doc = docsDb[di];
  p = (async () => {
    if (!doc || !doc.blob) throw new Error('sin contenido guardado');
    const buffer = await doc.blob.arrayBuffer();
    return pdfjsLib.getDocument({ data: buffer, isEvalSupported: false, useSystemFonts: true }).promise;
  })();
  cachePdf.set(di, p);
  p.catch(() => { if (cachePdf.get(di) === p) cachePdf.delete(di); });
  while (cachePdf.size > MAX_PDF_ABIERTOS) {
    const [viejoDi, viejo] = cachePdf.entries().next().value;
    cachePdf.delete(viejoDi);
    setTimeout(() => viejo.then(pdf => pdf.destroy()).catch(() => {}), 8000);
  }
  return p;
}

function cerrarPdfsAbiertos() {
  for (const p of cachePdf.values()) p.then(pdf => pdf.destroy()).catch(() => {});
  cachePdf = new Map();
}

// Aviso mientras se prepara un expediente por primera vez (o vacío para sacarlo).
function avisoApertura(texto) {
  let el = document.getElementById('avisoApertura');
  if (!el) {
    el = document.createElement('div');
    el.id = 'avisoApertura';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;background:#006e6e;color:#fff;' +
      'padding:10px 18px;border-radius:8px;font:13px Segoe UI,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    document.body.appendChild(el);
  }
  el.textContent = texto;
  el.style.display = texto ? '' : 'none';
}

async function verificarFirmasEnSegundoPlano() {
  const generacion = generacionExp, docs = docsDb;
  for (let di = 0; di < docs.length; di++) {
    if (generacion !== generacionExp) return; // se abrió otro expediente
    const doc = docs[di];
    // La firma de una actuación guardada no cambia: se verifica una vez y el
    // resultado queda en la base (se descarta si el documento se vuelve a bajar).
    if (doc.firma && doc.firma.estado && doc.firma.estado !== 'error') {
      firmasPorDoc[di] = doc.firma;
      actualizarBadgeFirma(di);
      continue;
    }
    try {
      const buffer = await doc.blob.arrayBuffer();
      firmasPorDoc[di] = await verificarFirmaPDF(buffer);
      if (firmasPorDoc[di].estado !== 'error' && doc.id != null) {
        doc.firma = firmasPorDoc[di];
        db.guardarMetaDocumento(doc.id, { firma: firmasPorDoc[di] }).catch(() => {});
      }
    } catch (err) {
      firmasPorDoc[di] = { estado: 'error', firmas: [], detalle: err.message };
    }
    if (generacion !== generacionExp) return;
    // actualizarBadgeFirma ya recorre las hojas visibles (izq. y der.) y
    // no hace nada si ninguna es de este documento — no hace falta
    // filtrar acá primero (antes solo miraba la izquierda, y la firma de
    // la derecha podía quedar sin actualizar).
    actualizarBadgeFirma(di);
  }
}

function etiquetaFirma(resultado) {
  if (!resultado) return { cls: 'checking', texto: '⏳ Verificando firma...', title: '' };
  if (resultado.estado === 'sin_firma') return { cls: 'none', texto: '— Sin firma', title: resultado.detalle };
  if (resultado.estado === 'no_detectable') return { cls: 'bad', texto: '❓ Firma no verificable', title: resultado.detalle };
  if (resultado.estado === 'valida') {
    const f = resultado.firmas[0] || {};
    return { cls: 'ok', texto: '✅ Firma válida', title: 'Firmante: ' + (f.firmante || '?') + ' · Emisor: ' + (f.emisor || '?') };
  }
  if (resultado.estado === 'invalida') return { cls: 'bad', texto: '⚠️ Revisar firma', title: resultado.detalle };
  return { cls: 'bad', texto: '❓ No se pudo verificar', title: resultado.detalle };
}

function iconoFirma(et) {
  const m = et.texto.match(/^(\S+)/);
  return m ? m[1] : '—';
}

// Actualiza el iconito de firma de CUALQUIER hoja visible (izq. o der.,
// en cualquiera de las dos caras) que pertenezca al documento 'di' —
// puede haber hasta dos a la vez si el par cruza dos actuaciones y una
// de ellas es justo esta.
function actualizarBadgeFirma(di) {
  const et = etiquetaFirma(firmasPorDoc[di]);
  document.querySelectorAll('.leaf-col').forEach(col => {
    const idx = col.dataset.pagina === '' ? null : +col.dataset.pagina;
    if (idx === null || !pages[idx] || pages[idx].di !== di) return;
    const el = col.querySelector('.lh-firma');
    el.className = 'lh-firma ' + et.cls;
    el.textContent = iconoFirma(et);
    el.title = et.texto + (et.title ? ' — ' + et.title : '');
  });
}

// ─────────────────────────── RENDER DE PÁGINA (lazy) ───────────────────────────
const spread3d = document.getElementById('spread3d');
const caraA = document.getElementById('caraA');
const caraB = document.getElementById('caraB');
const stageEl = document.getElementById('stage');

async function renderCanvas(idx) {
  const pg = pages[idx];
  if (pg.canvas) return pg; // ya renderizado, lo reusamos
  let page;
  try {
    const pdf = await obtenerPdf(pg.di);
    page = await pdf.getPage(pg.p);
  } catch (err) {
    // PDF dañado o que no se pudo leer: hoja con aviso, sin cortar el libro.
    console.warn('[PJN Biblioteca] No se pudo leer la foja', pg.di, pg.p, err);
    registrar('aviso', 'biblioteca', 'No se pudo mostrar una foja', { actuacion: pg.di + 1, foja: pg.p, error: err && err.message });
    const c = document.createElement('canvas');
    c.width = 600; c.height = 840;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#b3261e'; ctx.font = '20px Segoe UI, Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No se pudo leer esta foja.', 300, 400);
    ctx.fillText('Probá "Chequear novedades" para volver a descargarla.', 300, 432);
    pg.canvas = c; pg.textLayerEl = null; pg.escala = 1;
    return pg;
  }

  // Escala dinámica: aprovechamos el espacio real disponible de UNA hoja
  // (la mitad del libro, no el libro entero) en vez de un zoom fijo, así
  // se ve grande en pantallas grandes y entera en chicas. Solo tiene
  // sentido cuando el stage ya está en el DOM medible.
  const base = page.getViewport({ scale: 1 });
  let scale;
  if (zoomManual) {
    scale = zoomManual;
  } else {
    scale = 1.4;
    if (stageEl && stageEl.clientWidth > 80 && stageEl.clientHeight > 40) {
      const margen = 0.95;
      const anchoHoja = (modoUnaPagina || modoContinuo) ? stageEl.clientWidth : stageEl.clientWidth / 2;
      scale = Math.min((anchoHoja * margen) / base.width, (stageEl.clientHeight * margen) / base.height);
      scale = Math.max(0.5, Math.min(scale, 2.6));
    }
  }

  const vp = page.getViewport({ scale });
  pg.escala = scale; // para la capa de texto (--scale-factor, ver pintarHoja)
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  pg.canvas = canvas;

  // Capa de texto invisible superpuesta al canvas, para poder seleccionar
  // y copiar texto — antes el libro solo mostraba una imagen (el canvas
  // renderizado), sin nada seleccionable. Se guarda ya armada en
  // pg.textLayerEl y pintarHoja() la clona igual que ya hacía con el
  // canvas, para no tener que rearmarla en cada vuelta de hoja.
  try {
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    const textContent = await page.getTextContent();
    await pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport: vp }).promise;
    pg.textLayerEl = textLayerDiv;
  } catch (err) {
    console.warn('[PJN Biblioteca] No se pudo armar la capa de texto de la página (queda sin selección):', err);
    pg.textLayerEl = null;
  }
  return pg;
}

// Copia los píxeles ya renderizados a un canvas nuevo (barato: no vuelve a
// dibujar el PDF) — hace falta porque el MISMO <canvas> no puede estar a
// la vez en la hoja "de reposo" y en la hoja "en tránsito" mientras gira.
function clonarCanvas(origen) {
  const c = document.createElement('canvas');
  c.width = origen.width; c.height = origen.height;
  c.getContext('2d').drawImage(origen, 0, 0);
  return c;
}

// Pinta UNA hoja (columna izquierda o derecha) dentro de una cara: su
// canvas, referencia (actuación · título · página), firma, bandera y
// enlace público propios — cada hoja es autosuficiente, no depende de la
// otra (pueden ser de actuaciones distintas).
// Capa de texto alineada con el dibujo. pdf.js 3.x dimensiona la letra
// con la variable CSS --scale-factor (sin ella, la selección y el
// resaltado de búsqueda salen corridos). Además el CSS puede achicar la
// página para que entre (max-width/max-height:100% del .page-box), y no
// siempre en la misma proporción en ancho y alto (por ejemplo, al abrir
// un panel lateral): la capa se arma al tamaño nativo del canvas y se
// escala igual que él. Un ResizeObserver la reajusta si cambia el lugar.
const observadorCapas = new ResizeObserver(entradas => entradas.forEach(e => ajustarCapaTexto(e.target)));
function ajustarCapaTexto(box) {
  const capa = box.querySelector('.textLayer');
  const canvas = box.querySelector('canvas');
  const escala = +box.dataset.escala;
  if (!capa || !canvas || !escala) return;
  const r = box.getBoundingClientRect();
  if (!r.width || !r.height) return;
  capa.style.setProperty('--scale-factor', String(escala));
  capa.style.right = 'auto'; capa.style.bottom = 'auto';
  capa.style.width = canvas.width + 'px';
  capa.style.height = canvas.height + 'px';
  capa.style.transformOrigin = '0 0';
  capa.style.transform = 'scale(' + (r.width / canvas.width) + ',' + (r.height / canvas.height) + ')';
}

function pintarHoja(colEl, pg, indice) {
  const wrap = colEl.querySelector('.pdf-canvas-wrap');
  const anterior = wrap.querySelector('.page-box');
  if (anterior) observadorCapas.unobserve(anterior);
  wrap.innerHTML = '';
  colEl.dataset.pagina = indice === null ? '' : String(indice);
  colEl.dataset.url = '';
  colEl.classList.toggle('vacia', !pg);
  colEl.querySelector('.leaf-head').style.visibility = pg ? '' : 'hidden';
  colEl.querySelector('.leaf-foot').style.visibility = pg ? '' : 'hidden';
  if (!pg) return;

  // La caja se arma con el tamaño en px NATIVO del canvas (pg.canvas.width
  // x .height, la resolución interna a la escala elegida, no el tamaño
  // final en pantalla) — canvas y textLayer adentro van al 100%/100%,
  // así que el .page-box entero se achica como UNA sola unidad vía
  // max-width/max-height:100% del CSS (ver biblioteca.html). Eso
  // garantiza que la capa de texto quede exactamente encima del canvas
  // a cualquier zoom, sin tener que medir nada por JS.
  const box = document.createElement('div');
  box.className = 'page-box';
  box.dataset.escala = String(pg.escala || 0);
  box.style.width = pg.canvas.width + 'px';
  box.style.height = pg.canvas.height + 'px';
  box.appendChild(clonarCanvas(pg.canvas));
  if (pg.textLayerEl) box.appendChild(pg.textLayerEl.cloneNode(true));
  wrap.appendChild(box);
  // pdf.js 3.x dimensiona la letra de la capa de texto con la variable CSS
  // --scale-factor; sin ella la letra queda en el tamaño por defecto y la
  // selección (y el resaltado de búsqueda) sale corrida respecto del
  // dibujo. Se multiplica por cuánto achicó el CSS la página en pantalla
  // (max-width/max-height:100% del .page-box).
  ajustarCapaTexto(box);
  observadorCapas.observe(box);
  if (busq.consulta) resaltarEnHoja(box, pg);
  const doc = pg.doc;
  const ref = colEl.querySelector('.lh-ref');
  ref.textContent = `Act. ${pg.di + 1} · ${doc.titulo} · pág ${pg.p}`;
  ref.title = ref.textContent;
  colEl.querySelector('.lh-flag').classList.toggle('on', flags.some(f => f.page === indice));

  const url = doc.urlHiper || '';
  colEl.dataset.url = url;
  colEl.querySelector('.lf-url').textContent = url.replace('https://', '');

  const et = etiquetaFirma(firmasPorDoc[pg.di]);
  const fEl = colEl.querySelector('.lh-firma');
  fEl.className = 'lh-firma ' + et.cls;
  fEl.textContent = iconoFirma(et);
  fEl.title = et.texto + (et.title ? ' — ' + et.title : '');
}

// Dibuja el par de páginas (i, i+1) dentro de una de las dos caras del
// spread (caraA o caraB). Devuelve la página izquierda (la "focal", la que
// manda en el índice y en counter/prev/next).
// Cuántas fojas hay en un "salto" de página: dos enfrentadas, o una sola
// si el operador eligió el modo de una página (monitores angostos/cuadrados).
function paso() { return (modoUnaPagina || modoContinuo) ? 1 : 2; }

async function pintarSpreadEnCara(caraEl, i) {
  const pgL = pages[i] || null;
  const pgR = modoUnaPagina ? null : (pages[i + 1] || null);
  caraEl.classList.toggle('una-pagina', modoUnaPagina);
  await Promise.all([pgL, pgR].filter(Boolean).map(pg => renderCanvas(pages.indexOf(pg))));
  pintarHoja(caraEl.querySelector('[data-lado="l"]'), pgL, pgL ? i : null);
  pintarHoja(caraEl.querySelector('[data-lado="r"]'), pgR, pgR ? i + 1 : null);
  return pgL;
}

function actualizarCabeceraPieControles(i, pgL) {
  cur = i;
  const pgR = modoUnaPagina ? null : (pages[i + 1] || null);

  const hayDerecha = !!pgR;
  document.getElementById('counter').textContent = hayDerecha
    ? `fs. ${i + 1}-${i + 2} / ${pages.length}`
    : `fs. ${i + 1} / ${pages.length}`;
  document.getElementById('btnPrev').disabled = i <= 0;
  document.getElementById('btnNext').disabled = i + paso() >= pages.length;
  document.getElementById('btnPrimera').disabled = i <= 0;
  document.getElementById('btnUltima').disabled = i + paso() >= pages.length;
  document.querySelectorAll('.index-item').forEach(t => {
    const di = +t.dataset.di;
    t.classList.toggle('on', di === pgL.di || (pgR && di === pgR.di));
  });
  document.getElementById('btnFlag')?.classList.toggle('on', flags.some(f => f.page === i));

  // Precarga silenciosa de lo que sigue para que el siguiente "pasar
  // hoja" sea instantáneo — no bloquea nada de lo de arriba.
  if (i + paso() < pages.length) renderCanvas(i + paso());
  if (!modoUnaPagina && i + paso() + 1 < pages.length) renderCanvas(i + paso() + 1);
}

// Primera carga, o saltos sin animación de vuelta de hoja (por ejemplo,
// al abrir el expediente): siempre queda pintado en caraA, en reposo.
async function render(i) {
  if (modoContinuo) return mostrarContinuo(i);
  const objetivo = modoUnaPagina ? i : i - (i % 2);
  const pgL = await pintarSpreadEnCara(caraA, objetivo);
  actualizarCabeceraPieControles(objetivo, pgL);
}

function ultimoIzquierdoValido() {
  if (modoUnaPagina) return pages.length - 1;
  return pages.length % 2 === 0 ? pages.length - 2 : pages.length - 1;
}

// Cambia entre dos páginas enfrentadas y una sola — sin animación de
// vuelta de hoja (es un cambio de disposición, no de lugar en el libro).
async function cambiarModoPaginas(unaSola) {
  if (modoUnaPagina === unaSola) return;
  modoUnaPagina = unaSola;
  await render(cur);
}

// Invierte el sentido de lectura: de la actuación más vieja a la más
// nueva (cronológico, el orden real del expediente) o al revés. No
// rearma nada — pagesAsc guarda siempre el orden cronológico, así que
// invertir es solo tomar esa lista (o darla vuelta) y volver a mostrar
// la misma hoja que se estaba viendo, ahora en su nueva posición.
//
// Los marcadores (flags) se anclan por actuación+foja EN LA BASE (no por
// posición absoluta), pero cargarBanderitas() les calcula una posición
// absoluta (.page) en memoria a partir del orden ACTUAL de "pages" — al
// invertir, esas posiciones quedan mal (apuntan al orden viejo), así que
// hay que recalcularlas de nuevo contra el nuevo orden, no alcanza con
// mover el array de páginas solo.
async function invertirOrdenLectura() {
  if (animating || !pages.length) return;
  const pgActual = pages[cur];
  ordenInvertido = !ordenInvertido;
  pages = ordenInvertido ? pagesAsc.slice().reverse() : pagesAsc;
  const btn = document.getElementById('btnInvertir');
  btn.classList.toggle('on', ordenInvertido);
  btn.title = ordenInvertido
    ? 'Leyendo de la actuación más nueva a la más vieja — tocar para volver al orden cronológico'
    : 'Leer de la actuación más nueva a la más vieja';
  const nuevoIdx = pgActual ? pages.findIndex(pg => pg.di === pgActual.di && pg.p === pgActual.p) : 0;
  flags = await cargarBanderitas(expActivo.cid);
  await render(Math.max(0, nuevoIdx));
  renderFlags();
}
document.getElementById('btnInvertir').addEventListener('click', invertirOrdenLectura);

function esperarTransicion(el) {
  return new Promise(resolve => {
    const fin = (e) => { if (e.target !== el) return; el.removeEventListener('transitionend', fin); resolve(); };
    el.addEventListener('transitionend', fin);
    setTimeout(resolve, 320); // red de seguridad si transitionend no llega a disparar
  });
}

async function goTo(iSolicitado, dir) {
  if (modoContinuo) { irAFojaContinuo(iSolicitado); return; }
  if (animating) return;
  const alineado = modoUnaPagina ? iSolicitado : iSolicitado - (iSolicitado % 2);
  const objetivo = Math.max(0, Math.min(alineado, ultimoIzquierdoValido()));
  if (objetivo === cur) return;
  animating = true;
  try {
    const avanza = objetivo > cur;
    // El destino se dibuja en caraB (invisible) MIENTRAS el operador
    // todavía ve caraA — nunca hay un hueco en blanco esperando.
    const pgL = await pintarSpreadEnCara(caraB, objetivo);

    // 1) La hoja actual se desliza y se desvanece hacia el lado por el
    //    que "se pasa" (adelante → sale por la izquierda, como si diera
    //    vuelta; atrás → por la derecha).
    caraA.classList.add(avanza ? 'sale-izq' : 'sale-der');
    await esperarTransicion(caraA);

    // 2) Se copia el contenido de caraB a caraA (barato: son canvases ya
    //    renderizados, no se vuelve a dibujar el PDF) y se la reubica AL
    //    INSTANTE del lado opuesto, sin animar — recién ahí se le saca
    //    esa clase, así la transición que sigue la trae deslizando desde
    //    el lado contrario al que salió la hoja vieja.
    await pintarSpreadEnCara(caraA, objetivo);
    caraA.style.transition = 'none';
    caraA.classList.remove('sale-izq', 'sale-der');
    caraA.classList.add(avanza ? 'entra-der' : 'entra-izq');
    void caraA.offsetWidth; // forzar reflow antes de reactivar la transición
    caraA.style.transition = '';
    caraA.classList.remove('entra-der', 'entra-izq');
    await esperarTransicion(caraA);

    actualizarCabeceraPieControles(objetivo, pgL);
  } catch (e) {
    console.error('[PJN Biblioteca] Error pasando de hoja:', e);
  } finally {
    animating = false;
  }
}

function irADoc(di) {
  const firstIdx = pages.findIndex(pg => pg.di === di);
  if (firstIdx >= 0) goTo(firstIdx, firstIdx > cur ? 'next' : 'prev');
}

document.getElementById('btnPrev').addEventListener('click', () => goTo(cur - paso(), 'prev'));
document.getElementById('btnNext').addEventListener('click', () => goTo(cur + paso(), 'next'));
// Saltar directo a la primera/última foja — mismo destino que ya hacían
// las teclas Home/End (ver el listener de keydown más abajo), ahora
// también como botón visible.
document.getElementById('btnPrimera').addEventListener('click', () => goTo(0, 'prev'));
document.getElementById('btnUltima').addEventListener('click', () => goTo(pages.length - 1, 'next'));
document.getElementById('navL').addEventListener('click', () => goTo(cur - paso(), 'prev'));
document.getElementById('navR').addEventListener('click', () => goTo(cur + paso(), 'next'));
document.addEventListener('keydown', e => {
  if (!expActivo || sceneEl.style.display === 'none') return;
  if (e.key === 'ArrowRight') goTo(cur + paso(), 'next');
  else if (e.key === 'ArrowLeft') goTo(cur - paso(), 'prev');
  else if (e.key === 'Home') goTo(0, 'prev');
  else if (e.key === 'End') goTo(pages.length - 1, 'next');
  else if (e.key === 'Escape') { if (!busqPanel.classList.contains('closed')) cerrarBusqueda(); else cerrarIndice(); }
});

// ─────────────────────────── BÚSQUEDA DE TEXTO ───────────────────────────
// Primera búsqueda en un expediente: se extrae el texto de todas las fojas
// con pdf.js (los mismos PDFs ya abiertos para el libro) y se guarda en
// cada documento (db.guardarTextosDocumento) — la próxima vez que se abra
// el expediente, buscar es instantáneo. Las fojas escaneadas no tienen
// texto (no hay OCR): se cuentan y se avisa, para que "no encontrado" no
// se lea como "no está en el expediente".
const busqPanel = document.getElementById('busqPanel');
const busqInput = document.getElementById('busqInput');
const busqLista = document.getElementById('busqLista');
const busqEstadoEl = document.getElementById('busqEstado');
let busq = { consulta: '', resultados: [], actual: -1, indexando: null };
let textosPorDoc = null; // [di] → [texto foja 1, foja 2, …] | null si el documento no se pudo abrir

function reiniciarBusqueda() {
  textosPorDoc = null;
  busq = { consulta: '', resultados: [], actual: -1, indexando: null };
  busqInput.value = '';
  busqLista.innerHTML = '';
  busqEstadoEl.textContent = '';
  actualizarFlechasBusqueda();
}

function abrirBusqueda() {
  busqPanel.classList.remove('closed');
  setTimeout(() => { busqInput.focus(); busqInput.select(); }, 50);
}
function cerrarBusqueda() {
  busqPanel.classList.add('closed');
  busq.consulta = '';
  busq.resultados = [];
  busq.actual = -1;
  resaltarVisibles();
}
document.getElementById('btnBuscarTexto').addEventListener('click', () =>
  busqPanel.classList.contains('closed') ? abrirBusqueda() : cerrarBusqueda());
document.getElementById('busqClose').addEventListener('click', cerrarBusqueda);
document.addEventListener('keydown', e => {
  if (!expActivo || sceneEl.style.display === 'none') return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); abrirBusqueda(); }
});

async function asegurarTextos() {
  if (textosPorDoc) return textosPorDoc;
  if (busq.indexando) return busq.indexando;
  busq.indexando = (async () => {
    const totalFojas = pagesAsc.length;
    let hechas = 0;
    const textos = new Array(docsDb.length).fill(null);
    for (let di = 0; di < docsDb.length; di++) {
      const n = paginasPorDoc[di], doc = docsDb[di];
      if (!n) continue;
      if (Array.isArray(doc.textoPaginas) && doc.textoPaginas.length === n) {
        textos[di] = doc.textoPaginas;
        hechas += n;
        continue;
      }
      let pdf;
      try { pdf = await obtenerPdf(di); } catch (err) { textos[di] = new Array(n).fill(''); hechas += n; continue; }
      const deEste = [];
      for (let p = 1; p <= n; p++) {
        try {
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          deEste.push(tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join(''));
        } catch (err) {
          deEste.push('');
        }
        hechas++;
        if (hechas % 5 === 0) busqEstadoEl.textContent = '⏳ Preparando la búsqueda (solo la primera vez)… ' + hechas + ' / ' + totalFojas + ' fojas';
      }
      textos[di] = deEste;
      doc.textoPaginas = deEste;
      if (doc.id != null) db.guardarTextosDocumento(doc.id, deEste).catch(err => console.warn('[PJN Biblioteca] No se pudo guardar el texto extraído:', err));
    }
    textosPorDoc = textos;
    busq.indexando = null;
    return textos;
  })();
  return busq.indexando;
}

async function ejecutarBusqueda() {
  const consulta = busqInput.value;
  if (normalizarConsulta(consulta).length < 2) {
    busq = { ...busq, consulta: '', resultados: [], actual: -1 };
    busqLista.innerHTML = '';
    busqEstadoEl.textContent = consulta.trim() ? 'Escribí al menos 2 letras.' : '';
    actualizarFlechasBusqueda();
    resaltarVisibles();
    return;
  }
  const cidBuscado = expActivo && expActivo.cid;
  const textos = await asegurarTextos();
  if (!expActivo || expActivo.cid !== cidBuscado) return; // se cambió de expediente mientras se indexaba
  // Siempre en orden cronológico real (pagesAsc), aunque el libro esté invertido.
  const paginas = pagesAsc.map(pg => ({ di: pg.di, p: pg.p, texto: textos[pg.di] ? textos[pg.di][pg.p - 1] : '' }));
  const r = buscarEnPaginas(paginas, consulta);
  const sinTexto = paginas.filter(pg => esFojaSinTexto(pg.texto)).length;
  busq.consulta = r.consulta;
  busq.resultados = r.resultados;
  busq.actual = -1;
  renderResultadosBusqueda(r, sinTexto, paginas.length);
  actualizarFlechasBusqueda();
  resaltarVisibles();
}

function renderResultadosBusqueda(r, sinTexto, totalFojas) {
  busqLista.innerHTML = '';
  let estado = r.total
    ? r.total + ' aparición' + (r.total !== 1 ? 'es' : '') + ' en ' + r.resultados.length + ' foja' + (r.resultados.length !== 1 ? 's' : '') + (r.cortado ? ' (se muestran las primeras ' + r.resultados.length + ')' : '')
    : 'No se encontró "' + busqInput.value.trim() + '" en el texto del expediente.';
  busqEstadoEl.textContent = estado;
  if (sinTexto) {
    const av = document.createElement('div');
    av.className = 'aviso';
    av.textContent = '⚠ ' + sinTexto + ' de ' + totalFojas + ' fojas son escaneos sin texto: lo que diga ahí no se puede buscar.';
    busqEstadoEl.appendChild(av);
  }
  if (!r.total) return;
  r.resultados.forEach((res, i) => {
    const doc = docsDb[res.di];
    const it = document.createElement('div');
    it.className = 'busq-item';
    const ref = document.createElement('div');
    ref.className = 'busq-ref';
    ref.textContent = 'Act. ' + (res.di + 1) + ' · ' + (doc.tipo || doc.titulo || '') + ' · pág ' + res.p + (res.cantidad > 1 ? '  (' + res.cantidad + ')' : '');
    ref.title = (doc.titulo || '') + (doc.fecha ? ' — ' + doc.fecha : '');
    const frag = document.createElement('div');
    frag.className = 'busq-frag';
    const b = document.createElement('b');
    b.textContent = res.fragmento.match;
    frag.append(document.createTextNode(res.fragmento.antes), b, document.createTextNode(res.fragmento.despues));
    it.append(ref, frag);
    it.addEventListener('click', () => irAResultado(i));
    busqLista.appendChild(it);
  });
}

function actualizarFlechasBusqueda() {
  const hay = busq.resultados.length > 0;
  document.getElementById('busqPrev').disabled = !hay;
  document.getElementById('busqNext').disabled = !hay;
  document.getElementById('busqCount').textContent = hay
    ? (busq.actual >= 0 ? (busq.actual + 1) + ' de ' + busq.resultados.length + ' fojas' : busq.resultados.length + ' fojas con resultados')
    : 'sin mayúsculas ni acentos';
}

async function irAResultado(i) {
  if (!busq.resultados.length) return;
  busq.actual = (i + busq.resultados.length) % busq.resultados.length;
  const res = busq.resultados[busq.actual];
  busqLista.querySelectorAll('.busq-item').forEach((el, k) => el.classList.toggle('on', k === busq.actual));
  const item = busqLista.children[busq.actual];
  if (item) item.scrollIntoView({ block: 'nearest' });
  actualizarFlechasBusqueda();
  const idx = pages.findIndex(pg => pg.di === res.di && pg.p === res.p);
  if (idx < 0) return;
  await goTo(idx, idx > cur ? 'next' : 'prev');
  resaltarVisibles();
}

let temporizadorBusqueda = null;
busqInput.addEventListener('input', () => {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(ejecutarBusqueda, 350);
});
busqInput.addEventListener('keydown', async e => {
  e.stopPropagation(); // que las flechas/Home/End escriban en el campo, no pasen hojas
  if (e.key === 'Escape') { cerrarBusqueda(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  clearTimeout(temporizadorBusqueda);
  if (normalizarConsulta(busqInput.value) !== busq.consulta) { await ejecutarBusqueda(); if (busq.resultados.length) irAResultado(0); return; }
  irAResultado(busq.actual + (e.shiftKey ? -1 : 1));
});
document.getElementById('busqNext').addEventListener('click', () => irAResultado(busq.actual + 1));
document.getElementById('busqPrev').addEventListener('click', () => irAResultado(busq.actual - 1));

// Resaltado sobre la capa de texto (invisible) del libro: se envuelve lo
// encontrado de cada <span> en un <mark>. Una frase partida entre dos
// spans (dos renglones) no se resalta, pero la foja igual aparece en los
// resultados.
function resaltarEnHoja(box, pg) {
  const capa = box.querySelector('.textLayer');
  if (!capa) return;
  const res = busq.actual >= 0 ? busq.resultados[busq.actual] : null;
  const esActual = res && pg && res.di === pg.di && res.p === pg.p;
  let primera = true;
  capa.querySelectorAll('span').forEach(span => {
    // Solo spans "hoja" (texto puro, o texto + marks nuestros): un span
    // contenedor (markedContent de pdf.js) se saltea para no aplanarlo.
    if ([...span.children].some(h => h.tagName !== 'MARK')) return;
    if (span.querySelector('mark')) span.textContent = span.textContent; // limpia un resaltado anterior
    if (!busq.consulta) return;
    const texto = span.textContent;
    const { norm, mapa } = normalizarConMapa(texto);
    const pos = ocurrencias(norm, busq.consulta);
    if (!pos.length) return;
    const frag = document.createDocumentFragment();
    let ultimo = 0;
    for (const p of pos) {
      const [ini, fin] = rangoOriginal(mapa, p, busq.consulta.length);
      if (ini > ultimo) frag.appendChild(document.createTextNode(texto.slice(ultimo, ini)));
      const m = document.createElement('mark');
      m.className = 'hl-busqueda' + (esActual && primera ? ' actual' : '');
      primera = false;
      m.textContent = texto.slice(ini, fin);
      frag.appendChild(m);
      ultimo = fin;
    }
    if (ultimo < texto.length) frag.appendChild(document.createTextNode(texto.slice(ultimo)));
    span.textContent = '';
    span.appendChild(frag);
  });
}

function resaltarVisibles() {
  document.querySelectorAll('.cara .leaf-col, .continuo .leaf-col').forEach(col => {
    const idx = col.dataset.pagina === '' ? null : +col.dataset.pagina;
    const box = col.querySelector('.page-box');
    if (idx === null || !box) return;
    resaltarEnHoja(box, pages[idx]);
  });
}

let dragStartX = null;
stageEl.addEventListener('pointerdown', e => { dragStartX = e.clientX; stageEl.classList.add('dragging'); });
stageEl.addEventListener('pointerup', e => {
  stageEl.classList.remove('dragging');
  if (modoContinuo) { dragStartX = null; return; } // en continuo se scrollea; arrastrar es seleccionar texto
  if (dragStartX === null) return;
  const dx = e.clientX - dragStartX; dragStartX = null;
  if (dx < -60) goTo(cur + paso(), 'next'); else if (dx > 60) goTo(cur - paso(), 'prev');
});
stageEl.addEventListener('pointerleave', () => { stageEl.classList.remove('dragging'); dragStartX = null; });

// ─────────────────────────── ÍNDICE DESLIZABLE ───────────────────────────
const idxPanel = document.getElementById('idxPanel');

// El panel ahora es fijo (visible por defecto, empuja el libro en vez de
// taparlo): "cerrarlo" solo lo angosta a 0 para darle más lugar a la
// página, no lo saca de encima de nada.
function abrirIndice() { idxPanel.classList.remove('closed'); }
function cerrarIndice() { idxPanel.classList.add('closed'); }
document.getElementById('btnIndex').addEventListener('click', abrirIndice);
document.getElementById('idxClose').addEventListener('click', cerrarIndice);

// ─────────────────────────── ENLACE PÚBLICO (uno por hoja, en su pie) ───────────────────────────
// Delegado en el stage, no un listener por botón: el par de hojas se
// vuelve a pintar entero en cada vuelta de hoja (pintarHoja hace
// wrap.innerHTML = ''), así que cualquier listener puesto directo sobre
// un botón anterior quedaría huérfano.
stageEl.addEventListener('click', e => {
  const copy = e.target.closest('.lf-copy');
  const open = e.target.closest('.lf-open');
  const btn = copy || open;
  if (!btn) return;
  const col = btn.closest('.leaf-col');
  const url = col && col.dataset.url;
  if (!url) return;
  if (copy) {
    navigator.clipboard?.writeText(url).catch(() => {});
    const original = btn.textContent;
    btn.textContent = '✓'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1600);
  } else {
    window.open(url, '_blank');
  }
});

// ─────────────────────────── BANDERITAS LIBRES (persistentes de verdad) ───────────────────────────
const fpColors = document.getElementById('fpColors');
FLAG_COLORS.forEach(c => {
  const sw = document.createElement('div');
  sw.className = 'fp-color' + (c.id === selColor ? ' sel' : '');
  sw.style.background = c.hex; sw.dataset.id = c.id;
  sw.addEventListener('click', () => {
    selColor = c.id;
    fpColors.querySelectorAll('.fp-color').forEach(x => x.classList.toggle('sel', x.dataset.id === c.id));
  });
  fpColors.appendChild(sw);
});
// ─── Anclaje de banderitas ───
// En la base se guardan por { actuacionId, pagina } (foja dentro de la
// actuación). Acá se les agrega .page (foja absoluta en ESTE armado del
// libro) solo en memoria, para que el resto del lector siga igual.
function lugarDeFoja(i) {
  const pg = pages[i];
  return { actuacionId: db.idDeDocumento(pg.doc), pagina: pg.p - 1 };
}

async function cargarBanderitas(cid) {
  const guardadas = await db.obtenerMarcadores(cid);
  const inicioPorId = new Map();   // actuacionId → { inicio, fojas }
  pages.forEach((pg, i) => {
    const id = db.idDeDocumento(pg.doc);
    const r = inicioPorId.get(id);
    if (!r) inicioPorId.set(id, { inicio: i, fojas: 1 });
    else r.fojas++;
  });

  const resueltas = [];
  for (const m of guardadas) {
    if (m.actuacionId) {
      const r = inicioPorId.get(m.actuacionId);
      if (!r) continue; // la actuación no está en este armado: queda guardada, no se muestra
      // Si la actuación se volvió a descargar con menos fojas, cae a la última.
      resueltas.push({ ...m, page: r.inicio + Math.min(m.pagina || 0, r.fojas - 1) });
    } else if (typeof m.page === 'number' && m.page < pages.length) {
      // Formato viejo (foja absoluta): se migra al anclaje por actuación.
      const nueva = await db.guardarMarcador({ cid, ...lugarDeFoja(m.page), label: m.label, color: m.color });
      await db.eliminarMarcadorPorId(m.id);
      resueltas.push({ ...nueva, page: m.page });
    }
  }
  // Dos banderitas que resuelven a la misma foja: queda una.
  const porFoja = new Map();
  resueltas.forEach(f => porFoja.set(f.page, f));
  return [...porFoja.values()].sort((a, b) => a.page - b.page);
}

function renderFlags() {
  const rail = document.getElementById('flagRail');
  rail.innerHTML = '';
  const total = pages.length;
  flags.forEach(f => {
    const color = FLAG_COLORS.find(c => c.id === f.color) || FLAG_COLORS[0];
    const el = document.createElement('div');
    el.className = 'flag'; el.style.background = color.hex;
    el.style.top = ((f.page / (total - 1 || 1)) * 100) + '%';
    el.title = f.label || 'Marcador';
    el.innerHTML = `<span class="flabel">fs.${f.page + 1} · ${esc(f.label || 'marcador')}</span>`;
    el.addEventListener('click', e => { e.stopPropagation(); goTo(f.page, f.page > cur ? 'next' : 'prev'); });
    rail.appendChild(el);
  });
  document.getElementById('btnFlag').classList.toggle('on', flags.some(f => f.page === cur));
}
const flagPop = document.getElementById('flagPop');
const btnFlag = document.getElementById('btnFlag');
// Qué página apunta el popup: la izquierda por defecto (botón del
// toolbar), o la que sea si se abrió desde el iconito de una hoja
// puntual (izquierda o derecha, cualquiera de las dos caras).
let paginaObjetivoFlag = cur;

function abrirPopupFlag(pagina) {
  paginaObjetivoFlag = pagina;
  const existing = flags.find(f => f.page === pagina);
  document.getElementById('flagLabel').value = existing ? existing.label : '';
  selColor = existing ? existing.color : FLAG_COLORS[0].id;
  fpColors.querySelectorAll('.fp-color').forEach(x => x.classList.toggle('sel', x.dataset.id === selColor));
  document.getElementById('flagRemove').style.display = existing ? 'block' : 'none';
  flagPop.classList.add('open');
}
btnFlag.addEventListener('click', e => {
  e.stopPropagation();
  if (flagPop.classList.contains('open') && paginaObjetivoFlag === cur) { flagPop.classList.remove('open'); return; }
  abrirPopupFlag(cur);
});
// Delegado: el iconito 🏳 de cada hoja se recrea en cada vuelta de página
// (mismo motivo que el enlace público — pintarHoja rehace el contenido).
stageEl.addEventListener('click', e => {
  const btn = e.target.closest('.lh-flag');
  if (!btn) return;
  e.stopPropagation();
  const col = btn.closest('.leaf-col');
  const pagina = col && col.dataset.pagina;
  if (pagina === '' || pagina == null) return; // hoja vacía (spread con una sola página)
  abrirPopupFlag(+pagina);
});
document.addEventListener('click', e => {
  if (!flagPop.contains(e.target) && e.target !== btnFlag && !e.target.closest('.lh-flag')) flagPop.classList.remove('open');
});
document.getElementById('flagSave').addEventListener('click', async () => {
  const label = document.getElementById('flagLabel').value.trim();
  const pagina = paginaObjetivoFlag;
  const guardado = await db.guardarMarcador({ cid: expActivo.cid, ...lugarDeFoja(pagina), label, color: selColor });
  flags = flags.filter(f => f.page !== pagina);
  flags.push({ ...guardado, page: pagina });
  flags.sort((a, b) => a.page - b.page);
  renderFlags();
  actualizarIconosFlagVisibles();
  flagPop.classList.remove('open');
});
document.getElementById('flagRemove').addEventListener('click', async () => {
  const pagina = paginaObjetivoFlag;
  await db.eliminarMarcador(expActivo.cid, lugarDeFoja(pagina));
  flags = flags.filter(f => f.page !== pagina);
  renderFlags();
  actualizarIconosFlagVisibles();
  flagPop.classList.remove('open');
});
// Tras guardar/quitar una banderita, refleja el cambio en los iconitos
// 🏳 que ya están pintados en pantalla (sin tener que repintar la hoja
// entera).
function actualizarIconosFlagVisibles() {
  document.querySelectorAll('.leaf-col').forEach(col => {
    if (col.dataset.pagina === '' || col.dataset.pagina == null) return;
    const pagina = +col.dataset.pagina;
    col.querySelector('.lh-flag')?.classList.toggle('on', flags.some(f => f.page === pagina));
  });
}

// ─────────────────────────── EXPORTAR ZIP (desde la biblioteca) ───────────────────────────
async function exportarZip(exp) {
  const docs = await db.obtenerDocumentos(exp.cid);
  if (!docs.length) { alert('Este expediente no tiene documentos guardados.'); return; }

  const zipEntries = [];
  const filas = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const numero = String(i + 1).padStart(4, '0');
    const basename = numero + ' - ' + sanitizarNombre(d.titulo || 'documento') + (d.extension || '.pdf');
    const buffer = await d.blob.arrayBuffer();
    zipEntries.push({ name: basename, data: new Uint8Array(buffer) });
    filas.push({ nombre: basename, titulo: d.titulo, hist: d.esHistorica, url: d.urlHiper });
  }

  const indexHtml = generarIndiceZip(exp, filas);
  zipEntries.unshift({ name: 'index.html', data: new TextEncoder().encode(indexHtml) });

  const folder = sanitizarNombre(exp.folderName || exp.numero || exp.cid);
  const allEntries = zipEntries.map(e => ({ name: folder + '/' + e.name, data: e.data }));
  const zipBlob = buildZip(allEntries);
  const zipUrl = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = zipUrl; a.download = folder + '.zip'; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(zipUrl), 30000);
}

function sanitizarNombre(texto) { return String(texto).replace(/[/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim(); }

function generarIndiceZip(exp, filas) {
  const filasHtml = filas.map((f, i) => `
    <tr class="${f.hist ? 'hist' : ''}">
      <td>${i + 1}</td>
      <td>${f.hist ? '📜' : '📋'}</td>
      <td><a href="${encodeURIComponent(f.nombre)}" target="_blank">${escZip(f.titulo)}</a></td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>${escZip(exp.numero || exp.cid)}</title>
<style>
body{font-family:Arial,sans-serif;background:#f0f4f8;color:#1a3a3a;margin:0;padding:0}
header{background:#006e6e;color:#fff;padding:18px 24px}
header h1{font-size:16px;margin:0 0 4px}
header p{font-size:12px;color:#a8e8e8;margin:0}
table{width:100%;border-collapse:collapse;margin:16px auto;max-width:900px}
td{padding:9px 12px;border-bottom:1px solid #dbf2f2;font-size:13px}
tr.hist{background:#fffbf0}
a{color:#008080;text-decoration:none}
a:hover{text-decoration:underline}
</style></head><body>
<header><h1>⚖️ ${escZip(exp.numero || exp.cid)}</h1><p>${escZip(exp.caratula || '')} · ${filas.length} actuaciones</p></header>
<table><tbody>${filasHtml}</tbody></table>
</body></html>`;
}
function escZip(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildZip(files) {
  const lp = [], cd = []; let off = 0;
  const now = new Date();
  const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) >>> 0;
  const dd = ((((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate())) >>> 0;
  for (const f of files) {
    const nb = new TextEncoder().encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new Uint8Array(30 + nb.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dt, true); lv.setUint16(12, dd, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, sz, true); lv.setUint32(22, sz, true); lv.setUint16(26, nb.length, true); lv.setUint16(28, 0, true);
    lh.set(nb, 30); lp.push(lh, f.data);
    const ce = new Uint8Array(46 + nb.length); const cv = new DataView(ce.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, dt, true); cv.setUint16(14, dd, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, sz, true); cv.setUint32(24, sz, true); cv.setUint16(28, nb.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, off, true); ce.set(nb, 46);
    cd.push(ce); off += lh.length + sz;
  }
  const cds = cd.reduce((s, c) => s + c.length, 0);
  const eo = new Uint8Array(22); const ev = new DataView(eo.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cds, true); ev.setUint32(16, off, true); ev.setUint16(20, 0, true);
  return new Blob([...lp, ...cd, eo], { type: 'application/zip' });
}
function crc32(d) {
  if (!crc32.t) {
    crc32.t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crc32.t[i] = c; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = crc32.t[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ─────────────────────────── ARRANQUE ───────────────────────────
cargarBiblioteca();

// biblioteca.html?abrir=<cid>: la pantalla de inicio llega acá con "Leer
// como libro" después de guardar el expediente; se abre directo en el
// lector, SIN pasar por "Mis expedientes" — antes mostrarBiblioteca() se
// llamaba igual (sin condición) antes de abrirExpediente(), que es
// asincrónica (decodifica los PDFs), así que la biblioteca se veía un
// instante antes de que el lector la tapara.
const cidAbrir = new URLSearchParams(location.search).get('abrir');
if (cidAbrir) {
  // .library tiene display:flex por defecto en el CSS (para que se vea
  // sin depender de JS en el caso normal) — se ve desde el primer pintado
  // de la página, antes de que corra cualquier script. Ocultarla recién
  // dentro de abrirExpediente() (asincrónica: decodifica los PDFs) dejaba
  // ese hueco visible. Se oculta acá, ya, antes de arrancar esa espera.
  libraryEl.style.display = 'none';
  abrirExpediente(cidAbrir);
} else {
  mostrarBiblioteca();
}

// Versión visible en el encabezado (sale del manifest: se actualiza sola en cada release).
document.querySelectorAll('[data-version-ext]').forEach(el => { el.textContent = 'v' + chrome.runtime.getManifest().version; });


// ─────────────────────────── MODO CONTINUO ───────────────────────────
// Todas las fojas una debajo de la otra. Cada hoja tiene alto fijo (el del
// escenario), así la foja visible se calcula con una división, sin medir
// nada. Se pinta solo lo que está cerca de la vista (IntersectionObserver)
// y se libera lo que queda lejos: en un expediente de 500 fojas no se
// pueden tener todos los canvases en memoria a la vez.
const continuoEl = document.getElementById('continuo');
const GAP_CONTINUO = 12;
let observadorContinuo = null;
let altoHojaContinuo = 0;

function plantillaHojaContinuo(i) {
  const col = document.createElement('div');
  col.className = 'leaf-col';
  col.dataset.pagina = String(i);
  col.dataset.lado = 'l';
  col.style.height = altoHojaContinuo + 'px';
  col.innerHTML =
    '<div class="leaf-head"><span class="lh-ref"></span><span class="lh-firma checking" title="">⏳</span><button class="lh-flag" title="Marcar esta foja">🏳</button></div>' +
    '<div class="leaf"><div class="pdf-canvas-wrap"><div class="page-skeleton"><div class="spin"></div></div></div></div>' +
    '<div class="leaf-foot"><span class="lf-dot"></span><span class="lf-url"></span><button class="lf-copy" title="Copiar el enlace público">⧉</button><button class="lf-open" title="Abrir en el SCW">↗</button></div>';
  return col;
}

async function pintarHojaContinuo(col) {
  const i = +col.dataset.pagina;
  if (col.dataset.pintada === '1' || !pages[i]) return;
  col.dataset.pintada = '1';
  try {
    await renderCanvas(i);
    if (!modoContinuo || col.dataset.pintada !== '1' || !col.isConnected) return;
    pintarHoja(col, pages[i], i);
  } catch (err) {
    console.error('[PJN Biblioteca] No se pudo pintar la foja ' + (i + 1) + ' en modo continuo:', err);
    col.dataset.pintada = '';
  }
}

function vaciarHojaContinuo(col) {
  if (col.dataset.pintada !== '1') return;
  col.dataset.pintada = '';
  const wrapC = col.querySelector('.pdf-canvas-wrap');
  const boxC = wrapC.querySelector('.page-box');
  if (boxC) observadorCapas.unobserve(boxC);
  wrapC.innerHTML = '<div class="page-skeleton"><div class="spin"></div></div>';
  // Lejos de lo que se está leyendo: se libera también el canvas en caché.
  const i = +col.dataset.pagina;
  if (pages[i] && Math.abs(i - cur) > 8) { pages[i].canvas = null; pages[i].textLayerEl = null; }
}

async function mostrarContinuo(i) {
  if (observadorContinuo) observadorContinuo.disconnect();
  observadorCapas.disconnect(); // las hojas viejas se descartan: no seguir observándolas
  stageEl.classList.add('con-continuo');
  continuoEl.hidden = false;
  continuoEl.innerHTML = '';
  altoHojaContinuo = Math.max(300, stageEl.clientHeight - 20);
  const frag = document.createDocumentFragment();
  for (let k = 0; k < pages.length; k++) frag.appendChild(plantillaHojaContinuo(k));
  continuoEl.appendChild(frag);
  observadorContinuo = new IntersectionObserver(entradas => {
    entradas.forEach(en => en.isIntersecting ? pintarHojaContinuo(en.target) : vaciarHojaContinuo(en.target));
  }, { root: continuoEl, rootMargin: '150% 0px' });
  continuoEl.querySelectorAll('.leaf-col').forEach(col => observadorContinuo.observe(col));
  irAFojaContinuo(i, true);
}

function irAFojaContinuo(iSolicitado, sinAnimacion) {
  const i = Math.max(0, Math.min(iSolicitado, pages.length - 1));
  const destino = i * (altoHojaContinuo + GAP_CONTINUO);
  const lejos = Math.abs(continuoEl.scrollTop - destino) > 3 * altoHojaContinuo;
  continuoEl.scrollTo({ top: destino, behavior: (sinAnimacion || lejos) ? 'auto' : 'smooth' });
  actualizarControlesContinuo(i);
}

function actualizarControlesContinuo(i) {
  if (!pages[i]) return;
  cur = i;
  document.getElementById('counter').textContent = `fs. ${i + 1} / ${pages.length}`;
  document.getElementById('btnPrev').disabled = i <= 0;
  document.getElementById('btnNext').disabled = i >= pages.length - 1;
  document.getElementById('btnPrimera').disabled = i <= 0;
  document.getElementById('btnUltima').disabled = i >= pages.length - 1;
  const di = pages[i].di;
  document.querySelectorAll('.index-item').forEach(t => t.classList.toggle('on', +t.dataset.di === di));
  document.getElementById('btnFlag')?.classList.toggle('on', flags.some(f => f.page === i));
}

let scrollPendiente = false;
continuoEl.addEventListener('scroll', () => {
  if (scrollPendiente) return;
  scrollPendiente = true;
  requestAnimationFrame(() => {
    scrollPendiente = false;
    if (!modoContinuo) return;
    const i = Math.floor((continuoEl.scrollTop + continuoEl.clientHeight / 2) / (altoHojaContinuo + GAP_CONTINUO));
    if (i !== cur && pages[i]) actualizarControlesContinuo(Math.min(i, pages.length - 1));
  });
});

async function cambiarModoContinuo(activar) {
  if (activar === modoContinuo || animating) return;
  modoContinuo = activar;
  const btn = document.getElementById('btnContinuo');
  btn.classList.toggle('on', modoContinuo);
  btn.textContent = modoContinuo ? '📖 Libro' : '📜 Continuo';
  btn.title = modoContinuo ? 'Volver al libro con paso de hoja' : 'Ver las fojas una debajo de la otra y recorrerlas con la rueda del mouse';
  document.getElementById('btnPaginas').disabled = modoContinuo;
  pages.forEach(p => { p.canvas = null; p.textLayerEl = null; }); // cambia el ancho disponible: hay que re-renderizar
  if (!modoContinuo) {
    if (observadorContinuo) observadorContinuo.disconnect();
    observadorCapas.disconnect();
    continuoEl.hidden = true;
    continuoEl.innerHTML = '';
    stageEl.classList.remove('con-continuo');
  }
  await render(cur);
  if (busq.consulta) resaltarVisibles();
}
document.getElementById('btnContinuo').addEventListener('click', () => cambiarModoContinuo(!modoContinuo));

// Si cambia el tamaño de la ventana, el alto fijo de cada hoja queda viejo.
let temporizadorResize = null;
window.addEventListener('resize', () => {
  if (!modoContinuo) return;
  clearTimeout(temporizadorResize);
  temporizadorResize = setTimeout(() => { pages.forEach(p => { p.canvas = null; p.textLayerEl = null; }); render(cur); }, 250);
});
