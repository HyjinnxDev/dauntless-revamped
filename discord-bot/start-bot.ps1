# (Re)starts the Discord bot in the background: stops a running copy, builds, starts, logs to bot.log here.
#   powershell -ExecutionPolicy Bypass -File discord-bot\start-bot.ps1
# Only one copy per token may run (two would answer every /issue twice). -Stop stops it and starts nothing.
param([switch]$Stop)

$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*dist/bot.js*" -and $_.CommandLine -like "*--env-file*" } |
  ForEach-Object { Write-Host "stopping bot $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($Stop) { return }

Push-Location $PSScriptRoot
try {
  if (-not (Test-Path .env)) { throw 'no .env here: copy .env.example to .env and fill it in' }
  if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed' } }
  npm run build; if ($LASTEXITCODE) { throw 'build failed' }
  Start-Process cmd.exe -ArgumentList '/c', 'node --env-file=.env dist/bot.js > bot.log 2>&1' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  Write-Host "bot started; log: $PSScriptRoot\bot.log"
} finally { Pop-Location }
