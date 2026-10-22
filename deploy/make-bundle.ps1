# Builds the test-server bundle: one folder with everything a second Windows machine needs to run the
# Dauntless 1.14.7 stack (deploy/README.md). Only READS the live server: its .env files, game data, certificates,
# update files, game install and a mongodump of its database. Nothing live is stopped, changed or restarted.
#   powershell -ExecutionPolicy Bypass -File deploy\make-bundle.ps1 -TestLanIp 192.168.1.50
# Re-run to refresh it (code is pulled, files are re-copied). -SkipGame / -SkipDb leave those parts as they are.
# The bundle holds secrets (.env files, TLS private key): keep it on your own drives, never in a cloud folder.
param(
  [Parameter(Mandatory)][string]$TestLanIp,                  # the test machine's LAN address
  [string]$PublicIp,                                         # default: live Director MY_IP (same router)
  [string]$Out = 'D:\RevampedBundle',
  [string]$TargetRoot = 'C:\Revamped',                       # where install.ps1 puts it on the test machine
  [string]$Branch = 'deploy-split',                          # code to ship
  [string]$Live = 'D:\Dev\dauntless-revamped',               # live repo (its .env files and game data)
  [string]$Game = 'D:\Dev\dauntless 1.14.7\Dauntless_1.14.7',
  [string]$Data = 'D:\MysticParadoxData',
  [switch]$SkipGame,
  [switch]$SkipDb
)

$ErrorActionPreference = 'Stop'
# Test ports: the live box keeps 443 / UDP 8780-8791 on the router, so the test box gets its own.
$Ports = @{ Https = 9443; GameFirst = 9780; GameLast = 9790; Voice = 9791 }
$V = "$Live\versions\1.14.7"

