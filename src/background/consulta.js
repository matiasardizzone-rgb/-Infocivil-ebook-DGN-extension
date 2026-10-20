// consulta.js — Consulta de un expediente desde la pantalla de inicio de la
// extensión (src/public/inicio.html), sin que el operador pase por el SCW.
//
// El SCW sigue siendo la fuente (no tiene otra vía pública): se abre en una
// PESTAÑA en segundo plano, al lado de la de la extensión, y el operador
// nunca la ve. Se completa la Consulta Pública, se leen históricas (antes
// de 2019) y actuaciones, y al final los vinculados. La pestaña queda
// abierta mientras la pantalla de inicio la necesite para descargar y se
// cierra sola cuando se cierra o se va de esa pantalla.
//
// Comunicación con inicio.html por un puerto (chrome.runtime.connect con
// nombre 'consulta'): mantiene vivo el service worker durante la consulta y
// avisa cuándo la pantalla se cerró.
//
// Lógica de búsqueda portada del Portable (src/scw/buscarExpediente.js),
// que es la versión probada contra el SCW real: no alcanza con ver cid= en
// la URL (el SCW lo agrega a casi todas sus páginas); se confirma por
// contenido (ver estadoPaginaSCW en scw-content.js).

const SCW = 'https://scw.pjn.gov.ar/scw';
const URL_HOME = SCW + '/home.seam';
const urlExpediente = cid => SCW + '/expediente.seam?cid=' + cid;
const urlHistoricas = cid => SCW + '/actuacionesHistoricas.seam?cid=' + cid;

const esperar = ms => new Promise(r => setTimeout(r, ms));

// ─── Variante DGN: búsqueda en "Lista de Expedientes Relacionados" ─────────
// Las causas restringidas (las que ve un defensor o letrado vinculado por el
// juzgado) no aparecen en la Consulta Pública. Con sesión iniciada se buscan
// primero en la lista de relacionados del usuario; la Consulta Pública queda
// como último recurso.
const URL_RELACIONADOS = SCW + '/consultaListaRelacionados.seam';
const URL_LOGIN = 'https://portalpjn.pjn.gov.ar/';
const RE_LOGIN = /^https:\/\/(sso|portalpjn)\.pjn\.gov\.ar\//;

const claveDe = (sigla, numero, anio, inc) =>
  String(sigla || '').toUpperCase() + '|' + Number(numero) + '|' + anio + '|' + (inc ? Number(inc) : 0);

// { estado: 'abierto', cid } | { estado: 'sin-sesion' } | { estado: 'no-figura' }
// La pestaña ya tiene que estar navegando a URL_RELACIONADOS.
export async function abrirDesdeRelacionados(tabId, clave, avisar) {
  const inicio = Date.now();
  let enLoginDesde = null, fueraDeListaDesde = null, listaVaciaDesde = null;
  while (true) {
    if (Date.now() - inicio > 45000) throw new Error('El SCW no respondió (no cargó la lista de expedientes relacionados).');
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Se cerró la ventana del SCW.');
    const url = tab.url || tab.pendingUrl || '';
    // El SSO puede pasar de largo (redirección con la sesión ya abierta):
    // solo cuenta como "sin sesión" si se queda en la página de login.
    if (RE_LOGIN.test(url)) {
      if (enLoginDesde === null) enLoginDesde = Date.now();
      else if (tab.status === 'complete' && Date.now() - enLoginDesde > 5000) return { estado: 'sin-sesion' };
    } else if (tab.status === 'complete') {
      enLoginDesde = null;
      const e = await pedir(tabId, { action: 'relacionadosEstadoPagina' });
      if (e && e.esLista && e.filas > 0) break;
      if (e && e.esLista) {                       // lista sin filas: sin causas vinculadas
        if (listaVaciaDesde === null) listaVaciaDesde = Date.now();
        else if (Date.now() - listaVaciaDesde > 6000) return { estado: 'no-figura' };
      } else if (e) {                             // otra página del SCW: sin sesión de letrado
        if (fueraDeListaDesde === null) fueraDeListaDesde = Date.now();
        else if (Date.now() - fueraDeListaDesde > 5000) return { estado: 'sin-sesion' };
      }
    }
    await esperar(400);
  }

  avisar('Buscando en tus expedientes relacionados…');
  const r = await pedir(tabId, { action: 'relacionadosAbrir', clave });
  if (!r) throw new Error('No se pudo leer la lista de expedientes relacionados.');
  if (!r.ok) {
    if (/no figura/i.test(r.error || '')) return { estado: 'no-figura' };
    throw new Error(r.error);
  }
  avisar('Abriendo el expediente…');
  const exp = await esperarEstado(tabId, e => e.esExpediente && !!e.cid, 45000, 'abriendo desde relacionados');
  if (exp.vencido) throw new Error('El expediente no terminó de abrir desde la lista de relacionados.');
  const actual = await pedir(tabId, { action: 'relacionadosClaveActual' });
  if (actual && actual.clave && actual.clave !== clave) {
    throw new Error('Se abrió otra causa (' + actual.clave.replace(/\|/g, ' ') + ') en lugar de la pedida.');
  }
  return { estado: 'abierto', cid: exp.cid };
}

