// unificador.js — arma un único PDF con todas las actuaciones del expediente.
//
// Reglas acordadas (ver CAMBIOS_EN_EL_SCRIPT.md):
//  1. Orden cronológico de más vieja a más actual.
//  2. Índice/portada al principio: cada actuación es un hipervínculo interno
//     (Dest) que salta a su primera página.
//  3. Hipervínculo público visible Y clicable en el pie de TODAS las páginas
//     de cada actuación (para que se pueda extraer con texto plano, no solo
//     como link).
//  4. Sin páginas separadoras entre actuaciones.
//  5. Si una actuación no se pudo descargar, se dibuja una página de error
//     ("ACTUACIÓN NO DISPONIBLE") con el link público visible — nunca se
//     omite en silencio.
//  6. Es una copia de trabajo: al unificar, las firmas electrónicas
//     embebidas de cada PDF original pierden validez criptográfica.
//
// import como módulo ES.

import { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString } from '../../vendor/pdf-lib.esm.js';

const A4 = [595.28, 841.89];
const MARGIN = 50;
const PIE_FONT_SIZE = 6;
const INDICE_FONT_SIZE = 9;
const INDICE_STEP = 16;
const INDICE_START_Y_PORTADA = A4[1] - 185; // deja lugar arriba para título + subtítulo
const INDICE_START_Y_CONT    = A4[1] - 100; // páginas de índice siguientes (sin portada)
const INDICE_MARGIN_INFERIOR = 60;

// Variante DGN: sin enlaces al SCW. Las causas restringidas solo se ven con
// sesión de un usuario vinculado, así que el enlace "público" no le sirve a
// quien recibe el PDF. Se conservan los enlaces INTERNOS del índice (saltan
// a otra página del mismo PDF); se quitan la URL del pie y la de la página
// de "actuación no disponible".
const INCLUIR_ENLACES_SCW = false;

// ─── Fechas ─────────────────────────────────────────────────────────────
// Soporta dd/mm/yyyy y ISO (yyyy-mm-dd[...]). Devuelve null si no matchea.
function parseFecha(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function fechaDe(actuacion) {
  return parseFecha(actuacion.fecha);
}

// Orden cronológico ascendente. Regla explícita: si a cualquiera de los dos
// elementos comparados le falta fecha válida, se los trata como "iguales"
// (comparator devuelve 0) para que el sort estable conserve el orden
// original entre ellos — nunca se empujan al principio o al final.
export function ordenarPorFechaAsc(actuaciones) {
  return actuaciones
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const fx = fechaDe(x.a), fy = fechaDe(y.a);
      if (!fx || !fy) return 0;
      const diff = fx.getTime() - fy.getTime();
      return diff !== 0 ? diff : 0;
    })
    .map(({ a }) => a);
}

// ─── Utilidades PDF ───────────────────────────────────────────────────────

// La fuente estándar (Helvetica) usa codificación WinAnsi: no puede dibujar
// saltos de línea ni caracteres de control (el error típico es
// "WinAnsi cannot encode \n"), y tampoco caracteres fuera de Latin-1
// (emojis, comillas tipográficas, etc.). Los títulos vienen del innerText
// de la tabla del SCW y a veces traen \n adentro de una celda — por eso se
// limpia CUALQUIER texto antes de pasarlo a drawText o a una anotación.
// Caracteres 0x80–0x9F: en el SCW a veces llegan como "controles C1"
// (texto Windows-1252 mal decodificado: U+0096 en vez del guion largo "–").
// WinAnsi NO los puede codificar ("WinAnsi cannot encode … (0x0096)"), así
// que se traducen a su carácter real según la tabla de Windows-1252.
const CP1252_C1 = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021',
  0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160', 0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D',
  0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153', 0x9E: '\u017E', 0x9F: '\u0178',
};
// Lo que WinAnsi sí puede dibujar fuera de Latin-1 (los mismos de arriba).
const WINANSI_EXTRA = new Set(Object.values(CP1252_C1));

