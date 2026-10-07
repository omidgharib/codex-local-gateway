$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'CodexLocalGateway'
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath($target)) { throw 'Unexpected installation directory.' }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -eq "$target\runtime\node.exe" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Local Gateway.lnk'
Remove-Item -LiteralPath $startup -Force -ErrorAction SilentlyContinue
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Local Gateway'
if (Test-Path -LiteralPath $menu) { Remove-Item -LiteralPath $menu -Recurse -Force }
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLocalGateway' -Force -ErrorAction SilentlyContinue
foreach ($name in @('src', 'public', 'runtime', 'start.ps1', 'uninstall.ps1', 'package.json', 'README.md', 'openapi.yaml', 'INTEGRATION_PROMPT.md')) {
    $item = Join-Path $target $name
    if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item -Recurse -Force }
}
Write-Host 'Removed. Local settings and logs have been kept.'