// La ventana de consulta se enfoca (ver más abajo, en consultar()); esto le
// devuelve el foco al operador apenas termina de buscar, sin depender de
// que la ventana de consulta se cierre (sigue abierta, sin foco, por si
// hace falta para las descargas).
// La pestaña del SCW corre oculta, así que normalmente no hay foco que
// devolver. Solo si por algún motivo quedó al frente (el operador la
// abrió a mano, por ejemplo) se vuelve a la de origen; si no, no se mueve
// al operador de donde esté.
async function devolverFoco(sesion) {
  if (!sesion.pestanaPrevia || !sesion.tabId) return;
  const scw = await chrome.tabs.get(sesion.tabId).catch(() => null);
  if (scw && scw.active) chrome.tabs.update(sesion.pestanaPrevia, { active: true }).catch(() => {});
}

// Mensaje al content script de la pestaña; null si todavía no hay uno
// escuchando (la página está navegando o cargando).
export function pedir(tabId, mensaje) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, mensaje, resp => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
}

// El SCW parece dar varios saltos de navegación seguidos al abrir
// home.seam por primera vez (visto contra el sitio real: el formulario no
// estaba, pese a que la pestaña ya reportaba 'complete' y el content
// script respondió). "complete" del navegador no alcanza como señal de
// que la página está lista — hay que confirmarlo por CONTENIDO
// (condicion sobre el resultado de 'estadoPagina') antes de mandar el
// mensaje real, y si aun así no llega respuesta (perdida por una
// renavegación en el instante entre medio), reintentar.
// Backoff de reintento: arranca en 350ms y sube de a 150ms hasta un techo
// de 2000ms (antes: arrancaba en 600ms, subía de a 200ms). Sigue dando más
// margen cuanto más tarda —para no hostigar a una pestaña que está
// genuinamente atascada— pero deja de partir con casi un segundo de
// ventaja regalado en el caso normal, que es la mayoría de las veces.
export async function pedirCuandoListo(tabId, condicion, mensaje, { timeoutMs = 30000 } = {}) {
  const inicio = Date.now();
  let ultimoEstado = null, intento = 0;
  while (Date.now() - inicio < timeoutMs) {
    intento++;
    const seg = () => Math.round((Date.now() - inicio) / 1000);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Se cerró la ventana del SCW.');

    if (tab.status !== 'complete') {
      // Antes esto quedaba en silencio: si la pestaña nunca llega a
      // 'complete' (por ejemplo, atascada en una redirección), el bucle
      // entero pasaba sin dejar un solo rastro en la consola.
      if (intento % 3 === 0) console.warn('[Infocivil consulta] Pestaña sin terminar de cargar para "' +
        mensaje.action + '" (' + seg() + 's, intento ' + intento + '): status=' + tab.status + ' url=' + tab.url);
      await esperar(Math.min(200 + intento * 150, 2000));
      continue;
    }

    const estado = await pedir(tabId, { action: 'estadoPagina' });
    if (!estado) {
      // Tampoco esto: 'complete' pero el content script no respondió
      // nada (no se inyectó, o se está reinyectando justo ahora).
      if (intento % 3 === 0) console.warn('[Infocivil consulta] Sin respuesta del content script para "' +
        mensaje.action + '" (' + seg() + 's, intento ' + intento + '): url=' + tab.url);
      await esperar(Math.min(200 + intento * 150, 2000));
      continue;
    }

    ultimoEstado = estado;
    if (condicion(estado)) {
      const r = await pedir(tabId, mensaje);
      if (r) return r;
      console.warn('[Infocivil consulta] Página lista pero sin respuesta a "' + mensaje.action +
        '" (intento ' + intento + ', ' + seg() + 's, url=' + tab.url +
        ') — probablemente renavegó justo entonces. Reintentando…');
    } else if (intento % 3 === 0) {
      console.warn('[Infocivil consulta] Página aún no lista para "' + mensaje.action + '" (' + seg() +
        's, intento ' + intento + '): url=' + tab.url + ' enHome=' + estado.enHome +
        ' esExpediente=' + estado.esExpediente + ' linksResultados=' + estado.linksResultados +
        ' mensajes=' + JSON.stringify(estado.mensajes));
    }
    await esperar(Math.min(200 + intento * 150, 2000));
  }
  console.warn('[Infocivil consulta] Se agotó el tiempo esperando "' + mensaje.action + '" (' +
    Math.round(timeoutMs / 1000) + 's). Último estado visto:', ultimoEstado);
  return null;
}

