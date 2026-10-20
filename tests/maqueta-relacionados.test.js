// Prueba del content script contra una maqueta de consultaListaRelacionados.seam
// (estructura relevada del SCW real, datos inventados).
const fs = require('fs');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(process.argv[2], 'utf8');
const TOTAL = 37, POR_PAG = 15, PAGINAS = Math.ceil(TOTAL / POR_PAG);
const causas = Array.from({ length: TOTAL }, (_, i) => ({
  exp: 'CIV\n' + String(1000 + i * 7).padStart(6, '0') + '/20' + String(10 + (i % 15)).padStart(2, '0'),
  car: 'PRUEBA ' + i + ' S/DETERMINACION DE LA CAPACIDAD',
  act: (1 + (i % 28)) + '/0' + (1 + (i % 9)) + '/2026',
}));

const dom = new JSDOM(`<!doctype html><body><div class="container">
  <h2>Lista de Expedientes Relacionados</h2>
  <form id="tablaConsultaLista:tablaConsultaForm">
  <div class="form-group"><label>Jurisdicción</label><div><select id="j1"><option value="">Seleccione una opción</option><option value="0">CSJ - Corte Suprema</option><option value="1">CIV - Cámara Nacional de Apelaciones en lo Civil</option></select></div></div>
  <div class="form-group"><label>Número/Año</label><div><input type="text" id="n1"> <span>/</span> <input type="text" id="a1"></div></div>
  <div class="form-group"><label>Carátula</label><div><input type="text"></div></div>
  <div class="checkbox"><label><input type="checkbox" id="vt" onclick="__clics.verTodos=this.checked"> Ver todos los expedientes</label></div>
  <input type="submit" value="Consultar" onclick="__filtrar();return false">
  <div id="zona"></div></form></div></body>`,
  { url: 'https://scw.pjn.gov.ar/scw/consultaListaRelacionados.seam', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });

const clics = { ojo: [], estrella: 0, libro: 0, escrito: 0, paginas: [], filtros: [] };
let filtro = null;
window.__clics = clics;

function render(pag) {
  const desde = (pag - 1) * POR_PAG;
  const base = filtro ? causas.filter(c => filtro(c)) : causas;
  const filas = base.slice(desde, desde + POR_PAG).map((c, i) => `<tr>
    <td class="column">${c.exp}</td><td class="column">JUZGADO CIVIL 86 - SECRETARIA Nº 45</td>
    <td class="column">${c.car}</td><td class="column">EN LETRA</td><td class="column">${c.act}</td>
    <td class="text-center">
      <a href="#" class="btn btn-default btn-sm no-margin" onclick="jsf.util.chain(this,event,'PF(\\'dialog\\').show();','mojarra.jsfcljs(document.getElementById(\\'tablaConsultaLista:tablaConsultaForm\\'),{\\'x:dataTable:${i}:j\\':\\'x\\'},\\'\\')');__clics.ojo.push(${causas.indexOf(c)});return false">ojo</a>
      <button class="btn btn-default dropdown-toggle"></button>
      <ul><li><a href="#" onclick="mojarra.jsfcljs(f,{'a':'b','conversationPropagation':'join'},'');__clics.libro++;return false">Libro digital</a></li>
      <li><a href="#" onclick="mojarra.jsfcljs(f,{'a':'b','conversationPropagation':'join'},'_blank');__clics.escrito++;return false">Presentar escrito</a></li></ul>
    </td>
    <td class="text-center width-12"><a id="x:dataTable:${i}:agregarAfavorito:outputLink" class="favorite" href="#" onclick="jsf.util.chain(this,event,'x','mojarra.ab(this,event,\\'action\\',0,\\'agregarAfavorito\\')');__clics.estrella++;return false">★</a></td>
  </tr>`).join('');
  const nums = Array.from({ length: PAGINAS }, (_, k) => k + 1).map(n => n === pag
    ? `<li><a id="p:${n}" class="padding-pagination margin-pagination"><span>${n}</span></a></li>`
    : `<li><a id="p:${n}" class="padding-pagination margin-pagination" onclick="RichFaces.ajax('p:${n}',event,{});__irA(${n});return false;"><span>${n}</span></a></li>`).join('');
  const sig = pag < PAGINAS ? ` onclick="__irA(${pag + 1});return false;"` : '';
  const ult = pag < PAGINAS ? ` onclick="__irA(${PAGINAS});return false;"` : '';
  document.getElementById('zona').innerHTML = `<table id="tablaConsultaLista:tablaConsultaForm:j_idt88:dataTable">
    <thead><tr><th>Expediente</th><th>Dependencia</th><th>Carátula</th><th>Situación</th><th>Últ. Act.</th><th></th><th>☆</th></tr></thead>
    <tbody>${filas}</tbody></table>
    <ul class="pagination no-margin no-padding">${nums}
      <li><a id="p:sig" class="padding-pagination margin-pagination no-pagination-background"${sig}><span>›</span></a></li>
      <li><a id="p:ult" class="padding-pagination margin-pagination no-pagination-background last-page"${ult}><span>»</span></a></li></ul>`;
}
window.jsf = { util: { chain() {} } };
window.mojarra = { jsfcljs() {}, ab() {} };
window.PF = () => ({ show() {} });
window.RichFaces = { ajax() {} };
window.__filtrar = () => {
  const j = document.getElementById('j1').value, n = document.getElementById('n1').value, a = document.getElementById('a1').value;
  clics.filtros.push(j + ':' + n + '/' + a);
  filtro = c => j === '1' && Number(c.exp.match(/(\d+)\//)[1]) === Number(n) && c.exp.endsWith('/' + a);
  setTimeout(() => render(1), 250);
};
window.__irA = n => { clics.paginas.push(n); setTimeout(() => render(n), 250); };
render(1);

// chrome.* simulado
const almacen = {};
const oyentesStorage = [], oyentesMsg = [];
window.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) {
      setTimeout(() => {
        if (msg.action === 'runInPageWorld') { window.eval(msg.code); cb && cb({ ok: true }); return; }
        if (msg.action === 'relacionadosEstado') {
          const estados = {};
          msg.filas.forEach((f, i) => { estados[f.clave] = { estado: i === 0 ? 'al-dia' : i === 1 ? 'novedades' : 'no-guardado' }; });
          cb && cb({ ok: true, estados }); return;
        }
        if (msg.action === 'relacionadosGuardarLote') { window.__lote = msg; cb && cb({ ok: true, total: msg.items.length }); return; }
        cb && cb(null);
      }, 5);
    },
    onMessage: { addListener(f) { oyentesMsg.push(f); } },
  },
  storage: {
    local: { get(k, cb) { cb({}); }, set() {} },
    onChanged: { addListener(f) { oyentesStorage.push(f); } },
  },
};
window.console.table = () => {};
window.eval(SCRIPT);

