$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$archivePath = Join-Path ([IO.Path]::GetTempPath()) ('forja-workers-' + [guid]::NewGuid().ToString('N') + '.zip')
& git -C $projectRoot archive --format=zip --output=$archivePath HEAD
if ($LASTEXITCODE -ne 0) { throw 'No se pudo exportar el código versionado' }
Write-Output $archivePath
