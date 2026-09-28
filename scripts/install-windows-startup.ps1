param([string]$TaskName = "CodexLocalGateway")

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-gateway.ps1"
if (-not (Test-Path -LiteralPath $runner)) { throw "Gateway runner not found: $runner" }

$powerShell = (Get-Command powershell.exe).Source
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Start Codex Local Gateway for the current user" -Force | Out-Null
Write-Host "Installed startup task: $TaskName"