function Read-EnvValue([string]$Text, [string]$Key) {
  if ($Text -match "(?m)^$Key=`"?([^`"\r\n]*)`"?") { return $Matches[1] } else { return '' }
}

# Live .env text -> test .env text: live paths become test-machine paths, then the listed keys are set.
function Convert-Env([string]$Text, [hashtable]$Set) {
  $Map = [ordered]@{ "$Game" = "$TargetRoot\game\Dauntless_1.14.7"; "$Live" = "$TargetRoot\repo"; "$Data" = "$TargetRoot\data" }
  foreach ($From in $Map.Keys) {
    # Both spellings: D:\x\y and D:/x/y.
    foreach ($Slash in '\', '/') {
      $Text = [regex]::Replace($Text, [regex]::Escape($From.Replace('\', $Slash)), $Map[$From].Replace('\', $Slash).Replace('$', '$$'), 'IgnoreCase')
    }
  }
  foreach ($Key in $Set.Keys) {
    $Line = "$Key=`"$($Set[$Key])`""
    if ($Text -match "(?m)^$Key=") { $Text = [regex]::Replace($Text, "(?m)^$Key=[^\r\n]*", $Line.Replace('$', '$$')) }
    else { $Text = $Text.TrimEnd() + "`r`n$Line`r`n" }
  }
  # Any live-machine path left over would point at a drive the test machine doesn't have.
  $Left = [regex]::Matches($Text, '(?m)^([A-Z0-9_]+)=.*\b[D-Z]:[\\/]') | ForEach-Object { $_.Groups[1].Value }
  if ($Left) { Write-Warning "still pointing at this PC's drives, fix by hand: $($Left -join ', ')" }
  return $Text
}

function Copy-Tree([string]$From, [string]$To, [string[]]$Extra = @()) {
  robocopy $From $To /E /R:1 /W:1 /NFL /NDL /NJH /NP @Extra | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "copy failed: $From -> $To (robocopy $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

New-Item -ItemType Directory -Force $Out | Out-Null
# .env files are UTF-8 without BOM (a BOM would break the first key for node --env-file).
$BackendEnv = [IO.File]::ReadAllText("$V\ParadoxBackend\.env")
$DirectorEnv = [IO.File]::ReadAllText("$V\ParadoxDirector\.env")
if (-not $PublicIp) { $PublicIp = Read-EnvValue $DirectorEnv 'MY_IP' }

# 1. Code: a clone of the branch, its remote set to GitHub so the test machine can pull later.
Write-Host "== repo ($Branch)"
if (Test-Path "$Out\repo\.git") { git -C "$Out\repo" pull -q --ff-only $Live $Branch }
else {
  git clone -q --branch $Branch --single-branch $Live "$Out\repo"
  git -C "$Out\repo" remote set-url origin (git -C $Live remote get-url origin)
}
if ($LASTEXITCODE) { throw 'git failed' }

# 2. Backend: test .env + game data. Crash reports and update pushes stay with the live server; no bot.
Write-Host '== backend'
$Hosts = @((Read-EnvValue $BackendEnv 'REALTIME_XMPP_ALLOWED_HOSTS') -split ',' | Where-Object { $_ }) + $TestLanIp + $PublicIp | Select-Object -Unique
New-Item -ItemType Directory -Force "$Out\backend" | Out-Null
$BackendTest = Convert-Env $BackendEnv @{
  HTTPS_PORT = $Ports.Https
  VOICE_UDP_PORT = $Ports.Voice
  REALTIME_XMPP_ALLOWED_HOSTS = $Hosts -join ','
  GITHUB_CRASH_TOKEN = ''
  DISCORD_NEWS_BOT_TOKEN = ''
  DISCORD_BOT_URL = ''
  UPDATE_PUBLISHER_ALLOWED_IPS = ''
}
[IO.File]::WriteAllText("$Out\backend\.env", $BackendTest)
Copy-Tree "$V\ParadoxBackend\game-data" "$Out\backend\game-data"

# 3. Director: test .env (public address for outside testers, test UDP range) + game data.
Write-Host '== director'
New-Item -ItemType Directory -Force "$Out\director" | Out-Null
$DirectorTest = Convert-Env $DirectorEnv @{
  MY_IP = $PublicIp
  PORT_RANGE_BEGIN = $Ports.GameFirst
  PORT_RANGE_END = $Ports.GameLast
}
[IO.File]::WriteAllText("$Out\director\.env", $DirectorTest)
Copy-Tree "$V\ParadoxDirector\game-data" "$Out\director\game-data"

# 4. Certificates (the launcher pins this certificate's fingerprint) and signed runtime/launcher updates.
Write-Host '== certs, updates'
Copy-Tree "$Data\certs" "$Out\certs"
Copy-Tree "$Data\updates" "$Out\updates"

# 5. Database copy. mongodump only reads; the live server keeps running.
if (-not $SkipDb) {
  Write-Host '== mongo dump'
  $Dump = Get-Command mongodump -ErrorAction SilentlyContinue | ForEach-Object Source
  if (-not $Dump) { $Dump = Get-ChildItem 'C:\Program Files\MongoDB\Tools\*\bin\mongodump.exe' -ErrorAction SilentlyContinue | Select-Object -Last 1 -ExpandProperty FullName }
  if (-not $Dump) { throw 'mongodump not found: winget install MongoDB.DatabaseTools (or re-run with -SkipDb)' }
  New-Item -ItemType Directory -Force "$Out\mongo" | Out-Null
  & $Dump --uri (Read-EnvValue $BackendEnv 'MONGODB_URI') --db (Read-EnvValue $BackendEnv 'MONGODB_DB') --archive="$Out\mongo\db.archive.gz" --gzip --quiet
  if ($LASTEXITCODE) { throw 'mongodump failed (is the live mongod on 27018 running?)' }
}

# 6. Game install (~16 GB) without the old runtime DLL backups.
if (-not $SkipGame) {
  Write-Host '== game install'
  Copy-Tree $Game "$Out\game\Dauntless_1.14.7" @('/XF', 'MysticParadox.dll.bak*', 'MysticParadox.dll.old*')
}

# 7. Installer, guide and what this bundle was made for.
Copy-Item "$PSScriptRoot\install.ps1", "$PSScriptRoot\README.md" $Out -Force
[ordered]@{
  created = (Get-Date).ToString('s'); branch = $Branch; commit = (git -C "$Out\repo" rev-parse --short HEAD)
  targetRoot = $TargetRoot; testLanIp = $TestLanIp; publicIp = $PublicIp; ports = $Ports
} | ConvertTo-Json | Set-Content -Encoding ascii "$Out\bundle.json"
Write-Host "bundle ready: $Out  (copy the whole folder to the test machine, then run install.ps1 there as admin)"
