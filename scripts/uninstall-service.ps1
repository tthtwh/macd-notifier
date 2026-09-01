$ErrorActionPreference = 'Stop'
$TaskName = 'MACD-Notifier-512760'

$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $Task) {
  Write-Host "Task is not installed: $TaskName"
  exit 0
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Stopped and uninstalled: $TaskName (configuration, state and logs were kept)"
