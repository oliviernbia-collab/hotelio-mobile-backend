<#
    Construit hotelio-api-lws.zip, prêt à être dézippé dans ~/hotelio-api sur l'hébergement LWS.
    Les dépendances (node_modules) sont installées sur le serveur par cPanel → Setup Node.js App.

    Usage (depuis backendMobile) :  powershell -ExecutionPolicy Bypass -File .\deploy-lws.ps1
#>

$ErrorActionPreference = 'Stop'

$source  = $PSScriptRoot
$archive = Join-Path $source 'hotelio-api-lws.zip'
if (Test-Path $archive) { Remove-Item $archive -Force }

Write-Host '==> Création de l''archive'
# tar (bsdtar de Windows) écrit des chemins avec "/" : l'archive se dézippe correctement sous Linux.
# src/uploads/hotels n'est plus utilisé (images servies par Cloudinary ou par le storage Laravel).
& "$env:SystemRoot\System32\tar.exe" -a -c -f $archive -C $source `
    --exclude=./node_modules --exclude=./.git --exclude=./.expo `
    --exclude=./.env --exclude=./src/uploads/hotels `
    --exclude=./deploy-lws.ps1 --exclude=./hotelio-api-lws.zip --exclude='*.log' `
    .
if ($LASTEXITCODE -ne 0) { throw 'La création du zip a échoué' }

$size = [math]::Round((Get-Item $archive).Length / 1MB, 1)
Write-Host "OK : $archive ($size Mo)"
