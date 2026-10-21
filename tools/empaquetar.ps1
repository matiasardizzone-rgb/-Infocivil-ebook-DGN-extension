# empaquetar.ps1 — Genera los paquetes de Infocivil Ebook DGN para las tiendas.
#
#   .\tools\empaquetar.ps1              # Chrome/Edge y Firefox
#   .\tools\empaquetar.ps1 -Destino firefox
#
# Toma los archivos versionados en git (no lo que haya suelto en la carpeta, como
# ZIP viejos o pruebas), con su contenido actual,
# deja afuera tests/, docs/ y tools/, y escribe los ZIP en ..\paquetes\:
#   infocivil-ebook-dgn-<versión>-chrome.zip   (Chrome Web Store y Edge Add-ons)
#   infocivil-ebook-dgn-<versión>-firefox.zip  (addons.mozilla.org)
#
# Para Firefox el manifest se transforma al vuelo: background con scripts en
# lugar de service_worker, id y versión mínima de gecko (115 ESR), sin
# externally_connectable ni minimum_chrome_version.
# Compatible con Windows PowerShell 5.1 y PowerShell 7. Las rutas dentro del
# ZIP van con "/" (AMO rechaza las "\" que genera Compress-Archive en 5.1).

param(
  [ValidateSet('todos', 'chrome', 'firefox')]
  [string]$Destino = 'todos'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$raiz = Split-Path -Parent $PSScriptRoot
$salida = Join-Path (Split-Path -Parent $raiz) 'paquetes'
if (-not (Test-Path $salida)) { New-Item -ItemType Directory -Path $salida | Out-Null }

$textoManifest = [IO.File]::ReadAllText((Join-Path $raiz 'manifest.json'), [Text.Encoding]::UTF8)
$version = ($textoManifest | ConvertFrom-Json).version

$pendientes = git -C $raiz status --porcelain
if ($pendientes) { Write-Warning 'Hay cambios sin commitear: se empaquetan tal como están en la carpeta. Conviene commitear antes de publicar.' }

$archivos = git -C $raiz ls-files | Where-Object { $_ -notmatch '^(tests|docs|tools)/' -and $_ -ne 'manifest.json' }

function Nuevo-Paquete([string]$nombre, [string]$manifest) {
  $ruta = Join-Path $salida $nombre
  if (Test-Path $ruta) { Remove-Item $ruta }
  $zip = [IO.Compression.ZipFile]::Open($ruta, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in $archivos) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $raiz $f), $f, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    $entrada = $zip.CreateEntry('manifest.json')
    $escritor = New-Object IO.StreamWriter($entrada.Open(), (New-Object Text.UTF8Encoding($false)))
    $escritor.Write($manifest)
    $escritor.Close()
  } finally {
    $zip.Dispose()
  }
  Write-Host ('  ' + $ruta)
}

Write-Host "Infocivil Ebook DGN $version"

if ($Destino -in 'todos', 'chrome') {
  Nuevo-Paquete "infocivil-ebook-dgn-$version-chrome.zip" $textoManifest
}

if ($Destino -in 'todos', 'firefox') {
  $m = $textoManifest | ConvertFrom-Json
  $m.PSObject.Properties.Remove('externally_connectable')
  $m.PSObject.Properties.Remove('minimum_chrome_version')
  $m.background = [ordered]@{ scripts = @('src/background/index.js'); type = 'module' }
  $gecko = [ordered]@{
    id = 'infocivil-ebook-dgn@sytec.pjn.gov.ar'
    strict_min_version = '115.0'
    data_collection_permissions = [ordered]@{ required = @('none') }
  }
  $m | Add-Member -NotePropertyName browser_specific_settings -NotePropertyValue ([ordered]@{ gecko = $gecko }) -Force
  Nuevo-Paquete "infocivil-ebook-dgn-$version-firefox.zip" ($m | ConvertTo-Json -Depth 10)
}