// Espera hasta que el estado de la página cumpla la condición.
export async function esperarEstado(tabId, condicion, timeoutMs, etiqueta = '') {
  const inicio = Date.now();
  let ultimo = null, intento = 0;
  while (Date.now() - inicio < timeoutMs) {
    intento++;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Se cerró la ventana del SCW.');
    if (tab.status === 'complete') {
      const estado = await pedir(tabId, { action: 'estadoPagina' });
      if (estado) {
        ultimo = estado;
        if (condicion(estado)) return estado;
        if (etiqueta && intento % 3 === 0) console.warn('[Infocivil consulta] ' + etiqueta + ': condición aún no cumplida (' +
          Math.round((Date.now() - inicio) / 1000) + 's): url=' + tab.url + ' ' + JSON.stringify(estado));
      } else if (etiqueta && intento % 3 === 0) {
        console.warn('[Infocivil consulta] ' + etiqueta + ': sin respuesta del content script (' +
          Math.round((Date.now() - inicio) / 1000) + 's): url=' + tab.url);
      }
    } else if (etiqueta && intento % 3 === 0) {
      console.warn('[Infocivil consulta] ' + etiqueta + ': pestaña sin terminar de cargar (' +
        Math.round((Date.now() - inicio) / 1000) + 's): status=' + tab.status + ' url=' + tab.url);
    }
    // 200ms (antes 500ms): el costo de cada sondeo es un chrome.tabs.get +
    // sendMessage, del orden de unos pocos ms — nada comparado con los
    // segundos de round-trip del SCW. Sondear más seguido no lo sobrecarga
    // y recorta hasta ~300ms de latencia "de detección" en cada una de las
    // varias transiciones de esta función a lo largo de una consulta
    // (home, resultado de búsqueda, confirmar expediente, volver de
    // históricas) — no cambia ningún timeout, solo qué tan rápido se nota
    // que la condición ya se cumplió.
    await esperar(200);
  }
  return { vencido: true, ultimo };
}

async function esperarStorage(clave, timeoutMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const d = await chrome.storage.local.get([clave, 'pjnHistoricasResult']);
    if (clave in d) return { ok: true, valor: d[clave] };
    if (d.pjnHistoricasResult && d.pjnHistoricasResult.ok === false) {
      return { ok: false, error: d.pjnHistoricasResult.error };
    }
    // 300ms (antes 700ms): chrome.storage.local.get es local, no hay
    // round-trip de red que justifique espaciarlo tanto.
    await esperar(300);
  }
  return { ok: false, error: 'tiempo agotado' };
}

// Históricas + actuaciones sobre un expediente YA confirmado (cid propio):
// la parte de consultar() que no depende de cómo se llegó hasta acá.
// Reusada tanto por la búsqueda normal como por abrir un vinculado sobre
// una pestaña que ya estaba en el expediente.
// Desde este año el fuero no tiene actuaciones históricas (dato del
// operador: los expedientes de 2019 en adelante nacieron digitales). Para
// esos no se visita actuacionesHistoricas.seam: se ahorra la ida, la
// espera y la vuelta enteras.
const ANIO_SIN_HISTORICAS = 2019;

