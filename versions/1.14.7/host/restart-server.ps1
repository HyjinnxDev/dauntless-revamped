# Restarts the Dauntless 1.14.7 server stack (Mystic Paradox backend + one Director) so it runs the
# current code and .env. Leaves everything else alone (the 1.4.4 Dauntless Revived stack, game clients).
#   powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\restart-server.ps1"
# Logs: D:\MysticParadoxData\logs\backend.log and director.log
# -DirectorOnly: restart just the Director and its game servers (staff dashboard "Restart Director").
param([switch]$DirectorOnly)

$ErrorActionPreference = 'Stop'
# Admin: a Director started from an elevated window (and its game servers) can only be stopped, or
# even seen, from an elevated one. Asks once through UAC.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList (@('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"") + @(if ($DirectorOnly) { '-DirectorOnly' }))
  return
}
$repo = Split-Path $PSScriptRoot   # versions\1.14.7
$game = 'D:\Dev\dauntless 1.14.7\Dauntless_1.14.7\'
$logs = 'D:\MysticParadoxData\logs'
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

if (-not $DirectorOnly) {
# 2. MongoDB for the backend (hand-started mongod on 27018, not the MongoDB service on 27017).
if (-not (Get-NetTCPConnection -State Listen -LocalPort 27018 -ErrorAction SilentlyContinue)) {
  Start-Process 'C:\Program Files\MongoDB\Server\9.0\bin\mongod.exe' -WindowStyle Hidden -ArgumentList '--port', '27018', '--bind_ip', '127.0.0.1', '--replSet', 'rs0', '--dbpath', 'D:\MysticParadoxData\mongo', '--logpath', 'D:\MysticParadoxData\mongo.log', '--logappend'
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Get-NetTCPConnection -State Listen -LocalPort 27018 -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -gt $deadline) { throw 'mongod did not start; see D:\MysticParadoxData\mongo.log' }
    Start-Sleep -Seconds 1
  }
  Write-Host 'mongod started'
}

# 3. Backend (rebuilds itself when stale), then wait until HTTPS is up.
Start-Process cmd.exe -ArgumentList '/c', "npm start > `"$logs\backend.log`" 2>&1" -WorkingDirectory "$repo\ParadoxBackend" -WindowStyle Hidden
$deadline = (Get-Date).AddMinutes(3)
while (-not (Select-String "$logs\backend.log" -Pattern 'paradox=ready|EADDRINUSE|FATAL' -Quiet -ErrorAction SilentlyContinue)) {
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
