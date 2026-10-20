// externo.js — Canal landing web → extensión (chrome.runtime.onMessageExternal).
//
// Chrome ya filtra por externally_connectable.matches del manifest, pero
// volvemos a validar acá el origen del remitente contra esos mismos patrones:
// si alguien amplía el manifest por error (o se deja el origen de prueba
// en un build de producción) este chequeo no depende de haberlo notado.
// Única fuente de verdad: el propio manifest; no hay otra lista que mantener.
//
// Uso desde src/background/index.js:
//   import { registrarAccionExterna, iniciarCanalExterno } from './externo.js';
//   registrarAccionExterna('buscarYAbrir', async (msg, sender) => { ... });
//   iniciarCanalExterno();

const acciones = new Map();

// Convierte un match pattern de Chrome ("*://10.5.1.224/*",
// "https://*.pjn.gov.ar/*") a RegExp sobre el ORIGEN (sin path).
// Chrome ignora el puerto al matchear estos patrones, así que acá también.
function patronARegexOrigen(patron) {
  const m = /^(\*|https?):\/\/([^/]+)\//.exec(patron);
  if (!m) return null;
  const esquema = m[1] === '*' ? 'https?' : m[1];
  const host = m[2]
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/^\*\\\./, '(?:[^.]+\\.)*')   // "*.dominio" → subdominios opcionales
    .replace(/^\*$/, '[^/]+');
  return new RegExp('^' + esquema + '://' + host + '(?::\\d+)?$');
}

// Chrome/Edge: externally_connectable.matches. Firefox no lo soporta, así que
// ahí la landing se comunica por el content script puente-landing.js
// (ver src/content/puente-landing.js) y los orígenes salen de sus "matches".
const origenesPermitidos = (() => {
  const manifest = chrome.runtime.getManifest();
  const matches = [...((manifest.externally_connectable || {}).matches || [])];
  (manifest.content_scripts || []).forEach(cs => {
    if ((cs.js || []).some(js => js.endsWith('puente-landing.js'))) matches.push(...(cs.matches || []));
  });
  return matches.map(patronARegexOrigen).filter(Boolean);
})();

function origenPermitido(sender) {
  const origen = sender.origin || (sender.url ? new URL(sender.url).origin : '');
  return origenesPermitidos.some(re => re.test(origen));
}

export function registrarAccionExterna(nombre, manejador) {
  acciones.set(nombre, manejador);
}

// ping: la landing lo usa para detectar si la extensión está instalada y
// qué versión tiene (sirve para avisar "actualizá la extensión" más adelante).
registrarAccionExterna('ping', async () => ({
  version: chrome.runtime.getManifest().version,
  acciones: [...acciones.keys()],
}));

// Lógica común a los dos canales. Devuelve true si la respuesta es asíncrona.
function atender(msg, sender, sendResponse) {
  if (!origenPermitido(sender)) {
    sendResponse({ ok: false, error: 'origen_no_permitido' });
    return false;
  }
  const manejador = msg && acciones.get(msg.action);
  if (!manejador) {
    sendResponse({ ok: false, error: 'accion_desconocida' });
    return false;
  }
  Promise.resolve()
    .then(() => manejador(msg, sender))
    .then(r => sendResponse({ ok: true, ...(r || {}) }))
    .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // respuesta asíncrona
}

export function iniciarCanalExterno() {
  // Chrome / Edge / Brave: la página web habla directo con la extensión.
  if (chrome.runtime.onMessageExternal) {
    chrome.runtime.onMessageExternal.addListener(atender);
  }
  // Firefox: la página habla con el content script puente, y este reenvía
  // acá como mensaje interno. Se valida el origen real de la pestaña
  // (sender.tab.url), no lo que diga el mensaje.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== '__puenteLanding' || !sender.tab) return false;
    return atender(msg.mensaje, { origin: new URL(sender.tab.url).origin }, sendResponse);
  });
}