export async function leerHistoricasYActuaciones(tabId, cid, avisar, anio) {
  const clave = 'pjnHistoricas_' + cid;
  let vuelta;
  if (Number(anio) >= ANIO_SIN_HISTORICAS) {
    // Lista vacía explícita (no ausencia de la clave): así obtenerActuaciones
    // no lo reporta como "históricas faltantes".
    await chrome.storage.local.set({ [clave]: [] });
    vuelta = await esperarEstado(tabId, e => e.esExpediente, 30000, 'confirmando expediente');
    if (vuelta.vencido) throw new Error('La página del expediente no terminó de cargar.');
  } else {
    avisar('Leyendo actuaciones históricas…');
    await chrome.storage.local.remove([clave, 'pjnHistoricasResult']);
    await chrome.tabs.update(tabId, { url: urlHistoricas(cid) });
    const hist = await esperarStorage(clave, 60000);
    if (!hist.ok) console.warn('[Infocivil consulta] Históricas no leídas:', hist.error);

    await chrome.tabs.update(tabId, { url: urlExpediente(cid) });
    vuelta = await esperarEstado(tabId, e => e.esExpediente, 30000, 'volviendo al expediente tras históricas');
    if (vuelta.vencido) throw new Error('No se pudo volver al expediente después de leer las históricas.');
  }

  avisar('Leyendo actuaciones…');
  // Generoso a propósito: adentro puede haber varias páginas, cada una
  // con hasta 70s de margen (25s + 45s de reintento, ver scw-content.js)
  // porque esta pestaña corre en segundo plano casi siempre.
  const act = await pedirCuandoListo(tabId, e => e.esExpediente, { action: 'obtenerActuaciones' }, { timeoutMs: 300000 });
  if (!act || !act.ok) throw new Error((act && act.error) || 'No se pudieron leer las actuaciones (la página del expediente no terminó de asentarse).');

  return { vuelta, act };
}

