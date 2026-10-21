(function () {
  if (window.__pjnListener) {
    chrome.runtime.onMessage.removeListener(window.__pjnListener);
  }
  window.__pjnDescargadorLoaded = true;

  window.__pjnListener = function (message, sender, sendResponse) {
    if (!message) return;

    // ─── Consulta desde la pantalla de inicio de la extensión ───────────
    // background/consulta.js maneja el flujo completo (esta instancia se
    // destruye en cada navegación); acá solo se lee y se actúa sobre la
    // página actual.
    if (message.action === 'estadoPagina') {
      sendResponse(estadoPaginaSCW());
      return false;
    }

    if (message.action === 'completarFormularioBusqueda') {
      (async () => {
        try {
          await completarFormularioBusquedaDOM(message.valorJurisdiccion, message.numero, message.anio);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }

    if (message.action === 'tomarPrimerResultadoBusqueda') {
      sendResponse(tomarPrimerResultadoBusquedaDOM());
      return false;
    }

    if (message.action === 'leerVinculados') {
      (async () => {
        try { sendResponse({ ok: true, ...(await leerVinculadosDOM()) }); }
        catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
      })();
      return true;
    }

    if (message.action === 'abrirVinculado') {
      (async () => {
        try { sendResponse({ ok: true, ...(await abrirVinculadoDOM(message.expediente)) }); }
        catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
      })();
      return true;
    }

    if (message.action === 'findPdfs') {
      (async () => {
        try {
          const folderName = obtenerNombreExpediente();
          const archivos   = await recolectarTodosLosDocumentos();
          const resultado  = { ok: true, folderName, total: archivos.length, archivos };
          // Guardar en storage por si el popup se cerró mientras esperaba (tab de históricas)
          chrome.storage.local.set({ pjnFindPdfsResult: resultado });
          sendResponse(resultado);
        } catch (e) {
          console.error('[PJN] Error en findPdfs:', e);
          registrarIC('error', 'Falló la lectura del expediente en el SCW', { error: e.message || String(e) });
          const error = { ok: false, error: e.message || String(e) };
          chrome.storage.local.set({ pjnFindPdfsResult: error });
          sendResponse(error);
        }
      })();
      return true;
    }

    // Alias liviano de 'findPdfs' para el flujo de PDF unificado: además de
    // 'archivos' (compatibilidad con el resto de la extensión), devuelve
    // 'actuaciones' con fecha/tipo separados y las dos variantes de URL que
    // necesita el unificador (urlPdf para descargar, urlPublica para el pie
    // y el índice — sin el parámetro download=true).
    if (message.action === 'obtenerActuaciones') {
      (async () => {
        try {
          const folderName = obtenerNombreExpediente();
          const tituloExpediente = obtenerCaratula() || folderName;
          const archivos = await recolectarTodosLosDocumentos();
          const actuaciones = archivos.map((a, i) => {
            let urlPdf = a.url ? String(a.url) : '';
            if (urlPdf && urlPdf.indexOf('http') !== 0) urlPdf = 'https://scw.pjn.gov.ar' + urlPdf;
            if (urlPdf.indexOf('/scw/viewer') !== -1 && urlPdf.indexOf('download=true') === -1)
              urlPdf += (urlPdf.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
            const urlPublica = urlPdf.replace(/[&?]download=true/g, '');
            return {
              numero: i + 1,
              titulo: a.titulo || 'documento',
              fecha: a.fecha || '',
              tipo: a.tipo || '',
              descripcion: a.descripcion || '',
              url: urlPdf, urlPdf, urlPublica,
              esHistorica: a.esHistorica || false,
            };
          });

          // Aviso: si el usuario nunca visitó "Actuaciones históricas" para
          // este expediente, esa sección no se cargó — y ahí suele estar
          // el inicio del expediente (demanda, primeras providencias). Sin
          // este aviso el PDF unificado sale "incompleto" en silencio,
          // como pasó con el caso que arrancaba en 2024 en vez de 2021.
          const cid = obtenerCid();
          let historicasFaltantes = false;
          if (cid) {
            const key = 'pjnHistoricas_' + cid;
            const data = await new Promise(res => chrome.storage.local.get(key, res));
            historicasFaltantes = !(key in data);
          }

          // Segundo aviso posible para el mismo síntoma (falta la actuación
          // más vieja): la paginación de actuaciones ACTUALES se cortó por
          // timeout antes de llegar genuinamente al final, en vez de que el
          // expediente realmente no tenga históricas.
          const paginacionIncompleta = !ultimaPaginacionCompleta;

          const resultado = { ok: true, actuaciones, archivos, folderName, tituloExpediente, total: actuaciones.length, historicasFaltantes, paginacionIncompleta };
          if (historicasFaltantes || paginacionIncompleta)
            registrarIC('aviso', 'Lectura del SCW posiblemente incompleta', { expediente: folderName, actuaciones: actuaciones.length, historicasFaltantes, paginacionIncompleta });
          chrome.storage.local.set({ pjnFindPdfsResult: resultado });
          sendResponse(resultado);
        } catch (e) {
          console.error('[PJN] Error en obtenerActuaciones:', e);
          registrarIC('error', 'Falló la lectura de actuaciones en el SCW', { error: e.message || String(e) });
          const error = { ok: false, error: e.message || String(e) };
          chrome.storage.local.set({ pjnFindPdfsResult: error });
          sendResponse(error);
        }
      })();
      return true;
    }

    if (message.action === 'crearYDescargarZip') {
      (async () => {
        const archivos   = message.archivos || [];
        const folderName = message.folderName || 'Expediente';
        const total      = archivos.length;
        let descargados = 0, errores = 0, completados = 0;

        // Antes: un fetch atrás de otro, uno a la vez — para un expediente
        // grande (cientos de actuaciones) eso son cientos de idas y vueltas
        // a la red EN FILA. Mismo pool de 3 descargas en simultáneo que ya
        // usa "PDF unificado" (background/index.js) y que ya está probado
        // contra el SCW real — acá se replica el mismo patrón, no es nuevo.
        // Los resultados se guardan por POSICIÓN ORIGINAL (resultados[i]),
        // no en el orden en que van terminando (que con 3 en simultáneo ya
        // no coincide con el orden de las actuaciones) — así el ZIP sale
        // numerado igual que antes: 1, 2, 3... solo lo que se pudo bajar,
        // en el orden real del expediente.
        const resultados = new Array(total);
        const CONC = 3;
        let siguiente = 0;
        async function worker() {
          while (siguiente < total) {
            const i = siguiente++;
            const archivo = archivos[i];
            let url = archivo.url ? String(archivo.url) : '';
            if (!url) { errores++; completados++; continue; }
            if (url.indexOf('http') !== 0) url = 'https://scw.pjn.gov.ar' + url;
            if (url.indexOf('/scw/viewer') !== -1 && url.indexOf('download=true') === -1)
              url += (url.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
            try {
              const buffer = await descargarPDFValidado(url, 30000);
              resultados[i] = { archivo, buffer };
              descargados++;
            } catch (err) {
              console.warn('[PJN] Descarga descartada (' + (archivo.titulo || 'documento') + '):', err.message);
              registrarIC('aviso', 'Descarga descartada (ZIP)', { actuacion: i + 1, de: total, error: err.message });
              errores++;
            }
            completados++;
            chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: false }, nextIndex: completados + 1 });
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONC, total) }, worker));

        const zipEntries = [], pdfNames = [];
        let indice = 1;
        for (let i = 0; i < total; i++) {
          const r = resultados[i];
          if (!r) continue;
          const numero   = leftPad(indice, 4);
          const basename = numero + ' - ' + sanitizar(r.archivo.titulo || 'documento') + (r.archivo.extension || '.pdf');
          zipEntries.push({ name: basename, data: new Uint8Array(r.buffer) });
          pdfNames.push(basename);
          indice++;
        }

        const viewerBytes = new TextEncoder().encode(generarViewerHtml(folderName, pdfNames));
        zipEntries.unshift({ name: 'index.html', data: viewerBytes });
        const allEntries = zipEntries.map(e => ({ name: sanitizar(folderName) + '/' + e.name, data: e.data }));
        const zipBlob = buildZip(allEntries);
        const zipUrl  = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = zipUrl; a.download = sanitizar(folderName) + '.zip'; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(zipUrl), 30000);
        chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: true }, nextIndex: indice });
      })();
      return false;
    }
    if (message.action === 'guardarEnBiblioteca') {
      (async () => {
       try {
        const archivos   = message.archivos || [];
        const folderName = message.folderName || 'Expediente';
        const total      = archivos.length;
        const cid        = obtenerCid();

        if (!cid) {
          chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados: 0, errores: total, terminado: true }, error: 'No se pudo determinar el cid del expediente.' });
          return;
        }

        // Lectura fallida (sesión vencida, página que no es un expediente,
        // tabla de actuaciones vacía): no se toca la biblioteca. Antes se
        // borraba la versión guardada y quedaba una ficha "Expediente" vacía.
        if (!total || !/[A-Z]{2,4}\s?\d+/.test(folderName)) {
          const motivo = !total ? 'No se encontraron actuaciones en el SCW (¿sesión vencida?).'
                                : 'No se pudo identificar el número del expediente en la página.';
          chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados: 0, errores: 1, terminado: true, error: motivo }, error: motivo });
          registrarIC('error', 'Guardado cancelado: ' + motivo, { expedienteDetectado: folderName, actuaciones: total });
          return;
        }

        // Reemplaza cualquier versión previa guardada de este mismo expediente.
        await new Promise(r => chrome.runtime.sendMessage({ action: 'bibliotecaEliminar', cid }, r));
        await new Promise(r => chrome.runtime.sendMessage({
          action: 'bibliotecaIniciar', cid, numero: folderName, folderName,
          caratula: obtenerCaratula(), archivos, vinculados: message.vinculados || []
        }, r));

        // Descarga y guardado en cadena. Antes se bajaba TODO el expediente a
        // memoria y recién después se guardaba: con expedientes de cientos de
        // MB (uno de 850 MB en la prueba) el navegador se quedaba sin memoria
        // y el proceso de fondo dejaba de contestar a mitad del guardado.
        // Ahora 3 descargas en simultáneo alimentan un guardado en orden real
        // del expediente, y las descargas no se adelantan más de VENTANA
        // actuaciones al guardado: en memoria hay solo unas pocas a la vez.
        let descargados = 0, errores = 0, completados = 0;
        const resultados = new Array(total);
        const avisarListo = new Array(total);
        const listos = Array.from({ length: total }, (_, i) => new Promise(r => { avisarListo[i] = r; }));
        const CONC = 3, VENTANA = 6;
        let siguiente = 0, proximoAGuardar = 0, abortado = false;
        async function worker() {
          while (siguiente < total && !abortado) {
            while (!abortado && siguiente - proximoAGuardar >= VENTANA) await esperar(150);
            if (abortado || siguiente >= total) break;
            const i = siguiente++;
            const archivo = archivos[i];
            let url = archivo.url ? String(archivo.url) : '';
            if (!url) { errores++; completados++; avisarListo[i](); continue; }
            if (url.indexOf('http') !== 0) url = 'https://scw.pjn.gov.ar' + url;
            if (url.indexOf('/scw/viewer') !== -1 && url.indexOf('download=true') === -1)
              url += (url.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
            const urlHiper = url.replace(/[&?]download=true/g, '');
            try {
              const buffer = await descargarPDFValidado(url, 30000);
              resultados[i] = { archivo, buffer, urlHiper };
              descargados++;
            } catch (err) {
              console.warn('[PJN] Descarga descartada al guardar en biblioteca (' + (archivo.titulo || 'documento') + '):', err.message);
              registrarIC('aviso', 'Descarga descartada (Mis expedientes)', { actuacion: i + 1, de: total, error: err.message });
              errores++;
            }
            completados++;
            if (completados % 3 === 0 || completados === total)
              chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: false }, nextIndex: completados + 1 });
            avisarListo[i]();
          }
        }
        const descargas = Promise.all(Array.from({ length: Math.min(CONC, total) }, worker));

        // Mensaje al proceso de fondo con tiempo límite. lastError se lee
        // DENTRO del callback (afuera ya no existe) para informar el motivo real.
        function enviarAlFondo(msg, ms) {
          return new Promise(res => {
            const t = setTimeout(() => res({ ok: false, error: 'sin respuesta del proceso de fondo en ' + Math.round(ms / 1000) + ' s' }), ms);
            try {
              chrome.runtime.sendMessage(msg, resp => {
                clearTimeout(t);
                const le = chrome.runtime.lastError;
                res(le ? { ok: false, error: le.message } : (resp || { ok: false, error: 'respuesta vacía del proceso de fondo' }));
              });
            } catch (e) { clearTimeout(t); res({ ok: false, error: e.message || String(e) }); }
          });
        }

        // chrome.runtime.sendMessage tiene un tope de 64 MiB por mensaje y el
        // base64 agranda un 33 %: cada actuación viaja en trozos de 8 MB; el
        // último lleva los datos de la actuación y el fondo arma el PDF.
        async function guardarActuacion(r, indice) {
          const todo = new Uint8Array(r.buffer);
          const megas = todo.length / 1048576;
          const TROZO = 8 * 1024 * 1024;
          const partes = Math.max(1, Math.ceil(todo.length / TROZO));
          const claveTrozos = partes > 1 ? cid + '#' + indice + '#' + Date.now() : undefined;
          for (let p = 0; p < partes - 1; p++) {
            const rt = await enviarAlFondo({
              action: 'bibliotecaTrozoDocumento', clave: claveTrozos,
              b64: arrayBufferABase64(todo.slice(p * TROZO, (p + 1) * TROZO).buffer)
            }, 60000);
            if (!rt.ok) throw new Error('No se pudo guardar la actuación ' + indice + ' (trozo ' + (p + 1) + ' de ' + partes + '): ' + rt.error);
          }
          const bufferB64 = arrayBufferABase64(todo.slice((partes - 1) * TROZO).buffer);
          const resp = await enviarAlFondo({
            action: 'bibliotecaGuardarDocumento', cid, indice,
            titulo: r.archivo.titulo || 'documento',
            fecha: r.archivo.fecha || '',
            tipo: r.archivo.tipo || '',
            descripcion: r.archivo.descripcion || '',
            esHistorica: r.archivo.esHistorica || false,
            extension: r.archivo.extension || '.pdf',
            urlHiper: r.urlHiper, bufferB64, mime: 'application/pdf', claveTrozos
          }, 60000 + Math.round(megas * 2000)); // escribir un PDF grande en disco puede tardar
          if (!resp.ok) {
            registrarIC('error', 'No se pudo guardar una actuación en Mis expedientes', { actuacion: indice, de: total, megas: Math.round(megas), partes, error: resp.error });
            throw new Error('No se pudo guardar la actuación ' + indice + ': ' + resp.error);
          }
          if (partes > 1) registrarIC('info', 'Actuación grande guardada en trozos', { actuacion: indice, megas: Math.round(megas), partes });
        }

        let indice = 1;
        try {
          for (let i = 0; i < total; i++) {
            await listos[i];
            const r = resultados[i];
            resultados[i] = null; // liberar memoria apenas se usa
            if (r) {
              await guardarActuacion(r, indice);
              console.log('[PJN] Guardada actuación', indice, 'de', total);
              indice++;
            }
            proximoAGuardar = i + 1;
          }
        } catch (err) {
          abortado = true;
          throw err;
        }
        await descargas;

        await new Promise(r => chrome.runtime.sendMessage({ action: 'bibliotecaFinalizar', cid, archivos }, r));
        chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: true }, nextIndex: indice });
       } catch (err) {
        console.error('[PJN] Falló guardarEnBiblioteca:', err);
        registrarIC('error', 'Falló el guardado en Mis expedientes', { error: String(err && err.message || err) });
        chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total: (message.archivos || []).length, descargados: 0, errores: 1, terminado: true, error: String(err && err.message || err) } });
       }
      })();
      return false;
    }
  };

  chrome.runtime.onMessage.addListener(window.__pjnListener);

  // ─── Recolección completa ─────────────────────────────────────────────────

  // Se setea en cada corrida de recorrerTodasLasPaginas(); permite avisar si
  // la paginación de actuaciones actuales se cortó por timeout en vez de
  // llegar genuinamente al final (ver obtenerActuaciones más abajo).
  let ultimaPaginacionCompleta = true;

  async function recolectarTodosLosDocumentos() {
    const href = window.location.href;
    if (href.includes('actuacionesHistoricas')) {
      const h = await scrapeHistoricasDOMDirecto();
      console.log('[PJN] Históricas DOM:', h.length);
      return h;
    }
    const actuales   = await recorrerTodasLasPaginas();
    const historicas = await fetchHistoricasConPost();
    console.log('[PJN] Actuales:', actuales.length, '| Históricas:', historicas.length);
    return [...historicas, ...actuales];
  }

  // ─── Históricas scraping directo ──────────────────────────────────────────


  // Criterio portado del Portable (commit "Detectar correctamente sin
  // historicas", confirmado con un expediente real): cuando no hay
  // históricas, el SCW NO muestra ningún cartel — solo carga la página con
  // los datos generales del expediente y ninguna tabla. Buscar el texto
  // "no posee actuaciones hist" no alcanzaba: se esperaban los 40s enteros
  // por algo que nunca iba a aparecer. Ahora: si la página ya cargó (tiene
  // "Carátula") y en 6s no aparecieron filas con documentos, no hay.
  async function esperarFilasConLinks(timeoutMs) {
    return new Promise(resolve => {
      const inicio = Date.now();
      let paginaCargadaDesde = null;
      const id = setInterval(() => {
        const texto = (document.body && document.body.innerText) || '';
        if (/no posee actuaciones hist/i.test(texto)) {
          console.log('[PJN] Expediente sin actuaciones históricas (cartel explícito).');
          clearInterval(id); resolve(); return;
        }
        const filas = document.querySelectorAll('tbody tr');
        const ok = Array.from(filas).some(f => f.querySelector("a[href*='viewer']"));
        if (ok) {
          console.log('[PJN] Tabla de históricas lista con', filas.length, 'filas');
          clearInterval(id); resolve(); return;
        }
        // Variante DGN: la pestaña corre en segundo plano y la tabla puede
        // tardar más que en la consulta pública. Con 6 s se concluía "no
        // tiene" antes de que apareciera (visto contra el SCW real: a mano
        // traía 2, en segundo plano 0). Ahora: 5 s si la tabla ya tiene filas
        // sin documentos; 20 s si todavía no apareció ninguna fila.
        if (/car[aá]tula/i.test(texto)) {
          if (paginaCargadaDesde === null) paginaCargadaDesde = Date.now();
          else if (Date.now() - paginaCargadaDesde > (filas.length ? 5000 : 20000)) {
            console.log('[PJN] Página de históricas cargada sin documentos: no tiene.');
            clearInterval(id); resolve(); return;
          }
        }
        if (Date.now() - inicio >= timeoutMs) {
          console.log('[PJN] Timeout esperando tabla históricas');
          clearInterval(id); resolve();
        }
      }, 250); // 250ms (antes 500ms): sondeo local del DOM, sin costo real de acortarlo.
    });
  }

  async function scrapeHistoricasDOMDirecto() {
    const r = [], u = new Set();
    // Esperar activamente hasta que RichFaces rellene la tabla (hasta 25s)
    console.log('[PJN] Esperando que cargue tabla de históricas...');
    await esperarFilasConLinks(40000);
    let pag = 1;
    while (true) {
      console.log('[PJN] Históricas DOM pág', pag);
      scrapearFilas(document, r, u, true);
      const btn = Array.from(document.querySelectorAll('a,button')).find(el =>
        el.textContent.trim().toLowerCase() === 'siguiente' &&
        !el.disabled && !el.classList.contains('disabled') && !el.classList.contains('ui-state-disabled')
      );
      if (!btn) break;
      const btnId = btn.getAttribute('id') || '';
      const oc = btn.getAttribute('onclick') || '';
      if (!oc) break;
      const contarLinks = () => document.querySelectorAll("tbody a[href*='viewer']").length;
      const linksBefore = contarLinks();
      if (btnId) {
        // Clickear el elemento por ID directamente en MAIN world
        await new Promise(r => {
          chrome.runtime.sendMessage({ action: 'runInPageWorld', code: 'document.getElementById(' + JSON.stringify(btnId) + ')?.click();' }, () => setTimeout(r, 200));
        });
      } else if (oc.includes('RichFaces')) {
        await ejecutarEnPaginaViaBg(oc);
      } else {
        dispararClickReal(btn);
      }
      // Esperar que cambien los links (RichFaces puede no cambiar innerHTML pero sí los hrefs)
      await new Promise(resolve => {
        const inicio = Date.now();
        const id = setInterval(() => {
          if (contarLinks() !== linksBefore || Date.now() - inicio >= 8000) {
            clearInterval(id); resolve();
          }
        }, 300);
      });
      if (contarLinks() === linksBefore) {
        console.warn('[PJN] Históricas: links no cambiaron, deteniendo paginación');
        break;
      }
      pag++;
    }
    return r.reverse();
  }

  // ─── Históricas via tab en segundo plano ─────────────────────────────────────
  // El iframe no funciona porque RichFaces necesita el ciclo completo del navegador.
  // Solución: pedirle al background que abra la página en un tab invisible,
  // la scrapea con el content script que ya existe, y devuelve los datos.

  async function fetchHistoricasConPost() {
    // Leer históricas guardadas desde storage (el usuario navegó manualmente a históricas)
    const cidMatch = window.location.href.match(/cid=(\d+)/);
    if (!cidMatch) return [];
    const cid = cidMatch[1];
    return new Promise(resolve => {
      chrome.storage.local.get('pjnHistoricas_' + cid, function(data) {
        const archivos = data['pjnHistoricas_' + cid] || [];
        console.log('[PJN] Históricas en storage para cid=' + cid + ':', archivos.length);
        resolve(archivos);
      });
    });
  }

  function extraerFormParaSiguiente(doc, urlBase) {
    let btnSig = null;
    for (const el of doc.querySelectorAll('a, input[type="submit"], button, span')) {
      const txt = (el.textContent || el.value || el.getAttribute('title') || '').trim().toLowerCase();
      if (txt === 'siguiente' || txt === 'siguiente >' || txt.startsWith('siguiente')) {
        const disabled = el.disabled || el.classList.contains('disabled') ||
          el.classList.contains('ui-state-disabled') || el.getAttribute('aria-disabled') === 'true';
        if (!disabled) { btnSig = el; break; }
      }
    }
    if (!btnSig) return null;

    const form = btnSig.closest('form') || doc.querySelector('form');
    if (!form) return null;

    const data = new FormData();
    form.querySelectorAll('input[type="hidden"]').forEach(inp => {
      if (inp.name) data.append(inp.name, inp.value || '');
    });
    if (btnSig.tagName === 'INPUT' && btnSig.name) data.append(btnSig.name, btnSig.value || '');
    if (btnSig.tagName === 'A') {
      const onclick = btnSig.getAttribute('onclick') || '';
      const match = onclick.match(/\{([^}]+)\}/);
      if (match) {
        try {
          const pairs = match[1].match(/'([^']+)'\s*:\s*'([^']*)'/g);
          if (pairs) pairs.forEach(pair => {
            const [, k, v] = pair.match(/'([^']+)'\s*:\s*'([^']*)'/) || [];
            if (k) data.append(k, v || '');
          });
        } catch(e) {}
      }
    }
    return data;
  }

  async function fetchHTML(url, method, formData) {
    try {
      const opts = { credentials: 'include', method };
      if (method === 'POST' && formData) opts.body = formData;
      const resp = await fetch(url, opts);
      if (!resp.ok || !resp.url.includes('scw.pjn.gov.ar')) return null;
      return await resp.text();
    } catch (err) { console.error('[PJN] Error fetch:', err.message); return null; }
  }

  function parseHTML(html) { return new DOMParser().parseFromString(html, 'text/html'); }

  // El SCW mete etiquetas de accesibilidad (para lectores de pantalla) como
  // texto plano en varias celdas — quedan pegadas al valor real cuando se
  // lee con textContent/innerText ("Tipo actuacion ESCRITO AGREGADO",
  // "Detalle DR. INGENIERI..."). Sin sacarlas, cualquier texto armado con
  // estos campos (el índice del PDF unificado, por ejemplo) queda ilegible
  // y repite "Fecha"/"Tipo actuacion"/"Detalle" en cada línea.
  function limpiarEtiquetaAccesibilidad(texto) {
    return (texto || '')
      .replace(/^\s*(tipo\s+actuaci[oó]n|detalle|fecha)\s*:?\s*/i, '')
      .trim();
  }

  function scrapearFilas(doc, r, u, esHistorica) {
    doc.querySelectorAll('tbody tr').forEach(fila => {
      const link = fila.querySelector("a[href*='viewer']");
      if (!link) return;
      let url = link.getAttribute('href');
      if (!url) return;
      if (url.indexOf('http') === 0) url = url.replace(/^http:\/\//, 'https://');
      else url = 'https://scw.pjn.gov.ar' + url;
      if (url.includes('/scw/viewer') && !url.includes('download=true'))
        url += (url.includes('?') ? '&' : '?') + 'download=true';
      if (u.has(url)) return;
      u.add(url);
      const c = fila.querySelectorAll('td');
      // Columnas: 0=botones, 1=oficina, 2=fecha, 3=tipo, 4=descripcion, 5=fojas
      const foja  = (c[5]||{}).textContent||'';
      const fecha = limpiarEtiquetaAccesibilidad((c[2]||{}).textContent||'');
      const tipo  = limpiarEtiquetaAccesibilidad((c[3]||{}).textContent||'');
      const desc  = limpiarEtiquetaAccesibilidad((c[4]||{}).textContent||'');
      r.push({
        url,
        titulo: sanitizar(`${foja.trim()} - ${fecha} - ${tipo} - ${desc}`),
        fecha, tipo, descripcion: desc,
        extension: '.pdf',
        esHistorica
      });
    });
  }

  // Fetch con timeout para evitar que un PDF colgado trabe todo
  async function fetchConTimeout(url, opciones, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...opciones, signal: controller.signal });
      clearTimeout(timer);
      return resp;
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // El SCW a veces responde 200 OK con una página HTML (error de sesión,
  // redirect a login, etc.) en vez del PDF pedido — sobre todo si la sesión
  // vence a mitad de una descarga larga. Un fetch "exitoso" (resp.ok) no
  // garantiza que el body sea un PDF real, y guardar esa página HTML como si
  // fuera el documento produce las "actuaciones en blanco" que no se pueden
  // abrir después. Chequeamos la firma %PDF- al inicio del archivo antes de
  // darlo por bueno.
  function esBufferPDFValido(buffer) {
    if (!buffer || buffer.byteLength < 5) return false;
    const firma = new Uint8Array(buffer, 0, 5);
    return firma[0] === 0x25 && firma[1] === 0x50 && firma[2] === 0x44 && firma[3] === 0x46 && firma[4] === 0x2D; // "%PDF-"
  }

  // Descarga un documento validando que el resultado sea un PDF real.
  // Si la primera respuesta no lo es (típicamente sesión vencida), reintenta
  // una vez tras una pequeña espera antes de darlo por error.
  async function descargarPDFValidado(url, timeoutMs) {
    for (let intento = 0; intento < 2; intento++) {
      const resp = await fetchConTimeout(url, { credentials: 'include' }, timeoutMs);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const crudo = await resp.arrayBuffer();
      // Copia en memoria propia del content script: en Firefox el buffer que
      // devuelve fetch() pertenece a la página y acceder a su "constructor"
      // (subarray, slice, etc.) lanza "Permission denied" por las Xray.
      const copia = new Uint8Array(crudo.byteLength);
      copia.set(new Uint8Array(crudo));
      const buffer = copia.buffer;
      if (esBufferPDFValido(buffer)) return buffer;
      if (intento === 0) await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('La respuesta no es un PDF válido (posible sesión vencida)');
  }

  // ─── Índice del ZIP ───────────────────────────────────────────────────────
  // Antes el ZIP incluía un visor que cargaba pdf.js desde una CDN. Manifest V3
  // no admite código alojado de forma remota, así que ahora el ZIP lleva un
  // índice simple con enlaces a los PDF (se abren con el visor del navegador).
  function generarViewerHtml(titulo, pdfNames) {
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const items = pdfNames.map(n => '<li><a href="' + encodeURI(n) + '">' + esc(n.replace(/\.pdf$/i,'')) + '</a></li>').join('\n');
    return '<!DOCTYPE html>\n<html lang="es"><head><meta charset="utf-8"><title>' + esc(titulo) + '</title>' +
      '<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a2b3c}' +
      'h1{font-size:1.3rem}li{margin:.25rem 0}a{color:#1a56a0}</style></head><body><h1>' + esc(titulo) + '</h1><ol>\n' + items + '\n</ol></body></html>';
  }

  function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  // ─── Actuaciones actuales ─────────────────────────────────────────────────

  async function recorrerTodasLasPaginas(){
    const r=[],u=new Set();
    ultimaPaginacionCompleta = true;
    await esperarTablaLista(4500);await irAPrimeraPagina();
    let n=obtenerPaginaActual();
    while(true){
      console.log('[PJN] Scrapeando pág',n);
      scrapearPaginaActual(r,u);
      const oc=obtenerOnclickSiguiente();
      if(!oc){console.log('[PJN] Fin actuales. Total:',r.length);break;}
      const h=obtenerHtmlTabla();
      await ejecutarEnPaginaViaBg(oc);
      // 25s (antes 8s): esta pestaña corre en segundo plano, donde Chrome
      // espacia los timers, y nadie está mirando — ser paciente cuesta
      // poco. OJO: el corte "en la página 2" visto en v0.9.x NO era por
      // esto (más margen no lo cambió); era el paginador de la solapa
      // Vinculados, ver paginadorActuaciones().
      let cambio = await esperarCambioDOM(h,25000);
      if(!cambio){
        // Puede ser una respuesta lenta puntual de RichFaces, no
        // necesariamente el final real de la paginación — reintentamos una
        // vez con más margen antes de cortar y avisar que quedó incompleta.
        console.warn('[PJN] Timeout pág',n+1,'— reintentando una vez...');
        await ejecutarEnPaginaViaBg(oc);
        cambio = await esperarCambioDOM(h,45000);
        if(!cambio){
          console.warn('[PJN] Timeout definitivo en pág',n+1,'— paginación quedó incompleta.');
          registrarIC('aviso', 'Timeout en la paginación de actuaciones del SCW', { pagina: n + 1 });
          ultimaPaginacionCompleta = false;
          break;
        }
      }
      n++;
    }
    return r.reverse();
  }

  function scrapearPaginaActual(r,u){
    document.querySelectorAll('#expediente\\:action-table tbody tr').forEach(fila=>{
      const link=fila.querySelector("a[href*='viewer']");if(!link)return;
      let url=link.getAttribute('href');if(!url)return;
      if(url.includes('/scw/viewer')&&!url.includes('download=true'))url+=(url.includes('?')?'&':'?')+'download=true';
      if(u.has(url))return;u.add(url);
      // nth-child es 1-based: 3=fecha, 4=tipo, 5=descripcion, 6=fojas
      const fecha = limpiarEtiquetaAccesibilidad(extraerTexto(fila,'td:nth-child(3)'));
      const tipo  = limpiarEtiquetaAccesibilidad(extraerTexto(fila,'td:nth-child(4)'));
      const desc  = limpiarEtiquetaAccesibilidad(extraerTexto(fila,'td:nth-child(5)'));
      r.push({
        url,
        titulo: sanitizar(`${extraerTexto(fila,'td:nth-child(6)')} - ${fecha} - ${tipo} - ${desc}`),
        fecha, tipo, descripcion: desc,
        extension:'.pdf', esHistorica:false
      });
    });
  }

  function dispararClickReal(el){
    el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    el.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  }

  async function esperarCambioFn(fn, valorAntes, timeoutMs){
    return new Promise(resolve=>{
      const i=Date.now();
      const id=setInterval(()=>{
        if(fn()!==valorAntes){clearInterval(id);resolve();}
        else if(Date.now()-i>=timeoutMs){clearInterval(id);resolve();}
      },300);
    });
  }

  // Paginador de la tabla de ACTUACIONES, no cualquiera de la página: con
  // la solapa "Vinculados" abierta (se lee para mostrar los incidentes),
  // su tabla trae su propio paginador, y un 'li.active' genérico podía
  // agarrar ese — la paginación creía estar en la última página y leía
  // solo la primera (visto contra el SCW real: 13 de 29 actuaciones).
  function paginadorActuaciones(){
    const vinc=document.querySelector('#expediente\\:vinculadosTab');
    const tabla=document.querySelector('#expediente\\:action-table');
    const candidatos=Array.from(document.querySelectorAll('.pagination, ul')).filter(u=>
      u.querySelector('li.active') && !(vinc && vinc.contains(u)));
    if(!candidatos.length)return null;
    if(tabla){
      // El primero que aparece después de la tabla de actuaciones en el DOM.
      const despues=candidatos.find(u=>tabla.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_FOLLOWING);
      if(despues)return despues;
    }
    return candidatos[0];
  }
  function liActivoActuaciones(){const p=paginadorActuaciones();return p?p.querySelector('li.active'):null;}
  function obtenerPaginaActual(){const a=liActivoActuaciones();if(a){const n=parseInt(a.textContent.trim(),10);if(!isNaN(n))return n;}return 1;}
  function obtenerOnclickSiguiente(){const li=liActivoActuaciones();if(!li)return null;const s=li.nextElementSibling;if(!s)return null;const a=s.querySelector('a');const o=a&&a.getAttribute('onclick')||'';return o.includes('RichFaces')?o:null;}
  async function irAPrimeraPagina(){
    if(obtenerPaginaActual()===1)return;
    const pag=paginadorActuaciones();
    for(const li of (pag?pag.querySelectorAll('li'):document.querySelectorAll('.pagination li'))){
      const a=li.querySelector('a');const o=a&&a.getAttribute('onclick');
      if(li.textContent.trim()==='1'&&o&&o.includes('RichFaces')){const h=obtenerHtmlTabla();await ejecutarEnPaginaViaBg(o);await esperarCambioDOM(h,15000);return;}
    }
  }
  function ejecutarEnPaginaViaBg(c){return new Promise(r=>{chrome.runtime.sendMessage({action:'runInPageWorld',code:c},()=>setTimeout(r,200));});}
  function obtenerHtmlTabla(){const t=document.querySelector('#expediente\\:action-table tbody');return t?t.innerHTML:'';}
  function esperarCambioDOM(h,t){return new Promise(r=>{const i=Date.now();const id=setInterval(()=>{if(obtenerHtmlTabla()!==h){clearInterval(id);r(true);}else if(Date.now()-i>=t){clearInterval(id);r(false);}},300);});}
  // Antes de arrancar a leer la tabla de actuaciones: esperar de verdad a
  // que tenga contenido, en vez de un sleep fijo de 4.5s pase lo que pase
  // (1.5s + 3s, sin importar si la tabla ya estaba lista mucho antes).
  // Mismo techo total que antes (4.5s) para no arriesgar nada en una
  // conexión lenta — solo deja de esperar de más cuando no hace falta.
  function esperarTablaLista(t){return new Promise(r=>{const i=Date.now();const id=setInterval(()=>{if(obtenerHtmlTabla().trim().length>0){clearInterval(id);r(true);}else if(Date.now()-i>=t){clearInterval(id);r(false);}},200);});}
  // Incluye el segmento de incidente opcional (/n al final) — sin esto, un
  // incidente (CIV 2425/2026/1) devolvía el mismo nombre que su expediente
  // principal (CIV 2425/2026), y fusionarDuplicadosPorNumero (db.js) los
  // trataba como el mismo expediente: al guardar el incidente en la
  // biblioteca, borraba el principal ya guardado por "duplicado".
  function obtenerNombreExpediente(){const m=document.body.innerText.match(/[A-Z]{2,4}\s?\d+\/\d+(?:\/\d+)?/);return m?m[0].replace(/\//g,'-'):'Expediente';}
  function obtenerCid(){const m=window.location.href.match(/cid=(\d+)/);return m?m[1]:null;}
  function arrayBufferABase64(buffer){
    // chrome.runtime.sendMessage puede corromper ArrayBuffers grandes;
    // los mandamos como base64 (texto) y se reconstruyen en background.js.
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const fin = Math.min(i + chunk, bytes.length);
      const trozo = new Array(fin - i);
      for (let j = i; j < fin; j++) trozo[j - i] = bytes[j];
      binary += String.fromCharCode.apply(null, trozo);
    }
    return btoa(binary);
  }
  function obtenerCaratula(){
    // Best-effort: el SCW no siempre expone la carátula con un selector fijo,
    // así que buscamos el patrón de texto típico "Carátula: ..." en la página.
    const texto = document.body.innerText || '';
    const m = texto.match(/Car[aá]tula\s*:?\s*(.+)/i);
    if (m && m[1]) return m[1].split('\n')[0].trim().slice(0, 160);
    return '';
  }
  function extraerTexto(fila,sel){const el=fila.querySelector(sel);return el?el.innerText.trim():'';}
  function sanitizar(texto){return texto.replace(/[/\\?%*:|"<>]/g,' ').replace(/\s+/g,' ').trim();}
  // Registro técnico local (ver src/lib/registro.js). El content script no
  // puede importar módulos: lo manda al service worker, que lo guarda.
  function registrarIC(nivel, mensaje, datos){
    try { chrome.runtime.sendMessage({ action: 'registrarEvento', evento: { nivel, origen: 'scw', mensaje, datos } }, () => void chrome.runtime.lastError); } catch (_) {}
  }
  function leftPad(n,w){let s=String(n);while(s.length<w)s='0'+s;return s;}
  function esperar(ms){return new Promise(r=>setTimeout(r,ms));}

  // ─── Búsqueda en la Consulta Pública (home.seam) ──────────────────────────
  // Selectores confirmados contra el HTML real de home.seam por el Portable
  // (src/scw/buscarExpediente.js). El value del <select> es un código
  // numérico (0=CSJ, 1=CIV, ...), no la sigla.
  //
  // Un cid= en la URL NO alcanza para dar por encontrado el expediente: el
  // SCW agrega cid= a casi todas sus páginas, incluida home.seam. Igual que
  // en el Portable, se confirma por contenido: "Carátula" en el texto o la
  // tabla de actuaciones presente.
  function estadoPaginaSCW() {
    const texto = (document.body && document.body.innerText) || '';
    const enHome = !!document.querySelector('input[name="formPublica:buscarPorNumeroButton"]');
    // Antes exigía además "Carátula" en el texto o la tabla de
    // actuaciones presente — visto contra el sitio real: el SCW navega
    // bien al expediente tecleado, pero esa condición extra se queda en
    // false (el texto o la tabla tardan en aparecer, o no calzan exacto)
    // y la extensión espera algo que ya pasó, sin límite. La URL de
    // expediente.seam con un cid numérico alcanza — ese patrón no se da
    // en ningún otro lugar del sitio (a diferencia de home.seam, que sí
    // puede traer un cid propio de sesión).
    const esExpediente = /\/expediente\.seam$/.test(location.pathname) && !!obtenerCid();
    const linksResultados = enHome || esExpediente ? 0 :
      document.querySelectorAll('a[href*="expediente.seam?cid="]').length;
    // Mensajes que el SCW muestra en la propia página (p. ej. "no se
    // encontraron resultados"): PrimeFaces/RichFaces los pone en estos
    // contenedores. Se devuelven tal cual para mostrarlos al operador.
    const mensajes = Array.from(document.querySelectorAll('.ui-messages, .ui-message, .rf-msgs, .rf-msg, .alert, .error'))
      .map(el => (el.innerText || '').trim()).filter(Boolean).join(' · ').slice(0, 300);
    return {
      ok: true, url: location.href, cid: obtenerCid(), enHome, esExpediente, linksResultados, mensajes,
      caratula: esExpediente ? (obtenerCaratula() || '') : '',
      textoInicio: texto.replace(/\s+/g, ' ').slice(0, 300),
    };
  }

  async function completarFormularioBusquedaDOM(valorJurisdiccion, numero, anio) {
    const sel = document.querySelector('select[name="formPublica:camaraNumAni"]');
    const inpNumero = document.querySelector('input[name="formPublica:numero"]');
    const inpAnio = document.querySelector('input[name="formPublica:anio"]');
    const boton = document.querySelector('input[name="formPublica:buscarPorNumeroButton"]');
    if (!sel || !inpNumero || !inpAnio || !boton) {
      throw new Error('No se encontró el formulario de Consulta Pública (¿cambió el HTML de home.seam?).');
    }
    sel.value = String(valorJurisdiccion);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // 150ms no alcanzaba: si el <select> dispara un postback AJAX propio
    // (típico en formularios JSF — el value=camaraNumAni sugiere que puede
    // recalcular algo dependiente de la jurisdicción), un humano tarda
    // naturalmente más que eso en escribir número y año, dándole tiempo a
    // terminar. Automatizado, 150ms no le dejaba margen: se probó contra
    // un simulador que nunca tuvo ese comportamiento, así que nunca se
    // hubiera detectado ahí.
    await esperar(1200);
    inpNumero.value = String(numero);
    inpNumero.dispatchEvent(new Event('input', { bubbles: true }));
    inpAnio.value = String(anio);
    inpAnio.dispatchEvent(new Event('input', { bubbles: true }));
    // Mismo margen antes de tocar "Consultar": si escribir el número o el
    // año también dispara algo (menos probable, pero barato de cubrir).
    await esperar(500);
    // El botón dispara jsf.util.chain(...) → mojarra.jsfcljs(...), un submit
    // real de formulario: se ejecuta su onclick en el mundo de la página
    // (mismo mecanismo que la paginación de históricas).
    const onclick = boton.getAttribute('onclick') || '';
    if (onclick) await ejecutarEnPaginaViaBg(onclick);
    else dispararClickReal(boton);
  }

  // ─── Vinculados / incidentes ────────────────────────────────────────────
  // Portado de vinculados.js del Portable (versión Playwright, probada
  // contra el SCW real; "playwright-reference" en el paquete fusionado
  // resultó ser una copia literal, nunca se portó a DOM de verdad).
  // Selectores verificados por el Portable sobre el HTML real de la solapa
  // abierta — no confirmados de nuevo acá.
  const SELECTOR_TABLA_VINCULADOS = '#expediente\\:connectedTable';
  const SELECTOR_CONTENIDO_VINCULADOS = '#expediente\\:vinculadosTab';

  // Normaliza "CIV 013719/2023/1" y "CIV 13719/2023/1" a la misma clave.
  function claveExpediente(texto) {
    const m = (texto || '').match(/([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/i);
    if (!m) return null;
    return m[1].toUpperCase() + '|' + Number(m[2]) + '|' + m[3] + '|' + Number(m[4]);
  }
  function contieneClave(texto, clave) {
    const re = /([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/gi;
    let m;
    while ((m = re.exec(texto || '')) !== null) {
      if (m[1].toUpperCase() + '|' + Number(m[2]) + '|' + m[3] + '|' + Number(m[4]) === clave) return true;
    }
    return false;
  }

  function abrirSolapaVinculados() {
    // RichFaces engancha el manejador por JS, no por atributo onclick — clic
    // real (mousedown/up/click), no ejecutar código.
    const etiquetas = Array.from(document.querySelectorAll('.rf-tab-lbl'))
      .filter(el => (el.textContent || '').trim() === 'Vinculados');
    for (const el of etiquetas) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { dispararClickReal(el); return true; }
    }
    return false;
  }

  // Diagnóstico real (consola del operador, v1.18.6): la tabla SÍ aparece
  // y SÍ tiene 1 fila (tablaPresente=true, filasEnTabla=1) pero esta
  // función nunca la reconocía como vinculado válido — se quedaba
  // esperando hasta darse por vencida con estado 'sin-vinculados', pese a
  // haber una fila real. La sospecha, sin poder confirmarla contra el
  // HTML real: la primera celda de la fila no es el número de expediente
  // (puede ser un ícono, un checkbox de selección, o quedar vacía por
  // alguna otra razón), y/o la fila usa <th> en vez de <td> para alguna
  // celda. Antes esto exigía el número de expediente en la celda 0
  // exactamente; ahora se busca en cualquier celda de la fila (td o th),
  // igual que ya no importaba en qué celda estuviera para claveExpediente
  // más abajo.
  function leerFilasVinculados() {
    const tabla = document.querySelector(SELECTOR_TABLA_VINCULADOS);
    const filas = tabla ? Array.from(tabla.querySelectorAll('tbody tr')) : [];
    const salida = [];
    for (const fila of filas) {
      const celdas = Array.from(fila.querySelectorAll('td, th')).map(c => (c.innerText || '').trim());
      if (!celdas.length) continue;
      const idx = celdas.findIndex(c => /\d+\/\d{4}\/\d+/.test(c));
      if (idx === -1) continue;
      const expediente = celdas[idx].replace(/\s+/g, ' ').trim();
      salida.push({
        expediente, dependencia: celdas[idx + 1] || '', situacion: celdas[idx + 2] || '',
        caratula: celdas[idx + 3] || '', ultimaActuacion: celdas[idx + 4] || '',
      });
    }
    return salida;
  }

  // { vinculados: [...], estado: 'ok'|'sin-vinculados'|'no-disponible' }
  // Si esta solapa ya se había abierto antes en la vida de esta misma
  // página (p. ej. se leyó una vez durante la búsqueda, y ahora se vuelve
  // a pedir al tocar "Abrir" en un vinculado), un solo clic puede no
  // disparar una recarga nueva por AJAX — RichFaces a veces no reacciona
  // a un clic sobre una solapa que ya considera "visitada", aunque su
  // contenido ya no esté en el DOM. Por eso, si no aparecen filas en un
  // primer tramo de espera, se reintenta con un segundo clic antes de
  // darse por vencido — no cuesta nada si ya andaba bien de una, y
  // resuelve el caso en que no.
  // Diagnóstico (no cambia el resultado, solo lo que se ve en la consola):
  // este mecanismo salió mal en la práctica (v1.18.5) y no se pudo
  // reproducir en esta sesión sin un Chrome real — si vuelve a fallar,
  // este log en consola es lo que hace falta pegar para poder seguir.
  function diagnosticoVinculados(etapa) {
    try {
      const tabla = document.querySelector(SELECTOR_TABLA_VINCULADOS);
      const filas = tabla ? Array.from(tabla.querySelectorAll('tbody tr')) : [];
      console.warn('[Infocivil vinculados] ' + etapa + ' — solapaEncontrada=' +
        (Array.from(document.querySelectorAll('.rf-tab-lbl')).some(el => (el.textContent || '').trim() === 'Vinculados')) +
        ', contenidoAjaxPresente=' + !!document.querySelector(SELECTOR_CONTENIDO_VINCULADOS) +
        ', tablaPresente=' + !!tabla +
        ', filasEnTabla=' + filas.length +
        // Si vuelve a fallar tras el fix de v1.18.8, esto muestra el texto
        // real de cada celda de la primera fila — lo que hace falta para
        // seguir si la sospecha (número en otra celda / <th>) no alcanzó.
        (filas.length ? ', primeraFila=' + JSON.stringify(Array.from(filas[0].querySelectorAll('td, th')).map(c => (c.innerText || '').trim())) : ''));
    } catch (e) { /* nunca romper el flujo real por un log */ }
  }

  async function leerVinculadosDOM() {
    if (!abrirSolapaVinculados()) return { vinculados: [], estado: 'no-disponible' };

    // El contenido llega por AJAX recién al abrir la solapa.
    const inicioEspera = Date.now();
    while (!document.querySelector(SELECTOR_CONTENIDO_VINCULADOS) && Date.now() - inicioEspera < 12000) {
      await esperar(300);
    }

    async function esperarFilas(tope) {
      const inicio = Date.now();
      while (Date.now() - inicio < tope) {
        const filas = leerFilasVinculados();
        if (filas.length) return { vinculados: filas, estado: 'ok' };
        const texto = (document.body && document.body.innerText) || '';
        if (/total de 0 vinculado/i.test(texto) || /no se (han )?encontr/i.test(texto)) {
          diagnosticoVinculados('esperarFilas: mensaje "sin vinculados" detectado en el texto de la página');
          return { vinculados: [], estado: 'sin-vinculados' };
        }
        await esperar(400);
      }
      diagnosticoVinculados('esperarFilas: se acabó el tiempo de espera (' + tope + 'ms) sin filas ni mensaje de "sin vinculados"');
      return null; // ni filas ni mensaje de "sin vinculados" — inconcluso, no se sabe todavía
    }

    let resultado = await esperarFilas(7000);
    if (resultado) return resultado;

    // Inconcluso tras 7s: puede que el primer clic no haya disparado
    // nada nuevo — reintenta con un segundo clic y espera lo que queda.
    abrirSolapaVinculados();
    resultado = await esperarFilas(10000);
    if (!resultado) diagnosticoVinculados('segundo clic también inconcluso: se da por vencido');
    return resultado || { vinculados: [], estado: 'sin-vinculados' };
  }

  // { cid: '...' } — expediente: ej. 'CIV 013719/2023/1' (los ceros no importan).
  async function abrirVinculadoDOM(expediente) {
    const clave = claveExpediente(expediente);
    if (!clave) throw new Error('No se entiende el expediente "' + expediente + '".');

    // ¿La página YA es ese expediente? Pasa cuando un pedido anterior hizo
    // el clic y navegó, pero su respuesta se perdió con la navegación, y el
    // fondo reintenta: antes buscaba el vinculado en la lista del propio
    // vinculado, no lo encontraba y avisaba "No se encontró … en la lista"
    // aunque el incidente sí se había abierto.
    const propio = ((document.body && document.body.innerText) || '')
      .match(/Expediente:\s*([A-Z]{2,4}\s?\d+\/\d{4}(?:\/\d+)?)/);
    const cidActual = obtenerCid();
    if (propio && cidActual && claveExpediente(propio[1]) === clave) return { cid: cidActual };

    // La solapa puede no estar abierta: si esta pestaña navegó de vuelta
    // desde actuacionesHistoricas.seam después de haberla leído la primera
    // vez (para leer históricas, por ejemplo), la vuelta recarga la
    // página entera y la borra — no alcanza con haberla abierto una vez
    // antes en la vida de esta pestaña.
    if (!document.querySelector(SELECTOR_TABLA_VINCULADOS + ' tbody tr')) {
      const leido = await leerVinculadosDOM();
      if (leido.estado !== 'ok') {
        throw new Error('No se encontró el vinculado ' + expediente +
          ' (no se pudo abrir la solapa "Vinculados": ' + leido.estado + ').');
      }
    }

    const filas = Array.from(document.querySelectorAll(SELECTOR_TABLA_VINCULADOS + ' tbody tr'));
    let objetivo = null;
    for (const fila of filas) {
      if (claveExpediente(fila.innerText) === clave) { objetivo = fila; break; }
    }
    if (!objetivo) throw new Error('No se encontró el vinculado ' + expediente + ' en la lista.');

    const boton = objetivo.querySelector('a.btn, a[onclick]');
    if (!boton) throw new Error('No se encontró el botón para abrir ' + expediente + '.');

    // Clic real no alcanza: el onclick hace un submit de formulario JSF
    // (mojarra.jsfcljs) — se ejecuta ese código en la página, mismo
    // mecanismo que el botón "Consultar" de home.seam.
    const urlAntes = location.href;
    const onclick = boton.getAttribute('onclick') || '';
    if (onclick) await ejecutarEnPaginaViaBg(onclick);
    else dispararClickReal(boton);

    const inicio = Date.now();
    while (Date.now() - inicio < 25000) {
      const m = location.href.match(/cid=(\d+)/);
      const texto = (document.body && document.body.innerText) || '';
      if (m && texto.length > 200 && contieneClave(texto, clave)) return { cid: m[1] };
      await esperar(400);
    }
    throw new Error('No se pudo abrir ' + expediente + ': el sitio no terminó de cargarlo' +
      (location.href === urlAntes ? ' (la página no cambió).' : '.'));
  }

  // Página intermedia de resultados (sin confirmar si el SCW la muestra
  // cuando hay un único resultado): se abre el primer expediente.
  function tomarPrimerResultadoBusquedaDOM() {
    const links = Array.from(document.querySelectorAll('a[href*="expediente.seam?cid="]'));
    if (!links.length) return { ok: false, error: 'No hay resultados en esta página.' };
    const link = links[0];
    const href = link.getAttribute('href') || '';
    const onclick = link.getAttribute('onclick') || '';
    if (onclick) ejecutarEnPaginaViaBg(onclick);
    else if (href && href !== '#') location.href = href.indexOf('http') === 0 ? href : 'https://scw.pjn.gov.ar' + href;
    else dispararClickReal(link);
    return { ok: true, multiplesResultados: links.length > 1 };
  }

  // ─── ZIP builder ──────────────────────────────────────────────────────────
  function buildZip(files){
    const lp=[],cd=[];let off=0;
    const now=new Date();
    const dt=((now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1))>>>0;
    const dd=((((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate()))>>>0;
    for(const f of files){
      const nb=new TextEncoder().encode(f.name),crc=crc32(f.data),sz=f.data.length;
      const lh=new Uint8Array(30+nb.length);const lv=new DataView(lh.buffer);
      lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0,true);lv.setUint16(8,0,true);
      lv.setUint16(10,dt,true);lv.setUint16(12,dd,true);lv.setUint32(14,crc,true);
      lv.setUint32(18,sz,true);lv.setUint32(22,sz,true);lv.setUint16(26,nb.length,true);lv.setUint16(28,0,true);
      lh.set(nb,30);lp.push(lh,f.data);
      const ce=new Uint8Array(46+nb.length);const cv=new DataView(ce.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0,true);
      cv.setUint16(10,0,true);cv.setUint16(12,dt,true);cv.setUint16(14,dd,true);cv.setUint32(16,crc,true);
      cv.setUint32(20,sz,true);cv.setUint32(24,sz,true);cv.setUint16(28,nb.length,true);
      cv.setUint16(30,0,true);cv.setUint16(32,0,true);cv.setUint16(34,0,true);cv.setUint16(36,0,true);
      cv.setUint32(38,0,true);cv.setUint32(42,off,true);ce.set(nb,46);
      cd.push(ce);off+=lh.length+sz;
    }
    const cds=cd.reduce((s,c)=>s+c.length,0);
    const eo=new Uint8Array(22);const ev=new DataView(eo.buffer);
    ev.setUint32(0,0x06054b50,true);ev.setUint16(4,0,true);ev.setUint16(6,0,true);
    ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);
    ev.setUint32(12,cds,true);ev.setUint32(16,off,true);ev.setUint16(20,0,true);
    return new Blob([...lp,...cd,eo],{type:'application/zip'});
  }
  function crc32(d){
    if(!crc32.t){crc32.t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);crc32.t[i]=c;}}
    let c=0xFFFFFFFF;for(let i=0;i<d.length;i++)c=crc32.t[(c^d[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;
  }

  // ─── Auto-scraping en página de históricas ────────────────────────────────
  // Cuando el background abre este tab, el content script corre automáticamente
  // y guarda los resultados en storage (evita el timeout del canal de mensajes).
  if (window.location.href.includes('actuacionesHistoricas')) {
    (async () => {
      try {
        console.log('[PJN] Auto-scraping históricas...');
        const t0 = Date.now();

        const archivos = await scrapeHistoricasDOMDirecto();
        // Diagnóstico (queda en la pantalla de Diagnóstico de la extensión).
        try {
          const filas = Array.from(document.querySelectorAll('tbody tr'));
          registrarIC(archivos.length ? 'info' : 'aviso', 'Históricas leídas en el SCW', {
            documentos: archivos.length, filas: filas.length,
            filasConBotones: filas.filter(f => f.querySelector('a, button')).length,
            linksViewer: document.querySelectorAll("tbody a[href*='viewer']").length,
            segundos: Math.round((Date.now() - t0) / 1000),
            visible: document.visibilityState, cid: (location.href.match(/cid=(\d+)/) || [])[1] || null,
          });
        } catch (_) {}
        const archivosHist = archivos.map(a => ({ ...a, esHistorica: true }));

        // Obtener cid de la URL — en históricas puede no estar como parámetro
        // sino embebido en el link "Volver al expediente"
        let cid = '0';
        const cidUrl = window.location.href.match(/cid=(\d+)/);
        if (cidUrl) {
          cid = cidUrl[1];
        } else {
          // Buscar en el link "Volver al expediente"
          const linkVolver = Array.from(document.querySelectorAll('a')).find(a =>
            (a.textContent || '').toLowerCase().includes('volver') &&
            (a.getAttribute('href') || '').includes('cid=')
          );
          if (linkVolver) {
            const m = (linkVolver.getAttribute('href') || '').match(/cid=(\d+)/);
            if (m) cid = m[1];
          }
          // Fallback: buscar en cualquier link del DOM
          if (cid === '0') {
            const anyLink = Array.from(document.querySelectorAll('a[href*="cid="]'))
              .find(a => (a.getAttribute('href') || '').match(/cid=\d+/));
            if (anyLink) {
              const m = (anyLink.getAttribute('href') || '').match(/cid=(\d+)/);
              if (m) cid = m[1];
            }
          }
        }

        console.log('[PJN] Guardando', archivosHist.length, 'históricas para cid=' + cid);
        const storageData = {};
        storageData['pjnHistoricas_' + cid] = archivosHist;
        // Con sesión iniciada, el SCW puede darle a esta página un cid
        // distinto del expediente (conversación de Seam nueva, visto contra
        // el sitio real: expediente cid=358872, históricas cid=366097). Se
        // deja también la última lectura con su número de expediente, para
        // que el fondo la tome aunque los cid no coincidan.
        storageData.pjnHistoricasUltimo = { cid, numero: obtenerNombreExpediente(), archivos: archivosHist, ts: Date.now() };
        chrome.storage.local.set(storageData);
      } catch (e) {
        console.error('[PJN] Error auto-scraping históricas:', e);
        chrome.storage.local.set({ pjnHistoricasResult: { ok: false, error: e.message } });
      }
    })();
  }

})();
