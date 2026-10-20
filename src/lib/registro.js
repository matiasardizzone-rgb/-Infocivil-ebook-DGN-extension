// registro.js — Registro técnico local de errores y avisos.
//
// Guarda los últimos MAX_EVENTOS en chrome.storage.local (en ESTE
// navegador). No sale del equipo salvo que el usuario lo exporte desde la
// pantalla de Diagnóstico — por eso no cambia la declaración de privacidad
// ("no recopila datos").
//
// Nunca registrar carátulas, nombres de partes ni texto de actuaciones: el
// archivo exportado puede terminar adjunto en un mail. Por eso limpiar()
// descarta claves sensibles y recorta los textos.
//
// Lo usan como módulo el service worker y las páginas de la extensión. El
// popup (script clásico) y el content script del SCW no pueden importarlo:
// mandan { action: 'registrarEvento', evento } al service worker.

const CLAVE = 'registroEventos';
const MAX_EVENTOS = 500;
const CLAVES_PROHIBIDAS = /caratula|titulo|texto|descripcion|nombre|partes|actor|demandad/i;

function limpiar(valor, profundidad = 0) {
  if (valor == null) return valor;
  if (typeof valor === 'string') return valor.length > 500 ? valor.slice(0, 500) + '…' : valor;
  if (typeof valor !== 'object') return valor;
  if (profundidad > 2) return '[…]';
  if (Array.isArray(valor)) return valor.slice(0, 20).map(v => limpiar(v, profundidad + 1));
  const out = {};
  for (const [k, v] of Object.entries(valor)) {
    if (CLAVES_PROHIBIDAS.test(k)) continue;
    out[k] = limpiar(v, profundidad + 1);
  }
  return out;
}

// Escrituras en fila dentro de cada contexto (página o service worker), para
// que dos eventos seguidos no se pisen al leer-modificar-escribir.
let cola = Promise.resolve();

// nivel: 'error' | 'aviso' | 'info' · origen: 'scw', 'biblioteca', 'inicio',
// 'popup', 'background'… · mensaje: texto corto · datos: objeto opcional.
function registrar(nivel, origen, mensaje, datos) {
  const evento = {
    fecha: new Date().toISOString(),
    nivel: nivel || 'info',
    origen: origen || '?',
    mensaje: limpiar(String(mensaje == null ? '' : mensaje)),
    version: chrome.runtime.getManifest().version,
  };
  if (datos !== undefined) evento.datos = limpiar(datos);
  cola = cola.then(async () => {
    const r = await chrome.storage.local.get(CLAVE);
    const lista = Array.isArray(r[CLAVE]) ? r[CLAVE] : [];
    lista.push(evento);
    if (lista.length > MAX_EVENTOS) lista.splice(0, lista.length - MAX_EVENTOS);
    await chrome.storage.local.set({ [CLAVE]: lista });
  }).catch(() => {}); // el registro nunca debe romper lo que está registrando
  return cola;
}

// Captura lo que se escape: errores no atrapados y promesas rechazadas sin
// catch, en la página o en el service worker que lo llame.
function instalarCaptura(origen) {
  const g = typeof self !== 'undefined' ? self : window;
  g.addEventListener('error', e => {
    registrar('error', origen, (e && e.message) || 'Error no controlado', {
      archivo: e && e.filename ? String(e.filename).replace(/^chrome-extension:\/\/[^/]+\//, '') : undefined,
      linea: e && e.lineno, columna: e && e.colno,
    });
  });
  g.addEventListener('unhandledrejection', e => {
    const r = e && e.reason;
    registrar('error', origen, (r && r.message) || String(r) || 'Promesa rechazada sin manejar', {
      pila: r && r.stack ? String(r.stack).split('\n').slice(0, 4).join(' | ') : undefined,
    });
  });
}

async function leerRegistro() {
  const r = await chrome.storage.local.get(CLAVE);
  return Array.isArray(r[CLAVE]) ? r[CLAVE] : [];
}

async function borrarRegistro() {
  await chrome.storage.local.remove(CLAVE);
}

export { registrar, instalarCaptura, leerRegistro, borrarRegistro, limpiar, MAX_EVENTOS };