async function consultar({ valorJurisdiccion, sigla, numero, anio, incidente }, sesion, avisar) {
  // Se reasigna más abajo si termina abriendo un incidente en vez del
  // principal (nombre del PRINCIPAL hasta ese punto — los mensajes de
  // "Buscando…"/"Abriendo…" de más arriba hablan del principal a propósito,
  // es lo que el operador tecleó).
  let nombre = `${sigla} ${numero}/${anio}`;

  // Varias ventanas aparte (minimizada, chica sin foco, chica con foco,
  // grande con foco) se probaron para intentar que la búsqueda fuera
  // invisible, y ninguna funcionó de forma confiable — además de que una
  // ventana emergente aparte es rara y no se integra con nada.
  // Se abandona esa idea: la búsqueda pasa por una PESTAÑA común, dentro
  // de la ventana del operador, igual que si abriera el SCW a mano (que
  // es, al final, la única forma que se confirmó que funciona). Se
  // recuerda cuál era la pestaña activa antes para volver a ella apenas
  // se encuentra el expediente.
  // Pestaña de origen: la que mandó la consulta (sesion.pestanaOrigen, que
  // Chrome informa en el propio mensaje), no "la activa de la última
  // ventana enfocada" — con la consola del service worker abierta, esa
  // consulta puede devolver la ventana de DevTools, y el foco nunca vuelve.
  const pestanaPrevia = sesion.pestanaOrigen ||
    await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      .then(t => (t && t[0]) || null).catch(() => null);

  avisar('Conectando con el Sistema de Consulta Web…');
  // En segundo plano (active:false), al lado de la pestaña de la
  // extensión: el operador nunca ve el SCW. Entre v0.9.0 y v0.9.3 se
  // sospechó de la visibilidad por un corte en la paginación (13 de 29) —
  // falsa pista: la causa era la solapa "Vinculados" abierta confundiendo
  // el paginador (ver scw-content.js, paginadorActuaciones). La búsqueda
  // oculta sí funcionó en v0.9.0, y la paginación en segundo plano sí
  // trajo las 29 en v0.5.x.
  const tab = await chrome.tabs.create({
    url: URL_RELACIONADOS, active: false,
    ...(pestanaPrevia ? { windowId: pestanaPrevia.windowId, index: pestanaPrevia.index + 1 } : {}),
  });
  const tabId = tab.id;
  sesion.tabId = tabId;
  sesion.pestanaPrevia = pestanaPrevia && pestanaPrevia.id !== tabId ? pestanaPrevia.id : null;

  // Variante DGN: primero la lista de relacionados del usuario (el incidente
  // puede figurar como fila propia; si no, se abre el principal y después
  // el incidente por la solapa Vinculados, como siempre).
  let estado = null;
  let incidenteAbierto = false;
  let rel = await abrirDesdeRelacionados(tabId, claveDe(sigla, numero, anio, incidente), avisar);
  if (rel.estado === 'abierto' && incidente) incidenteAbierto = true;
  if (rel.estado === 'no-figura' && incidente) {
    await chrome.tabs.update(tabId, { url: URL_RELACIONADOS });
    rel = await abrirDesdeRelacionados(tabId, claveDe(sigla, numero, anio, null), avisar);
  }
  if (rel.estado === 'sin-sesion') {
    chrome.tabs.create({ url: URL_LOGIN, active: true,
      ...(pestanaPrevia ? { windowId: pestanaPrevia.windowId, index: pestanaPrevia.index + 1 } : {}) }).catch(() => {});
    throw new Error('No hay una sesión iniciada en el Sistema de Consulta Web. Se abrió la página de ingreso del PJN: ' +
      'iniciá sesión con tu usuario y volvé a consultar.');
  }
  if (rel.estado === 'abierto') {
    estado = { cid: rel.cid };
  } else {
    avisar('No figura entre tus expedientes relacionados; probando la Consulta Pública…');
    await chrome.tabs.update(tabId, { url: URL_HOME });
  }

  if (!estado) {
  const home = await esperarEstado(tabId, e => e.enHome, 30000, 'esperando home.seam');
  if (home.vencido) throw new Error('El expediente ' + nombre + ' no figura entre tus expedientes relacionados (y la Consulta Pública no respondió).');

  // Tres salidas posibles: el expediente, una página de resultados, o de
  // vuelta en home.seam (típicamente con un mensaje de "no encontrado").
  // Para distinguir "todavía no envió" de "volvió a home", se exige haber
  // visto la pestaña navegar después del envío, o que home muestre un
  // mensaje (por si el SCW contesta por AJAX sin recargar). El registro de
  // la navegación se activa ANTES de enviar, para no perderla.
  let navego = false;
  const onUpdated = (id, info) => { if (id === tabId && info.status === 'loading') navego = true; };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    avisar('Buscando ' + nombre + '…');
    const r = await pedirCuandoListo(tabId, e => e.enHome,
      { action: 'completarFormularioBusqueda', valorJurisdiccion, numero, anio }, { timeoutMs: 12000 });
    if (!r || !r.ok) {
      // Visto contra el sitio real: el envío puede funcionar (la página
      // navega al expediente correcto) y perderse solo la RESPUESTA de
      // ese mensaje, porque la navegación destruye el content script en
      // el instante en que iba a contestar. pedirCuandoListo, al no
      // recibir respuesta, sigue esperando 'enHome' — que ya no vuelve a
      // ser cierto nunca, porque ya estamos en el expediente. Antes de
      // darlo por error, nos fijamos si la página ya avanzó de verdad.
      const chequeo = await pedir(tabId, { action: 'estadoPagina' });
      if (!chequeo || !(chequeo.esExpediente || chequeo.linksResultados > 0)) {
        throw new Error((r && r.error) || 'No se pudo completar la Consulta Pública (la página del SCW no terminó de asentarse).');
      }
      console.warn('[Infocivil consulta] El envío no confirmó respuesta, pero la página ya avanzó ' +
        '(la búsqueda probablemente sí funcionó): url=' + chequeo.url);
    }
    const inicio = Date.now();
    let resultadosTomados = false;
    while (true) {
      if (Date.now() - inicio > 45000) {
        throw new Error('El SCW tardó demasiado en responder la búsqueda de ' + nombre + '.');
      }
      estado = await esperarEstado(tabId, e =>
        (navego && (e.esExpediente || e.linksResultados > 0 || e.enHome)) || (e.enHome && !!e.mensajes), 5000, 'esperando resultado de la búsqueda');
      if (estado.vencido) continue;
      if (estado.esExpediente && estado.cid) break;
      if (estado.linksResultados > 0 && !resultadosTomados) {
        resultadosTomados = true;
        navego = false;
        avisar('Abriendo el expediente…');
        await pedirCuandoListo(tabId, e => e.linksResultados > 0, { action: 'tomarPrimerResultadoBusqueda' }, { timeoutMs: 8000 });
        continue;
      }
      if (estado.enHome) {
        throw new Error('No se encontró el expediente ' + nombre + ' ni entre tus expedientes relacionados ni en la Consulta Pública.' +
          (estado.mensajes ? ' El SCW dice: ' + estado.mensajes : ''));
      }
    }
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
  } // fin de la Consulta Pública (solo si no figuraba en relacionados)

  let cid = estado.cid;
  let aviso = '';

  // Vinculados: se leen siempre (para mostrarlos en la pantalla de
  // resultados, haya o no incidente pedido), sobre el expediente PRINCIPAL
  // — es donde vive la solapa "Vinculados".
  // Vinculados: se leen del PRINCIPAL, abriendo su solapa. Si se pidió un
  // incidente hay que hacerlo ya (para abrirlo); si no, recién DESPUÉS de
  // leer las actuaciones — con la solapa abierta, su paginador propio
  // confundía la paginación de actuaciones (13 de 29, contra el SCW real).
  let vinculados = [];
  const leerVinc = async () => {
    avisar('Buscando vinculados…');
    const vin = await pedir(tabId, { action: 'leerVinculados' });
    if (vin && vin.ok) vinculados = vin.vinculados || [];
    else console.warn('[Infocivil consulta] No se pudo leer vinculados:', vin && vin.error);
  };
  if (incidente && !incidenteAbierto) await leerVinc();
  if (incidenteAbierto) nombre = sigla + ' ' + numero + '/' + anio + '/' + incidente;

  if (incidente && !incidenteAbierto) {
    const objetivo = sigla + ' ' + numero + '/' + anio + '/' + incidente;
    avisar('Abriendo el incidente ' + incidente + '…');
    const cidPrincipal = cid;
    let r = await pedir(tabId, { action: 'abrirVinculado', expediente: objetivo });
    if (!r) {
      // Mismo patrón que el envío del formulario de búsqueda (v0.5.5): el
      // clic en el botón "ojo" puede funcionar de verdad (la página navega
      // al incidente) y perderse solo la RESPUESTA, porque la navegación
      // destruye el content script en el instante de contestar. Antes de
      // reintentar —que correría sobre la página YA navegada al incidente,
      // sin tabla de vinculados, y fallaría por una razón distinta y
      // confusa— nos fijamos si ya cambió de expediente.
      const chequeo = await esperarCambioDeExpediente(tabId, cidPrincipal);
      if (chequeo && chequeo.esExpediente && chequeo.cid && chequeo.cid !== cidPrincipal) {
        r = { ok: true, cid: chequeo.cid };
        console.warn('[Infocivil consulta] Abrir vinculado sin confirmar respuesta, pero la página ya cambió de expediente (probablemente sí funcionó): cid=' + chequeo.cid);
      } else {
        await esperar(1000);
        r = await pedir(tabId, { action: 'abrirVinculado', expediente: objetivo });
      }
    }
    if (r && r.ok && r.cid) {
      cid = r.cid;
      nombre = objetivo; // ya no es el principal: la pantalla debe decir "CIV .../n", no el principal
      // "vinculados" hasta acá es la solapa del PRINCIPAL (se leyó arriba,
      // antes de abrir el incidente — es donde vive esa solapa). Ahora que
      // cid pasó a ser el del incidente, esa lista queda mal atribuida: es
      // la lista de vinculados DEL PRINCIPAL (que lo incluye a él mismo),
      // no la del incidente. Sin este reset, quedaba guardado un
      // expediente marcado como "vinculado de sí mismo" (visto en la
      // práctica). No se vuelve a leer la solapa en la página del
      // incidente (ya es bastante frágil como para pedirle más lecturas);
      // se deja vacío, igual que ya hace abrirVinculadoEnPestanaExistente
      // para este mismo caso.
      vinculados = [];
    } else {
      aviso = 'No se pudo abrir el incidente ' + incidente + ' (' +
        ((r && r.error) || 'no encontrado en Vinculados') + '): se abrió el expediente principal.';
    }
  }
  sesion.cid = cid;

  // Históricas: se leen navegando la misma pestaña a su página (el
  // content script las lee solo y las deja en storage) y se vuelve.
  const { vuelta, act } = await leerHistoricasYActuaciones(tabId, cid, avisar, anio);
  if (!incidente || incidenteAbierto) await leerVinc();

  // Por si la pestaña del SCW quedó al frente (ver devolverFoco()).
  devolverFoco(sesion);

  return {
    cid, tabId, aviso,
    nombre,
    caratula: vuelta.caratula || act.tituloExpediente || '',
    folderName: act.folderName,
    tituloExpediente: act.tituloExpediente,
    actuaciones: act.actuaciones || [],
    archivos: act.archivos || [],
    historicasFaltantes: !!act.historicasFaltantes,
    paginacionIncompleta: !!act.paginacionIncompleta,
    vinculados,
  };
}

