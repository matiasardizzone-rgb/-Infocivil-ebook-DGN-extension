document.addEventListener('DOMContentLoaded', function () {
  var estado       = document.getElementById('estado');
  var btnLibro     = document.getElementById('btnLibro');
  var btnDescargar = document.getElementById('btnDescargar');
  var btnUnificado = document.getElementById('btnUnificado');
  var btnGuardar   = document.getElementById('btnGuardar');
  var btnBiblioteca= document.getElementById('btnBiblioteca');
  var cambiosBox   = document.getElementById('cambiosBox');
  var pollingInterval = null;
  var pollingUnificado = null;

  // Consulta sin pasar por el SCW: pantalla de inicio de la extensión.
  // Reusa una pestaña ya abierta (recargada, formulario limpio) en vez de
  // apilar una nueva cada vez.
  function irAConsultar() {
    var url = chrome.runtime.getURL('src/public/inicio.html');
    // Se filtra a mano: los patrones de chrome.tabs.query({ url }) no
    // admiten el esquema chrome-extension:// y nunca encontraban nada.
    chrome.tabs.query({}, function (todas) {
      var existentes = (todas || []).filter(function (t) { return t.url && t.url.indexOf(url) === 0; });
      if (existentes.length) {
        chrome.tabs.update(existentes[0].id, { url: url, active: true });
        chrome.windows.update(existentes[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: url });
      }
      window.close();
    });
  }
  document.getElementById('btnConsultar').addEventListener('click', irAConsultar);

  document.getElementById('linkDiagnostico').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/public/diagnostico.html') });
  });

  btnBiblioteca.addEventListener('click', function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/public/biblioteca.html') });
  });

  function fechaCorta(iso) {
    if (!iso) return '?';
    try { return new Date(iso).toLocaleDateString('es-AR'); } catch (e) { return iso; }
  }

  function mostrarEstadoBiblioteca(cid) {
    chrome.runtime.sendMessage({ action: 'bibliotecaListar' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.ok) return;
      var registro = (r.expedientes || []).find(function (e) { return e.cid === cid; });
      if (!registro) return;

      cambiosBox.style.display = 'block';
      if (registro.estado === 'nuevo') {
        cambiosBox.innerHTML =
          '📚 En biblioteca · ' + textoNovedades(registro.nuevasDetectadas, registro.eliminadasDetectadas || 0) + ' ' +
          '(última verificación: ' + fechaCorta(registro.fechaVerificacion) + ')<br>' +
          '<button id="btnActualizarBib">💾 Actualizar biblioteca</button> ' +
          '<button id="btnVerificar" style="background:#fff;color:#8a6000;margin-top:6px">🔍 Verificar de nuevo</button>';
      } else {
        cambiosBox.innerHTML =
          '📚 En biblioteca · ✅ al día (' + registro.cantidadActuaciones + ' actuaciones, guardado ' + fechaCorta(registro.fechaDescarga) + ')<br>' +
          '<button id="btnVerificar" style="background:#fff;color:#8a6000">🔍 Verificar cambios</button>';
      }
      var bA = document.getElementById('btnActualizarBib');
      if (bA) bA.addEventListener('click', function () { ejecutarAccion('guardarEnBiblioteca'); });
      var bV = document.getElementById('btnVerificar');
      if (bV) bV.addEventListener('click', function () { ejecutarAccion('verificarCambios'); });
    });
  }

  // Resumen de novedades (nuevas y las que el SCW ya no muestra).
  function textoNovedades(nuevas, eliminadas) {
    var partes = [];
    if (nuevas > 0) partes.push('🔴 ' + nuevas + (nuevas === 1 ? ' actuación nueva' : ' actuaciones nuevas'));
    if (eliminadas > 0) partes.push('⚠️ ' + eliminadas + (eliminadas === 1 ? ' ya no figura' : ' ya no figuran') + ' en el SCW');
    return partes.join(' · ');
  }

  function mostrarResultadoVerificacion(r) {
    if (!r || !r.ok) {
      cambiosBox.style.display = 'block';
      cambiosBox.textContent = '❌ No se pudo verificar contra la biblioteca.';
      return;
    }
    if (r.noGuardado) { cambiosBox.style.display = 'none'; return; }
    cambiosBox.style.display = 'block';
    if (r.cambio) {
      cambiosBox.innerHTML =
        textoNovedades(r.nuevasDetectadas, r.eliminadasDetectadas || 0) + '.<br>' +
        '<button id="btnActualizarBib">💾 Actualizar biblioteca</button>';
      document.getElementById('btnActualizarBib').addEventListener('click', function () { ejecutarAccion('guardarEnBiblioteca'); });
    } else {
      cambiosBox.textContent = '✅ Al día — sin actuaciones nuevas desde la última descarga.';
    }
  }

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab  = tabs && tabs[0];
    var url  = tab && tab.url || '';

    if (!url.includes('scw.pjn.gov.ar')) {
      // No hay nada útil que este popup pueda ofrecer acá (no es una
      // página del SCW): en vez de mostrarlo vacío, se salta directo a la
      // pantalla de consulta, reusando la pestaña si ya hay una abierta.
      irAConsultar();
      return;
    }

    if (url.includes('actuacionesHistoricas')) {
      bloquear();
      estado.textContent = '📜 Scrapeando actuaciones históricas...\n\nCuando termine, volvé al expediente con "Volver al expediente" y usá la extensión desde ahí.';
      return;
    }

    if (!url.includes('expediente.seam')) {
      bloquear();
      estado.textContent = '⚠️ Abrí un expediente en el SCW para usar esta extensión.';
      return;
    }

    var cidMatch = url.match(/cid=(\d+)/);
    var cid = cidMatch ? cidMatch[1] : null;
    var keysToGet = ['descargaProgreso', 'pjnFindPdfsPendiente', 'pjnFindPdfsResult'];
    if (cid) keysToGet.push('pjnHistoricas_' + cid);

    chrome.storage.local.get(keysToGet, function (data) {

      // Caso 1: resultado de findPdfs listo para procesar
      if (data.pjnFindPdfsResult && data.pjnFindPdfsPendiente) {
        bloquear();
        estado.textContent = '🔍 Detectando documentos...';
        var pendiente = data.pjnFindPdfsPendiente;
        chrome.storage.local.remove(['pjnFindPdfsResult', 'pjnFindPdfsPendiente'], function() {
          procesarResultadoFindPdfs(data.pjnFindPdfsResult, pendiente.tabId, pendiente.accion);
        });
        return;
      }

      // Caso 2: findPdfs en curso
      if (data.pjnFindPdfsPendiente) {
        bloquear();
        estado.textContent = '🔍 Detectando documentos...';
        var pendiente = data.pjnFindPdfsPendiente;
        iniciarPollingFindPdfs(pendiente.tabId, pendiente.accion);
        return;
      }

      // Caso 3: descarga en curso
      if (data.descargaProgreso && !data.descargaProgreso.terminado) {
        bloquear();
        mostrarProgreso(data.descargaProgreso);
        iniciarPollingProgreso();
        return;
      }

      // Mostrar info de históricas guardadas para este expediente
      if (cid && data['pjnHistoricas_' + cid] && data['pjnHistoricas_' + cid].length > 0) {
        estado.textContent = '📜 Históricas cargadas: ' + data['pjnHistoricas_' + cid].length + ' docs\n✅ Se incluirán al descargar.';
      } else if (cid) {
        estado.textContent = '💡 Este expediente puede tener actuaciones históricas. Para incluirlas, navegá primero a la sección "Actuaciones históricas" del expediente y luego volvé acá.';
      }

      if (cid) mostrarEstadoBiblioteca(cid);
    });
  });

  btnLibro.addEventListener('click', function () {
    // Guarda en biblioteca (mismo camino confiable que 'Guardar en
    // biblioteca' y el PDF unificado: sobre la pestaña ya abierta, sin
    // automatizar nada del SCW) y abre el lector real de páginas.
    ejecutarAccion('guardarEnBiblioteca', true);
  });

  btnDescargar.addEventListener('click', function () {
    ejecutarAccion('crearYDescargarZip');
  });

  btnGuardar.addEventListener('click', function () {
    ejecutarAccion('guardarEnBiblioteca');
  });

  btnUnificado.addEventListener('click', function () {
    bloquear();
    estado.textContent = '🔍 Detectando actuaciones...';

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) { mostrarError('No se encontró la pestaña activa.'); desbloquear(); return; }

      chrome.tabs.sendMessage(tab.id, { action: 'obtenerActuaciones' }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          mostrarError((resp && resp.error) || 'No se pudieron detectar las actuaciones.');
          desbloquear();
          return;
        }
        var actuaciones = resp.actuaciones || resp.archivos || [];
        if (!actuaciones.length) {
          mostrarError('No se encontraron actuaciones para unificar.');
          desbloquear();
          return;
        }

        if (resp.historicasFaltantes) {
          var seguir = confirm(
            '⚠️ No se detectaron actuaciones históricas cargadas para este expediente.\n\n' +
            'Si este expediente tiene actuaciones anteriores a la fecha en que empezó a operar el sistema actual (por ejemplo la demanda inicial), el PDF unificado va a arrancar más adelante en el tiempo, sin ellas.\n\n' +
            'Para incluirlas: cancelá, andá a la sección "Actuaciones históricas" del expediente, esperá a que cargue la tabla, volvé al expediente y probá de nuevo.\n\n' +
            '¿Continuar igual, sin las históricas?'
          );
          if (!seguir) { desbloquear(); estado.textContent = ''; return; }
        }

        if (resp.paginacionIncompleta) {
          var seguir2 = confirm(
            '⚠️ El recorrido de páginas de actuaciones se cortó antes de tiempo (demoró más de lo esperado en alguna página).\n\n' +
            'Es posible que falten actuaciones más viejas, incluida la primera (la demanda). Podés reintentar — a veces es solo una demora puntual del sistema — o continuar igual con lo que se detectó hasta ahora.\n\n' +
            '¿Continuar igual?'
          );
          if (!seguir2) { desbloquear(); estado.textContent = ''; return; }
        }

        continuarUnificado(actuaciones, resp);
      });
    });
  });

  function continuarUnificado(actuaciones, resp) {
    estado.textContent = '⏳ Descargando ' + actuaciones.length + ' actuaciones y armando el PDF unificado...\n(esto puede tardar según el tamaño del expediente)';
    iniciarPollingUnificado();

    chrome.runtime.sendMessage({
      action: 'descargarExpedienteUnificado',
      actuaciones: actuaciones,
      tituloExpediente: resp.tituloExpediente || resp.folderName || 'Expediente',
      historicasFaltantes: !!resp.historicasFaltantes,
      paginacionIncompleta: !!resp.paginacionIncompleta
    }, function (r) {
      detenerPollingUnificado();
      desbloquear();
      if (chrome.runtime.lastError || !r || !r.ok) {
        mostrarError((r && r.error) || 'No se pudo generar el PDF unificado.');
        return;
      }
      estado.textContent = '✅ PDF unificado listo (' + r.descargados + '/' + r.total + ' actuaciones incorporadas' +
        (r.errores > 0 ? ', ' + r.errores + ' con página de error' : '') + ').\nSe abrió el diálogo para guardarlo.';
    });
  }

  function iniciarPollingUnificado() {
    if (pollingUnificado) return;
    pollingUnificado = setInterval(function () {
      chrome.storage.local.get(['unificadoProgreso'], function (data) {
        var p = data.unificadoProgreso;
        if (!p) return;
        if (p.error) { estado.textContent = '❌ ' + p.error; return; }
        var pct = p.total > 0 ? Math.round((p.descargados / p.total) * 100) : 0;
        var etapa = p.etapa === 'armando' ? '📎 Armando PDF unificado...' : '⏳ Descargando actuaciones...';
        estado.textContent = etapa + '\n' + p.descargados + ' / ' + p.total + ' (' + pct + '%)' +
          (p.errores > 0 ? '\n⚠️ Con error hasta ahora: ' + p.errores : '');
      });
    }, 800);
  }
  function detenerPollingUnificado() {
    if (pollingUnificado) { clearInterval(pollingUnificado); pollingUnificado = null; }
    chrome.storage.local.remove(['unificadoProgreso']);
  }

  function ejecutarAccion(accion, abrirLibroAlTerminar) {
    bloquear();
    estado.textContent = accion === 'verificarCambios'
      ? '🔍 Comparando con la biblioteca...'
      : (accion === 'guardarEnBiblioteca' ? '🔍 Detectando documentos para guardar...' : '🔍 Detectando documentos...');

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) { mostrarError('No se encontró la pestaña activa.'); desbloquear(); return; }

      var tabIdOriginal = tab.id;
      var cidMatch = (tab.url || '').match(/cid=(\d+)/);
      var cid = cidMatch ? cidMatch[1] : null;

      chrome.storage.local.remove(['pjnFindPdfsResult'], function() {
        chrome.storage.local.set({ pjnFindPdfsPendiente: { tabId: tabIdOriginal, accion: accion, cid: cid } });

        chrome.tabs.sendMessage(tabIdOriginal, { action: 'findPdfs' }, function(resp) {
          if (chrome.runtime.lastError) return;
          if (resp && resp.ok) {
            chrome.storage.local.set({ pjnFindPdfsResult: resp });
          }
        });

        iniciarPollingFindPdfs(tabIdOriginal, accion, cid, abrirLibroAlTerminar);
      });
    });
  }

  function iniciarPollingFindPdfs(tabIdOriginal, accion, cid, abrirLibroAlTerminar) {
    var intentos = 90;
    var interval = setInterval(function() {
      chrome.storage.local.get(['pjnFindPdfsResult'], function(data) {
        if (data.pjnFindPdfsResult) {
          clearInterval(interval);
          chrome.storage.local.remove(['pjnFindPdfsResult', 'pjnFindPdfsPendiente']);
          procesarResultadoFindPdfs(data.pjnFindPdfsResult, tabIdOriginal, accion, cid, abrirLibroAlTerminar);
        } else if (--intentos <= 0) {
          clearInterval(interval);
          chrome.storage.local.remove(['pjnFindPdfsPendiente']);
          mostrarError('Tiempo de espera agotado.');
          desbloquear();
        }
      });
    }, 1000);
  }

  function procesarResultadoFindPdfs(resp, tabIdOriginal, accion, cid, abrirLibroAlTerminar) {
    if (!resp || !resp.ok) {
      mostrarError((resp && resp.error) || 'Error al detectar.');
      desbloquear();
      return;
    }

    var archivos   = resp.archivos;
    var folderName = resp.folderName;

    if (!archivos || !archivos.length) {
      mostrarError('No se encontraron documentos descargables.');
      desbloquear();
      return;
    }

    // Verificar cambios no descarga nada: solo compara contra la biblioteca.
    if (accion === 'verificarCambios') {
      estado.textContent = '🔍 Comparando ' + archivos.length + ' documentos con la biblioteca...';
      chrome.runtime.sendMessage({ action: 'bibliotecaVerificarCambios', cid: cid, archivos: archivos }, function (r) {
        desbloquear();
        estado.textContent = '';
        mostrarResultadoVerificacion(r);
      });
      return;
    }

    var nHist = archivos.filter(function(a) { return a.esHistorica; }).length;
    var nAct  = archivos.length - nHist;

    var accionTexto = accion === 'abrirVisor' ? '⏳ Cargando visor...'
      : accion === 'guardarEnBiblioteca' ? '⏳ Guardando en biblioteca...'
      : '⏳ Preparando ZIP...';

    estado.textContent =
      '📋 Encontrados: ' + archivos.length + ' documentos\n' +
      (nHist > 0 ? '📜 Históricas: ' + nHist + '\n' : '') +
      '📄 Actuales: ' + nAct + '\n\n' + accionTexto;

    chrome.storage.local.set({
      descargaProgreso: { total: archivos.length, descargados: 0, errores: 0, terminado: false }
    });

    chrome.tabs.sendMessage(tabIdOriginal, {
      action:     accion,
      archivos:   archivos,
      folderName: folderName,
      startIndex: 1
    });

    iniciarPollingProgreso(abrirLibroAlTerminar && cid);
  }

  function iniciarPollingProgreso(cidParaAbrirLibro) {
    if (pollingInterval) return;
    pollingInterval = setInterval(function () {
      chrome.storage.local.get(['descargaProgreso'], function (data) {
        var p = data.descargaProgreso;
        if (!p) return;
        mostrarProgreso(p);
        if (p.terminado) {
          clearInterval(pollingInterval);
          pollingInterval = null;
          desbloquear();
          chrome.storage.local.remove(['descargaProgreso']);
          if (cidParaAbrirLibro && !p.errores) {
            estado.textContent = '📖 Abriendo el libro...';
            chrome.tabs.create({ url: chrome.runtime.getURL('src/public/biblioteca.html?abrir=' + encodeURIComponent(cidParaAbrirLibro)) });
          }
        }
      });
    }, 800);
  }

  function mostrarProgreso(p) {
    var pct = p.total > 0 ? Math.round((p.descargados / p.total) * 100) : 0;
    estado.textContent =
      (p.terminado ? '✅ Listo\n' : '⏳ Procesando...\n') +
      'Progreso: ' + p.descargados + ' / ' + p.total + ' (' + pct + '%)' +
      (p.errores > 0 ? '\n⚠️ Errores: ' + p.errores : '');
  }

  function mostrarError(msg) {
    estado.textContent = '❌ ' + msg;
    try { chrome.runtime.sendMessage({ action: 'registrarEvento', evento: { nivel: 'error', origen: 'popup', mensaje: msg } }, function () { void chrome.runtime.lastError; }); } catch (_) {}
  }
  function bloquear()   { btnLibro.disabled = true;  btnDescargar.disabled = true;  btnGuardar.disabled = true;  btnUnificado.disabled = true; }
  function desbloquear(){ btnLibro.disabled = false; btnDescargar.disabled = false; btnGuardar.disabled = false; btnUnificado.disabled = false; }
});

// Versión visible en el encabezado (sale del manifest: se actualiza sola en cada release).
document.querySelectorAll('[data-version-ext]').forEach(el => { el.textContent = 'v' + chrome.runtime.getManifest().version; });
