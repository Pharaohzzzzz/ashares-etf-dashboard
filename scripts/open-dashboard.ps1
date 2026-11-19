$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'start-dashboard.ps1')
Start-Process 'http://127.0.0.1:37821'