// Abrir un vinculado desde la pantalla de resultados: mensaje suelto
// (sendMessage), no puerto. Un puerto de conexión larga (el que usa la
// búsqueda inicial) puede quedar mirando a un service worker que ya se
// apagó por inactividad — visto en la práctica: la pantalla de resultados
// puede quedar quieta un buen rato antes de que alguien toque "Abrir" en
// un vinculado, tiempo de sobra para que se apague. sendMessage es el
// mecanismo estándar para justamente ese caso (despertarlo bajo demanda),
// a costa de no tener mensajes de 'etapa' en vivo por este camino — la
// pantalla ya no los necesita, solo el resultado final.
// Abrir un vinculado directo sobre la pestaña del expediente PRINCIPAL,
// si esa pestaña sigue abierta (queda abierta en segundo plano después de
// cada búsqueda, justamente para esto). No pasa por home.seam de nuevo:
// nada de foco en ningún momento, porque no hay ningún salto de
// navegación delicado de por medio esta vez — la pestaña ya está en el
// expediente correcto. null si la pestaña ya no sirve (cerrada, navegada
// a otra cosa): el llamador decide si cae a la búsqueda completa.
// Tras un clic en un vinculado cuya respuesta se perdió con la navegación:
// espera hasta ~8 s a que la pestaña muestre otro expediente (antes se
// miraba una sola vez a los 800 ms; si el SCW tardaba un poco más, se
// reintentaba sobre la página nueva y fallaba con un error engañoso).
async function esperarCambioDeExpediente(tabId, cidAnterior) {
  let ultimo = null;
  const inicio = Date.now();
  while (Date.now() - inicio < 8000) {
    await esperar(500);
    ultimo = await pedir(tabId, { action: 'estadoPagina' });
    if (ultimo && ultimo.esExpediente && ultimo.cid && ultimo.cid !== cidAnterior) return ultimo;
  }
  return ultimo;
}

