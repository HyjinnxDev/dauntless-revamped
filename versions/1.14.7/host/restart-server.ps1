# Restarts the Dauntless 1.14.7 server stack (Mystic Paradox backend + one Director) so it runs the
# current code and .env. Leaves everything else alone (the 1.4.4 Dauntless Revived stack, game clients).
#   powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\restart-server.ps1"
# Logs: D:\MysticParadoxData\logs\backend.log and director.log (REVAMPED_DATA_DIR\logs on another host)
# -DirectorOnly: restart just the Director and its game servers (staff dashboard "Restart Director").
# -Stop: stop the backend, Director and game servers, start nothing (mongod is left running).
param([switch]$DirectorOnly, [switch]$Stop)

$ErrorActionPreference = 'Stop'
# Admin: a Director started from an elevated window (and its game servers) can only be stopped, or
# even seen, from an elevated one. Asks once through UAC.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList (@('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"") + @(if ($DirectorOnly) { '-DirectorOnly' }) + @(if ($Stop) { '-Stop' }))
  return
}
$repo = Split-Path $PSScriptRoot   # versions\1.14.7
# Machine paths. Another host (deploy/README.md) sets them as machine environment variables; unset = this PC.
$game = if ($env:REVAMPED_GAME_DIR) { $env:REVAMPED_GAME_DIR.TrimEnd('\') + '\' } else { 'D:\Dev\dauntless 1.14.7\Dauntless_1.14.7\' }
$data = if ($env:REVAMPED_DATA_DIR) { $env:REVAMPED_DATA_DIR.TrimEnd('\') } else { 'D:\MysticParadoxData' }
$mongod = if ($env:REVAMPED_MONGOD) { $env:REVAMPED_MONGOD } else { 'C:\Program Files\MongoDB\Server\9.0\bin\mongod.exe' }
$logs = "$data\logs"
New-Item -ItemType Directory -Force $logs | Out-Null

# 1. What to stop: the owners of the backend/Director ports, every node that runs 1.14.7 game servers
#    (a second Director would), and those game servers.
$servers = Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" |
  Where-Object { $_.ExecutablePath -like "$game*" -and $_.CommandLine -match '(^|\s)-server(\s|$)' }
$ids = @()
$ports = if ($DirectorOnly) { 3001 } else { 443, 3000, 3001 }
$ids += Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue | ForEach-Object OwningProcess
$ids += $servers | ForEach-Object ParentProcessId
$ids = $ids | Sort-Object -Unique | Where-Object {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_"
  $p -and $p.Name -eq 'node.exe'
}
foreach ($id in $ids) { Write-Host "stopping node $id"; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
foreach ($s in $servers) { Write-Host "stopping game server $($s.ProcessId)"; Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
if ($Stop) { Write-Host 'stopped'; return }

if (-not $DirectorOnly) {
# 2. MongoDB for the backend (hand-started mongod on 27018, not the MongoDB service on 27017).
if (-not (Get-NetTCPConnection -State Listen -LocalPort 27018 -ErrorAction SilentlyContinue)) {
  Start-Process $mongod -WindowStyle Hidden -ArgumentList '--port', '27018', '--bind_ip', '127.0.0.1', '--replSet', 'rs0', '--dbpath', "`"$data\mongo`"", '--logpath', "`"$data\mongo.log`"", '--logappend'
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Get-NetTCPConnection -State Listen -LocalPort 27018 -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -gt $deadline) { throw "mongod did not start; see $data\mongo.log" }
    Start-Sleep -Seconds 1
  }
  Write-Host 'mongod started'
}

# 3. Backend (rebuilds itself when stale), then wait until HTTPS is up.
Remove-Item "$logs\backend.log" -ErrorAction SilentlyContinue   # else the ready check can match the last run
Start-Process cmd.exe -ArgumentList '/c', "npm start > `"$logs\backend.log`" 2>&1" -WorkingDirectory "$repo\ParadoxBackend" -WindowStyle Hidden
$deadline = (Get-Date).AddMinutes(3)
# Test-Path first: under ErrorActionPreference=Stop, Select-String throws on a missing file despite SilentlyContinue.
while (-not ((Test-Path "$logs\backend.log") -and (Select-String "$logs\backend.log" -Pattern 'paradox=ready|EADDRINUSE|FATAL' -Quiet))) {
  if ((Get-Date) -gt $deadline) { throw "backend did not start; see $logs\backend.log" }
  Start-Sleep -Seconds 1
}
if (Select-String "$logs\backend.log" -Pattern 'EADDRINUSE|FATAL' -Quiet) { throw "backend failed; see $logs\backend.log" }
Write-Host 'backend ready'
}

# 4. One Director (it does not rebuild on start).
Push-Location "$repo\ParadoxDirector"
cmd /c "npm run build > `"$logs\director-build.log`" 2>&1"
Pop-Location
Start-Process cmd.exe -ArgumentList '/c', "node --env-file=.env dist/server.js > `"$logs\director.log`" 2>&1" -WorkingDirectory "$repo\ParadoxDirector" -WindowStyle Hidden
Write-Host "director started; Ramsgate and the Dojo take a minute (watch $logs\director.log for 'ramsgate ready')"
