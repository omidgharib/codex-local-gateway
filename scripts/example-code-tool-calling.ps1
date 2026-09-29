param(
  [string]$FilePath = ".\fixtures\sample-buggy.js",
  [string]$Prompt = "این فایل کد را بخوان، مهم‌ترین باگ‌ها و ریسک‌های reliability را پیدا کن و برای هر مورد راه‌حل مشخص بده.",
  [string]$GatewayUrl = $(if ($env:CODEX_GATEWAY_URL) { $env:CODEX_GATEWAY_URL } else { "http://127.0.0.1:4317" }),
  [string]$Model = ""
)

$ErrorActionPreference = "Stop"

function Invoke-GatewayResponse {
  param(
    [Parameter(Mandatory)] [string]$GatewayUrl,
    [Parameter(Mandatory)] [hashtable]$Headers,
    [Parameter(Mandatory)] [hashtable]$Body
  )

  $json = $Body | ConvertTo-Json -Depth 30 -Compress
  try {
    return Invoke-RestMethod `
      -Uri "$($GatewayUrl.TrimEnd('/'))/v1/responses" `
      -Method Post `
      -Headers $Headers `
      -ContentType "application/json; charset=utf-8" `
      -Body $json `
      -TimeoutSec 310
  } catch {
    $requestId = $_.Exception.Response.Headers["x-request-id"]
    if ($requestId) {
      throw "Gateway request failed. x-request-id: $requestId. $($_.Exception.Message)"
    }
    throw
  }
}

function Read-SelectedSourceFile {
  param([Parameter(Mandatory)] [System.IO.FileInfo]$File)

  $allowedExtensions = @(
    ".c", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
    ".json", ".md", ".mjs", ".php", ".ps1", ".py", ".rb", ".rs", ".ts",
    ".tsx", ".yaml", ".yml"
  )
  if ($allowedExtensions -notcontains $File.Extension.ToLowerInvariant()) {
    throw "File extension '$($File.Extension)' is not allowed by this sample."
  }
  if ($File.Length -gt 100KB) {
    throw "Selected file is larger than the 100 KB sample limit."
  }

  $content = Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8
  return @{
    ok = $true
    file_name = $File.Name
    extension = $File.Extension
    size_bytes = $File.Length
    content = $content
  }
}

$token = $env:LOCAL_CODEX_GATEWAY_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "LOCAL_CODEX_GATEWAY_TOKEN is required. Set it before running the script."
}

$selectedFile = Get-Item -LiteralPath (Resolve-Path -LiteralPath $FilePath).Path
if (-not $selectedFile.PSIsContainer -and $selectedFile -is [System.IO.FileInfo]) {
  Write-Host "Selected source: $($selectedFile.FullName)" -ForegroundColor DarkGray
} else {
  throw "FilePath must point to a file."
}

$headers = @{ Authorization = "Bearer $token" }
$sourceTool = @{
  type = "function"
  name = "read_selected_source"
  description = "Read the one source-code file explicitly selected by the human operator. This function takes no arguments."
  strict = $true
  parameters = @{
    type = "object"
    properties = @{}
    required = @()
    additionalProperties = $false
  }
}

$history = [System.Collections.ArrayList]::new()
[void]$history.Add(@{
  role = "user"
  content = @(@{
    type = "input_text"
    text = "$Prompt`n`nSelected filename: $($selectedFile.Name). You must call read_selected_source before answering."
  })
})

$toolHasRun = $false
for ($round = 1; $round -le 4; $round++) {
  $body = @{
    input = @($history)
    tools = @($sourceTool)
    tool_choice = $(if ($toolHasRun) { "auto" } else { @{ type = "function"; name = "read_selected_source" } })
    parallel_tool_calls = $false
    mode = "read-only"
  }
  if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $body.model = $Model
  }

  $response = Invoke-GatewayResponse -GatewayUrl $GatewayUrl -Headers $headers -Body $body
  $calls = @($response.output | Where-Object { $_.type -eq "function_call" })

  if ($calls.Count -eq 0) {
    if ([string]::IsNullOrWhiteSpace([string]$response.output_text)) {
      throw "Gateway returned neither a function_call nor output_text."
    }
    Write-Host "`nCode review:" -ForegroundColor Green
    Write-Output $response.output_text
    exit 0
  }

  foreach ($call in $calls) {
    if ($call.name -ne "read_selected_source") {
      throw "Gateway requested an unknown function: $($call.name)"
    }
    try {
      $arguments = $call.arguments | ConvertFrom-Json
    } catch {
      throw "Invalid JSON arguments returned for read_selected_source: $($call.arguments)"
    }
    if (@($arguments.PSObject.Properties).Count -ne 0) {
      throw "read_selected_source does not accept arguments."
    }

    Write-Host "Tool call: reading $($selectedFile.Name)..." -ForegroundColor Cyan
    try {
      $toolOutput = Read-SelectedSourceFile -File $selectedFile | ConvertTo-Json -Compress -Depth 10
    } catch {
      $toolOutput = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }

    [void]$history.Add(@{
      type = "function_call"
      call_id = [string]$call.call_id
      name = [string]$call.name
      arguments = [string]$call.arguments
    })
    [void]$history.Add(@{
      type = "function_call_output"
      call_id = [string]$call.call_id
      output = $toolOutput
    })
    $toolHasRun = $true
  }
}

throw "Tool-calling loop exceeded 4 rounds."
