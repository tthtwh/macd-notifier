param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$TaskName = 'MACD-Notifier-512760'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $Task) {
  throw 'Task is not installed. Run npm run service:install first.'
}

switch ($Action) {
  'start' {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started: $TaskName"
  }
  'stop' {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "Stopped: $TaskName"
  }
  'status' {
    $Info = Get-ScheduledTaskInfo -TaskName $TaskName
    [PSCustomObject]@{
      Name = $TaskName
      State = $Task.State
      LastRunTime = $Info.LastRunTime
      LastTaskResult = $Info.LastTaskResult
      NextRunTime = $Info.NextRunTime
    } | Format-List
  }
}
