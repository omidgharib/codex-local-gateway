param([string]$Ref = 'production')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'This installer requires Windows x64.'
}
$stage = Join-Path ([IO.Path]::GetTempPath()) ('CodexGateway-download-' + [Guid]::NewGuid())
function Download($Url, $Path) {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -TimeoutSec 180; return }
        catch {
            if ($attempt -eq 2) { throw }
            Start-Sleep -Seconds ([Math]::Pow(2, $attempt + 1))
        }
    }
}
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    Write-Host 'Downloading gateway and private runtimes (no administrator access needed)...'
    $headers = @{ 'User-Agent' = 'CodexLocalGateway-Installer' }
    $commit = Invoke-RestMethod -Headers $headers -Uri ('https://api.github.com/repos/omidgharib/codex-local-gateway/commits/' + [Uri]::EscapeDataString($Ref))
    Download "https://github.com/omidgharib/codex-local-gateway/archive/$($commit.sha).zip" "$stage\source.zip"
    Expand-Archive -LiteralPath "$stage\source.zip" -DestinationPath "$stage\source"
    $root = Join-Path "$stage\source" "codex-local-gateway-$($commit.sha)"
    $app = Join-Path $stage 'app'
    New-Item -ItemType Directory -Path "$app\runtime" -Force | Out-Null
    foreach ($name in @('src', 'public', 'package.json', 'README.md', 'openapi.yaml', 'INTEGRATION_PROMPT.md')) {
        Copy-Item -LiteralPath (Join-Path $root $name) -Destination $app -Recurse
    }
    foreach ($name in @('start.ps1', 'uninstall.ps1')) {
        Copy-Item -LiteralPath "$root\setup\$name" -Destination $app
    }
    Download 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' "$stage\node-checksums.txt"
    $checksum = Get-Content "$stage\node-checksums.txt" | Where-Object { $_ -match ' node-v[\d.]+-win-x64.zip$' } | Select-Object -First 1
    if (-not $checksum) { throw 'Node download checksum was not found.' }
    $parts = $checksum.Trim() -split '\s+'
    Download "https://nodejs.org/dist/latest-v22.x/$($parts[1])" "$stage\node.zip"
    if ((Get-FileHash "$stage\node.zip" -Algorithm SHA256).Hash -ne $parts[0]) { throw 'Node checksum mismatch.' }
    Expand-Archive "$stage\node.zip" "$stage\node"
    $node = Get-ChildItem "$stage\node" -Filter node.exe -Recurse | Select-Object -First 1
    Copy-Item -LiteralPath $node.FullName -Destination "$app\runtime\node.exe"
    $release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/openai/codex/releases/latest'
    foreach ($binary in @('codex', 'codex-app-server', 'codex-command-runner', 'codex-code-mode-host', 'codex-windows-sandbox-setup', 'codex-windows-sandbox-service', 'codex-responses-api-proxy')) {
        $asset = $release.assets | Where-Object { $_.name -eq "$binary-x86_64-pc-windows-msvc.exe" } | Select-Object -First 1
        if (-not $asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw "Verified release asset missing: $binary" }
        $binaryPath = "$app\runtime\$binary.exe"
        Download $asset.browser_download_url $binaryPath
        if ((Get-FileHash $binaryPath -Algorithm SHA256).Hash -ne $asset.digest.Substring(7)) { throw "Checksum mismatch: $binary" }
    }
    Copy-Item -LiteralPath "$root\setup\install.ps1" -Destination "$stage\install.ps1"
    & "$stage\install.ps1"
    if ($LASTEXITCODE -ne 0) { throw 'Installation did not complete.' }
} finally {
    $resolved = [IO.Path]::GetFullPath($stage)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
