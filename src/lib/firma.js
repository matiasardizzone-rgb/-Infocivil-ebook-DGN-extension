// firma.js — Verificación de certificados de firma electrónica en PDFs del PJN.
//
// ALCANCE REAL de esta verificación (léase antes de confiar ciegamente):
//   ✅ Detecta si el PDF tiene una firma electrónica embebida.
//   ✅ Extrae el certificado del firmante y verifica que fue emitido
//      genuinamente por la cadena "Autoridad Certificante de Firma
//      Electrónica" → "Autoridad Certificante del PJN" (los certificados
//      que vos mismo cargaste), y que está dentro de su período de validez.
//   ❌ NO verifica que el PDF no haya sido modificado después de firmado
//      (eso requiere descifrar la estructura criptográfica CMS/PKCS#7
//      completa — firma sobre signedAttributes, hash del ByteRange, etc.
//      Deliberadamente no se implementó a medias acá por ser un tema legal:
//      para esa garantía completa, usar Adobe Reader con estos mismos
//      certificados importados).
//   ❌ NO verifica revocación (el propio certificado no publica CRL/OCSP,
//      así que tampoco lo hace Adobe salvo que consulte otro mecanismo).
//
// Usa `forge` (cargado como script clásico en biblioteca.html, variable global).

const ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIFyDCCA7CgAwIBAgIBATANBgkqhkiG9w0BAQsFADB0MQswCQYDVQQGEwJBUjEk
MCIGA1UECgwbUG9kZXIgSnVkaWNpYWwgZGUgbGEgTmFjaW9uMT8wPQYDVQQDDDZB
dXRvcmlkYWQgQ2VydGlmaWNhbnRlIGRlbCBQb2RlciBKdWRpY2lhbCBkZSBsYSBO
YWNpb24wIBcNMTYxMjA3MTMzMjI2WhgPMjA1MTA5MTUxMzMyMjZaMHQxCzAJBgNV
BAYTAkFSMSQwIgYDVQQKDBtQb2RlciBKdWRpY2lhbCBkZSBsYSBOYWNpb24xPzA9
BgNVBAMMNkF1dG9yaWRhZCBDZXJ0aWZpY2FudGUgZGVsIFBvZGVyIEp1ZGljaWFs
IGRlIGxhIE5hY2lvbjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAL7v
AjMeBGB6DUsuScLq4AM60tEFF+t7dhVPKmLw1FsqbnVsXqTZp7a7m9yq3z2Ea7D0
flQFbSqbajR4PVsnF0H7abEen95jUNDagid+gmpdwag4tU1WNl5nVquwd4ykaIqB
8FI+BpFCrNJT89LJ6QxtWKAyid42ilokZkaduHBy086X+kLFnD1sBFzpvvwz3n+I
+slP3OJwotMReDeadcy952JH6/pObliSbRlhPuiW3EYKww16NGtfNjEsIGZQee8E
QzvnDFQkoDVKpitOXK3f6descoHV5ZRElX5BMjDOWd3Zxz92PSjoCO8Nv+b0loPE
P2w/GE+Ciw/ou+ytyGPN5wZfQL51cWmmqj55hxnQ0Pdv6bV+kc6ggzPb9tqdzQaD
lBuH/v0OsVuXflKcQBzbuOHgNaKj55EZc6wiH36waFDnQdsuYtwnslCVtZQo56DR
pPqYNfBMlp3AzEf5PrjzGBq0fnOE7UWfjxmag0uAl1zaTxXGaBN5H//S/cNj+GiP
gdI9IbvpIkA+c24zJTW8S+zyDZkUZEfuMfTlNRvjCHNSi0wR+dfIZF4XuHESZNCO
q6OyiyZX9fxWXmHrNy7gAFp3vILRm5UtbrqGJR7IY1wQxnPX1ZolT0ZZ4X42YrrZ
15vlY/xZlXXRGkmj2MD0mF3qUnjtqu/RcJvLnq3dAgMBAAGjYzBhMA4GA1UdDwEB
/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBR1zrJ9KcKB+ae9FMio
iMpF2vLx9DAfBgNVHSMEGDAWgBR1zrJ9KcKB+ae9FMioiMpF2vLx9DANBgkqhkiG
9w0BAQsFAAOCAgEAZgP3ts6fXyEJiX1/GKuY/AL9Ps4BYVHjK9rLT6bc94s2Puwv
/DUY8bxIMSUN+a/wftU3/XSthfWck6rAhf1pK5IzZ9n8YZQxldsN4WfQr1hIY/pi
w9s+2Z5DoFFf764AmeMnSeF7AE8ALefis8M+ET+aJZN9ubGHjBhx8ZPZLvNNYOwS
mg3gQdFEBY7cvtZsoE/psEFV90TU9Vl8AAdMh0WF2vXhgiejNspkbwNQmqJ4U5LX
7+yqxFOP5qNYnUyEvDazsVCcaCpGjXvxslYBuZgxujasY2SxR+0LZiWm3nau7rZl
5l01066U+oOjYi+x5xGmpSKwu1LQxS4EpZC6uzvLzAYxFf/OfuJbOZh6RkFomkK2
d9hO2NyKYIqizdHHNeg/i++K7F72uu9lyTn+JI8D92vNW2VTnyKNmxBkTZpqPmqN
pWDP0QjlFRpPfYvZhOMe+7S/jolhptS3BpRKGzG0CSLT57KtOfmXRtTOntr+qvut
l+d9d+HYrHoipJIaS/fbSQ89cqd83bypu6Xn6NTz5aJl6yuEniG8PHCdQh/D8agy
RX+OpJC3LC8a384CcPiPAQ/mamXw+kfW1QhokyRQ1MCyPx4t8SWyDrVQ+NY3J0l3
3e5Vg90dztRvqnq2a2pa6Nk92DoW5XO3F/1DXuGxU04LbI1NvMRoTWv5mG4=
-----END CERTIFICATE-----`;

const SIGNING_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIGMTCCBBmgAwIBAgIBBDANBgkqhkiG9w0BAQsFADB0MQswCQYDVQQGEwJBUjEk
MCIGA1UECgwbUG9kZXIgSnVkaWNpYWwgZGUgbGEgTmFjaW9uMT8wPQYDVQQDDDZB
dXRvcmlkYWQgQ2VydGlmaWNhbnRlIGRlbCBQb2RlciBKdWRpY2lhbCBkZSBsYSBO
YWNpb24wIBcNMTYxMjA3MTQxOTU5WhgPMjA1MTA5MTQxNDE5NTlaMIHZMQswCQYD
VQQGEwJBUjEoMCYGA1UECAwfQ2l1ZGFkIEF1dG9ub21hIGRlIEJ1ZW5vcyBBaXJl
czEkMCIGA1UECgwbUG9kZXIgSnVkaWNpYWwgZGUgTGEgTmFjaW9uMSMwIQYDVQQL
DBpDb25zZWpvIGRlIGxhIE1hZ2lzdHJhdHVyYTEfMB0GA1UECwwWQWRtaW5pc3Ry
YWNpb24gR2VuZXJhbDE0MDIGA1UEAwwrQXV0b3JpZGFkIENlcnRpZmljYW50ZSBk
ZSBGaXJtYSBFbGVjdHJvbmljYTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoC
ggIBAMcSCtw62qrpehcujcg7tlMnkgTnaTS/Q327NcqTX6ksTYWRfxxpa4qtwN8O
9MqSyZxQyzz6HaJNDo9hqCJopaS/NAi9lb5MyZtAaVaASY3E9crWGNH6qp49jvMM
W4tlEukCWVPn+a9ZmSp61LFUr0Nz3F8C4lZy1NMtY8zeRSYSzskUzaIzc2kVwfkx
4WyDiCuUpRDdcgeh4/JBW4GDqZmPpqTmg0O40CUTCMPhwR7ZI3khcLnpAk7+iHuX
LcpFhgHqCZiw/pJplE/2OkpyppzLv2O6gqQB0S8eztV5OUx1THa+u3qR3m1oW6NT
62a8nGYRhB7xWAKa4sJ3Y0Q3IPeE3CUirEA3GHJV4sAdxAGRcVgpsERCFn4ZmvLb
9Jmn/FnWfP/TEShlljyFMvyZCqXFOGhdj7Qc4MwzeoiLTcsEQp0f6MB5K8g7Gxbi
zB6jdbnhFrQ1fSFQqk6VBpN1ZquH1FmwDY+2Qn5MxpVhCc3Juu5KVNoiw5BVArXz
80/1+suomBWiAT7RUP4BIGMjD90Tv2a+hB4KyAYKqysl8qW1eIcSlK8MPzLiGgTz
/7l7CAPAll02QBnDkSW7EQ/MgdpJLIhRCOX5JmYNbdr9IiaDI3Sbh5Fk7VDP2amO
caINmTo8SkV0BdjJXbDMIcb3EAlyMGA2Bq2k0rxHzb0B2dCdAgMBAAGjZjBkMA4G
A1UdDwEB/wQEAwIBhjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBRwkKvg
lx56XayrwRgxkLCDV71z9zAfBgNVHSMEGDAWgBR1zrJ9KcKB+ae9FMioiMpF2vLx
9DANBgkqhkiG9w0BAQsFAAOCAgEAPftvMOsLDtziz1beHdKAyokf21RDG4F3StVP
uSNfsWPe8pla6jj2U0941k+xKlruMY5LvjLE6Y3DJeNVvBI92JKwNe3xO/xVizNQ
7QNXBVyzX8qj+sEUbtB484/rhko5rLLfIDmQ8YbMKaOb4dl0XZ5XZ15pgEIkici3
JaeSgw9BInQST/VUSSl8BAcQvCXphoi92Ygtu3XzNz1V+2QAMCeBmxm1np3cLU8R
vZ+P++kRyLfiwxG5Ej9yvYRoTGUNukJnIN3Rl4/f1qyFxhZ245jKAvdO0aePZrwo
SqbmSj1YCGsgoMxUfgi+cpJOcZHSTHY4nyRx0pdLqDn7V7EFdHnynjjM9w846MEK
EjfcsaeK2v0rH3dJmpfCkAm8sig8sG8V1k4wIoz5KK1lSEvUfdJQHcJFJxaPuudD
4ge3FJKNCXYF6T++4ZRAps1YsK9jgl4ez7lP5Qm16td1uTA94FWLkziAN7Z1vzvi
IMXEibCrbszRRrcrYVA8MEfIx5c+kBLbuVOqH5lv0S34TrhsX0QRZ5jRkbJP5sn+
F7avYFKZEAai7v2csjEGUzJFr54FQF/Zv/dV06L3XdmQz+xFZv9MB21V/1QYozxg
fN3ORVocsA/9QmjajKCUMvQLjpTfKz9Z8S9Of4xpJNryipqlbSXyeivXE3znw5E4
nUpRD58=
-----END CERTIFICATE-----`;

