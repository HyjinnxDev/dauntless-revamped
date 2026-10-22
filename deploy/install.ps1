# Installs a bundle made by make-bundle.ps1 on the test machine and starts the stack. Run from the bundle
# folder in an admin PowerShell (deploy/README.md lists the programs to install first):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# Safe to run again: files are re-copied, the database is only restored into an empty data folder
# (-RestoreDb replaces the test database with the bundle's copy), and the stack is restarted.
param([switch]$RestoreDb, [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$Bundle = $PSScriptRoot
$Info = Get-Content -Raw "$Bundle\bundle.json" | ConvertFrom-Json
$Root = $Info.targetRoot
$Repo = "$Root\repo"
$V = "$Repo\versions\1.14.7"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'run this from an admin PowerShell (firewall rules and machine settings need it)'
}

function Copy-Tree([string]$From, [string]$To) {
  robocopy $From $To /E /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "copy failed: $From -> $To (robocopy $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}
function Find-Exe([string]$Name, [string]$Pattern) {
  $Hit = Get-Command $Name -ErrorAction SilentlyContinue | ForEach-Object Source
  if (-not $Hit) { $Hit = Get-ChildItem $Pattern -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName }
  return $Hit
}
function Read-EnvValue([string]$File, [string]$Key) {
  if ([IO.File]::ReadAllText($File) -match "(?m)^$Key=`"?([^`"\r\n]*)`"?") { return $Matches[1] } else { return '' }
}

# 1. Programs.
$Mongod = Find-Exe mongod 'C:\Program Files\MongoDB\Server\*\bin\mongod.exe'
$Restore = Find-Exe mongorestore 'C:\Program Files\MongoDB\Tools\*\bin\mongorestore.exe'
$Missing = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $Missing += 'winget install OpenJS.NodeJS.LTS' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $Missing += 'winget install Git.Git' }
if (-not $Mongod) { $Missing += 'MongoDB Server (same major version as the live server): https://www.mongodb.com/try/download/community' }
if (-not $Restore) { $Missing += 'winget install MongoDB.DatabaseTools' }
if ($Missing) { throw "install first, then open a new admin PowerShell:`n  $($Missing -join "`n  ")" }

# 2. Files: code, game, certificates, update files, then each service's .env and game data.
Write-Host "== copying into $Root"
Copy-Tree "$Bundle\repo" $Repo
if (Test-Path "$Bundle\game") { Copy-Tree "$Bundle\game" "$Root\game" }
Copy-Tree "$Bundle\certs" "$Root\data\certs"
Copy-Tree "$Bundle\updates" "$Root\data\updates"
Copy-Item "$Bundle\backend\.env" "$V\ParadoxBackend\.env" -Force
Copy-Tree "$Bundle\backend\game-data" "$V\ParadoxBackend\game-data"
Copy-Item "$Bundle\director\.env" "$V\ParadoxDirector\.env" -Force
Copy-Tree "$Bundle\director\game-data" "$V\ParadoxDirector\game-data"
if (-not (Test-Path "$Root\game\Dauntless_1.14.7\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe")) { throw "game install missing in $Root\game (bundle made with -SkipGame?)" }

# 3. Where restart-server.ps1 finds this machine's game, data and mongod (and the staff console's restart button).
foreach ($Pair in @(@('REVAMPED_GAME_DIR', "$Root\game\Dauntless_1.14.7"), @('REVAMPED_DATA_DIR', "$Root\data"), @('REVAMPED_MONGOD', $Mongod))) {
  [Environment]::SetEnvironmentVariable($Pair[0], $Pair[1], 'Machine')
  Set-Item "env:$($Pair[0])" $Pair[1]
}

# 4. Node packages.
foreach ($Dir in "$V\ParadoxBackend", "$V\ParadoxDirector") {
  Write-Host "== npm ci $Dir"
  Push-Location $Dir; npm ci --no-audit --no-fund; $Code = $LASTEXITCODE; Pop-Location
  if ($Code) { throw "npm ci failed in $Dir" }
}

# 5. Database: start mongod like restart-server.ps1 does, make it the replica set, restore the live copy.
$DbDir = "$Root\data\mongo"
$Fresh = -not (Test-Path $DbDir) -or -not (Get-ChildItem $DbDir -ErrorAction SilentlyContinue)
New-Item -ItemType Directory -Force $DbDir, "$Root\data\logs" | Out-Null
if (-not (Get-NetTCPConnection -State Listen -LocalPort 27018 -ErrorAction SilentlyContinue)) {
  Start-Process $Mongod -WindowStyle Hidden -ArgumentList '--port', '27018', '--bind_ip', '127.0.0.1', '--replSet', 'rs0', '--dbpath', "`"$DbDir`"", '--logpath', "`"$Root\data\mongo.log`"", '--logappend'
  $Deadline = (Get-Date).AddSeconds(60)
  while (-not (Get-NetTCPConnection -State Listen -LocalPort 27018 -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -gt $Deadline) { throw "mongod did not start; see $Root\data\mongo.log" }
    Start-Sleep -Seconds 1
  }
}
Push-Location "$V\ParadoxBackend"; node scripts/init-replset.cjs 127.0.0.1:27018; $Code = $LASTEXITCODE; Pop-Location
if ($Code) { throw 'replica set setup failed' }
if (Test-Path "$Bundle\mongo\db.archive.gz") {
  if ($Fresh -or $RestoreDb) {
    Write-Host '== restoring database copy'
    & $Restore --uri 'mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true' --archive="$Bundle\mongo\db.archive.gz" --gzip --drop --quiet
    if ($LASTEXITCODE) { throw 'mongorestore failed' }
  } else { Write-Host '== database kept (already has data; -RestoreDb replaces it with the bundle copy)' }
}

# 6. Firewall: this machine's ports, open to everyone (outside testers come through the router).
$BackendEnv = "$V\ParadoxBackend\.env"; $DirectorEnv = "$V\ParadoxDirector\.env"
$Https = Read-EnvValue $BackendEnv 'HTTPS_PORT'; $Voice = Read-EnvValue $BackendEnv 'VOICE_UDP_PORT'
$Games = "$(Read-EnvValue $DirectorEnv 'PORT_RANGE_BEGIN')-$(Read-EnvValue $DirectorEnv 'PORT_RANGE_END')"
& "$V\host\host-firewall.ps1" -HttpsPort $Https -GamePorts $Games -VoicePort $Voice -Allowed Any

# 7. Invite links (same certificate fingerprint as live; the launcher keeps servers apart by host:port).
$Fp = node -e "const fs=require('fs');console.log(new (require('crypto').X509Certificate)(fs.readFileSync(process.argv[1])).fingerprint256.replace(/:/g,'').toLowerCase())" (Read-EnvValue $BackendEnv 'PARADOX_CERT_PEM_PATH')
$Code = ((Read-EnvValue $BackendEnv 'LAUNCHER_INVITE_CODES') -split ',')[0].Trim()
$Invites = foreach ($Target in @(@('LAN (you, at home)', $Info.testLanIp), @('Public (outside testers)', $Info.publicIp))) {
  $Query = "v=1&host=$($Target[1])&port=$Https&fp=$Fp&code=$([uri]::EscapeDataString($Code))&name=$([uri]::EscapeDataString('Revamped Test'))"
  "$($Target[0]):`n  dauntless-revamped://join?$Query`n  https://hyjinnxdev.github.io/dauntless-revamped-releases/join/#$Query"
}
$Invites | Set-Content -Encoding utf8 "$Root\invites.txt"
$Invites | Out-Host

$Ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Write-Host "RAM ${Ram} GB: each hunt server takes ~1 GB. Director .env MAX_CONCURRENT_HUNT_SERVERS is $(Read-EnvValue $DirectorEnv 'MAX_CONCURRENT_HUNT_SERVERS') (8 GB ~= 2, 16 GB ~= 4-5)."

# 8. Start backend + Director (logs in $Root\data\logs).
if (-not $NoStart) { & "$V\host\restart-server.ps1" }
