// Históricas cuando el SCW le da a su página otro cid (visto contra el sitio
// real: expediente 358872, históricas 366097). Deben llegar igual.
// Uso: node tests/historicas-cid.test.mjs <ruta absoluta a src/background/consulta.js>
const almacen = {};
let urlActual = 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=358872';
globalThis.chrome = {
  runtime: {},
  storage: { local: {
    get: async ks => Object.fromEntries([].concat(ks).filter(k => k in almacen).map(k => [k, almacen[k]])),
    set: async o => Object.assign(almacen, o),
    remove: async ks => [].concat(ks).forEach(k => delete almacen[k]),
  } },
  tabs: {
    get: async () => ({ status: 'complete', url: urlActual }),
    update: async (id, { url }) => {
      urlActual = url;
      if (url.includes('actuacionesHistoricas')) {
        urlActual = 'https://scw.pjn.gov.ar/scw/actuacionesHistoricas.seam?cid=366097';
        setTimeout(() => Object.assign(almacen, {
          pjnHistoricas_366097: [{ titulo: '248 / 248 - 17/02/2017', esHistorica: true }, { titulo: '247 / 247 - 06/02/2017', esHistorica: true }],
          pjnHistoricasUltimo: { cid: '366097', numero: 'CIV-082482-2010', archivos: [{ titulo: '248' }, { titulo: '247' }], ts: Date.now() },
        }), 400);
      }
    },
    sendMessage(id, msg, cb) {
      setTimeout(() => {
        const cid = (urlActual.match(/cid=(\d+)/) || [])[1];
        if (msg.action === 'estadoPagina') return cb({ ok: true, esExpediente: urlActual.includes('/expediente.seam'), cid });
        if (msg.action === 'obtenerActuaciones') {
          const h = almacen['pjnHistoricas_' + cid];   // lo que hace fetchHistoricasConPost
          return cb({ ok: true, archivos: [...(h || []), { titulo: '249 / 249 - 13/12/2021' }], historicasFaltantes: !h });
        }
        cb(null);
      }, 5);
    },
  },
};
const { leerHistoricasYActuaciones } = await import(process.argv[2]);
const r = await leerHistoricasYActuaciones(1, '358872', () => {}, '2010');
const ok = r.act.archivos.length === 3 && !r.act.historicasFaltantes && r.cid === '358872';
console.log((ok ? 'OK   ' : 'FALLA') + ' históricas con otro cid: ' + r.act.archivos.length + ' archivos (2 históricas + 1 actual), faltantes=' + r.act.historicasFaltantes);
process.exit(ok ? 0 : 1);
