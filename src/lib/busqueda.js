// busqueda.js — Búsqueda de texto dentro de un expediente (funciones puras,
// sin DOM ni IndexedDB, para poder probarlas aparte).
//
// Normaliza sin mayúsculas ni acentos ("Pericía" = "pericia"), pero la ñ se
// conserva ("año" ≠ "ano"). Los espacios, tabs y saltos de línea se
// colapsan a uno solo, así "pericia contable" se encuentra aunque el PDF
// la corte en dos renglones. El "mapa" lleva cada carácter normalizado a
// su posición en el texto original: con eso se arma el fragmento de
// contexto y se resalta exactamente lo encontrado.

const DIACRITICOS = /[̀-ͯ]/g;

function normalizarCaracter(c) {
  if (c === 'ñ' || c === 'Ñ') return 'ñ';
  return c.normalize('NFD').replace(DIACRITICOS, '').toLowerCase();
}

export function normalizarConMapa(texto) {
  let norm = '';
  const mapa = [];
  let enEspacio = false;
  const s = String(texto || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (!enEspacio && norm.length) { norm += ' '; mapa.push(i); }
      enEspacio = true;
      continue;
    }
    enEspacio = false;
    const n = normalizarCaracter(c);
    for (const ch of n) { norm += ch; mapa.push(i); }
  }
  return { norm, mapa };
}

export function normalizarConsulta(texto) {
  return normalizarConMapa(texto).norm.trim();
}

// Posiciones (en el texto normalizado) de cada aparición, sin solaparse.
export function ocurrencias(norm, q) {
  const pos = [];
  if (!q) return pos;
  let i = norm.indexOf(q);
  while (i !== -1) { pos.push(i); i = norm.indexOf(q, i + q.length); }
  return pos;
}

// Rango [inicio, fin) en el texto ORIGINAL de una aparición normalizada.
export function rangoOriginal(mapa, posNorm, largoNorm) {
  return [mapa[posNorm], mapa[posNorm + largoNorm - 1] + 1];
}

// Fragmento de contexto alrededor de una aparición: { antes, match, despues }.
export function fragmento(orig, mapa, posNorm, largoNorm, margen = 70) {
  const [ini, fin] = rangoOriginal(mapa, posNorm, largoNorm);
  let a = Math.max(0, ini - margen);
  let b = Math.min(orig.length, fin + margen);
  // Cortar en un espacio para no partir palabras en los bordes.
  if (a > 0) { const e = orig.indexOf(' ', a); if (e !== -1 && e < ini) a = e + 1; }
  if (b < orig.length) { const e = orig.lastIndexOf(' ', b); if (e > fin) b = e; }
  const limpio = t => t.replace(/\s+/g, ' ');
  return {
    antes: (a > 0 ? '…' : '') + limpio(orig.slice(a, ini)),
    match: limpio(orig.slice(ini, fin)),
    despues: limpio(orig.slice(fin, b)) + (b < orig.length ? '…' : ''),
  };
}

// paginas: [{ di, p, texto }] en orden de lectura. Devuelve una fila por
// foja con al menos una aparición: { di, p, cantidad, fragmento }.
export function buscarEnPaginas(paginas, consulta, { maxFojas = 1000 } = {}) {
  const q = normalizarConsulta(consulta);
  const resultados = [];
  let total = 0;
  if (q.length < 2) return { consulta: q, resultados, total, cortado: false };
  for (const pg of paginas) {
    if (!pg.texto) continue;
    const { norm, mapa } = normalizarConMapa(pg.texto);
    const pos = ocurrencias(norm, q);
    if (!pos.length) continue;
    total += pos.length;
    if (resultados.length < maxFojas) {
      resultados.push({ di: pg.di, p: pg.p, cantidad: pos.length, fragmento: fragmento(pg.texto, mapa, pos[0], q.length) });
    }
  }
  return { consulta: q, resultados, total, cortado: resultados.length >= maxFojas };
}

// Una foja "sin texto" es, en la práctica, un escaneo (imagen).
export function esFojaSinTexto(texto) {
  return String(texto || '').replace(/\s+/g, '').length < 15;
}