let _rootCert = null, _signingCaCert = null, _caStore = null;

function init() {
  if (_caStore) return;
  _rootCert = forge.pki.certificateFromPem(ROOT_CA_PEM);
  _signingCaCert = forge.pki.certificateFromPem(SIGNING_CA_PEM);
  _caStore = forge.pki.createCaStore([ROOT_CA_PEM]);
}

// Convierte un ArrayBuffer a "binary string" (1 byte = 1 char code),
// el formato que forge usa internamente para tratar bytes crudos.
function bufferABinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return s;
}

// Busca bloques de firma (/Contents<hex>) en un texto plano dado (puede ser
// el PDF crudo, o el contenido ya descomprimido de un stream).
//
// Nota de diseño: NO buscamos "cerca de /ByteRange" con una ventana de
// caracteres — probamos eso primero y falló con firmas reales, porque el
// campo /Contents (que incluye los certificados embebidos) puede pesar
// varios miles de caracteres en hexadecimal y quedar a 15.000+ caracteres
// de distancia de /ByteRange según el orden en que el firmador escribió el
// diccionario. En cambio, "/Contents<hex largo>" es en la práctica siempre
// el valor de una firma (las referencias normales a contenido de página son
// "/Contents N G R", una referencia indirecta, nunca un string hexadecimal
// inline) — así que alcanza con buscarlo directamente en todo el archivo.
function buscarBloquesEnTexto(binaryStr) {
  const bloques = [];
  const re = /\/Contents\s*<([0-9A-Fa-f\s]{200,})>/g;
  let m;
  while ((m = re.exec(binaryStr)) !== null) {
    bloques.push({ contentsHex: m[1].replace(/\s+/g, '') });
  }
  return bloques;
}

