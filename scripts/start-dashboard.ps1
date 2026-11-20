$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot 'data'
$stdoutLog = Join-Path $dataDir 'dashboard.stdout.log'
$stderrLog = Join-Path $dataDir 'dashboard.stderr.log'
$dashboardUrl = 'http://127.0.0.1:37821'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$nodePath = (Get-Command node -ErrorAction Stop).Source
$currentBuildId = (& $nodePath 'server/runtime-version.js' 2>$null).Trim()
if (-not $currentBuildId) {
  throw 'Unable to calculate the dashboard build fingerprint.'
}
$expectedApiVersion = [int](& $nodePath -e "process.stdout.write(String(require('./server/runtime-version').API_VERSION))").Trim()

$needsRestart = $false
try {
  $health = Invoke-RestMethod -Uri "$dashboardUrl/api/health" -TimeoutSec 2
  if ($health.status -in @('ok', 'starting', 'degraded')) {
    if ($health.buildId -eq $currentBuildId -and $health.apiVersion -eq $expectedApiVersion) {
      Write-Output ('ETF dashboard is already running with current code: ' + $dashboardUrl)
      exit 0
    }
    $needsRestart = $true
    $runningBuild = if ($health.buildId) { $health.buildId } else { 'missing buildId' }
    Write-Output (
      'ETF dashboard code is outdated; restarting. Running: ' +
      $runningBuild +
      '; current: ' + $currentBuildId
    )
  }
} catch {
  # The health endpoint being unavailable means the local service should be started.
}

if ($needsRestart) {
  & (Join-Path $PSScriptRoot 'stop-dashboard.ps1')
  $stopped = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      $null = Invoke-RestMethod -Uri "$dashboardUrl/api/health" -TimeoutSec 1
      Start-Sleep -Milliseconds 250
    } catch {
      $stopped = $true
      break
    }
  }
  if (-not $stopped) {
    throw 'The outdated ETF dashboard did not stop before the restart window ended.'
  }
}

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
    if (
      $health.status -in @('ok', 'starting', 'degraded') -and
      $health.buildId -eq $currentBuildId -and
      $health.apiVersion -eq $expectedApiVersion
    ) {
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

