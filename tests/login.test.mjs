// esperarLogin: la pestaña pasa por el SSO y el callback; debe cerrarse recién en /inicio.
const secuencia = [
  ['https://portalpjn.pjn.gov.ar/', 'loading'],
  ['https://sso.pjn.gov.ar/auth/realms/pjn/protocol/openid-connect/auth?x', 'complete'],
  ['https://sso.pjn.gov.ar/auth/realms/pjn/protocol/openid-connect/auth?x', 'complete'],
  ['https://portalpjn.pjn.gov.ar/auth/callback?code=x', 'complete'],
  ['https://portalpjn.pjn.gov.ar/inicio', 'complete'],
];
let paso = 0, cerrada = false, activada = null;
globalThis.chrome = { runtime: {}, tabs: {
  create: async () => ({ id: 99 }),
  get: async () => { const [url, status] = secuencia[Math.min(paso++, secuencia.length - 1)]; return { id: 99, url, status }; },
  remove: async () => { cerrada = true; },
  update: async (id) => { activada = id; },
} };
const { esperarLogin } = await import(process.argv[2]);
await esperarLogin({ id: 7, windowId: 1, index: 0 }, () => {});
const ok = cerrada && activada === 7 && paso === secuencia.length;
console.log(ok ? 'OK    cerró el login recién en /inicio y volvió a la pestaña de la extensión' : 'FALLA paso=' + paso + ' cerrada=' + cerrada);
process.exit(ok ? 0 : 1);