// Intenta descomprimir con DecompressionStream (formato zlib, que es el que
// usa FlateDecode en PDF) — si el bloque no es Flate válido, falla y se
// descarta en silencio. Usamos esto como red de seguridad para encontrar
// firmas que quedaron dentro de un object stream comprimido, donde el
// escaneo de texto plano no las puede ver.
async function intentarInflar(bytes) {
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    return null;
  }
}

// Extrae todos los segmentos "stream ... endstream" del PDF crudo (a nivel
// de bytes, sin interpretar la estructura de objetos — heurística simple
// pero efectiva) para poder intentar descomprimirlos uno por uno.
function extraerSegmentosStream(bytes) {
  const marcador = 'stream';
  const fin = 'endstream';
  const segmentos = [];
  // Trabajamos sobre la representación en binary-string para poder usar
  // indexOf con seguridad byte a byte.
  let texto = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    texto += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  let pos = 0;
  while (true) {
    const i1 = texto.indexOf(marcador, pos);
    if (i1 === -1) break;
    // El contenido real empieza después del salto de línea que sigue a "stream"
    let inicio = i1 + marcador.length;
    if (texto[inicio] === '\r') inicio++;
    if (texto[inicio] === '\n') inicio++;
    const i2 = texto.indexOf(fin, inicio);
    if (i2 === -1) break;
    let finContenido = i2;
    if (texto[finContenido - 1] === '\n') finContenido--;
    if (texto[finContenido - 1] === '\r') finContenido--;
    segmentos.push({ start: inicio, end: finContenido });
    pos = i2 + fin.length;
  }
  return { texto, segmentos };
}

