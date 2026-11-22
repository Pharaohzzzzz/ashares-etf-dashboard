$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = (Join-Path $projectRoot 'server\index.js').Replace('\', '/')
$escapedEntry = [regex]::Escape($entry)
$nodeCommand = '^\s*(?:"[^"]+"|\S+)\s+'
$entryPattern = $nodeCommand + '(?:"' + $escapedEntry + '"|' + $escapedEntry + ')(?:\s|$)'
$legacyPattern = $nodeCommand + '(?:"server/index\.js"|server/index\.js)(?:\s|$)'
$connections = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 37821 -State Listen -ErrorAction SilentlyContinue
$processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)

if (-not $processIds) {
  Write-Output 'No ETF dashboard process is running.'
  exit 0
}

$stoppedCount = 0
foreach ($processId in $processIds) {
  $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId"
  if (-not $process) { continue }
  $command = ([string]$process.CommandLine).Replace('\', '/')
  $isDashboard = $process.Name -eq 'node.exe' -and $command -match $entryPattern
  if (-not $isDashboard -and $process.Name -eq 'node.exe' -and $command -match $legacyPattern) {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:37821/api/health' -TimeoutSec 2
      $isDashboard = $health.status -in @('ok', 'starting', 'degraded') -and
        $health.buildId -match '^[a-f0-9]{16}$' -and $health.apiVersion -and
        $null -ne $health.etfs
    } catch {
      $isDashboard = $false
    }
  }
  if (-not $isDashboard) {
    throw "The process on port 37821 could not be identified as ETF dashboard (PID $processId)."
  }
  Stop-Process -Id $processId
  $stoppedCount++
}

Write-Output ('Stopped ETF dashboard processes: ' + $stoppedCount)

