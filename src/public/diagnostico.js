// diagnostico.js — Pantalla de Diagnóstico: muestra el registro técnico local
// (lib/registro.js), datos del entorno y permite exportarlo o mandarlo a SYTEC.

import { leerRegistro, borrarRegistro, instalarCaptura, MAX_EVENTOS } from '../lib/registro.js';
import * as db from '../lib/db.js';

instalarCaptura('diagnostico');

// Casilla de soporte. El mail lo arma el cliente de correo del usuario
// (mailto:), la extensión no envía nada por su cuenta.
const MAIL_SOPORTE = 'cncivil.sytec@outlook.com';

const $ = id => document.getElementById(id);
let eventos = [];
let entorno = {};

function tamanioLegible(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',') + ' GB';
}

function navegador() {
  const ua = navigator.userAgent;
  const m = ua.match(/Edg\/([\d.]+)/) ? ['Edge', ua.match(/Edg\/([\d.]+)/)[1]]
          : ua.match(/Firefox\/([\d.]+)/) ? ['Firefox', ua.match(/Firefox\/([\d.]+)/)[1]]
          : ua.match(/Chrome\/([\d.]+)/) ? ['Chrome', ua.match(/Chrome\/([\d.]+)/)[1]] : ['?', ''];
  return m[0] + ' ' + m[1];
}
function sistema() {
  const ua = navigator.userAgent;
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11' + (/WOW64|Win64|x64/.test(ua) ? ' (64 bits)' : ' (32 bits)');
  if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.1/.test(ua)) return 'Windows 7';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return navigator.platform || '?';
}

async function juntarEntorno() {
  const e = {
    version: chrome.runtime.getManifest().version,
    navegador: navegador(),
    sistema: sistema(),
    idioma: navigator.language,
    generado: new Date().toISOString(),
  };
  try {
    const est = await navigator.storage.estimate();
    e.espacioUsado = est.usage || 0;
    e.espacioDisponible = est.quota || 0;
  } catch (_) {}
  try {
    const exps = await db.listarExpedientes();
    e.expedientes = exps.length;
    // Números de expediente (sin carátula): sirven para cruzar un error con
    // la causa; si se prefiere anonimizar, sacar esta línea.
    e.listaExpedientes = exps.map(x => ({ numero: x.numero, actuaciones: x.cantidadActuaciones || 0, estado: x.estado }));
  } catch (_) {}
  return e;
}

function pintarDatos() {
  const errores = eventos.filter(x => x.nivel === 'error').length;
  const avisos = eventos.filter(x => x.nivel === 'aviso').length;
  const ultimoError = eventos.filter(x => x.nivel === 'error').slice(-1)[0];
  const datos = [
    ['Versión', 'v' + entorno.version],
    ['Navegador', entorno.navegador],
    ['Sistema', entorno.sistema],
    ['Espacio usado', entorno.espacioUsado != null ? tamanioLegible(entorno.espacioUsado) +
      (entorno.espacioDisponible ? ' de ' + tamanioLegible(entorno.espacioDisponible) : '') : '—'],
    ['Expedientes guardados', entorno.expedientes != null ? String(entorno.expedientes) : '—'],
    ['Eventos registrados', eventos.length + ' (máx. ' + MAX_EVENTOS + ')'],
    ['Errores / avisos', errores + ' / ' + avisos, errores ? 'err' : ''],
    ['Último error', ultimoError ? fechaLocal(ultimoError.fecha) : 'ninguno'],
  ];
  $('datos').innerHTML = datos.map(([et, va, cls]) =>
    `<div class="dato"><div class="et">${esc(et)}</div><div class="va ${cls || ''}">${esc(va)}</div></div>`).join('');
}

function pintarTabla() {
  const f = $('filtro').value;
  const lista = eventos.filter(x => !f || x.nivel === 'error' || (f === 'aviso' && x.nivel === 'aviso')).slice().reverse();
  if (!lista.length) {
    $('filas').innerHTML = `<tr><td colspan="5" class="vacio">${eventos.length ? 'No hay eventos con este filtro.' : 'Sin eventos registrados. Todo en orden.'}</td></tr>`;
    return;
  }
  $('filas').innerHTML = lista.map(x => `<tr>
      <td class="f">${esc(fechaLocal(x.fecha))}</td>
      <td><span class="nivel ${esc(x.nivel)}">${esc(x.nivel)}</span></td>
      <td>${esc(x.origen)}</td>
      <td>${esc(x.mensaje)}</td>
      <td class="d">${x.datos ? esc(JSON.stringify(x.datos)) : ''}</td>
    </tr>`).join('');
}

