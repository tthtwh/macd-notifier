$ErrorActionPreference = 'Stop'
$TaskName = 'MACD-Notifier-512760'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EnvFile = Join-Path $ProjectRoot '.env'
$RunnerFile = Join-Path $PSScriptRoot 'run-service.ps1'

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw 'Missing .env. Copy .env.example to .env and configure SERVERCHAN_SENDKEY first.'
}
$Configured = Select-String -LiteralPath $EnvFile -Pattern '^\s*SERVERCHAN_SENDKEY\s*=\s*[^\s#]+' -Quiet
if (-not $Configured) {
  throw 'SERVERCHAN_SENDKEY is missing or empty in .env.'
}

$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$PowerShellPath = Join-Path $PSHOME 'powershell.exe'
$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$RunnerFile`" -NodePath `"$NodePath`""
$Action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $Arguments -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$TaskPrincipal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Description 'Runs after user logon and checks 512760 MACD at 14:55 on weekdays.' `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $TaskPrincipal `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started: $TaskName"
Write-Host "Account: $UserId (standard user, starts after logon)"
Write-Host "Project: $ProjectRoot"
Write-Host 'Status command: npm run service:status'
