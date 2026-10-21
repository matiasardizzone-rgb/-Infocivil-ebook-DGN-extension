// relacionados-content.js — Variante DGN: lectura de "Lista de Expedientes
// Relacionados" (consultaListaRelacionados.seam) del SCW con sesión iniciada.
//
// Qué hace:
//   - Lee las filas de la lista (expediente, dependencia, carátula,
//     situación, última actualización) y recorre el paginador RichFaces.
//   - Abre una causa con el botón "ojo" de su fila (submit JSF, va a
//     expediente.seam?cid=…) cuando el proceso de fondo se lo pide.
//   - Inyecta un panel propio arriba de la tabla ("Mi biblioteca") para
//     leer la lista completa, ver qué causas tienen novedades y mandar a
//     guardar las seleccionadas.
//
// Qué NO hace nunca: la estrella (agregar/quitar favorito), "Presentar
// escrito", "Libro digital" ni "Dejar nota" — modifican estado en el SCW o
// están fuera de alcance. El selector del ojo los excluye explícitamente.
//
// Estructura relevada contra el SCW real (20/10/2026, usuario letrado):
//   form#tablaConsultaLista:tablaConsultaForm
//     table[id$=":dataTable"]  (15 filas por página)
//       td.column ×5  → Expediente | Dependencia | Carátula | Situación | Últ. Act.
//       td.text-center → a.btn (ojo, mojarra.jsfcljs) + desplegable
//                         (Libro digital / Presentar escrito)
//       td.text-center.width-12 → estrella (mojarra.ab … agregarAfavorito)
//     ul.pagination → enlaces numerados con RichFaces.ajax(...)
// Los j_idtN los genera JSF y pueden cambiar entre despliegues: no se usan.