function textoDiagnostico() {
  const lineas = [
    'DIAGNÓSTICO — Infocivil Ebook v' + entorno.version,
    'Generado: ' + entorno.generado,
    'Navegador: ' + entorno.navegador + ' · Sistema: ' + entorno.sistema + ' · Idioma: ' + entorno.idioma,
    'Espacio usado: ' + tamanioLegible(entorno.espacioUsado) + ' de ' + tamanioLegible(entorno.espacioDisponible),
    'Expedientes guardados: ' + (entorno.expedientes ?? '—'),
    '',
  ];
  (entorno.listaExpedientes || []).forEach(x => lineas.push('  · ' + x.numero + ' — ' + x.actuaciones + ' actuaciones — ' + x.estado));
  lineas.push('', 'EVENTOS (' + eventos.length + ', del más reciente al más viejo)', '');
  eventos.slice().reverse().forEach(x => {
    lineas.push(x.fecha + ' [' + x.nivel.toUpperCase() + '] ' + x.origen + ' v' + x.version + ' — ' + x.mensaje +
      (x.datos ? ' ' + JSON.stringify(x.datos) : ''));
  });
  return lineas.join('\n');
}

function nombreArchivo() {
  return 'diagnostico-infocivil-v' + entorno.version + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
}

function descargar() {
  const nombre = nombreArchivo();
  const blob = new Blob([textoDiagnostico()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return nombre;
}

function enviarPorMail() {
  const nombre = descargar();
  const errores = eventos.filter(x => x.nivel === 'error').slice(-5).reverse();
  // El cuerpo lleva un resumen por si el usuario se olvida de adjuntar el
  // archivo; mailto: tiene límite de largo, por eso solo los últimos errores.
  const cuerpo = [
    'Hola, les envío el diagnóstico de Infocivil Ebook.',
    '',
    'Qué estaba haciendo / qué pasó:',
    '',
    '',
    '--- Resumen automático ---',
    'Versión: v' + entorno.version + ' · ' + entorno.navegador + ' · ' + entorno.sistema,
    'Expedientes guardados: ' + (entorno.expedientes ?? '—') + ' · Espacio usado: ' + tamanioLegible(entorno.espacioUsado),
    'Últimos errores:',
    ...(errores.length ? errores.map(x => '- ' + fechaLocal(x.fecha) + ' ' + x.origen + ': ' + x.mensaje) : ['- ninguno']),
    '',
    'Archivo para adjuntar: ' + nombre + ' (quedó en la carpeta de Descargas)',
  ].join('\n');
  const asunto = 'Diagnóstico Infocivil Ebook v' + entorno.version;
  window.location.href = 'mailto:' + MAIL_SOPORTE + '?subject=' + encodeURIComponent(asunto) + '&body=' + encodeURIComponent(cuerpo);
  $('avisoMail').textContent = 'Se descargó «' + nombre + '». Adjuntalo al mail que se abrió. Si no se abrió ningún programa de correo, ' +
    'escribí a ' + MAIL_SOPORTE + ' desde tu webmail y adjuntá ese archivo.';
}

async function copiar() {
  try {
    await navigator.clipboard.writeText(textoDiagnostico());
    $('avisoMail').textContent = 'Diagnóstico copiado. Podés pegarlo en un mail a ' + MAIL_SOPORTE + '.';
  } catch (e) {
    $('avisoMail').textContent = 'No se pudo copiar: usá "Descargar diagnóstico".';
  }
}

async function borrar() {
  if (!confirm('¿Borrar el registro de diagnóstico de este navegador?')) return;
  await borrarRegistro();
  await cargar();
}

function fechaLocal(iso) {
  try { return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'medium' }); } catch (_) { return iso; }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function cargar() {
  [eventos, entorno] = await Promise.all([leerRegistro(), juntarEntorno()]);
  pintarDatos();
  pintarTabla();
}

$('btnMail').addEventListener('click', enviarPorMail);
$('btnDescargar').addEventListener('click', descargar);
$('btnCopiar').addEventListener('click', copiar);
$('btnBorrar').addEventListener('click', borrar);
$('filtro').addEventListener('change', pintarTabla);
// Si otro contexto registra algo mientras la pantalla está abierta.
chrome.storage.onChanged.addListener((cambios, area) => { if (area === 'local' && cambios.registroEventos) cargar(); });
document.querySelectorAll('[data-version-ext]').forEach(el => { el.textContent = 'v' + chrome.runtime.getManifest().version; });
cargar();
