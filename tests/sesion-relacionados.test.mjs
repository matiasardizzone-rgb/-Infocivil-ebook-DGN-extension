// Escenarios de abrirDesdeRelacionados con chrome.* simulado.
let escenario;
globalThis.chrome = {
  runtime: { lastError: undefined },
  tabs: {
    get: async () => escenario.tab(),
    sendMessage(id, msg, cb) { setTimeout(() => cb(escenario.resp(msg)), 5); },
  },
};
const { abrirDesdeRelacionados } = await import(process.argv[2]);
const clave = 'CIV|86007|2021|0';
const casos = [
  ['sin sesión (queda en el SSO)', { tab: () => ({ status: 'complete', url: 'https://sso.pjn.gov.ar/auth/realms/pjn/protocol/openid-connect/auth?x' }), resp: () => null }, 'sin-sesion'],
  ['sin sesión (SCW sin lista)', { tab: () => ({ status: 'complete', url: 'https://scw.pjn.gov.ar/scw/home.seam' }), resp: m => m.action === 'relacionadosEstadoPagina' ? { ok: true, esLista: false } : null }, 'sin-sesion'],
  ['lista sin causas', { tab: () => ({ status: 'complete', url: 'https://scw.pjn.gov.ar/scw/consultaListaRelacionados.seam' }), resp: m => ({ ok: true, esLista: true, filas: 0 }) }, 'no-figura'],
  ['no figura en la lista', { tab: () => ({ status: 'complete', url: 'https://scw.pjn.gov.ar/scw/consultaListaRelacionados.seam' }), resp: m => m.action === 'relacionadosAbrir' ? { ok: false, error: 'La causa no figura en la lista de relacionados (¿se desvinculó?).' } : { ok: true, esLista: true, filas: 15 } }, 'no-figura'],
  ['figura y abre', (() => { let abierto = false; return {
      tab: () => ({ status: 'complete', url: abierto ? 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=12' : 'https://scw.pjn.gov.ar/scw/consultaListaRelacionados.seam' }),
      resp: m => { if (m.action === 'relacionadosAbrir') { abierto = true; return { ok: true }; }
        if (m.action === 'estadoPagina') return { ok: true, esExpediente: abierto, cid: abierto ? '12' : null };
        if (m.action === 'relacionadosClaveActual') return { ok: true, clave };
        return { ok: true, esLista: !abierto, filas: abierto ? 0 : 15 }; } }; })(), 'abierto'],
];
let fallas = 0;
for (const [nombre, esc, esperado] of casos) {
  escenario = esc;
  const t = Date.now();
  const r = await abrirDesdeRelacionados(1, clave, () => {});
  const ok = r.estado === esperado;
  if (!ok) fallas++;
  console.log((ok ? 'OK   ' : 'FALLA') + ' ' + nombre + ' → ' + JSON.stringify(r) + ' (' + Math.round((Date.now() - t) / 1000) + ' s)');
}
process.exit(fallas ? 1 : 0);
