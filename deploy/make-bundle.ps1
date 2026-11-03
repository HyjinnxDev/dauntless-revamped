# Builds the test-server bundle: one folder with everything a second Windows machine needs to run the
# Dauntless 1.14.7 stack (deploy/README.md). Reads the live server: its .env files, game data, update files, game
# install and a mongodump of its database. Nothing live is stopped or restarted; the database copy is scrubbed in a
# temporary database (revamped_bundle_scrub) on the live mongod, then dropped.
# [Revamped 2026-11-03] FINDINGS M2: the bundle gets its OWN secrets (signing keys, gameserver key, hash secret,
# admin TOTP, invite code), its own self-signed certificate, and a database without sign-ins, sessions, emails or
# password hashes, so losing the bundle or the test box never exposes live accounts or keys.
#   powershell -ExecutionPolicy Bypass -File deploy\make-bundle.ps1 -TestLanIp 192.168.1.50
# Re-run to refresh it (code is pulled, files are re-copied). -SkipGame / -SkipDb leave those parts as they are.
# The bundle holds the test server's own secrets (.env files, TLS key): still keep it off cloud folders.
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
. "$Live\versions\1.14.7\host\new-test-secrets.ps1"
$ScrubDb = 'revamped_bundle_scrub'
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
$Secrets = New-TestSecrets $V

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
$BackendSet = @{
  HTTPS_PORT = $Ports.Https
  VOICE_UDP_PORT = $Ports.Voice
  REALTIME_XMPP_ALLOWED_HOSTS = $Hosts -join ','
  GITHUB_CRASH_TOKEN = ''
  DISCORD_NEWS_BOT_TOKEN = ''
  DISCORD_BOT_URL = ''
  UPDATE_PUBLISHER_ALLOWED_IPS = ''
  PARADOX_KEY_PASSPHRASE = ''   # the bundle's own certificate key (step 4) is not encrypted
}
foreach ($Key in $Secrets.Backend.Keys) { $BackendSet[$Key] = $Secrets.Backend[$Key] }
$BackendTest = Convert-Env $BackendEnv $BackendSet
[IO.File]::WriteAllText("$Out\backend\.env", $BackendTest)
Copy-Tree "$V\ParadoxBackend\game-data" "$Out\backend\game-data"

# 3. Director: test .env (public address for outside testers, test UDP range) + game data.
Write-Host '== director'
New-Item -ItemType Directory -Force "$Out\director" | Out-Null
$DirectorTest = Convert-Env $DirectorEnv @{
  MY_IP = $PublicIp
  PORT_RANGE_BEGIN = $Ports.GameFirst
  PORT_RANGE_END = $Ports.GameLast
  METAGAME_API_KEY = $Secrets.Director.METAGAME_API_KEY
}
[IO.File]::WriteAllText("$Out\director\.env", $DirectorTest)
Copy-Tree "$V\ParadoxDirector\game-data" "$Out\director\game-data"

# 4. A certificate of its own (the launcher pins its fingerprint; the live key never leaves this PC) and the signed
#    runtime/launcher updates.
Write-Host '== certs, updates'
$OpenSsl = Get-Command openssl -ErrorAction SilentlyContinue | ForEach-Object Source
if (-not $OpenSsl) { $OpenSsl = 'C:\Program Files\Git\usr\bin\openssl.exe' }
if (-not (Test-Path $OpenSsl)) { throw 'openssl not found (it ships with Git for Windows)' }
New-Item -ItemType Directory -Force "$Out\certs" | Out-Null
if (-not (Test-Path "$Out\certs\fullchain.pem")) {
  & $OpenSsl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -subj '/CN=revamped-test' -keyout "$Out\certs\privkey.pem" -out "$Out\certs\fullchain.pem" 2>&1 | Out-Null
  if ($LASTEXITCODE) { throw 'test certificate generation failed' }
}
Copy-Tree "$Data\updates" "$Out\updates"

