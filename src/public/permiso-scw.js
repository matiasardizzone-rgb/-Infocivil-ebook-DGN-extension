// permiso-scw.js — Script clásico para popup.html e inicio.html.
//
// Firefox con Manifest V3 anterior a la 127 (por ejemplo la ESR 115 de
// Windows 7) NO concede al instalar el permiso de host de scw.pjn.gov.ar:
// sin él ni el content script ni las consultas funcionan. Acá se detecta y
// se muestra un botón para concederlo (permissions.request exige un clic). Al concederlo recarga solo las
// pestañas del SCW abiertas, para que el content script se inyecte sin F5.
// En Chrome/Edge el permiso ya está concedido y este script no muestra nada.

(function () {
  var ORIGENES = ['https://scw.pjn.gov.ar/*'];
  if (!chrome.permissions || !chrome.permissions.contains) return;

  chrome.permissions.contains({ origins: ORIGENES }, function (concedido) {
    if (chrome.runtime.lastError || concedido) return;

    var caja = document.createElement('div');
    caja.style.cssText = 'background:#fff3d1;border:1px solid #e8d080;color:#6b5000;' +
      'padding:10px 12px;font:12px/1.5 "Segoe UI",Arial,sans-serif;margin:8px;border-radius:5px';
    var texto = document.createElement('div');
    texto.textContent = 'Falta autorizar el acceso a scw.pjn.gov.ar. Sin eso la extensión no puede leer los expedientes.';
    var boton = document.createElement('button');
    boton.textContent = 'Autorizar acceso';
    boton.style.cssText = 'margin-top:6px;padding:5px 12px;cursor:pointer;border:none;border-radius:4px;' +
      'background:#8a6000;color:#fff;font-size:12px;font-weight:600;width:auto';
    boton.addEventListener('click', function () {
      chrome.permissions.request({ origins: ORIGENES }, function (ok) {
        if (!ok) {
          texto.textContent = 'No se concedió el permiso. Sin él la extensión no funciona.';
          return;
        }
        boton.remove();
        // Con el permiso recién concedido, las pestañas del SCW que ya estaban
        // abiertas no tienen el content script: se recargan solas (el F5).
        chrome.tabs.query({ url: ORIGENES }, function (pestanas) {
          var lista = pestanas || [];
          lista.forEach(function (t) { chrome.tabs.reload(t.id); });
          texto.textContent = lista.length
            ? 'Listo. Se recargaron ' + lista.length + ' pestaña(s) del SCW. Ya podés usar la extensión.'
            : 'Listo. Ya podés abrir el SCW y usar la extensión.';
        });
      });
    });
    caja.appendChild(texto);
    caja.appendChild(boton);
    document.body.insertBefore(caja, document.body.firstChild);
  });
})();