// Búsqueda de respaldo: descomprime cada stream del PDF y busca la firma
// adentro. Solo se usa si el escaneo de texto plano no encontró nada.
async function buscarBloquesDescomprimiendo(bytes) {
  const { segmentos } = extraerSegmentosStream(bytes);
  const bloques = [];
  for (const seg of segmentos) {
    const trozo = bytes.subarray(seg.start, seg.end);
    if (trozo.length < 8 || trozo.length > 4_000_000) continue; // saltar streams gigantes (imágenes escaneadas, etc.)
    const inflado = await intentarInflar(trozo);
    if (!inflado) continue;
    let textoInflado = '';
    const chunk = 0x8000;
    for (let i = 0; i < inflado.length; i += chunk) {
      textoInflado += String.fromCharCode.apply(null, inflado.subarray(i, i + chunk));
    }
    const encontrados = buscarBloquesEnTexto(textoInflado);
    if (encontrados.length) bloques.push(...encontrados);
  }
  return bloques;
}

async function extraerBloquesDeFirma(bytes, binaryStr) {
  let bloques = buscarBloquesEnTexto(binaryStr);
  let viaCompresion = false;
  if (!bloques.length) {
    bloques = await buscarBloquesDescomprimiendo(bytes);
    viaCompresion = bloques.length > 0;
  }
  // Señal débil: hay "/ByteRange" en algún lado (crudo o dentro de algún
  // stream) pero no logramos aparear un /Contents válido — lo distinguimos
  // de "no hay firma en absoluto" para no informar un falso negativo.
  const hayIndicioSinConfirmar = !bloques.length && /\/ByteRange/.test(binaryStr);
  return { bloques, viaCompresion, hayIndicioSinConfirmar };
}

