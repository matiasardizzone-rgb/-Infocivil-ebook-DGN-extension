import * as db from '../lib/db.js';
import { registrar, instalarCaptura } from '../lib/registro.js';
import { generarPdfUnificado, generarIndiceHipervinculado } from '../lib/unificador.js';
import { iniciarCanalExterno } from './externo.js';
import { iniciarConsultas, iniciarAperturaVinculados, asegurarHistoricas, abrirDesdeRelacionados, pedir } from './consulta.js';
import { iniciarRelacionados } from './relacionados.js';
import { PDFDocument } from '../../vendor/pdf-lib.esm.js';

// Trozos de actuaciones grandes en tránsito: clave → [Uint8Array].
const trozosPendientes = new Map();

// Registro técnico local: errores no atrapados del service worker.
instalarCaptura('background');

// Canal landing web → extensión (ping; más adelante buscarYAbrir).
iniciarCanalExterno();
// Consulta de expedientes desde la pantalla de inicio (src/public/inicio.html).
iniciarConsultas();
iniciarAperturaVinculados();
// Variante DGN: lista de expedientes relacionados del SCW con sesión iniciada.
iniciarRelacionados();

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return;

  // Eventos del registro técnico que mandan el content script y el popup
  // (no pueden importar lib/registro.js).
  if (message.action === 'registrarEvento') {
    const ev = message.evento || {};
    registrar(ev.nivel, ev.origen, ev.mensaje, ev.datos).then(() => sendResponse({ ok: true }));
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PDF UNIFICADO — descarga cada actuación, arma un único PDF con índice
  // hipervinculado y link público en el pie de cada página (unificador.js).
  // ═══════════════════════════════════════════════════════════════════

  if (message.action === 'descargarExpedienteUnificado') {
    (async () => {
      try {
        const actuacionesIn = message.actuaciones || [];
        const tituloExpediente = message.tituloExpediente || 'Expediente';
        const historicasFaltantes = !!message.historicasFaltantes;
        const paginacionIncompleta = !!message.paginacionIncompleta;
        if (!actuacionesIn.length) { sendResponse({ ok: false, error: 'No hay actuaciones para unificar.' }); return; }

        // Normalizar URLs por si vinieran relativas o sin download=true
        // (obtenerActuaciones en content.js ya las arma completas, pero no
        // asumimos: este handler también puede invocarse a futuro desde
        // otro flujo, p.ej. biblioteca).
        const actuaciones = actuacionesIn.map((a, i) => {
          let urlPdf = a.urlPdf || a.url || '';
          if (urlPdf && urlPdf.indexOf('http') !== 0) urlPdf = 'https://scw.pjn.gov.ar' + urlPdf;
          if (urlPdf.indexOf('/scw/viewer') !== -1 && urlPdf.indexOf('download=true') === -1)
            urlPdf += (urlPdf.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
          const urlPublica = a.urlPublica || urlPdf.replace(/[&?]download=true/g, '');
          return {
            numero: a.numero || i + 1,
            titulo: a.titulo || 'Actuación ' + (i + 1),
            fecha: a.fecha || '',
            tipo: a.tipo || '',
            descripcion: a.descripcion || '',
            urlPdf, urlPublica,
            bytes: null, error: null,
          };
        });

        chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados: 0, errores: 0, terminado: false } });

        const CONC = 3;
        let siguiente = 0, descargados = 0, errores = 0;
        async function worker() {
          while (siguiente < actuaciones.length) {
            const act = actuaciones[siguiente++];
            try {
              const resp = await fetch(act.urlPdf, { credentials: 'include' });
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              const buffer = await resp.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              // Igual chequeo de firma %PDF- que en content.js: evita que una
              // página de error/sesión (200 OK con HTML) quede incrustada
              // como si fuera el documento — el unificador la reemplaza por
              // una página de error explícita en su lugar.
              if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D) {
                act.bytes = bytes;
                descargados++;
              } else {
                act.error = 'La respuesta no es un PDF válido (posible sesión vencida)';
                errores++;
              }
            } catch (e) {
              act.error = e.message;
              errores++;
            }
            chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados, errores, terminado: false, etapa: 'descargando' } });
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONC, actuaciones.length) }, worker));

        chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados, errores, terminado: false, etapa: 'armando' } });

        const pdfBytes = await generarPdfUnificado({ tituloExpediente, actuaciones, historicasFaltantes, paginacionIncompleta });
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });

        let url;
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          url = URL.createObjectURL(blob);
        } else {
          // Fallback por si el service worker no soporta createObjectURL:
          // data URI en base64 (funciona igual con chrome.downloads.download).
          const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          url = 'data:application/pdf;base64,' + b64;
        }

        const nombreArchivo = sanitizarNombre(tituloExpediente).slice(0, 50) + '_UNIFICADO.pdf';
        chrome.downloads.download({ url, filename: nombreArchivo, saveAs: true }, () => {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' && url.indexOf('blob:') === 0) {
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          }
        });

        chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados, errores, terminado: true } });
        sendResponse({ ok: true, descargados, errores, total: actuaciones.length });
      } catch (err) {
        console.error('[PJN BG] Error armando PDF unificado:', err);
        chrome.storage.local.set({ unificadoProgreso: { terminado: true, error: err.message } });
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Índice hipervinculado standalone: a diferencia del PDF unificado, no
  // copia ninguna página de ninguna actuación — cada entrada enlaza al
  // enlace público en el SCW, no a otra página de este mismo PDF. No hace
  // falta volver a descargar nada (solo título/fecha/tipo/enlace público,
  // ya guardados), así que funciona incluso sin pestaña del SCW abierta —
  // a diferencia de PDF unificado y ZIP.
  if (message.action === 'descargarIndiceHipervinculado') {
    (async () => {
      try {
        const actuaciones = message.actuaciones || [];
        const tituloExpediente = message.tituloExpediente || 'Expediente';
        if (!actuaciones.length) { sendResponse({ ok: false, error: 'No hay actuaciones para el índice.' }); return; }

        const pdfBytes = await generarIndiceHipervinculado({
          tituloExpediente, actuaciones,
          historicasFaltantes: !!message.historicasFaltantes,
          paginacionIncompleta: !!message.paginacionIncompleta,
        });
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });

        let url;
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          url = URL.createObjectURL(blob);
        } else {
          const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          url = 'data:application/pdf;base64,' + b64;
        }

        const nombreArchivo = sanitizarNombre(tituloExpediente).slice(0, 50) + '_INDICE.pdf';
        chrome.downloads.download({ url, filename: nombreArchivo, saveAs: true }, () => {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' && url.indexOf('blob:') === 0) {
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          }
        });

        sendResponse({ ok: true, total: actuaciones.length });
      } catch (err) {
        console.error('[PJN BG] Error armando índice hipervinculado:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // BIBLIOTECA — persistencia local en IndexedDB (ver db.js)
  // content.js corre en el origen de scw.pjn.gov.ar y no puede tocar el
  // IndexedDB de la extensión directamente, así que todo pasa por acá.
  // biblioteca.html, en cambio, puede importar db.js y leer directo.
  // ═══════════════════════════════════════════════════════════════════

  if (message.action === 'bibliotecaIniciar') {
    // { cid, numero, folderName, caratula, archivos }
    const archivos = message.archivos || [];
    (async () => {
      try {
        // Antes de que lleguen los documentos nuevos (ver migrarBanderitasViejas).
        await migrarBanderitasViejas(message.cid).catch(err =>
          console.warn('[Infocivil BG] No se pudieron migrar banderitas viejas:', err));
        const reg = await db.guardarExpediente({
          cid: message.cid,
          numero: message.numero,
          folderName: message.folderName,
          caratula: message.caratula,
          cantidadActuaciones: archivos.length,
          cantidadFojas: archivos.length, // aproximado: 1 PDF ≈ 1 foja hasta que el visor cuente páginas reales
          hash: db.calcularHash(archivos),
          estado: 'descargando',
          fechaDescarga: new Date().toISOString(),
          vinculados: message.vinculados || [],
        });
        sendResponse({ ok: true, expediente: reg });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Trozos de una actuación grande (ver guardarEnBiblioteca en el content
  // script): se juntan acá hasta que llega el último con bibliotecaGuardarDocumento.
  if (message.action === 'bibliotecaTrozoDocumento') {
    try {
      const lista = trozosPendientes.get(message.clave) || [];
      lista.push(base64ABytes(message.b64));
      trozosPendientes.set(message.clave, lista);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }

  if (message.action === 'bibliotecaGuardarDocumento') {
    // { cid, indice, titulo, fecha, tipo, esHistorica, extension, urlHiper, bufferB64, mime }
    try {
      const bytes = base64ABytes(message.bufferB64);
      console.log('[PJN DIAG BG] doc', message.indice, '| base64 recibido len:', (message.bufferB64||'').length,
        '| bytes decodificados:', bytes.length,
        '| primeros bytes:', Array.from(bytes.slice(0,5)).join(','));
      const previos = message.claveTrozos ? (trozosPendientes.get(message.claveTrozos) || []) : [];
      if (message.claveTrozos) trozosPendientes.delete(message.claveTrozos);
      const blob = new Blob([...previos, bytes], { type: message.mime || 'application/pdf' });
      // Cantidad de fojas, contada acá (mientras siguen llegando las
      // descargas) para que el libro se arme al abrirlo sin tener que leer
      // y procesar cada PDF del expediente. Si falla o el PDF es enorme, se
      // cuenta la primera vez que se abre el libro (y queda guardado).
      const contarFojas = blob.size > 60 * 1024 * 1024 ? Promise.resolve(undefined)
        : blob.arrayBuffer()
            .then(ab => PDFDocument.load(ab, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false }))
            .then(pdf => pdf.getPageCount())
            .catch(() => undefined);
      contarFojas.then(numPaginas => db.guardarDocumento({
        numPaginas,
        cid: message.cid,
        indice: message.indice,
        titulo: message.titulo,
        fecha: message.fecha,
        tipo: message.tipo,
        descripcion: message.descripcion,
        esHistorica: message.esHistorica,
        extension: message.extension,
        urlHiper: message.urlHiper,
        blob,
      })).then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }

  if (message.action === 'bibliotecaFinalizar') {
    // { cid, archivos }
    const archivos = message.archivos || [];
    (async () => {
      try {
        const ids = archivos.map(a => db.idActuacion(a.urlHiper || a.url)).filter(Boolean);
        const eliminadas = await db.marcarEliminadasEnSCW(message.cid, ids);
        const reg = await db.actualizarEstadoExpediente(message.cid, {
          estado: 'ok',
          nuevasDetectadas: 0,
          eliminadasDetectadas: eliminadas,
          cantidadActuaciones: archivos.length,
          cantidadFojas: archivos.length,
          hash: db.calcularHash(archivos),
          fechaVerificacion: new Date().toISOString(),
        });
        const fusionados = await db.fusionarDuplicadosPorNumero(message.cid, reg.numero);
        if (fusionados) console.log('[Infocivil BG] Fusionados ' + fusionados + ' duplicado(s) de "' + reg.numero + '" en cid=' + message.cid);
        sendResponse({ ok: true, expediente: reg });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'bibliotecaVerificarCambios') {
    // { cid, archivos }  — archivos = resultado liviano de findPdfs (sin blobs)
    verificarCambiosInterno(message.cid, message.archivos)
      .then(r => sendResponse(r))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'bibliotecaVerificarEnVivo') {
    // { cid } — abre (o reusa) la pestaña del expediente, escanea liviano y compara
    (async () => {
      try {
        const { tab, creado, cid: cidVivo } = await obtenerTabExpediente(message.cid);
        await asegurarHistoricas(tab.id, cidVivo, await anioGuardado(message.cid)).catch(e =>
          console.warn('[Infocivil BG] Históricas no aseguradas al verificar:', e));
        const resp = await sendMessageATab(tab.id, { action: 'findPdfs' });
        if (creado) chrome.tabs.remove(tab.id);
        if (!resp || !resp.ok) { sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' }); return; }
        const resultado = await verificarCambiosInterno(message.cid, resp.archivos);
        sendResponse(resultado);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'bibliotecaActualizarEnVivo') {
    // { cid } — abre (o reusa) la pestaña, escanea y dispara la descarga real.
    // El progreso se sigue por chrome.storage.local ('descargaProgreso'), igual que el popup.
    (async () => {
      try {
        const { tab, creado, cid: cidVivo } = await obtenerTabExpediente(message.cid);
        await asegurarHistoricas(tab.id, cidVivo, await anioGuardado(message.cid), { forzar: true }).catch(e =>
          console.warn('[Infocivil BG] Históricas no aseguradas al actualizar:', e));
        const resp = await sendMessageATab(tab.id, { action: 'findPdfs' });
        if (!resp || !resp.ok) {
          if (creado) chrome.tabs.remove(tab.id);
          sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' });
          return;
        }
        chrome.storage.local.set({ descargaProgreso: { total: resp.archivos.length, descargados: 0, errores: 0, terminado: false } });
        chrome.tabs.sendMessage(tab.id, {
          action: 'guardarEnBiblioteca', archivos: resp.archivos, folderName: resp.folderName, startIndex: 1
        });
        sendResponse({ ok: true, iniciado: true });

        if (creado) {
          // Cerramos la pestaña recién creada apenas termine la descarga.
          const check = setInterval(() => {
            chrome.storage.local.get(['descargaProgreso'], data => {
              if (data.descargaProgreso && data.descargaProgreso.terminado) {
                clearInterval(check);
                chrome.tabs.remove(tab.id, () => {});
              }
            });
          }, 1000);
          setTimeout(() => clearInterval(check), 180000); // tope de seguridad: 3 min
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'bibliotecaListar') {
    db.listarExpedientes()
      .then(expedientes => sendResponse({ ok: true, expedientes }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'bibliotecaEliminar') {
    db.eliminarExpediente(message.cid)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'verificarExpedienteEnVivo') {
    // Abre el expediente en una pestaña oculta, corre el mismo findPdfs liviano
    // que ya existe (no descarga PDFs), compara contra lo guardado y cierra.
    const cid = message.cid;
    const url = 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=' + cid;
    chrome.tabs.create({ url, active: false }, function (tab) {
      const tabId = tab.id;
      function onUpdated(tid, info) {
        if (tid !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, { action: 'findPdfs' }, async function (resp) {
            chrome.tabs.remove(tabId);
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' });
              return;
            }
            try {
              const existente = await db.obtenerExpediente(cid);
              if (!existente) { sendResponse({ ok: true, noGuardado: true }); return; }
              const hashNuevo = db.calcularHash(resp.archivos);
              const cambio = existente.hash !== hashNuevo;
              const nuevasDetectadas = cambio ? Math.max(0, resp.archivos.length - existente.cantidadActuaciones) : 0;
              const actualizado = await db.actualizarEstadoExpediente(cid, {
                estado: cambio ? 'nuevo' : 'ok',
                nuevasDetectadas,
                fechaVerificacion: new Date().toISOString(),
              });
              sendResponse({ ok: true, cambio, nuevasDetectadas, expediente: actualizado });
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
          });
        }, 4000); // margen para que RichFaces termine de pintar el paginador
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    return true;
  }

  if (message.action === 'actualizarExpedienteEnVivo') {
    // Abre el expediente, escanea, y dispara el mismo guardado que usa el
    // popup — el progreso se sigue vía chrome.storage.local ('descargaProgreso'),
    // igual que ya hace popup.js.
    const cid = message.cid;
    const url = 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=' + cid;
    chrome.tabs.create({ url, active: false }, function (tab) {
      const tabId = tab.id;
      function onUpdated(tid, info) {
        if (tid !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, { action: 'findPdfs' }, function (resp) {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              chrome.tabs.remove(tabId);
              sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' });
              return;
            }
            chrome.storage.local.set({
              descargaProgreso: { total: resp.archivos.length, descargados: 0, errores: 0, terminado: false }
            });
            chrome.tabs.sendMessage(tabId, {
              action: 'guardarEnBiblioteca', archivos: resp.archivos, folderName: resp.folderName, startIndex: 1
            });
            sendResponse({ ok: true, iniciado: true, total: resp.archivos.length });

            const check = setInterval(function () {
              chrome.storage.local.get(['descargaProgreso'], function (d) {
                if (d.descargaProgreso && d.descargaProgreso.terminado) {
                  clearInterval(check);
                  chrome.tabs.remove(tabId);
                }
              });
            }, 1500);
          });
        }, 4000);
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lógica original — sin cambios
  // ═══════════════════════════════════════════════════════════════════

  if (message.action === 'startDownload') {
    var archivos   = message.archivos || [];
    var folderName = message.folderName || 'Expediente';
    var startIndex = parseInt(message.startIndex, 10) || 1;

    if (!archivos.length) {
      sendResponse({ ok: false, error: 'Lista de archivos vacía' });
      return true;
    }

    chrome.storage.local.set({
      descargaProgreso: { total: archivos.length, descargados: 0, errores: 0, terminado: false }
    }, function () {
      sendResponse({ ok: true, total: archivos.length });
    });

    chrome.tabs.query({ url: 'https://scw.pjn.gov.ar/*' }, function (tabs) {
      var tabId = tabs && tabs[0] && tabs[0].id;
      if (!tabId) { console.error('[PJN BG] No se encontró tab del SCW'); return; }
      chrome.tabs.sendMessage(tabId, {
        action: 'crearYDescargarZip', archivos: archivos,
        folderName: folderName, startIndex: startIndex
      });
    });
    return true;
  }

  if (message.action === 'actualizarProgreso') {
    chrome.storage.local.set({ descargaProgreso: message.progreso });
    const pr = message.progreso || {};
    if (pr.terminado && (pr.errores > 0 || pr.error || message.error)) {
      registrar(pr.descargados ? 'aviso' : 'error', 'background', 'Operación terminada con errores',
        { total: pr.total, descargados: pr.descargados, errores: pr.errores, error: pr.error || message.error });
    }
    if (message.progreso.terminado) {
      chrome.storage.local.set({ nextCorrelativeIndex: message.nextIndex || 1 });
    }
    return false;
  }

  if (message.action === 'abrirTabHistoricas') {
    var cid     = message.cid;
    var urlHist = 'https://scw.pjn.gov.ar/scw/actuacionesHistoricas.seam?cid=' + cid;

    chrome.storage.local.remove('pjnHistoricasResult', function() {
      chrome.tabs.query({ active: true, currentWindow: true }, function(activeTabs) {
        var originalActiveTabId = activeTabs && activeTabs[0] && activeTabs[0].id;

        chrome.tabs.create({ url: urlHist, active: false }, function(tab) {
          var histTabId = tab.id;

          function onUpdated(tabId, info) {
            if (tabId !== histTabId || info.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.update(histTabId, { active: true }, function() {
              console.log('[PJN BG] Tab historicas activo, esperando auto-scraping...');
            });
          }
          chrome.tabs.onUpdated.addListener(onUpdated);

          var intentos = 40;
          function poll() {
            chrome.storage.local.get('pjnHistoricasResult', function(data) {
              if (data.pjnHistoricasResult) {
                var resp = data.pjnHistoricasResult;
                chrome.storage.local.remove('pjnHistoricasResult');
                chrome.tabs.remove(histTabId, function() {});
                if (originalActiveTabId) {
                  chrome.tabs.update(originalActiveTabId, { active: true });
                }
                var total = resp.archivos ? resp.archivos.length : 0;
                console.log('[PJN BG] Historicas recibidas:', total);
                sendResponse(resp);
              } else if (intentos-- > 0) {
                setTimeout(poll, 2000);
              } else {
                chrome.tabs.remove(histTabId, function() {});
                if (originalActiveTabId) {
                  chrome.tabs.update(originalActiveTabId, { active: true });
                }
                console.warn('[PJN BG] Timeout esperando historicas');
                sendResponse({ ok: false, error: 'Timeout' });
              }
            });
          }
          setTimeout(poll, 45000);
        });
      });
    });
    return true;
  }

  if (message.action === 'runInPageWorld') {
    var tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: 'Sin tabId' }); return true; }
    var codigoPagina = message.code || '';
    // Chrome/Edge y Firefox >= 128: se ejecuta en el mundo de la página.
    // Firefox 115 (ESR, último soportado en Windows 7) no conoce world:'MAIN':
    // se cae al plan B (executeOnclickFirefox), que usa wrappedJSObject.
    var plan = function (opciones, func) {
      return new Promise(function (resolve) {
        try {
          chrome.scripting.executeScript(
            Object.assign({ target: { tabId: tabId }, func: func, args: [codigoPagina] }, opciones),
            function () { resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : null); }
          );
        } catch (e) { resolve(String(e && e.message || e)); }
      });
    };
    plan({ world: 'MAIN' }, executeOnclick).then(function (error) {
      if (!error) return null;
      return plan({}, executeOnclickFirefox);
    }).then(function (error2) {
      if (error2) console.error('[PJN BG]', error2);
      sendResponse({ ok: true });
    });
    return true;
  }
});

function executeOnclick(onclickCode) {
  try {
    var code = onclickCode.replace(/;?\s*return\s+false\s*;?/g, '');
    new Function('event', code)(new MouseEvent('click', { bubbles: true, cancelable: true }));
  } catch (e) { console.error('[PJN]', e); }
}

// Plan B para Firefox sin world:'MAIN' (ESR 115): el script corre en el mundo
// aislado de la extensión y crea la función con el constructor Function de la
// PÁGINA (window.wrappedJSObject), de modo que el código ve los globales del
// sitio (RichFaces, A4J) igual que en executeOnclick.
function executeOnclickFirefox(onclickCode) {
  try {
    var code = onclickCode.replace(/;?\s*return\s+false\s*;?/g, '');
    var w = window.wrappedJSObject;
    var evento = new w.MouseEvent('click', cloneInto({ bubbles: true, cancelable: true }, w));
    new w.Function('event', code).call(w, evento);
  } catch (e) { console.error('[PJN]', e); }
}

// ─── Auxiliares para orquestar biblioteca ↔ pestañas del SCW ───────────────

// Compara lo recién escaneado en el SCW contra lo guardado, por id de
// actuación (link público), no por cantidad: así "cambió el orden" o "se
// leyó una histórica que antes faltaba" no se confunden con novedades, y
// también se detectan actuaciones que el SCW ya no muestra.
//
// Red de seguridad: si hay actuaciones guardadas pero NINGUNA coincide por
// id, lo más probable es que el link público no sea estable (algún
// parámetro de sesión en la URL) y comparar por id marcaría todo como
// nuevo. En ese caso se vuelve a la comparación por cantidad y se informa
// criterio:'cantidad' para poder detectarlo al probar contra el SCW real.
// Banderitas en formato viejo ({ page } = foja absoluta) se anclan a su
// actuación ANTES de que una actualización cambie el armado del libro:
// después ya no hay forma de saber a qué foja se referían. Reconstruye el
// armado tal como lo arma biblioteca.js (documentos por índice, todas sus
// fojas en orden). Solo trabaja si hay banderitas viejas; es por única vez.
async function migrarBanderitasViejas(cid) {
  const viejas = (await db.obtenerMarcadores(cid)).filter(m => !m.actuacionId && typeof m.page === 'number');
  if (!viejas.length) return 0;
  const docs = await db.obtenerDocumentos(cid);
  const tramos = []; // { desde, fojas, doc }
  let desde = 0;
  for (const doc of docs) {
    let fojas = 1;
    try {
      const pdf = await PDFDocument.load(await doc.blob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
      fojas = pdf.getPageCount();
    } catch (e) { /* PDF ilegible: el lector tampoco lo muestra bien; cuenta como 1 */ }
    tramos.push({ desde, fojas, doc });
    desde += fojas;
  }
  let migradas = 0;
  for (const m of viejas) {
    const t = tramos.find(t => m.page >= t.desde && m.page < t.desde + t.fojas);
    if (!t) continue; // foja fuera de rango: se deja como está
    await db.guardarMarcador({ cid, actuacionId: db.idDeDocumento(t.doc), pagina: m.page - t.desde, label: m.label, color: m.color });
    await db.eliminarMarcadorPorId(m.id);
    migradas++;
  }
  return migradas;
}

async function verificarCambiosInterno(cid, archivos) {
  const existente = await db.obtenerExpediente(cid);
  if (!existente) return { ok: true, noGuardado: true };

  const docs = await db.obtenerDocumentos(cid);
  const guardados = new Set(docs.map(db.idDeDocumento).filter(id => id.indexOf('indice:') !== 0));
  const actuales = new Set(archivos.map(a => db.idActuacion(a.urlHiper || a.url)).filter(Boolean));

  let criterio = 'id';
  let nuevasDetectadas = 0, eliminadasDetectadas = 0, cambio;
  const hayCoincidencias = [...actuales].some(id => guardados.has(id));

  if (guardados.size && actuales.size && hayCoincidencias) {
    nuevasDetectadas = [...actuales].filter(id => !guardados.has(id)).length;
    eliminadasDetectadas = [...guardados].filter(id => !actuales.has(id)).length;
    cambio = nuevasDetectadas > 0 || eliminadasDetectadas > 0;
  } else {
    criterio = 'cantidad';
    if (guardados.size && actuales.size) {
      console.warn('[Infocivil BG] Ningún link público coincide con lo guardado (cid=' + cid +
        '): se compara por cantidad. Revisar si la URL del visor trae parámetros variables.');
    }
    cambio = existente.hash !== db.calcularHash(archivos);
    nuevasDetectadas = cambio ? Math.max(0, archivos.length - existente.cantidadActuaciones) : 0;
  }

  const actualizado = await db.actualizarEstadoExpediente(cid, {
    estado: cambio ? 'nuevo' : 'ok',
    nuevasDetectadas,
    eliminadasDetectadas,
    fechaVerificacion: new Date().toISOString(),
  });
  return { ok: true, cambio, nuevasDetectadas, eliminadasDetectadas, criterio, expediente: actualizado };
}

// Busca una pestaña ya abierta en ese expediente; si no hay, crea una nueva
// (inactiva) y espera a que cargue + a que content.js se registre.
// Variante DGN: con sesión iniciada el cid es efímero (conversación de Seam).
// Si el guardado ya no abre ese expediente, se lo reabre desde la lista de
// relacionados por su número. Devuelve también el cid vigente.
async function anioGuardado(cid) {
  const reg = await db.obtenerExpediente(cid).catch(() => null);
  const clave = reg && db.normalizarClaveExpediente(reg.numero);
  return clave ? clave.split('|')[2] : '';
}

async function obtenerTabExpediente(cid) {
  const urlExp = 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=' + cid;
  const reg = await db.obtenerExpediente(cid).catch(() => null);
  const clave = reg && db.normalizarClaveExpediente(reg.numero);
  const esElMismo = async tabId => {
    const e = await pedir(tabId, { action: 'estadoPagina' });
    if (!e || !e.esExpediente || !e.cid) return null;
    if (clave) {
      const a = await pedir(tabId, { action: 'relacionadosClaveActual' });
      if (a && a.clave && a.clave !== clave) return null;
    }
    return e.cid;
  };

  const tabs = await chrome.tabs.query({ url: 'https://scw.pjn.gov.ar/scw/expediente.seam*' });
  let tab = tabs.find(t => (t.url || '').includes('cid=' + cid));
  if (tab) {
    const vivo = await esElMismo(tab.id);
    if (vivo) return { tab, creado: false, cid: vivo };
  }

  tab = await chrome.tabs.create({ url: urlExp, active: false });
  await esperarCargaCompleta(tab.id);
  await new Promise(r => setTimeout(r, 1500)); // margen para que content.js se registre
  const vivo = await esElMismo(tab.id);
  if (vivo) return { tab, creado: true, cid: vivo };

  if (!clave) { chrome.tabs.remove(tab.id).catch(() => {}); throw new Error('No se pudo reabrir el expediente en el SCW.'); }
  await chrome.tabs.update(tab.id, { url: 'https://scw.pjn.gov.ar/scw/consultaListaRelacionados.seam' });
  const rel = await abrirDesdeRelacionados(tab.id, clave, () => {}).catch(e => ({ estado: 'error', error: e.message }));
  if (rel.estado === 'abierto') return { tab, creado: true, cid: rel.cid };
  chrome.tabs.remove(tab.id).catch(() => {});
  if (rel.estado === 'sin-sesion') throw new Error('No hay una sesión iniciada en el SCW: iniciá sesión y volvé a intentar.');
  if (rel.estado === 'no-figura') throw new Error('El expediente ya no figura entre tus expedientes relacionados.');
  throw new Error(rel.error || 'No se pudo reabrir el expediente en el SCW.');
}

function esperarCargaCompleta(tabId) {
  return new Promise(resolve => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function sendMessageATab(tabId, msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, msg, resp => {
      if (chrome.runtime.lastError) resolve(null); else resolve(resp);
    });
  });
}

function sanitizarNombre(texto) {
  return String(texto || 'Expediente').replace(/[/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function base64ABytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