function limpiarTextoPDF(texto) {
  if (!texto) return '';
  const limpio = String(texto)
    .replace(/[\r\n\t]+/g, ' ')                          // saltos de línea / tabs → espacio
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // otros caracteres de control
    .replace(/[\u0080-\u009F]/g, ch => CP1252_C1[ch.charCodeAt(0)] || ''); // C1 → su carácter real
  // Array.from recorre por carácter real (un emoji es UN carácter, no dos).
  return Array.from(limpio).map(ch => {
      const c = ch.charCodeAt(0);
      if (c <= 0xFF || WINANSI_EXTRA.has(ch)) return ch;
      // Fuera de WinAnsi: se intenta sin tilde/diacrítico (ej. "ő" → "o"); si no, '?'.
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return base && base.charCodeAt(0) <= 0xFF ? base : '?';
    }).join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function parecePdf(bytes) {
  if (!bytes || bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D; // "%PDF-"
}

function truncarTextoSiExcede(font, size, texto, maxWidth) {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  const elipsis = '...';
  let lo = 0, hi = texto.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidato = texto.slice(0, mid) + elipsis;
    if (font.widthOfTextAtSize(candidato, size) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return texto.slice(0, lo) + elipsis;
}

// Envuelve texto en líneas según el ancho disponible (word-wrap simple,
// palabra por palabra) — a diferencia de pasarle maxWidth a drawText (que sí
// envuelve pero no informa cuántas líneas resultaron), esto nos deja saber
// de antemano cuánto espacio vertical va a ocupar el título del expediente,
// que puede ser arbitrariamente largo (carátulas largas → título de varias
// líneas), para no superponerlo con lo que va debajo.
function envolverTexto(font, size, texto, maxWidth, maxLineas) {
  const palabras = String(texto || '').split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = '';
  for (const palabra of palabras) {
    const candidato = actual ? actual + ' ' + palabra : palabra;
    if (font.widthOfTextAtSize(candidato, size) <= maxWidth || !actual) {
      actual = candidato;
    } else {
      lineas.push(actual);
      actual = palabra;
      if (lineas.length >= maxLineas) break;
    }
  }
  if (actual && lineas.length < maxLineas) lineas.push(actual);
  if (lineas.length >= maxLineas && palabras.length) {
    // Puede haber quedado texto sin usar: marcar con "..." la última línea.
    const consumido = lineas.join(' ').length;
    if (consumido < texto.length) {
      lineas[lineas.length - 1] = truncarTextoSiExcede(font, size, lineas[lineas.length - 1] + '...', maxWidth);
    }
  }
  return lineas.length ? lineas : [''];
}

function pushAnnot(pdf, page, annotRef) {
  if (!page.node.Annots()) page.node.set(PDFName.of('Annots'), pdf.context.obj([]));
  page.node.Annots().push(annotRef);
}

// Link interno: salta a la primera página de una actuación (Dest + Fit).
function anotacionInterna(pdf, page, rect, destPageRef) {
  const annot = pdf.context.obj({
    Type: 'Annot', Subtype: 'Link',
    Rect: rect, Border: [0, 0, 0],
    Dest: [destPageRef, PDFName.of('Fit')],
  });
  const ref = pdf.context.register(annot);
  pushAnnot(pdf, page, ref);
}

// Link público: URL clicable (acción URI).
function anotacionUri(pdf, page, rect, url) {
  const annot = pdf.context.obj({
    Type: 'Annot', Subtype: 'Link',
    Rect: rect, Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFHexString.fromText(url) },
  });
  const ref = pdf.context.register(annot);
  pushAnnot(pdf, page, ref);
}

function construirLineaDatos(numero, titulo, fecha) {
  const partes = ['Act. ' + numero];
  if (titulo) partes.push(titulo);
  if (fecha) partes.push(fecha);
  return partes.join(' · ');
}

// ─── Pie de página (línea de datos + URL pública visible y clicable) ──────
function pieEnTodasLasPaginas(pdf, paginas, fontRegular, fontBold, numero, titulo, fecha, urlPublica) {
  const linea1 = construirLineaDatos(numero, titulo, fecha);
  const maxWidthTexto = A4[0] - 2 * MARGIN;

  for (const page of paginas) {
    const { width } = page.getSize();
    const centroX = width / 2;

    // Línea 1: identificación de la actuación (gris, y=22; y=14 si no hay URL)
    const t1 = truncarTextoSiExcede(fontRegular, PIE_FONT_SIZE, linea1, maxWidthTexto);
    const w1 = fontRegular.widthOfTextAtSize(t1, PIE_FONT_SIZE);
    page.drawText(t1, {
      x: centroX - w1 / 2, y: INCLUIR_ENLACES_SCW ? 22 : 14, size: PIE_FONT_SIZE,
      font: fontRegular, color: rgb(0.25, 0.25, 0.25),
    });

    if (!INCLUIR_ENLACES_SCW || !urlPublica) continue;
    // Línea 2: URL pública completa, visible y clicable (y=12)
    const t2 = truncarTextoSiExcede(fontRegular, PIE_FONT_SIZE, urlPublica, maxWidthTexto);
    const w2 = fontRegular.widthOfTextAtSize(t2, PIE_FONT_SIZE);
    const x2 = centroX - w2 / 2;
    page.drawText(t2, {
      x: x2, y: 12, size: PIE_FONT_SIZE,
      font: fontRegular, color: rgb(0, 0, 0.6),
    });
    // Área clicable alrededor del texto de la URL
    anotacionUri(pdf, page, [x2 - 2, 8, x2 + w2 + 2, 18], urlPublica);
  }
}

// ─── Página de error (actuación no disponible) ─────────────────────────────
function dibujarPaginaError(pdf, fontBold, fontRegular, numero, titulo, fecha, urlPublica, motivo) {
  const page = pdf.addPage(A4);
  const { width, height } = page.getSize();

  page.drawText('ACTUACIÓN NO DISPONIBLE', {
    x: MARGIN, y: height - 140, size: 20, font: fontBold, color: rgb(0.75, 0.15, 0.15),
  });
  page.drawText('Act. ' + numero + (titulo ? ' · ' + titulo : ''), {
    x: MARGIN, y: height - 175, size: 12, font: fontRegular, color: rgb(0.2, 0.2, 0.2),
  });
  if (fecha) {
    page.drawText('Fecha: ' + fecha, {
      x: MARGIN, y: height - 195, size: 11, font: fontRegular, color: rgb(0.2, 0.2, 0.2),
    });
  }
  page.drawText('No se pudo incorporar este documento al PDF unificado' + (motivo ? ' (' + motivo + ').' : '.'), {
    x: MARGIN, y: height - 225, size: 10, font: fontRegular, color: rgb(0.35, 0.35, 0.35),
    maxWidth: width - 2 * MARGIN,
  });
  if (!INCLUIR_ENLACES_SCW) {
    page.drawText('Consultarla en el Sistema de Consulta Web con un usuario vinculado a la causa.', {
      x: MARGIN, y: height - 255, size: 10, font: fontRegular, color: rgb(0.35, 0.35, 0.35),
      maxWidth: width - 2 * MARGIN,
    });
    return page;
  }
  page.drawText('Consultar directamente en el SCW:', {
    x: MARGIN, y: height - 255, size: 10, font: fontRegular, color: rgb(0.35, 0.35, 0.35),
  });
  const yUrl = height - 275;
  page.drawText(urlPublica || '', {
    x: MARGIN, y: yUrl, size: 10, font: fontRegular, color: rgb(0, 0, 0.6),
    maxWidth: width - 2 * MARGIN,
  });
  const wUrl = fontRegular.widthOfTextAtSize(urlPublica || '', 10);
  if (urlPublica) anotacionUri(pdf, page, [MARGIN - 2, yUrl - 4, MARGIN + Math.min(wUrl, width - 2 * MARGIN) + 2, yUrl + 12], urlPublica);

  return page;
}

// ─── Índice ────────────────────────────────────────────────────────────────
// Calcula cuántas entradas entran por página según el Y inicial disponible
// (en vez de un número fijo, se deriva del alto de página real — así no se
// desalinea si algún día cambian los márgenes).
function capacidadPagina(startY) {
  return Math.max(1, Math.floor((startY - INDICE_MARGIN_INFERIOR) / INDICE_STEP) + 1);
}

function reservarPaginasIndice(pdf, cantidadEntradas, lineasAdvertencia, lineasExtraTitulo) {
  const offsetAdvertencia = (lineasAdvertencia && lineasAdvertencia.length) ? 14 + lineasAdvertencia.length * 11 : 0;
  const offsetTitulo = (lineasExtraTitulo || 0) * 22; // 22 ≈ alto de línea a 18pt
  const startYPortada = INDICE_START_Y_PORTADA - offsetAdvertencia - offsetTitulo;
  const capPortada = capacidadPagina(startYPortada);
  const capCont     = capacidadPagina(INDICE_START_Y_CONT);
  let restantes = cantidadEntradas - capPortada;
  let nPaginasCont = restantes > 0 ? Math.ceil(restantes / capCont) : 0;

  const paginas = [pdf.addPage(A4)]; // portada + índice
  for (let i = 0; i < nPaginasCont; i++) paginas.push(pdf.addPage(A4));
  return { paginas, capPortada, capCont, startYPortada };
}

function dibujarPortadaEIndice(pdf, paginas, capPortada, capCont, startYPortada, fontBold, fontRegular, tituloLineas, entradas, lineasAdvertencia, nota) {
  const portada = paginas[0];
  const { width, height } = portada.getSize();

  tituloLineas.forEach((linea, i) => {
    portada.drawText(linea, {
      x: MARGIN, y: height - 70 - i * 22, size: 18, font: fontBold, color: rgb(0.1, 0.15, 0.3),
    });
  });
  const yTrasTitulo = height - 70 - (tituloLineas.length - 1) * 22;

  portada.drawText('Índice de actuaciones (' + entradas.length + ')' + (nota ? ' · ' + nota : ''), {
    x: MARGIN, y: yTrasTitulo - 30, size: 11, font: fontRegular, color: rgb(0.35, 0.35, 0.35),
  });
  portada.drawText('Generado ' + new Date().toLocaleDateString('es-AR') + ' · copia de trabajo, sin validez de firma electrónica', {
    x: MARGIN, y: yTrasTitulo - 48, size: 8, font: fontRegular, color: rgb(0.5, 0.5, 0.5),
  });
  (lineasAdvertencia || []).forEach((linea, i) => {
    portada.drawText(linea, {
      x: MARGIN, y: yTrasTitulo - 62 - i * 11, size: 8, font: fontBold, color: rgb(0.75, 0.35, 0),
    });
  });

  const maxWidthEntrada = width - 2 * MARGIN - 15;
  let paginaIdx = 0, y = startYPortada, cap = capPortada;
  let usadosEnPagina = 0;

  for (let i = 0; i < entradas.length; i++) {
    if (usadosEnPagina >= cap) {
      paginaIdx++; y = INDICE_START_Y_CONT; cap = capCont; usadosEnPagina = 0;
    }
    const page = paginas[paginaIdx];
    const entrada = entradas[i];
    const numLabel = String(entrada.numero || (i + 1)).padStart(3, '0') + '. ';
    let linea = numLabel + entrada.titulo + (entrada.fecha ? '  (' + entrada.fecha + ')' : '');
    linea = truncarTextoSiExcede(fontRegular, INDICE_FONT_SIZE, linea, maxWidthEntrada);
    const w = fontRegular.widthOfTextAtSize(linea, INDICE_FONT_SIZE);

    page.drawText(linea, {
      x: MARGIN, y, size: INDICE_FONT_SIZE, font: fontRegular, color: rgb(0, 0, 0.55),
    });
    // Dos usos de esta misma función: el índice del PDF unificado enlaza
    // A OTRA PÁGINA de ese mismo PDF (destPageRef); el índice hipervinculado
    // standalone (generarIndiceHipervinculado, sin contenido propio) enlaza
    // directo al enlace público de cada actuación en el SCW (urlPublica).
    if (entrada.destPageRef) {
      anotacionInterna(pdf, page, [MARGIN - 2, y - 3, MARGIN + w + 2, y + 10], entrada.destPageRef);
    } else if (entrada.urlPublica && INCLUIR_ENLACES_SCW) {
      anotacionUri(pdf, page, [MARGIN - 2, y - 3, MARGIN + w + 2, y + 10], entrada.urlPublica);
    }

    y -= INDICE_STEP;
    usadosEnPagina++;
  }
}

// ─── Función principal ──────────────────────────────────────────────────
// actuaciones: [{ numero, titulo, fecha, tipo, descripcion, urlPublica, bytes: Uint8Array|null, error }]
// bytes === null (o no pasa parecePdf) ⇒ se dibuja página de error.
// conservarNumeros: usa act.numero (el número de la actuación en el
// expediente completo) en vez de numerar 1..N — para exportar una
// selección sin que cambien los números que se citan. nota: texto breve
// que se agrega al subtítulo de la portada (p. ej. «Selección de 12 de 45
// actuaciones»), para que no se tome por el expediente completo.
export async function generarPdfUnificado({ tituloExpediente, actuaciones, historicasFaltantes, paginacionIncompleta, conservarNumeros, nota }) {
  const titulo = limpiarTextoPDF(tituloExpediente) || 'Expediente unificado';
  const ordenadas = ordenarPorFechaAsc(actuaciones);

  const lineasAdvertencia = [];
  if (historicasFaltantes) {
    lineasAdvertencia.push(
      'ADVERTENCIA: no se cargaron actuaciones históricas de este expediente: pueden faltar',
      'actuaciones anteriores a la primera actuación listada abajo (p. ej. la demanda inicial).'
    );
  }
  if (paginacionIncompleta) {
    lineasAdvertencia.push(
      'ADVERTENCIA: el recorrido de páginas de actuaciones se cortó antes de tiempo (demora del',
      'sistema) — pueden faltar actuaciones más viejas que las incluidas en este PDF.'
    );
  }

  const pdf = await PDFDocument.create();
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold    = await pdf.embedFont(StandardFonts.HelveticaBold);

  // El título de portada puede ser arbitrariamente largo (carátulas largas
  // como "BERGARA, HILDA ESTER Y OTROS C/ LINEA 365 (...) Y OTRO S/DAÑOS Y
  // PERJUICIOS..."). Se envuelve a mano (máx. 4 líneas) para saber de
  // antemano cuánto espacio vertical ocupa y no superponerlo con lo que va
  // debajo (subtítulo, advertencias, índice).
  const tituloLineas = envolverTexto(fontBold, 18, titulo, A4[0] - 2 * MARGIN, 4);

  // 1) Reservar de entrada las páginas de índice (necesitamos sus refs para
  //    los links internos, pero el contenido se dibuja recién al final,
  //    cuando ya sabemos a qué página de contenido apunta cada entrada).
  const { paginas: paginasIndice, capPortada, capCont, startYPortada } =
    reservarPaginasIndice(pdf, ordenadas.length, lineasAdvertencia, tituloLineas.length - 1);

  // 2) Contenido: copiar páginas de cada actuación (o dibujar error) y
  //    aplicar el pie en todas las páginas que le correspondan.
  const entradasIndice = [];
  let correlativo = 1;
  for (const act of ordenadas) {
    const numero = (conservarNumeros && act.numero) ? act.numero : correlativo;
    // Preferimos "tipo - descripción" (más corto y sin ruido) para el índice
    // y el pie de página; el 'titulo' concatenado original (foja/fecha/tipo/
    // descripción, usado para nombres de archivo en el resto de la
    // extensión) queda como respaldo si no vinieran tipo/descripcion.
    const tipo = limpiarTextoPDF(act.tipo || '');
    const descripcion = limpiarTextoPDF(act.descripcion || '');
    const tituloCorto = (tipo || descripcion)
      ? [tipo, descripcion].filter(Boolean).join(' - ')
      : (limpiarTextoPDF(act.titulo) || ('Actuación ' + numero));
    const titulo = tituloCorto;
    const fecha = limpiarTextoPDF(act.fecha || '');
    const urlPublica = limpiarTextoPDF(act.urlPublica || act.url || '');
    let paginasDeEstaActuacion = [];

    let bytesOk = act.bytes && parecePdf(act.bytes);
    if (bytesOk) {
      try {
        const src = await PDFDocument.load(act.bytes, { ignoreEncryption: true });
        const indices = src.getPageIndices();
        const copiadas = await pdf.copyPages(src, indices);
        copiadas.forEach(p => { pdf.addPage(p); paginasDeEstaActuacion.push(p); });
        if (!copiadas.length) bytesOk = false;
      } catch (e) {
        bytesOk = false;
        act.error = act.error || e.message;
      }
    }

    if (!bytesOk) {
      const pErr = dibujarPaginaError(pdf, fontBold, fontRegular, numero, titulo, fecha, urlPublica, limpiarTextoPDF(act.error));
      paginasDeEstaActuacion = [pErr];
    }

    pieEnTodasLasPaginas(pdf, paginasDeEstaActuacion, fontRegular, fontBold, numero, titulo, fecha, urlPublica);

    entradasIndice.push({
      numero, titulo, fecha,
      destPageRef: paginasDeEstaActuacion[0].ref,
    });
    correlativo++;
  }

  // 3) Ahora sí, dibujar la portada + índice con los links internos ya resueltos.
  dibujarPortadaEIndice(pdf, paginasIndice, capPortada, capCont, startYPortada, fontBold, fontRegular, tituloLineas, entradasIndice, lineasAdvertencia, limpiarTextoPDF(nota || ''));

  pdf.setTitle(titulo);
  pdf.setSubject('Expediente judicial unificado — Infocivil Ebook');
  pdf.setCreator('Infocivil Ebook');
  pdf.setProducer('Infocivil Ebook (pdf-lib)');

  return pdf.save();
}

// ─── PDF unificado SIMPLE (sin portada, índice, pie ni enlaces) ─────────
// Un solo PDF con todas las actuaciones en orden cronológico, tal cual —
// pensado para remitir el expediente a otra jurisdicción. No agrega
// portada, índice, pie de página ni anotaciones de enlace. Si alguna
// actuación no está disponible, se deja una página que lo indica (sin
// enlace) para que no se pierda la correlación del expediente.
// actuaciones: [{ titulo, fecha, tipo, descripcion, bytes: Uint8Array|null, error }]
export async function generarPdfUnificadoSimple({ tituloExpediente, actuaciones }) {
  const titulo = limpiarTextoPDF(tituloExpediente) || 'Expediente unificado';
  const ordenadas = ordenarPorFechaAsc(actuaciones);
  const pdf = await PDFDocument.create();
  let fontRegular = null, fontBold = null;
  let numero = 1;
  for (const act of ordenadas) {
    let bytesOk = act.bytes && parecePdf(act.bytes);
    if (bytesOk) {
      try {
        const src = await PDFDocument.load(act.bytes, { ignoreEncryption: true });
        const copiadas = await pdf.copyPages(src, src.getPageIndices());
        copiadas.forEach(p => pdf.addPage(p));
        if (!copiadas.length) bytesOk = false;
      } catch (e) {
        bytesOk = false;
        act.error = act.error || e.message;
      }
    }
    if (!bytesOk) {
      if (!fontRegular) {
        fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
        fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
      }
      const tipo = limpiarTextoPDF(act.tipo || '');
      const descripcion = limpiarTextoPDF(act.descripcion || '');
      const tituloCorto = (tipo || descripcion)
        ? [tipo, descripcion].filter(Boolean).join(' - ')
        : (limpiarTextoPDF(act.titulo) || ('Actuación ' + numero));
      // urlPublica vacía a propósito: este formato no lleva enlaces.
      dibujarPaginaError(pdf, fontBold, fontRegular, numero, tituloCorto, limpiarTextoPDF(act.fecha || ''), '', limpiarTextoPDF(act.error));
    }
    numero++;
  }
  pdf.setTitle(titulo);
  pdf.setSubject('Expediente judicial unificado — Infocivil Ebook');
  pdf.setCreator('Infocivil Ebook');
  pdf.setProducer('Infocivil Ebook (pdf-lib)');
  return pdf.save();
}

// ─── Índice hipervinculado standalone (sin el contenido) ──────────────────
// Mismo aspecto que la portada+índice del PDF unificado, pero SIN copiar
// ninguna página de ninguna actuación — cada entrada es un link al enlace
// público de esa actuación en el SCW, no a otra página de este mismo PDF.
// Al no necesitar los bytes de cada PDF, no hace falta volver a descargar
// nada: funciona con solo lo que ya está guardado (título/fecha/tipo/
// enlace público), incluso sin una pestaña del SCW abierta.
// actuaciones: [{ numero, titulo, fecha, tipo, descripcion, urlPublica }]
export async function generarIndiceHipervinculado({ tituloExpediente, actuaciones, historicasFaltantes, paginacionIncompleta }) {
  const titulo = limpiarTextoPDF(tituloExpediente) || 'Expediente';
  const ordenadas = ordenarPorFechaAsc(actuaciones);

  const lineasAdvertencia = [];
  if (historicasFaltantes) {
    lineasAdvertencia.push(
      'ADVERTENCIA: no se cargaron actuaciones históricas de este expediente: pueden faltar',
      'actuaciones anteriores a la primera actuación listada abajo (p. ej. la demanda inicial).'
    );
  }
  if (paginacionIncompleta) {
    lineasAdvertencia.push(
      'ADVERTENCIA: el recorrido de páginas de actuaciones se cortó antes de tiempo (demora del',
      'sistema) — pueden faltar actuaciones más viejas que las incluidas en este índice.'
    );
  }

  const pdf = await PDFDocument.create();
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold    = await pdf.embedFont(StandardFonts.HelveticaBold);
  const tituloLineas = envolverTexto(fontBold, 18, titulo, A4[0] - 2 * MARGIN, 4);

  const { paginas, capPortada, capCont, startYPortada } =
    reservarPaginasIndice(pdf, ordenadas.length, lineasAdvertencia, tituloLineas.length - 1);

  let numero = 1;
  const entradas = ordenadas.map(act => {
    const tipo = limpiarTextoPDF(act.tipo || '');
    const descripcion = limpiarTextoPDF(act.descripcion || '');
    const tituloCorto = (tipo || descripcion)
      ? [tipo, descripcion].filter(Boolean).join(' - ')
      : (limpiarTextoPDF(act.titulo) || ('Actuación ' + numero));
    const entrada = {
      titulo: tituloCorto,
      fecha: limpiarTextoPDF(act.fecha || ''),
      urlPublica: limpiarTextoPDF(act.urlPublica || act.url || ''),
    };
    numero++;
    return entrada;
  });

  dibujarPortadaEIndice(pdf, paginas, capPortada, capCont, startYPortada, fontBold, fontRegular, tituloLineas, entradas, lineasAdvertencia);

  pdf.setTitle('Índice — ' + titulo);
  pdf.setSubject('Índice hipervinculado de actuaciones — Infocivil Ebook');
  pdf.setCreator('Infocivil Ebook');
  pdf.setProducer('Infocivil Ebook (pdf-lib)');

  return pdf.save();
}
