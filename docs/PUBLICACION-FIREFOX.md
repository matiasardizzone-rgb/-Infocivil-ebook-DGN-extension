# Publicación en Firefox (AMO, no listada) — Infocivil Ebook DGN

Igual que Infocivil Ebook: se firma en addons.mozilla.org como **no listada**
("On your own") para obtener el `.xpi` firmado, que se distribuye por enlace
o desde cncivil03.

## 1. Paquete

```powershell
.\tools\empaquetar.ps1 -Destino firefox
```

Genera `..\paquetes\infocivil-ebook-dgn-<versión>-firefox.zip` con el manifest
adaptado:

- `background.scripts` (Firefox no usa `service_worker`).
- `browser_specific_settings.gecko`: id `infocivil-ebook-dgn@sytec.pjn.gov.ar`
  (no cambiarlo nunca: las actualizaciones dependen de él), `strict_min_version`
  115.0 (ESR de Windows 7) y `data_collection_permissions: none`.
- Sin `externally_connectable` ni `minimum_chrome_version`.

`web-ext lint`: 0 errores. Las advertencias (eval/Function en pdf.js y forge,
innerHTML con contenido propio, script en línea en lector.html) son las mismas
que ya aceptó la versión de Infocivil Ebook.

## 2. Envío

https://addons.mozilla.org/developers/addon/submit/distribution →
**On your own** → subir el ZIP → plataforma: Firefox (escritorio).

Si pide **código fuente** por el código minificado: son bibliotecas de
terceros sin modificar, indicar las versiones de `vendor/LICENCIAS.md`:

- PDF.js 3.11.174 — https://github.com/mozilla/pdf.js/releases/tag/v3.11.174
- pdf-lib 1.17.1 — https://github.com/Hopding/pdf-lib/releases/tag/v1.17.1
- node-forge — https://github.com/digitalbazaar/forge

**Notas para el revisor:** el mismo texto de `PUBLICACION-CHROME.md`, sección 5.

## 3. Después de firmar

- Descargar el `.xpi` firmado.
- Instalación: arrastrarlo a Firefox, o abrir `about:addons` → engranaje →
  *Instalar complemento desde archivo*.
- Firefox 115 no concede el acceso a `scw.pjn.gov.ar` al instalar: el popup y
  la pantalla de inicio muestran "Autorizar acceso" (`permiso-scw.js`).