const esperar = ms => new Promise(r => setTimeout(r, ms));
const mensaje = msg => new Promise(r => { if (oyentesMsg[0](msg, {}, r) !== true) {} });
let fallas = 0;
const ok = (cond, txt) => { console.log((cond ? 'OK   ' : 'FALLA') + ' ' + txt); if (!cond) fallas++; };

(async () => {
  const host = document.getElementById('infocivil-dgn-panel');
  ok(!!host && host.nextElementSibling && host.nextElementSibling.tagName === 'FORM', 'panel montado arriba del formulario');
  const raiz = host.shadowRoot;

  const est = await mensaje({ action: 'relacionadosEstadoPagina' });
  ok(est.esLista && est.filas === 15 && est.pagina === 1, 'estado de página: lista, 15 filas, página 1');

  raiz.getElementById('leer').click();
  for (let i = 0; i < 60 && !/causas en/.test(raiz.getElementById('estado').textContent); i++) await esperar(200);
  const filasPanel = raiz.getElementById('cuerpo').querySelectorAll('tr');
  ok(filasPanel.length === TOTAL, `lectura completa: ${filasPanel.length} de ${TOTAL} causas`);
  ok(JSON.stringify(clics.paginas) === '[2,3]', 'avanzó de a una página (2, 3) sin usar "última": ' + JSON.stringify(clics.paginas));
  console.log('      estado: ' + raiz.getElementById('estado').textContent);
  ok(filasPanel[0].textContent.includes('Al día') && filasPanel[1].textContent.includes('Con novedades'), 'etiquetas de biblioteca');

  // Desde la página 3, una causa de la página 1: debe ir por el filtro, sin paginar
  const pagsAntes = clics.paginas.length;
  const objF = 5, claveF = 'CIV|' + (1000 + objF * 7) + '|20' + String(10 + (objF % 15)).padStart(2, '0') + '|0';
  const rf = await mensaje({ action: 'relacionadosAbrir', clave: claveF });
  await esperar(600);
  ok(rf.ok && clics.ojo[0] === objF && clics.paginas.length === pagsAntes && clics.filtros.length === 1 && clics.verTodos,
    'abrir por filtro Número/Año con "Ver todos": ' + JSON.stringify({ ojo: clics.ojo, filtros: clics.filtros, verTodos: clics.verTodos }));
  filtro = null; render(3); clics.ojo = []; await esperar(50);

  // Sin filtro (reintento tras recarga): recorre páginas
  // Abrir una causa de la página 2 estando en la página 3
  const objetivo = 20; // índice global → página 2
  const clave = 'CIV|' + (1000 + objetivo * 7) + '|20' + String(10 + (objetivo % 15)).padStart(2, '0') + '|0';
  const r = await mensaje({ action: 'relacionadosAbrir', clave, pagina: 2, usarFiltro: false });
  await esperar(600);
  ok(r.ok && JSON.stringify(clics.ojo) === JSON.stringify([objetivo]), 'abrir causa de otra página clickea el ojo correcto: ' + JSON.stringify(clics.ojo));

  const r2 = await mensaje({ action: 'relacionadosAbrir', clave: 'CIV|999999|2001|0', pagina: 1 });
  ok(!r2.ok && /no figura/.test(r2.error), 'causa inexistente → error claro');

  raiz.getElementById('selNovedades').click();
  raiz.getElementById('guardar').click();
  await esperar(50);
  ok(window.__lote && window.__lote.items.length === 25 && !window.__lote.items.some(i => i.clave === filasLeidasPrimera()),
    'selección "con novedades o sin guardar" excluye las al día y respeta el tope de 25: ' + (window.__lote && window.__lote.items.length));
  function filasLeidasPrimera() { return 'CIV|1000|2010|0'; }

  ok(clics.estrella === 0 && clics.libro === 0 && clics.escrito === 0, 'nunca tocó estrella, Libro digital ni Presentar escrito');
  console.log(fallas ? `\n${fallas} falla(s)` : '\nTodo OK');
  process.exit(fallas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
