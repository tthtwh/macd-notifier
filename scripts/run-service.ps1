param(
  [Parameter(Mandatory = $true)]
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EnvFile = Join-Path $ProjectRoot '.env'
$EntryFile = Join-Path $ProjectRoot 'src\index.js'
$LogDirectory = Join-Path $ProjectRoot 'logs'
$OutputLog = Join-Path $LogDirectory 'service.log'
$ErrorLog = Join-Path $LogDirectory 'service-error.log'

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
Set-Location $ProjectRoot

& $NodePath "--env-file=$EnvFile" $EntryFile 1>> $OutputLog 2>> $ErrorLog
exit $LASTEXITCODE
