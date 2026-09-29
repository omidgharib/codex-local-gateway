param(
  [string]$Prompt = "دمای فعلی تهران چند درجه است؟ از ابزار آب‌وهوا استفاده کن.",
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

function Get-CurrentWeather {
  param([Parameter(Mandatory)] [string]$City)

  $encodedCity = [Uri]::EscapeDataString($City)
  $geoUrl = "https://geocoding-api.open-meteo.com/v1/search?name=$encodedCity&count=1&language=en&format=json"
  $geo = Invoke-RestMethod -Uri $geoUrl -Method Get -TimeoutSec 30
  $location = @($geo.results)[0]
  if (-not $location) {
    throw "Open-Meteo could not find city '$City'."
  }

  $forecastUrl = "https://api.open-meteo.com/v1/forecast?latitude=$($location.latitude)&longitude=$($location.longitude)&current=temperature_2m,apparent_temperature,weather_code&timezone=auto"
  $forecast = Invoke-RestMethod -Uri $forecastUrl -Method Get -TimeoutSec 30
  if (-not $forecast.current) {
    throw "Open-Meteo returned no current weather for '$City'."
  }

  return @{
    ok = $true
    city = [string]$location.name
    country = [string]$location.country
    latitude = [double]$location.latitude
    longitude = [double]$location.longitude
    temperature_c = [double]$forecast.current.temperature_2m
    apparent_temperature_c = [double]$forecast.current.apparent_temperature
    weather_code = [int]$forecast.current.weather_code
    observed_at = [string]$forecast.current.time
    timezone = [string]$forecast.timezone
    source = "Open-Meteo"
  }
}

$token = $env:LOCAL_CODEX_GATEWAY_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "LOCAL_CODEX_GATEWAY_TOKEN is required. Set it in this PowerShell session before running the script."
}

$headers = @{
  Authorization = "Bearer $token"
}

$weatherTool = @{
  type = "function"
  name = "get_weather"
  description = "Get the current weather for a city from the public Open-Meteo API."
  strict = $true
  parameters = @{
    type = "object"
    properties = @{
      city = @{
        type = "string"
        description = "City name in English, for example Tehran or Paris."
      }
    }
    required = @("city")
    additionalProperties = $false
  }
}

$history = [System.Collections.ArrayList]::new()
[void]$history.Add(@{
  role = "user"
  content = @(@{ type = "input_text"; text = $Prompt })
})

for ($round = 1; $round -le 4; $round++) {
  $body = @{
    input = @($history)
    tools = @($weatherTool)
    tool_choice = "auto"
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
    Write-Host "`nCodex response:" -ForegroundColor Green
    Write-Output $response.output_text
    exit 0
  }

  foreach ($call in $calls) {
    if ($call.name -ne "get_weather") {
      throw "Gateway requested an unknown function: $($call.name)"
    }

    try {
      $arguments = $call.arguments | ConvertFrom-Json
    } catch {
      throw "Invalid JSON arguments returned for get_weather: $($call.arguments)"
    }
    if ([string]::IsNullOrWhiteSpace([string]$arguments.city)) {
      throw "get_weather requires a non-empty city."
    }

    Write-Host "Calling Open-Meteo for $($arguments.city)..." -ForegroundColor Cyan
    try {
      $toolResult = Get-CurrentWeather -City $arguments.city
      $toolOutput = $toolResult | ConvertTo-Json -Compress -Depth 10
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
  }
}

throw "Tool-calling loop exceeded 4 rounds."
