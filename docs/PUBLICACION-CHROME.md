# Publicación en Chrome Web Store — Infocivil Ebook DGN

Ítem nuevo, separado de Infocivil Ebook, en la misma cuenta de desarrollador.
Panel: https://chrome.google.com/webstore/devconsole → **Nuevo elemento**.

## 1. Paquete

Subir `infocivil-ebook-dgn-<versión>.zip` (el `manifest.json` va en la raíz,
sin `.git`, `tests` ni `docs`). Para generarlo desde la copia de trabajo:

```powershell
git archive --format=zip -o ..\infocivil-ebook-dgn-0.1.12.zip HEAD -- . ":!tests" ":!docs"
```

El manifest no lleva `"key"`: la Store asigna el id al subir el primer paquete.
Anotar ese id; si más adelante la landing de cncivil03 tiene que detectar
esta extensión (`externally_connectable`), va a hacer falta.

## 2. Ficha de Play Store

**Nombre** (sale del manifest): Infocivil Ebook DGN

**Resumen** (sale del manifest, ≤132): Expedientes vinculados al usuario del
SCW como libro digital: lectura, exportación y anotación. Defensoría General
de la Nación.

**Descripción:**

```
Infocivil Ebook DGN permite a defensores y letrados de la Defensoría General de la Nación leer como libro digital las causas en las que el juzgado los vinculó en el Sistema de Consulta Web (SCW) del Poder Judicial de la Nación.

Cómo funciona
• El usuario inicia sesión en el PJN con su propio usuario. La extensión no ve ni guarda credenciales: trabaja sobre la sesión ya abierta y solo muestra lo que el SCW le habilita.
• Desde la "Lista de Expedientes Relacionados" del SCW, un panel propio lee todas las causas y marca cuáles ya están guardadas, cuáles tienen novedades (según la fecha de última actualización) y cuáles faltan.
• También se puede consultar una causa por jurisdicción, número y año. Si no hay sesión iniciada, abre la página de ingreso del PJN y continúa sola al terminar.

Qué permite hacer
• Leer el expediente como libro, con dos páginas enfrentadas, o en modo continuo; incluye actuaciones actuales e históricas.
• Marcar fojas con banderitas y buscar en el índice.
• Exportar: PDF unificado con portada e índice navegable, PDF unificado simple, ZIP con cada actuación y su firma electrónica intacta, y EPUB. Las exportaciones no incluyen enlaces al SCW.
• Guardar causas en "Mi biblioteca" para leerlas sin conexión y actualizarlas cuando hay novedades.

Privacidad
Todo queda en el navegador del usuario: no hay servidor, analítica ni seguimiento. La extensión no modifica nada en el SCW (no agrega favoritos, no presenta escritos, no deja notas).

Desarrollada por la Oficina de Sistemas y Tecnología (SYTEC) de la Cámara Nacional de Apelaciones en lo Civil.
```

**Categoría:** Productividad (Herramientas). **Idioma:** español.

**Imágenes** (en `docs/store/`):

| Campo | Archivo |
|---|---|
| Ícono de la tienda 128×128 | `icono-128.png` |
| Capturas 1280×800 | `captura-1-consulta.png`, `captura-2-lista.png` (datos inventados) |
| Mosaico promocional pequeño 440×280 | `mosaico-440x280.png` |

## 3. Privacidad

**Propósito único:**

```
Leer, guardar localmente y exportar como libro digital los expedientes del Sistema de Consulta Web del PJN a los que el usuario tiene acceso con su propia sesión.
```

**Justificación de permisos:**

| Permiso | Justificación |
|---|---|
| `activeTab` | Actuar sobre la pestaña del SCW que el usuario tiene abierta cuando usa el botón de la extensión. |
| `tabs` | Abrir el SCW en una pestaña en segundo plano para leer la causa pedida, y detectar por la dirección de la pestaña cuándo el usuario terminó de iniciar sesión en el PJN. |
| `scripting` | Accionar los controles del SCW (paginador, abrir causa, actuaciones históricas), que son formularios JSF que requieren ejecutarse en el contexto de la página. |
| `storage` | Guardar la biblioteca local, el progreso de las descargas y la configuración. |
| `unlimitedStorage` | Los documentos de una causa pueden ocupar cientos de MB y se guardan en el navegador para leerlos sin conexión. |
| `downloads` | Guardar en el equipo los PDF, ZIP y EPUB que el usuario exporta. |
| Permiso de host `scw.pjn.gov.ar` | Único sitio donde opera: leer la lista de expedientes relacionados, las actuaciones y descargar sus documentos con la sesión del usuario. |

**Código remoto:** No, no uso código remoto.

**Uso de datos:** marcar las mismas respuestas que en Infocivil Ebook. La
extensión no transmite datos fuera del equipo. Tildar las tres
certificaciones (no se venden datos, no se usan para fines ajenos al
propósito único, no se usan para evaluar crédito).

**URL de la política de privacidad:** publicar `docs/privacidad-dgn.html` en
el repo de GitHub Pages de la política, junto a la de Infocivil Ebook, y
pegar su URL.

## 4. Distribución

- **Visibilidad:** No listado. Se instala solo con el enlace directo, que se le
  pasa a la DGN.
- **Regiones:** todas, o solo Argentina.

## 5. Instrucciones para el revisor

En **Instrucciones de prueba** (Cuenta → Instrucciones de prueba, o el campo
del envío):

```
La extensión opera solo sobre el Sistema de Consulta Web del Poder Judicial de la Nación (scw.pjn.gov.ar) y requiere un usuario del PJN con causas vinculadas, que no podemos compartir porque da acceso a expedientes judiciales restringidos.

Sin credenciales se puede verificar:
1. Al hacer clic en el ícono se abre la pantalla "Consulta de expediente".
2. Al consultar cualquier número sin sesión iniciada, la extensión abre la página oficial de ingreso del PJN (portalpjn.pjn.gov.ar) y espera; no pide ni lee credenciales.
3. "Mis expedientes" muestra la biblioteca local (vacía al instalar).

La extensión no envía datos a ningún servidor; todo queda en el almacenamiento local del navegador.
```

Si la revisión pide un acceso de prueba, hay que gestionar con el PJN un
usuario de prueba con causas ficticias; no usar un usuario real.

## 6. Después de publicar

- Anotar el id que asignó la Store.
- Para actualizar: subir el número de `version` en el manifest, generar el ZIP
  y subirlo en **Paquete → Subir nueva versión**.
