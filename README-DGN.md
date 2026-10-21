# Infocivil Ebook DGN

Variante de Infocivil Ebook para la Defensoría General de la Nación y, en
general, para cualquier letrado con sesión iniciada en el SCW. Lee las causas
en las que el usuario está vinculado por el juzgado ("Lista de Expedientes
Relacionados") y las guarda en la biblioteca local, con el mismo lector,
exportaciones y banderitas que la versión pública.

Base: Infocivil Ebook 1.21.1. Los cambios están aislados en archivos nuevos
para poder llevarlos de vuelta a la extensión principal.

## Cómo se usa

1. El usuario inicia sesión en el PJN (portal → SSO). La extensión nunca ve
   ni guarda credenciales.
2. En el SCW abre **Mis Expedientes → Lista de Expedientes Relacionados**.
3. Arriba de la tabla aparece el panel **"Infocivil Ebook DGN · Mi
   biblioteca"** → **Leer lista completa**. Recorre todas las páginas y
   marca cada causa como *No guardada*, *Con novedades* o *Al día*.
4. Se seleccionan causas (o **Seleccionar con novedades o sin guardar**) y
   **Guardar seleccionadas**. Se guardan de a una, en una pestaña aparte en
   segundo plano, hasta 25 por tanda.

Se llama "Mi biblioteca" y no "Mis expedientes" porque el SCW ya tiene un
menú con ese nombre (los favoritos de la estrella).

## Consulta desde la pantalla de inicio

En esta variante, "Consulta de expediente" busca primero en la **lista de
relacionados** del usuario (las causas restringidas no aparecen en la
Consulta Pública):

1. Si no hay sesión (se queda en el SSO o el SCW no muestra la lista), abre
   `portalpjn.pjn.gov.ar` para que el usuario inicie sesión y avisa.
2. Si la causa figura, la abre con el ojo de su fila. Un incidente se busca
   como fila propia; si no está, se abre el principal y el incidente por
   Vinculados.
3. Si no figura, prueba la Consulta Pública como último recurso.

Prueba: `node tests/sesion-relacionados.test.mjs ../src/background/consulta.js`.

## Arquitectura

| Pieza | Archivo |
|---|---|
| Lectura de la lista, paginador, apertura por el ojo, panel | `src/content/relacionados-content.js` |
| Estado contra la biblioteca y guardado por tandas | `src/background/relacionados.js` |
| Históricas + actuaciones (reutilizado, ahora exportado) | `src/background/consulta.js` |
| Descarga y guardado de cada causa (sin cambios) | `src/content/scw-content.js` → `guardarEnBiblioteca` |

Flujo por causa: lista → ojo de la fila → `expediente.seam?cid=…` →
históricas (si el año < 2019) → actuaciones → `guardarEnBiblioteca` →
vuelta a la lista.

Decisiones:

- **Secuencial y en una sola pestaña.** El SCW usa conversaciones de Seam
  (`conversationPropagation=join`): el `cid` es efímero y abrir causas en
  paralelo puede pisar la conversación. Por la misma razón cada causa se
  reabre desde la lista por su **número**, nunca por un `cid` guardado.
- **Novedades sin abrir causas.** Se compara la columna "Últ. Act." de la
  lista con `ultimaActualizacionSCW` guardado en la biblioteca.
- **Clics en el mundo de la página.** El ojo y el paginador usan
  `jsf.util.chain(this, event, …)`: el content script marca el elemento y el
  fondo hace `el.click()` en el mundo MAIN (`runInPageWorld`).
- **Selectores sin `j_idtN`.** Se usan las partes estables:
  `form#tablaConsultaLista:tablaConsultaForm`, `table[id$=":dataTable"]`,
  `ul.pagination`.
- **Paginador.** Avanza al número `actual + 1`; si no está visible, usa la
  flecha de navegación que no es `last-page`. Después confirma que la página
  nueva sea la esperada y, si no, marca la lectura como incompleta.

### Lo que nunca se toca

La estrella (`mojarra.ab … agregarAfavorito`), **Libro digital**,
**Presentar escrito** y **Dejar nota**. El selector del ojo los excluye por
su `onclick`, y la prueba lo verifica.

## Datos en `IndexedDB`

Además de los campos de siempre, cada expediente guardado desde la lista
lleva `origen: 'relacionados'`, `dependencia`, `situacion` y
`ultimaActualizacionSCW`. La biblioteca de esta variante está separada de la
de Infocivil Ebook (otro id de extensión, otro origen).

## Prueba

`tests/maqueta-relacionados.test.js` corre el content script contra una
maqueta de la lista con la estructura relevada (datos inventados):

```
cd tests && npm i jsdom@24 && node maqueta-relacionados.test.js ../src/content/relacionados-content.js
```

## Pendiente

- Probado contra el SCW real con un usuario letrado (consulta, históricas,
  login); falta probar el guardado por tandas desde el panel.
- Confirmar el comportamiento del paginador con más de 10 páginas.
- Leer la bandeja "Entradas" de `portalpjn.pjn.gov.ar` como aviso de
  novedades (habría que volver a agregar ese permiso de sitio al manifest).
- Publicación en Chrome: ver `docs/PUBLICACION-CHROME.md`.
- Publicar en Edge y Firefox: Firefox necesita `background.scripts`
  y `browser_specific_settings.gecko.id`, y no tiene
  `externally_connectable`.
- Definir con la DGN la política de exportaciones (ZIP, EPUB) y de borrado
  al cerrar sesión.