(function () {
  'use strict';
  if (window.__icRelacionadosCargado) return;
  window.__icRelacionadosCargado = true;

  const RUTA_LISTA = /\/scw\/consultaLista(Relacionados|Favoritos)\.seam$/;
  const ID_FORM = 'tablaConsultaLista:tablaConsultaForm';
  const MAX_PAGINAS = 300;          // tope de seguridad del recorrido
  const TOPE_LOTE = 25;             // máximo de causas por tanda de guardado
  const ESPERA_CAMBIO_MS = 20000;   // tope por cambio de página (AJAX)

  const esperar = ms => new Promise(r => setTimeout(r, ms));
  const esLista = () => RUTA_LISTA.test(location.pathname);
  const textoDe = el => ((el && el.innerText) || '').replace(/\s+/g, ' ').trim();

  // Misma normalización que db.normalizarClaveExpediente (SIGLA|num|año|inc).
  function claveExpediente(texto) {
    const m = (texto || '').match(/([A-Z]{2,4})\D*0*(\d+)\D+(\d{4})(?:\D+0*(\d+))?/i);
    if (!m) return null;
    return m[1].toUpperCase() + '|' + Number(m[2]) + '|' + m[3] + '|' + (m[4] !== undefined ? Number(m[4]) : 0);
  }

  // ─── Ejecución en el mundo de la página ──────────────────────────────────
  // Los controles usan jsf.util.chain(this, event, …): hace falta un clic
  // NATIVO del elemento en el mundo de la página (con this y event reales).
  // El content script marca el elemento con un atributo (el DOM es común a
  // los dos mundos) y le pide al fondo que lo clickee ahí (runInPageWorld,
  // mismo mecanismo que la paginación de históricas).
  let contadorObjetivos = 0;
  function clicEnPagina(el) {
    const token = 'ic' + Date.now().toString(36) + (++contadorObjetivos);
    el.setAttribute('data-ic-objetivo', token);
    const codigo = '(function(){var el=document.querySelector(\'[data-ic-objetivo="' + token +
      '"]\');if(el){el.removeAttribute(\'data-ic-objetivo\');el.click();}})()';
    return new Promise(r => {
      try { chrome.runtime.sendMessage({ action: 'runInPageWorld', code: codigo }, () => { void chrome.runtime.lastError; setTimeout(r, 200); }); }
      catch (e) { r(); }
    });
  }

  // ─── Tabla ───────────────────────────────────────────────────────────────
  function tablaLista() {
    const raiz = document.getElementById(ID_FORM) || document;
    const tablas = Array.from(raiz.querySelectorAll('table'));
    return tablas.find(t => /:dataTable$/.test(t.id)) ||
      tablas.find(t => /Car.tula/i.test(textoDe(t.tHead))) || null;
  }

  // Posición de cada columna por su encabezado (por si cambian de orden);
  // si no se reconoce, se usa el orden relevado.
  function columnas(tabla) {
    const enc = Array.from((tabla.tHead && tabla.tHead.rows[0] && tabla.tHead.rows[0].cells) || []).map(textoDe);
    const buscar = (re, def) => { const i = enc.findIndex(h => re.test(h)); return i === -1 ? def : i; };
    return {
      expediente: buscar(/^expediente/i, 0),
      dependencia: buscar(/dependencia/i, 1),
      caratula: buscar(/car.tula/i, 2),
      situacion: buscar(/situaci/i, 3),
      ultimaActualizacion: buscar(/lt\.?\s*act/i, 4),
    };
  }

  function botonOjo(fila) {
    // El ojo es el único mojarra.jsfcljs SIN conversationPropagation ni
    // destino _blank. Libro digital y Presentar escrito llevan
    // conversationPropagation; la estrella usa mojarra.ab. Ninguno de esos
    // puede salir de acá.
    return Array.from(fila.querySelectorAll('a[onclick]')).find(a => {
      const oc = a.getAttribute('onclick') || '';
      return /mojarra\.jsfcljs/.test(oc) && !/conversationPropagation|agregarAfavorito|_blank|mojarra\.ab\(/.test(oc);
    }) || null;
  }

  function leerFilasPagina() {
    const tabla = tablaLista();
    if (!tabla || !tabla.tBodies[0]) return [];
    const col = columnas(tabla);
    const salida = [];
    Array.from(tabla.tBodies[0].rows).forEach((fila, indiceFila) => {
      const c = fila.cells;
      if (!c || c.length < 5) return;
      const expediente = textoDe(c[col.expediente]);
      const clave = claveExpediente(expediente);
      if (!clave) return;
      salida.push({
        clave, expediente,
        dependencia: textoDe(c[col.dependencia]),
        caratula: textoDe(c[col.caratula]),
        situacion: textoDe(c[col.situacion]),
        ultimaActualizacion: textoDe(c[col.ultimaActualizacion]),
        indiceFila,
        abrible: !!botonOjo(fila),
      });
    });
    return salida;
  }

  function filaPorClave(clave) {
    const tabla = tablaLista();
    if (!tabla || !tabla.tBodies[0]) return null;
    const col = columnas(tabla);
    return Array.from(tabla.tBodies[0].rows).find(f =>
      f.cells && f.cells.length >= 5 && claveExpediente(textoDe(f.cells[col.expediente])) === clave) || null;
  }

  // ─── Paginador ───────────────────────────────────────────────────────────
  // Cada página es un elemento con clase padding-pagination; el de la página
  // actual no tiene onclick (ni él ni sus hijos). Los dos del final
  // (no-pagination-background) son navegación; el de "last-page" salta a la
  // última, así que nunca se usa para avanzar de a una.
  function paginador() {
    const raiz = document.getElementById(ID_FORM) || document;
    return raiz.querySelector('ul.pagination') || null;
  }
  function conOnclick(el) {
    return el.hasAttribute('onclick') ? el : el.querySelector('[onclick]');
  }
  function elementosPagina() {
    const ul = paginador();
    if (!ul) return [];
    // Solo los "de afuera": si li y a tienen la clase, se queda el de más arriba.
    const todos = Array.from(ul.querySelectorAll('[class*="padding-pagination"]'));
    return todos.filter(el => !todos.some(o => o !== el && o.contains(el))).map(el => {
      const texto = textoDe(el);
      return {
        el, texto,
        numero: /^\d+$/.test(texto) ? Number(texto) : null,
        destino: conOnclick(el),
        esUltima: /last-page/.test(el.className) || !!el.querySelector('.last-page'),
      };
    });
  }
  function paginaActual() {
    const els = elementosPagina();
    if (!els.length) return null; // sin paginador: una sola página
    const actual = els.find(e => e.numero !== null && !e.destino) ||
      els.find(e => e.numero !== null && /active|current|selected/.test(e.el.className));
    return actual ? actual.numero : null;
  }
  function firmaTabla() {
    const filas = leerFilasPagina();
    return (paginaActual() || 0) + '#' + filas.length + '#' + (filas[0] ? filas[0].clave : '');
  }
  async function esperarCambio(firmaAntes) {
    const inicio = Date.now();
    while (Date.now() - inicio < ESPERA_CAMBIO_MS) {
      await esperar(300);
      const f = firmaTabla();
      if (f !== firmaAntes && leerFilasPagina().length) return true;
    }
    return false;
  }

  // true: avanzó · false: no hay página siguiente · null: no se pudo confirmar
  async function avanzarPagina() {
    const cur = paginaActual();
    const els = elementosPagina();
    if (cur === null || !els.length) return false;
    let objetivo = els.find(e => e.numero === cur + 1 && e.destino);
    if (!objetivo) {
      // Página siguiente fuera de la ventana de números visibles: la flecha
      // de "siguiente" (navegación, después de la página actual, no "última").
      const iActual = els.findIndex(e => e.numero === cur && !e.destino);
      objetivo = els.slice(iActual + 1).find(e => e.numero === null && e.destino && !e.esUltima);
    }
    if (!objetivo) return false;
    const antes = firmaTabla();
    await clicEnPagina(objetivo.destino);
    if (!(await esperarCambio(antes))) return null;
    const nueva = paginaActual();
    if (nueva !== null && nueva !== cur + 1) {
      console.warn('[Infocivil DGN] El paginador saltó de la página ' + cur + ' a la ' + nueva + ' (se esperaba ' + (cur + 1) + ').');
      return null;
    }
    return true;
  }

  async function irAPagina(n) {
    for (let i = 0; i < 60; i++) {
      const cur = paginaActual();
      if (cur === null || cur === n) return cur === n || n === 1;
      const visibles = elementosPagina().filter(e => e.numero !== null && e.destino);
      if (!visibles.length) return false;
      const exacta = visibles.find(e => e.numero === n);
      const salto = exacta || (n < cur
        ? visibles.reduce((a, b) => (b.numero < a.numero ? b : a))
        : visibles.reduce((a, b) => (b.numero > a.numero ? b : a)));
      const antes = firmaTabla();
      await clicEnPagina(salto.destino);
      if (!(await esperarCambio(antes))) return false;
    }
    return false;
  }

  // ─── Lectura completa ────────────────────────────────────────────────────
  let leyendo = false;
  async function leerListaCompleta(alAvanzar) {
    if (leyendo) throw new Error('Ya se está leyendo la lista.');
    leyendo = true;
    try {
      if (paginaActual() !== null && paginaActual() !== 1) await irAPagina(1);
      const vistas = new Map();
      let pagina = paginaActual() || 1, incompleta = false;
      for (let n = 0; n < MAX_PAGINAS; n++) {
        for (const f of leerFilasPagina()) if (!vistas.has(f.clave)) vistas.set(f.clave, { ...f, pagina });
        if (alAvanzar) alAvanzar(pagina, vistas.size);
        const r = await avanzarPagina();
        if (r === false) break;
        if (r === null) { incompleta = true; break; }
        pagina = paginaActual() || pagina + 1;
      }
      return { filas: [...vistas.values()], paginas: pagina, incompleta };
    } finally {
      leyendo = false;
    }
  }

  // ─── Filtro "Personalizar Resultados" ──────────────────────────────────
  // Jurisdicción + Número/Año + "Ver todos los expedientes" (incluye los que
  // no están en trámite). Mucho más rápido que recorrer la lista página por
  // página. Los controles se ubican por su etiqueta visible, no por id
  // (los j_idtN cambian). Puede responder por AJAX o recargando la página
  // entera: en el segundo caso este script se destruye y el fondo reintenta
  // (la página nueva ya viene filtrada, ver relacionados.js / consulta.js).
  function grupoDeEtiqueta(re) {
    const etiquetas = Array.from(document.querySelectorAll('label, th, td, span, div'))
      .filter(el => el.children.length === 0 && re.test(textoDe(el)));
    for (const et of etiquetas) {
      let c = et.parentElement;
      for (let i = 0; c && i < 4; i++, c = c.parentElement) {
        if (c.querySelector('input:not([type=hidden]), select')) return c;
      }
    }
    return null;
  }
  function filtroDisponible() {
    const gNum = grupoDeEtiqueta(/^N[úu]mero\s*\/\s*A[ñn]o$/i);
    const gJur = grupoDeEtiqueta(/^Jurisdicci[óo]n$/i);
    if (!gNum || !gJur) return null;
    const textos = Array.from(gNum.querySelectorAll('input[type=text], input:not([type])'));
    const select = gJur.querySelector('select');
    const form = (textos[0] && textos[0].closest('form')) || document;
    const boton = Array.from(form.querySelectorAll('input[type=submit], input[type=button], button, a'))
      .find(b => /^Consultar$/i.test((b.value || textoDe(b) || '').trim()));
    const verTodos = Array.from(form.querySelectorAll('input[type=checkbox]'))
      .find(cb => /ver todos/i.test(textoDe(cb.closest('label, div, td, span') || cb.parentElement)));
    if (textos.length < 2 || !select || !boton) return null;
    return { numero: textos[0], anio: textos[1], select, boton, verTodos };
  }
  function poner(el, valor) {
    el.value = valor;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function filtrarPorNumero(clave) {
    const f = filtroDisponible();
    if (!f) return false;
    const [sigla, numero, anio] = clave.split('|');
    const opcion = Array.from(f.select.options).find(o => new RegExp('^\\s*' + sigla + '\\b', 'i').test(o.textContent));
    if (!opcion) return false;
    if (f.select.value !== opcion.value) {
      poner(f.select, opcion.value);
      await esperar(1200); // el select puede disparar un AJAX propio
    }
    poner(f.numero, String(numero));
    poner(f.anio, String(anio));
    if (f.verTodos && !f.verTodos.checked) await clicEnPagina(f.verTodos);
    await esperar(300);
    const antes = firmaTabla();
    await clicEnPagina(f.boton);
    // Resultado por AJAX: la tabla cambia. Si recarga la página, este script
    // muere acá y el fondo vuelve a pedir sobre la página ya filtrada.
    const inicio = Date.now();
    while (Date.now() - inicio < ESPERA_CAMBIO_MS) {
      await esperar(300);
      if (filaPorClave(clave)) return true;
      if (firmaTabla() !== antes) return !!filaPorClave(clave);
    }
    return !!filaPorClave(clave);
  }

  // Abre la causa (clic en el ojo): página actual → filtro por número →
  // como respaldo, la página donde se la vio y el recorrido desde la 1.
  async function abrirCausa(clave, paginaPista, usarFiltro = true) {
    let fila = filaPorClave(clave);
    if (!fila && usarFiltro) {
      try { if (await filtrarPorNumero(clave)) fila = filaPorClave(clave); }
      catch (e) { console.warn('[Infocivil DGN] Falló el filtro por número, se recorre la lista:', e); }
    }
    if (!fila && paginaPista) { await irAPagina(paginaPista); fila = filaPorClave(clave); }
    if (!fila) {
      await irAPagina(1);
      fila = filaPorClave(clave);
      for (let n = 0; !fila && n < MAX_PAGINAS; n++) {
        const r = await avanzarPagina();
        if (r !== true) break;
        fila = filaPorClave(clave);
      }
    }
    if (!fila) throw new Error('La causa no figura en la lista de relacionados (¿se desvinculó?).');
    const ojo = botonOjo(fila);
    if (!ojo) throw new Error('No se encontró el botón para abrir la causa.');
    return ojo;
  }

  // Número del expediente que muestra la página actual (para confirmar que
  // el ojo abrió la causa correcta).
  function claveExpedienteActual() {
    const texto = (document.body && document.body.innerText) || '';
    const m = texto.match(/Expediente:\s*([A-Z]{2,4}\s?\d+\/\d{4}(?:\/\d+)?)/) ||
      texto.match(/[A-Z]{2,4}\s?\d+\/\d{4}(?:\/\d+)?/);
    return m ? claveExpediente(m[1] || m[0]) : null;
  }

  // ─── Mensajes del proceso de fondo ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.action === 'relacionadosEstadoPagina') {
      sendResponse({ ok: true, esLista: esLista(), filas: esLista() ? leerFilasPagina().length : 0, pagina: esLista() ? paginaActual() : null, url: location.href });
      return false;
    }
    // Entra a "Actuaciones históricas" con el botón del expediente, como el
    // usuario. Con sesión iniciada, abrir actuacionesHistoricas.seam?cid=…
    // escribiendo la dirección muestra la página casi vacía (visto contra
    // el SCW real: 5 filas sin documentos; por el botón, 15 filas y 2
    // documentos, mismo cid).
    if (msg.action === 'irAHistoricas') {
      const candidatos = Array.from(document.querySelectorAll('a, button, input[type=submit], input[type=button]'))
        .filter(e => /hist[oó]ric/i.test(((e.value || '') + ' ' + (e.textContent || '')).trim()));
      const el = candidatos.find(e => e.getAttribute('onclick') || (e.getAttribute('href') || '').length > 1) || candidatos[0];
      if (!el) { sendResponse({ ok: false, error: 'No se encontró el botón de actuaciones históricas.' }); return false; }
      sendResponse({ ok: true, texto: textoDe(el).slice(0, 60) });
      setTimeout(() => clicEnPagina(el), 100);
      return false;
    }
    if (msg.action === 'relacionadosClaveActual') {
      sendResponse({ ok: true, clave: claveExpedienteActual() });
      return false;
    }
    if (msg.action === 'relacionadosAbrir') {
      if (!esLista()) { sendResponse({ ok: false, error: 'La pestaña no está en la lista de relacionados.' }); return false; }
      (async () => {
        try {
          const ojo = await abrirCausa(msg.clave, msg.pagina, msg.usarFiltro !== false);
          // Se responde ANTES del clic: el submit navega y destruye este
          // script, y la respuesta se perdería.
          sendResponse({ ok: true });
          setTimeout(() => clicEnPagina(ojo), 100);
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }
  });

  if (!esLista()) return;

  // ─── Panel "Mi biblioteca" ───────────────────────────────────────────────
  // En Shadow DOM para que el CSS del SCW (Bootstrap) no lo afecte. Se
  // llama "Mi biblioteca" y no "Mis expedientes" porque el SCW ya tiene un
  // menú con ese nombre (los favoritos de la estrella).
  let filasLeidas = [];
  let estados = {};
  const seleccion = new Set();

  const host = document.createElement('div');
  host.id = 'infocivil-dgn-panel';
  const raiz = host.attachShadow({ mode: 'open' });
  raiz.innerHTML = `
    <style>
      :host { all: initial; display: block; margin: 12px 0 16px; font: 14px/1.4 Arial, Helvetica, sans-serif; color: #1f3737; }
      .caja { border: 1px solid #b8dada; border-radius: 6px; background: #f6f9fc; }
      .cab { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #d6ecec; flex-wrap: wrap; }
      .cab b { font-size: 15px; color: #156f6f; margin-right: auto; }
      button { font: inherit; padding: 6px 12px; border-radius: 4px; border: 1px solid #2bb0b0; background: #fff; color: #2bb0b0; cursor: pointer; }
      button.prim { background: #2bb0b0; color: #fff; }
      button:disabled { opacity: .5; cursor: default; }
      .estado { padding: 8px 12px; font-size: 13px; color: #4a6868; }
      .estado.error { color: #b42318; }
      .tabla { max-height: 420px; overflow: auto; border-top: 1px solid #d6ecec; display: none; }
      table { border-collapse: collapse; width: 100%; font-size: 13px; background: #fff; }
      th { position: sticky; top: 0; background: #e8eef6; text-align: left; padding: 6px 8px; font-weight: 600; }
      td { padding: 5px 8px; border-top: 1px solid #edf1f6; vertical-align: top; }
      .et { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; white-space: nowrap; }
      .et.no-guardado { background: #edf1f6; color: #4a6868; }
      .et.novedades { background: #fff3cd; color: #8a5a00; }
      .et.al-dia { background: #dcf3e3; color: #1f6b3a; }
      .pie { display: none; gap: 8px; padding: 10px 12px; border-top: 1px solid #d6ecec; flex-wrap: wrap; align-items: center; }
      .pie .info { margin-left: auto; font-size: 12px; color: #4a6868; }
    </style>
    <div class="caja">
      <div class="cab">
        <b>Infocivil Ebook DGN · Mi biblioteca</b>
        <button id="leer" class="prim">Leer lista completa</button>
      </div>
      <div class="estado" id="estado">Lee todas las páginas de esta lista para ver qué causas ya están en tu biblioteca y cuáles tienen novedades. No modifica nada en el SCW.</div>
      <div class="tabla" id="contTabla"><table>
        <thead><tr><th><input type="checkbox" id="todas" title="Seleccionar todas"></th><th>Expediente</th><th>Carátula</th><th>Situación</th><th>Últ. act.</th><th>Mi biblioteca</th></tr></thead>
        <tbody id="cuerpo"></tbody>
      </table></div>
      <div class="pie" id="pie">
        <button id="selNovedades">Seleccionar con novedades o sin guardar</button>
        <button id="guardar" class="prim" disabled>Guardar seleccionadas</button>
        <button id="detener" style="display:none">Detener</button>
        <span class="info">Hasta ${TOPE_LOTE} causas por tanda · se descargan de a una</span>
      </div>
    </div>`;

  const $ = id => raiz.getElementById(id);
  function avisar(texto, esError) {
    const el = $('estado');
    el.textContent = texto;
    el.classList.toggle('error', !!esError);
  }

  const ETIQUETAS = { 'no-guardado': 'No guardada', 'novedades': 'Con novedades', 'al-dia': 'Al día' };

  function pintarTabla() {
    const cuerpo = $('cuerpo');
    cuerpo.textContent = '';
    for (const f of filasLeidas) {
      const tr = document.createElement('tr');
      const est = (estados[f.clave] && estados[f.clave].estado) || 'no-guardado';
      const celdas = [f.expediente, f.caratula, f.situacion, f.ultimaActualizacion];
      const tdCheck = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = seleccion.has(f.clave);
      cb.disabled = !f.abrible;
      cb.addEventListener('change', () => { cb.checked ? seleccion.add(f.clave) : seleccion.delete(f.clave); actualizarBotones(); });
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);
      for (const t of celdas) { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); }
      const tdEst = document.createElement('td');
      const et = document.createElement('span');
      et.className = 'et ' + est;
      et.textContent = ETIQUETAS[est] || est;
      tdEst.appendChild(et);
      tr.appendChild(tdEst);
      cuerpo.appendChild(tr);
    }
    $('contTabla').style.display = filasLeidas.length ? 'block' : 'none';
    $('pie').style.display = filasLeidas.length ? 'flex' : 'none';
    actualizarBotones();
  }

  let loteEnCurso = false;
  function actualizarBotones() {
    const n = seleccion.size;
    $('guardar').disabled = loteEnCurso || n === 0 || n > TOPE_LOTE;
    $('guardar').textContent = n > TOPE_LOTE ? `Máximo ${TOPE_LOTE} por tanda (${n} seleccionadas)` : `Guardar seleccionadas (${n})`;
    $('leer').disabled = loteEnCurso || leyendo;
    $('detener').style.display = loteEnCurso ? '' : 'none';
  }

  function pedirFondo(msg) {
    return new Promise(r => {
      try { chrome.runtime.sendMessage(msg, resp => { void chrome.runtime.lastError; r(resp || null); }); }
      catch (e) { r(null); }
    });
  }

  async function refrescarEstados() {
    const r = await pedirFondo({ action: 'relacionadosEstado', filas: filasLeidas.map(f => ({ clave: f.clave, ultimaActualizacion: f.ultimaActualizacion })) });
    estados = (r && r.ok && r.estados) || {};
  }

  $('leer').addEventListener('click', async () => {
    $('leer').disabled = true;
    try {
      avisar('Leyendo la lista…');
      const res = await leerListaCompleta((pag, n) => avisar('Leyendo página ' + pag + '… (' + n + ' causas)'));
      filasLeidas = res.filas;
      await refrescarEstados();
      const cuenta = k => filasLeidas.filter(f => ((estados[f.clave] || {}).estado || 'no-guardado') === k).length;
      avisar(filasLeidas.length + ' causas en ' + res.paginas + ' página(s) · ' + cuenta('al-dia') + ' al día · ' +
        cuenta('novedades') + ' con novedades · ' + cuenta('no-guardado') + ' sin guardar' +
        (res.incompleta ? ' · ⚠ la lectura se cortó antes del final del paginador' : ''), res.incompleta);
      console.info('[Infocivil DGN] Lista de relacionados leída:', res.paginas, 'página(s),', filasLeidas.length, 'causas', res.incompleta ? '(INCOMPLETA)' : '');
      console.table(filasLeidas.map(f => ({ expediente: f.expediente, situacion: f.situacion, ultAct: f.ultimaActualizacion, pagina: f.pagina, abrible: f.abrible, biblioteca: (estados[f.clave] || {}).estado || 'no-guardado' })));
      pintarTabla();
    } catch (e) {
      avisar('No se pudo leer la lista: ' + (e.message || e), true);
    } finally {
      actualizarBotones();
    }
  });

  $('todas').addEventListener('change', e => {
    seleccion.clear();
    if (e.target.checked) filasLeidas.filter(f => f.abrible).forEach(f => seleccion.add(f.clave));
    pintarTabla();
  });

  $('selNovedades').addEventListener('click', () => {
    seleccion.clear();
    filasLeidas.filter(f => f.abrible && ((estados[f.clave] || {}).estado || 'no-guardado') !== 'al-dia')
      .slice(0, TOPE_LOTE).forEach(f => seleccion.add(f.clave));
    pintarTabla();
  });

  $('guardar').addEventListener('click', async () => {
    const items = filasLeidas.filter(f => seleccion.has(f.clave)).slice(0, TOPE_LOTE);
    if (!items.length) return;
    const r = await pedirFondo({ action: 'relacionadosGuardarLote', ruta: location.pathname, items });
    if (!r || !r.ok) { avisar('No se pudo iniciar el guardado: ' + ((r && r.error) || 'sin respuesta de la extensión'), true); return; }
    loteEnCurso = true;
    actualizarBotones();
    avisar('Guardando ' + items.length + ' causa(s) en una pestaña aparte… Podés seguir usando el SCW.');
  });

  $('detener').addEventListener('click', () => {
    pedirFondo({ action: 'relacionadosDetenerLote' });
    avisar('Deteniendo después de la causa en curso…');
  });

  // Progreso del lote (lo publica el fondo en chrome.storage.local).
  function mostrarLote(lote) {
    if (!lote) return;
    loteEnCurso = !lote.terminado;
    if (lote.terminado) {
      const errs = lote.errores || [];
      avisar('Tanda terminada: ' + lote.hechos + ' de ' + lote.total + ' guardada(s)' +
        (lote.detenido ? ' (detenida)' : '') +
        (errs.length ? ' · Con error: ' + errs.map(e => e.expediente + ' (' + e.error + ')').join(' · ') : ''), errs.length > 0);
      seleccion.clear();
      refrescarEstados().then(pintarTabla);
    } else {
      avisar('Guardando ' + (lote.hechos + 1) + ' de ' + lote.total + ': ' + (lote.actual || '') + (lote.etapa ? ' — ' + lote.etapa : ''));
    }
    actualizarBotones();
  }
  chrome.storage.onChanged.addListener((cambios, area) => {
    if (area === 'local' && cambios.dgnLote) mostrarLote(cambios.dgnLote.newValue);
  });
  chrome.storage.local.get('dgnLote', d => { if (d.dgnLote && !d.dgnLote.terminado) mostrarLote(d.dgnLote); });

  // El panel va arriba de la tabla; si RichFaces re-renderiza esa zona y lo
  // saca, se vuelve a poner.
  function montar() {
    if (host.isConnected) return;
    const tabla = tablaLista();
    const ancla = tabla ? (tabla.closest('form') || tabla) : null;
    if (ancla && ancla.parentNode) ancla.parentNode.insertBefore(host, ancla);
  }
  montar();
  new MutationObserver(() => { if (!host.isConnected) montar(); })
    .observe(document.body, { childList: true, subtree: true });
})();
