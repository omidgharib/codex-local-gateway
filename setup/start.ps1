$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$mutex = New-Object Threading.Mutex($false, 'Local\CodexLocalGatewayRunner')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit }
try { & "$PSScriptRoot\runtime\node.exe" src/server.mjs 1>> "$PSScriptRoot\gateway.stdout.log" 2>> "$PSScriptRoot\gateway.stderr.log" }
finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