async function abrirVinculadoEnPestanaExistente(tabId, expedienteTexto, avisar, pestanaOrigen) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  const estadoPrevio = await pedir(tabId, { action: 'estadoPagina' });
  if (!estadoPrevio || !estadoPrevio.esExpediente) return null;
  const cidPrincipal = estadoPrevio.cid;

  // Todo en segundo plano, sin traer la pestaña al frente (v0.9.3 lo
  // hacía por una sospecha sobre la visibilidad que resultó falsa).
  try {
    avisar('Abriendo ' + expedienteTexto + '…');
    let r = await pedir(tabId, { action: 'abrirVinculado', expediente: expedienteTexto });
    if (!r) {
      // Mismo patrón que en consultar(): la respuesta se puede perder por la
      // navegación aunque el clic haya funcionado de verdad.
      const chequeo = await esperarCambioDeExpediente(tabId, cidPrincipal);
      if (chequeo && chequeo.esExpediente && chequeo.cid && chequeo.cid !== cidPrincipal) {
        r = { ok: true, cid: chequeo.cid };
      } else {
        await esperar(1000);
        r = await pedir(tabId, { action: 'abrirVinculado', expediente: expedienteTexto });
      }
    }
    if (!r || !r.ok || !r.cid) {
      // Dos motivos de error posibles acá, y merecen trato distinto:
      // - "... en la lista": la solapa Vinculados SÍ se pudo leer, y el
      //   expediente pedido genuinamente no está en ella — no tiene
      //   sentido reintentar con una búsqueda nueva, va a dar el mismo
      //   resultado.
      // - cualquier otro motivo (p. ej. "no se pudo abrir la solapa
      //   'Vinculados': sin-vinculados" o "no-disponible"): la solapa
      //   Vinculados que ya se había leído una vez al buscar puede haber
      //   perdido su estado en esta pestaña sin que la pestaña en sí se
      //   haya cerrado — por ejemplo, Chrome puede descargar ("discard")
      //   una pestaña de fondo para liberar memoria y recargarla desde
      //   cero recién al volver a usarla, perdiendo toda solapa ya
      //   abierta. Acá no hay que darse por vencido: se devuelve null
      //   para que el llamador caiga a la búsqueda completa de abajo,
      //   que reabre el expediente de cero y probablemente funcione.
      if (r && r.error && /en la lista\.?$/.test(r.error)) throw new Error(r.error);
      return null; // sin respuesta, o motivo no concluyente: que decida el llamador
    }

    const cid = r.cid;
    const { vuelta, act } = await leerHistoricasYActuaciones(tabId, cid, avisar, ((expedienteTexto || '').match(/\/(\d{4})\//) || [])[1]);
    return {
      cid, tabId, aviso: '', nombre: expedienteTexto,
      caratula: vuelta.caratula || act.tituloExpediente || '',
      folderName: act.folderName,
      tituloExpediente: act.tituloExpediente,
      actuaciones: act.actuaciones || [],
      archivos: act.archivos || [],
      historicasFaltantes: !!act.historicasFaltantes,
      paginacionIncompleta: !!act.paginacionIncompleta,
      vinculados: [],
    };
  } finally {
    // Solo si la pestaña del SCW quedó al frente por algún motivo.
    const scw = await chrome.tabs.get(tabId).catch(() => null);
    if (pestanaOrigen && scw && scw.active) chrome.tabs.update(pestanaOrigen.id, { active: true }).catch(() => {});
  }
}

export function iniciarAperturaVinculados() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== 'consultarVinculado') return;
    (async () => {
      try {
        if (msg.tabIdExistente && msg.expedienteVinculado) {
          try {
            const res = await abrirVinculadoEnPestanaExistente(
              msg.tabIdExistente, msg.expedienteVinculado, () => {}, sender && sender.tab);
            if (res) { sendResponse({ tipo: 'listo', ...res }); return; }
          } catch (err) {
            // Vinculado genuinamente no encontrado ahí: no tiene sentido
            // repetir con una búsqueda nueva, va a dar lo mismo.
            sendResponse({ tipo: 'error', texto: err.message || String(err) });
            return;
          }
          console.warn('[Infocivil consulta] La pestaña existente ya no sirve para abrir el vinculado; se busca de nuevo desde cero.');
        }
        const sesion = { pestanaOrigen: sender && sender.tab };
        try {
          const res = await consultar(msg, sesion, () => {});
          sendResponse({ tipo: 'listo', ...res });
        } catch (err) {
          await devolverFoco(sesion);
          if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
          throw err;
        }
      } catch (err) {
        console.warn('[Infocivil consulta]', err);
        sendResponse({ tipo: 'error', texto: err.message || String(err) });
      }
    })();
    return true; // respuesta asíncrona
  });
}