function hexABinaryString(hex) {
  let s = '';
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s;
}

function nombreDe(attrs, campo) {
  const a = (attrs || []).find(x => x.shortName === campo || x.name === campo);
  return a ? a.value : null;
}

// Verifica un único bloque de firma ya decodificado (CMS/PKCS#7 DER).
function verificarBloque(contentsHex) {
  try {
    const der = hexABinaryString(contentsHex);
    // parseAllBytes:false es necesario porque el campo /Contents suele venir
    // con relleno de ceros al final (se reserva un espacio fijo antes de
    // firmar, y la firma real casi siempre ocupa menos que eso).
    const asn1obj = forge.asn1.fromDer(der, { strict: true, parseAllBytes: false, decodeBitStrings: true });
    const p7 = forge.pkcs7.messageFromAsn1(asn1obj);
    const certs = p7.certificates || [];
    if (!certs.length) return { ok: false, motivo: 'La firma no incluye el certificado del firmante.' };

    // El firmante es el cert que NO es de la CA intermedia (o el primero si no se distingue).
    const leaf = certs.find(c => c.issuer.hash === _signingCaCert.subject.hash) || certs[0];

    let cadenaOk = false, motivoCadena = '';
    try {
      forge.pki.verifyCertificateChain(_caStore, [leaf, _signingCaCert]);
      cadenaOk = true;
    } catch (e) {
      motivoCadena = (e && e.message) || 'Cadena de confianza inválida.';
    }

    return {
      ok: cadenaOk,
      motivo: cadenaOk ? '' : motivoCadena,
      firmante: nombreDe(leaf.subject.attributes, 'CN') || '(sin nombre)',
      emisor: nombreDe(leaf.issuer.attributes, 'CN') || '(desconocido)',
      validoDesde: leaf.validity.notBefore,
      validoHasta: leaf.validity.notAfter,
      serial: leaf.serialNumber,
    };
  } catch (err) {
    return { ok: false, motivo: 'No se pudo interpretar la firma (' + err.message + ').' };
  }
}

/**
 * Verifica todas las firmas embebidas de un PDF.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{estado:'sin_firma'|'valida'|'invalida'|'no_detectable'|'error', firmas:Array, detalle:string}>}
 */
export async function verificarFirmaPDF(arrayBuffer) {
  try {
    init();
    const bytes = new Uint8Array(arrayBuffer);
    const binStr = bufferABinaryString(arrayBuffer);
    const { bloques, viaCompresion, hayIndicioSinConfirmar } = await extraerBloquesDeFirma(bytes, binStr);

    if (!bloques.length) {
      if (hayIndicioSinConfirmar) {
        return {
          estado: 'no_detectable', firmas: [],
          detalle: 'El PDF parece tener una firma, pero no se pudo extraer para verificarla automáticamente (estructura no reconocida).',
        };
      }
      return { estado: 'sin_firma', firmas: [], detalle: 'El PDF no tiene firma electrónica embebida.' };
    }

    const firmas = bloques.map(b => verificarBloque(b.contentsHex));
    const todasOk = firmas.every(f => f.ok);
    return {
      estado: todasOk ? 'valida' : 'invalida',
      firmas,
      detalle: todasOk
        ? 'Certificado del firmante verificado contra la cadena del PJN.' + (viaCompresion ? ' (firma estaba comprimida dentro del PDF)' : '')
        : (firmas.find(f => !f.ok) || {}).motivo || 'Firma no verificada.',
    };
  } catch (err) {
    return { estado: 'error', firmas: [], detalle: err.message };
  }
}