# 5. Database copy. mongodump only reads; the live server keeps running.
if (-not $SkipDb) {
  Write-Host '== mongo dump'
  $Dump = Get-Command mongodump -ErrorAction SilentlyContinue | ForEach-Object Source
  if (-not $Dump) { $Dump = Get-ChildItem 'C:\Program Files\MongoDB\Tools\*\bin\mongodump.exe' -ErrorAction SilentlyContinue | Select-Object -Last 1 -ExpandProperty FullName }
  if (-not $Dump) { throw 'mongodump not found: winget install MongoDB.DatabaseTools (or re-run with -SkipDb)' }
  $RestoreTool = Join-Path (Split-Path $Dump) 'mongorestore.exe'
  $Uri = Read-EnvValue $BackendEnv 'MONGODB_URI'; $LiveDb = Read-EnvValue $BackendEnv 'MONGODB_DB'
  if ($LiveDb -eq $ScrubDb) { throw "the live database is named $ScrubDb?" }
  New-Item -ItemType Directory -Force "$Out\mongo" | Out-Null
  $Raw = "$env:TEMP\revamped-live-dump.gz"
  & $Dump --uri $Uri --db $LiveDb --archive="$Raw" --gzip --quiet
  if ($LASTEXITCODE) { throw 'mongodump failed (is the live mongod on 27018 running?)' }
  # Into a scratch database (never the live one: --nsTo renames, --drop only touches the scratch copy), scrub, dump.
  & $RestoreTool --uri $Uri --archive="$Raw" --gzip --nsFrom "$LiveDb.*" --nsTo "$ScrubDb.*" --drop --quiet
  if ($LASTEXITCODE) { throw 'scratch restore failed' }
  Remove-Item $Raw -Force
  $env:MONGO_URI = $Uri; $env:SCRUB_DB = $ScrubDb
  Push-Location "$V\ParadoxBackend"
  try {
    node -e @'
const { MongoClient } = require('mongodb');
MongoClient.connect(process.env.MONGO_URI).then(async (c) => {
  if (process.env.SCRUB_DB !== 'revamped_bundle_scrub') throw new Error('refusing to scrub ' + process.env.SCRUB_DB);
  const db = c.db(process.env.SCRUB_DB);
  // Sign-ins, sessions, keys, staff authenticators and the audit log (IPs) don't travel.
  for (const name of ['refreshSessions', 'authIdentities', 'adminSessions', 'adminMfa', 'adminAudit', 'userApiKeys', 'gameServerApiKeys',
    'gameExchangeCodes', 'discordOAuthTransactions', 'launcherGuardSessions']) await db.collection(name).drop().catch(() => undefined);
  // No emails or password hashes: testers register again on the test server.
  const r = await db.collection('accounts').updateMany({ email: { $type: 'string' } },
    [{ $set: { email: { $concat: [{ $toString: '$_id' }, '@test.invalid'] } } }, { $unset: ['passwordHash'] }]);
  await db.collection('accounts').updateMany({ passwordHash: { $exists: true } }, { $unset: { passwordHash: '' } });
  console.log('scrubbed ' + r.modifiedCount + ' account emails');
  await c.close();
}).catch((e) => { console.error(e.message); process.exit(1); });
'@
    if ($LASTEXITCODE) { throw 'database scrub failed' }
  } finally { Pop-Location }
  & $Dump --uri $Uri --db $ScrubDb --archive="$Out\mongo\db.archive.gz" --gzip --quiet
  $DumpCode = $LASTEXITCODE
  Push-Location "$V\ParadoxBackend"
  try { node -e "require('mongodb').MongoClient.connect(process.env.MONGO_URI).then(async c => { await c.db('$ScrubDb').dropDatabase(); await c.close(); })" } finally { Pop-Location }
  if ($DumpCode) { throw 'mongodump of the scrubbed copy failed' }
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
  targetRoot = $TargetRoot; testLanIp = $TestLanIp; publicIp = $PublicIp; ports = $Ports; dumpDb = $ScrubDb
} | ConvertTo-Json | Set-Content -Encoding ascii "$Out\bundle.json"
Write-Host "test admin authenticator secret (add it to your app for the test console): $($Secrets.Backend.ADMIN_TOTP_SECRET)"
Write-Host "bundle ready: $Out  (copy the whole folder to the test machine, then run install.ps1 there as admin)"
