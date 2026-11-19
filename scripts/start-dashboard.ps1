$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot 'data'
$stdoutLog = Join-Path $dataDir 'dashboard.stdout.log'
$stderrLog = Join-Path $dataDir 'dashboard.stderr.log'
$dashboardUrl = 'http://127.0.0.1:37821'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

try {
  $health = Invoke-RestMethod -Uri "$dashboardUrl/api/health" -TimeoutSec 2
  if ($health.status -in @('ok', 'starting', 'degraded')) {
    Write-Output ('ETF dashboard is already running: ' + $dashboardUrl)
    exit 0
  }
} catch {
  # The health endpoint being unavailable means the local service should be started.
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
Start-Process `
  -FilePath $nodePath `
  -ArgumentList 'server/index.js' `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog

$started = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "$dashboardUrl/api/health" -TimeoutSec 2
    if ($health.status -in @('ok', 'starting', 'degraded')) {
      $started = $true
      break
    }
  } catch {
    # Keep waiting until the bounded startup window ends.
  }
}

if (-not $started) {
  throw ('ETF dashboard startup timed out. Check log: ' + $stderrLog)
}

Write-Output ('ETF dashboard started: ' + $dashboardUrl)

