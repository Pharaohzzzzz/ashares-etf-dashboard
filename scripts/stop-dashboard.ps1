$ErrorActionPreference = 'Stop'

$connections = Get-NetTCPConnection -LocalPort 37821 -State Listen -ErrorAction SilentlyContinue
$processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
$processes = @(
  $processIds |
    ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -eq 'node' }
)

if (-not $processes) {
  Write-Output 'No ETF dashboard process is running.'
  exit 0
}

foreach ($process in $processes) {
  Stop-Process -Id $process.Id -Force
}

Write-Output ('Stopped ETF dashboard processes: ' + $processes.Count)

