$ErrorActionPreference = 'Stop'
try {
    $target = Join-Path $env:LOCALAPPDATA 'CodexLocalGateway'
    $source = Join-Path $PSScriptRoot 'app'
    $alreadyInstalled = Test-Path -LiteralPath (Join-Path $target 'src/server.mjs')
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    if (-not $alreadyInstalled) { Copy-Item -Path "$source\*" -Destination $target -Recurse -Force }
    $envFile = Join-Path $target '.env.local'
    if (-not (Test-Path -LiteralPath $envFile)) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes); $rng.Dispose()
        $token = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
        @("LOCAL_CODEX_GATEWAY_TOKEN=$token", 'HOST=127.0.0.1', 'PORT=4317', "CODEX_BIN=$target\runtime\codex.exe", "CODEX_ALLOWED_ROOTS=$target", 'CODEX_ALLOW_WRITES=false') | Set-Content -LiteralPath $envFile -Encoding UTF8
        & icacls.exe $envFile /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(F)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not protect local configuration.' }
    }
    $settings = @{}
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^([A-Z_]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim() }
    }
    $port = if ($env:PORT) { $env:PORT } elseif ($settings.PORT) { $settings.PORT } else { '4317' }
    $baseUrl = "http://127.0.0.1:$port"
    $gatewayToken = if ($env:LOCAL_CODEX_GATEWAY_TOKEN) { $env:LOCAL_CODEX_GATEWAY_TOKEN } else { $settings.LOCAL_CODEX_GATEWAY_TOKEN }
    if (-not $gatewayToken) { throw 'Local token is missing from the existing settings.' }
    $shell = New-Object -ComObject WScript.Shell
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Local Gateway'
    New-Item -ItemType Directory -Path $menu -Force | Out-Null
    $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Local Gateway.lnk'
    foreach ($linkPath in @($startup, (Join-Path $menu 'Start Gateway.lnk'))) {
        $link = $shell.CreateShortcut($linkPath)
        $link.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
        $link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$target\start.ps1`""
        $link.WorkingDirectory = $target; $link.Save()
    }
    $link = $shell.CreateShortcut((Join-Path $menu 'Sign in to Codex.lnk'))
    $link.TargetPath = "$target\runtime\codex.exe"; $link.Arguments = 'login'; $link.Save()
    $link = $shell.CreateShortcut((Join-Path $menu 'Dashboard.lnk'))
    $link.TargetPath = "$baseUrl/dashboard"; $link.Save()
    $link = $shell.CreateShortcut((Join-Path $menu 'Uninstall.lnk'))
    $link.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$target\uninstall.ps1`""; $link.Save()
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLocalGateway'
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name DisplayName -Value 'Codex Local Gateway' -Force | Out-Null
    New-ItemProperty -Path $key -Name UninstallString -Value $link.Arguments.Insert(0, 'powershell.exe ') -Force | Out-Null
    & "$target\runtime\codex.exe" login status
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Sign in with your own Codex account to finish setup.'
        & "$target\runtime\codex.exe" login
        if ($LASTEXITCODE -ne 0) { throw 'Sign-in did not finish. Use the Sign in to Codex shortcut, then Start Gateway.' }
    }
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$target\start.ps1`""
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        try { $health = Invoke-RestMethod "$baseUrl/health" -TimeoutSec 2; if ($health.status -eq 'ok') { $ready = $true; break } } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "Gateway did not start. Check $target\gateway.stderr.log" }
    Write-Host 'Checking authenticated model access and a real read-only response...'
    $headers = @{ Authorization = "Bearer $gatewayToken" }
    $models = Invoke-RestMethod "$baseUrl/v1/models" -Headers $headers -TimeoutSec 30
    if (-not $models.data) { throw 'Model discovery returned no models.' }
    $body = @{ input = 'Reply with exactly: GATEWAY_OK'; mode = 'read-only' } | ConvertTo-Json
    try {
        $response = Invoke-RestMethod "$baseUrl/v1/responses" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 310
    } catch {
        $requestId = $_.Exception.Response.Headers['x-request-id']
        throw "Real response check failed (request ID: $requestId). Settings are saved; rerun setup after resolving account or network access."
    }
    if ([string]::IsNullOrWhiteSpace($response.output_text)) { throw 'Real response check returned no final answer.' }
    Start-Process "$baseUrl/dashboard"
    Write-Host 'Installation completed.'
} catch { Write-Host $_ -ForegroundColor Red; exit 1 }