export function iniciarConsultas() {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'consulta') return;
    const sesion = { tabId: null, cid: null, pestanaOrigen: port.sender && port.sender.tab };
    const avisar = texto => { try { port.postMessage({ tipo: 'etapa', texto }); } catch (e) {} };

    // Cerrar la pestaña del SCW cuando la pantalla de inicio (la pestaña
    // que abrió este puerto) se cierra DE VERDAD — no cuando el puerto se
    // cae porque el service worker se apagó solo por inactividad, que en
    // Manifest V3 es NORMAL y pasa aunque la pantalla siga abierta y
    // quieta (visto en la práctica: "Se perdió la conexión con la
    // extensión" apenas el operador tardaba un rato en tocar algo después
    // de que llegaran los resultados). Antes esto se hacía con
    // port.onDisconnect, que no distingue entre "la pantalla cerró de
    // verdad" y "el service worker durmió" — en el segundo caso, cerraba
    // la pestaña del SCW por abajo igual, y cualquier acción posterior
    // (Leer como libro, Agregar a Mis expedientes, etc.) fallaba porque ya
    // no había pestaña, aunque la pantalla siguiera perfectamente abierta.
    // chrome.tabs.onRemoved sí es confiable en este caso: no depende del
    // puerto ni del service worker estar despierto (Chrome lo entrega
    // igual, despertándolo si hace falta).
    const tabOrigenId = port.sender && port.sender.tab && port.sender.tab.id;
    function alCerrarPestanaOrigen(tabId) {
      if (tabId !== tabOrigenId) return;
      chrome.tabs.onRemoved.removeListener(alCerrarPestanaOrigen);
      if (sesion.rescateTimer) clearTimeout(sesion.rescateTimer);
      if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
    }
    if (tabOrigenId != null) chrome.tabs.onRemoved.addListener(alCerrarPestanaOrigen);

    port.onMessage.addListener(async msg => {
      if (!msg || msg.tipo !== 'consultar') return;
      if (sesion.tabId) {
        // Consulta nueva desde la misma pantalla: se descarta la anterior.
        if (sesion.rescateTimer) { clearTimeout(sesion.rescateTimer); sesion.rescateTimer = null; }
        chrome.tabs.remove(sesion.tabId).catch(() => {});
        sesion.tabId = sesion.cid = null;
      }
      try {
        const res = await consultar(msg, sesion, avisar);
        port.postMessage({ tipo: 'listo', ...res });
      } catch (err) {
        console.warn('[Infocivil consulta]', err);
        await devolverFoco(sesion);
        if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
        sesion.tabId = sesion.cid = null;
        try { port.postMessage({ tipo: 'error', texto: err.message || String(err) }); } catch (e) {}
      }
    });

    // Ya NO cierra la pestaña del SCW acá (ver alCerrarPestanaOrigen más
    // arriba) — un disconnect del puerto por sí solo no dice que la
    // pantalla haya cerrado. Si no se pudo identificar la pestaña de
    // origen (tabOrigenId null, caso raro), se cae al comportamiento
    // anterior como red de seguridad, para no dejar la pestaña del SCW
    // huérfana para siempre.
    port.onDisconnect.addListener(() => {
      if (tabOrigenId != null) return;
      if (sesion.rescateTimer) clearTimeout(sesion.rescateTimer);
      if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
    });
  });
}
