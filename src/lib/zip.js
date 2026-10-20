// zip.js — armador de ZIP sin dependencias (STORED, sin compresión), para
// usar desde módulos ES (páginas de la extensión). Portado de la función
// buildZip() de src/content/scw-content.js, donde vive aparte porque los
// content scripts NO son módulos ES y no pueden hacer import de esto —
// scw-content.js sigue con su propia copia interna, sin cambios.
function crc32(d) {
  if (!crc32.t) {
    crc32.t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.t[i] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = crc32.t[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name: 'ruta/dentro/del/zip.ext', data: Uint8Array }]
// mimeType: tipo del Blob resultante — 'application/zip' por defecto, pero
// un EPUB (que por dentro ES un zip) necesita 'application/epub+zip' para
// que no se descargue con extensión .zip en vez de .epub.
export function crearZip(files, mimeType) {
  const lp = [], cd = [];
  let off = 0;
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
  return new Blob([...lp, ...cd, eo], { type: mimeType || 'application/zip' });
}
