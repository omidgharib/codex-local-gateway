param([string]$NodePath = (Get-Command node.exe).Source, [string]$CodexPath = (Get-Command codex.exe).Source)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $PSScriptRoot ('build-' + [Guid]::NewGuid())
$app = Join-Path $stage 'app'
try {
    New-Item -ItemType Directory -Path "$app\runtime" -Force | Out-Null
    foreach ($name in @('src', 'public', 'package.json', 'README.md', 'openapi.yaml', 'INTEGRATION_PROMPT.md')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination $app -Recurse }
    Copy-Item -LiteralPath $NodePath -Destination "$app\runtime\node.exe"
    Copy-Item -Path "$(Split-Path -Parent $CodexPath)\*.exe" -Destination "$app\runtime"
    foreach ($name in @('start.ps1', 'uninstall.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $app }
    Copy-Item -LiteralPath "$PSScriptRoot\install.ps1" -Destination $stage
    $zip = Join-Path $PSScriptRoot 'payload.zip'
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
    $compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    & $compiler /nologo /target:exe /platform:x64 "/out:$PSScriptRoot\Setup.exe" /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$zip,payload.zip" "$PSScriptRoot\Launcher.cs"
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
    & "$PSScriptRoot\Setup.exe" --verify
    if ($LASTEXITCODE -ne 0) { throw 'Payload validation failed.' }
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if (Test-Path -LiteralPath "$PSScriptRoot\payload.zip") { Remove-Item -LiteralPath "$PSScriptRoot\payload.zip" -Force }
}
