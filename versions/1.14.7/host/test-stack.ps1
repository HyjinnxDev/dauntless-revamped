# Test stack: a second backend + Director for feature branches, running beside the live one and sharing
# nothing it writes. Run it from a worktree (never the live checkout, which it refuses).
#   powershell -ExecutionPolicy Bypass -File versions\1.14.7\host\test-stack.ps1 -Setup   # once
#   ... test-stack.ps1            restart test backend + Director (and mongod if down)
#   ... test-stack.ps1 -Stop      stop them and their game servers
#   ... test-stack.ps1 -Remove    stop, drop the test DB, delete $root. Then: git worktree remove <worktree>
#   ... test-stack.ps1 -Client tester1   start a windowed test client logged in as dev user "tester1"
#       (the test backend's dev login: no launcher; the user is created on first login). Run it again
#       with another name for a second client.
# Live stays on 443/3000/3001/80, UDP 8780-8791, DB mysticparadox, D:\MysticParadoxData.
# Test uses the ports below, DB $testDb, and everything else under $root (a hard-linked game copy, logs,
# updates, crash/launcher logs). Discord, GitHub and admin-login secrets are blanked in the test .env.
# Clients reach it with MYSTICPARADOX_API_BASE=https://paradox.test:4443.
param([switch]$Setup, [switch]$Stop, [switch]$Remove, [string]$Client)

$ErrorActionPreference = 'Stop'
$repo     = Split-Path $PSScriptRoot   # <worktree>\versions\1.14.7
$live     = 'D:\Dev\dauntless-revamped\versions\1.14.7'
$liveGame = 'D:\Dev\dauntless 1.14.7\Dauntless_1.14.7'
$root     = 'D:\MysticParadoxTest'
$game     = "$root\game"
$liveClient = 'D:\Dev\dauntless 1.14.7\Client'
$clientDir = "$root\client"
$logs     = "$root\logs"
$testDb   = 'mysticparadox_test'
$ports    = @{ Http = 3100; Https = 4443; Qos = 8100; Director = 3101; Voice = 8792; RangeBegin = 8800; RangeEnd = 8810 }

if ((Resolve-Path $repo).Path -eq (Resolve-Path $live).Path) { throw 'run this from a worktree, not the live checkout' }

function Read-Env($path) {
  $map = [ordered]@{}
  foreach ($l in Get-Content $path) { if ($l -match '^([A-Z_][A-Z0-9_]*)=(.*)$') { $map[$matches[1]] = $matches[2].Trim('"') } }
  $map
}
function Invoke-Mongo($js) {
  $env:MONGO_URI = (Read-Env "$repo\ParadoxBackend\.env").MONGODB_URI
  $env:TEST_DB = $testDb
  Push-Location "$repo\ParadoxBackend"
  try { node -e $js; if ($LASTEXITCODE) { throw 'mongo script failed' } } finally { Pop-Location }
}

if ($Client) {
  if ($Client -notmatch '^[A-Za-z0-9]{3,16}$') { throw 'client name: 3-16 letters/digits' }
  if (-not (Test-Path $clientDir)) { throw 'run with -Setup first' }
  # The dev login creates a game account but no launcher account, and chat (XMPP) only admits launcher accounts.
  # Test DB only: give this tester the launcher fields (same document, Collections.Accounts).
  $env:TESTER = $Client
  Invoke-Mongo @'
require('mongodb').MongoClient.connect(process.env.MONGO_URI).then(async c => {
  const u = process.env.TESTER;
  await c.db(process.env.TEST_DB).collection('accounts').updateOne({ _id: u }, {
    $set: { displayName: u, displayNameNormalized: u.toLowerCase(), status: 'active', approvalStatus: 'approved', roles: [], usernameSet: true },
    $setOnInsert: { userId: u, name: u, notes: 0, createdAt: new Date().toISOString() },
  }, { upsert: true });
  await c.close();
});
'@
  # Same arguments as the launcher (launcher/src/main/launch.ts); the name doubles as the dev-login code.
  $env:MYSTICPARADOX_API_BASE = "https://paradox.test:$($ports.Https)"
  # 1.14.7 takes its chat (XMPP) server from Engine.ini: the runtime's redirect is not ported. The launcher
  # rewrites this section on every launch, so the next normal launch puts it back.
  $ini = "$env:LOCALAPPDATA\Archon\Saved\Config\WindowsClient\Engine.ini"
  $kept = @(); $skip = $false
  if (Test-Path $ini) {
    foreach ($l in Get-Content $ini -Encoding Unicode) {
      if ($l -match '^\s*\[') { $skip = $l.Trim() -eq '[OnlineSubsystemMcp.XMPP]' }
      if (-not $skip) { $kept += $l }
    }
  }
  Set-Content $ini -Encoding Unicode -Value (@('[OnlineSubsystemMcp.XMPP]', 'ServerAddr="wss://paradox.test"', "ServerPort=$($ports.Https)", 'bUseSSL=true', '') + $kept)
  Start-Process "$clientDir\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe" -ArgumentList @(
    '-DisableEOS', '-EpicPortal', '-NoEAC', '-AUTH_TYPE=exchangecode', '-epicapp=Archon', '-epicenv=Prod',
    '-epicsandboxid=jackal', '-epicdeploymentid=53565ba467df4edbb6f5a3d939a8b4f2',
    "-AUTH_LOGIN=$Client", "-AUTH_PASSWORD=$Client", "-epicusername=$Client", "-epicuserid=$Client",
    "-epicaccountid=$Client", '-epiclocale=en-US', '-windowed', '-ResX=1280', '-ResY=720')
  Write-Host "test client '$Client' starting"
  return
}

# Live .env with the test overrides applied (replaced in place, missing keys appended).
function Write-TestEnv($from, $to, $overrides) {
  $done = @{}
  $out = foreach ($l in Get-Content $from) {
    if ($l -match '^([A-Z_][A-Z0-9_]*)=' -and $overrides.Contains($matches[1])) { $k = $matches[1]; $done[$k] = 1; "$k=`"$($overrides[$k])`"" } else { $l }
  }
  $out += foreach ($k in $overrides.Keys) { if (-not $done[$k]) { "$k=`"$($overrides[$k])`"" } }
  [IO.File]::WriteAllLines($to, [string[]]$out)   # no BOM: node --env-file would read the first key as "﻿PORT"
}
# Hard links (no disk cost; the game never writes these) except Win64, which is real so test DLLs, flags
# and the DLL's own logs never touch the source install.
function Copy-GameLinked($from, $to) {
  if (Test-Path $to) { return }
  $win64 = 'Archon\Binaries\Win64'
  Get-ChildItem -LiteralPath $from -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($from.Length + 1)
    if ($rel.StartsWith('_orig\') -or $_.Name -like 'mysticparadox_dll_port*.log') { return }
    $dst = Join-Path $to $rel
    New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
    if ($rel.StartsWith("$win64\")) {
      if ($_.Name -notmatch '\.dll\.(bak|old|pre)') { Copy-Item -LiteralPath $_.FullName $dst }
    } else { New-Item -ItemType HardLink -Path $dst -Target $_.FullName | Out-Null }
  }
  Write-Host "game copy at $to"
}

# Stop: only test ports and game servers launched from the test game copy.
$servers = Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" | Where-Object { $_.ExecutablePath -like "$game\*" }
$ids = @(Get-NetTCPConnection -State Listen -LocalPort $ports.Http, $ports.Https, $ports.Qos, $ports.Director -ErrorAction SilentlyContinue | ForEach-Object OwningProcess)
$ids += $servers | ForEach-Object ParentProcessId
foreach ($id in ($ids | Sort-Object -Unique)) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if ($p -and $p.Name -eq 'node.exe') { Write-Host "stopping test node $id"; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
foreach ($s in $servers) { Write-Host "stopping test game server $($s.ProcessId)"; Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue }
if ($Stop) { Write-Host 'test stack stopped'; return }

if ($Remove) {
  Start-Sleep -Seconds 2
  Invoke-Mongo "require('mongodb').MongoClient.connect(process.env.MONGO_URI).then(async c => { await c.db(process.env.TEST_DB).dropDatabase(); console.log('dropped ' + process.env.TEST_DB); await c.close(); })"
  # ponytail: plain delete is safe: $root holds copies and hard links only, no junctions.
  if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force; Write-Host "deleted $root" }
  Write-Host "now remove the code: git worktree remove `"$(Split-Path (Split-Path $repo))`""
  return
}

if ($Setup) {
  New-Item -ItemType Directory -Force $logs, "$root\updates" | Out-Null

  # 1. Game copies (server, and a client for -Client): hard links except Win64. Not under the live paths,
  #    so the live restart script's server matching never sees them.
  Copy-GameLinked $liveGame $game
  Copy-GameLinked $liveClient $clientDir

  # 2. Gitignored files the code needs: game data, runtime SDK headers.
  foreach ($d in 'ParadoxBackend\game-data', 'ParadoxDirector\game-data') {
    robocopy "$live\$d" "$repo\$d" /E /XF *.bak* /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  robocopy "$live\ParadoxRuntime" "$repo\ParadoxRuntime" SDK.hpp *.inl PropertyFixup.hpp UnrealContainers.hpp UtfN.hpp deployment_config.generated.h /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy "$live\ParadoxRuntime\SDK" "$repo\ParadoxRuntime\SDK" /E /NFL /NDL /NJH /NJS /NP | Out-Null

  # 3. Test .env files.
  Write-TestEnv "$live\ParadoxBackend\.env" "$repo\ParadoxBackend\.env" ([ordered]@{
    PORT = $ports.Http; HTTPS_PORT = $ports.Https; QOS_PORT = $ports.Qos; VOICE_UDP_PORT = $ports.Voice
    DEPLOYSERVER_URL = "127.0.0.1:$($ports.Director)"
    MONGODB_DB = $testDb; MONGODB_APP_NAME = 'paradox-backend-test'
    LAUNCHER_UPDATE_ROOT = "$root\updates"; UPDATE_PUBLIC_BASE_URL = "https://paradox.test:$($ports.Https)"
    CRASH_REPORT_STORAGE_DIR = "$root\crash-reports"; LAUNCHER_LOG_STORAGE_DIR = "$root\launcher-logs"
    ADMIN_LOG_DIR = $logs; ADMIN_RESTART_SCRIPT = ''; ADMIN_DISCORD_REDIRECT_URI = ''
    GITHUB_CRASH_TOKEN = ''; GITHUB_CRASH_REPO = ''
    DISCORD_NEWS_BOT_TOKEN = ''; DISCORD_NEWS_CHANNEL_ID = ''; DISCORD_STATUS_CHANNEL_ID = ''; DISCORD_GUILD_ID = ''
    DISCORD_CLIENT_ID = ''; DISCORD_CLIENT_SECRET = ''
    HIDESEEK_ENABLED = 1
  })
  Write-TestEnv "$live\ParadoxDirector\.env" "$repo\ParadoxDirector\.env" ([ordered]@{
    PORT = $ports.Director; PORT_RANGE_BEGIN = $ports.RangeBegin; PORT_RANGE_END = $ports.RangeEnd
    GAMESERVER_BINARY_PATH = "$game\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe"
    GAMESERVER_LOG_DIR = "$logs\gameservers"; SERVER_RUNTIME_AUTO_UPDATE = 'false'
    MAX_CONCURRENT_HUNT_SERVERS = 2
    MYSTICPARADOX_API_BASE = "https://paradox.test:$($ports.Https)"   # inherited by test game servers
  })

  # 4. Dependencies, then the test DB as a copy of live (accounts/characters to test with). Kept if it exists.
  foreach ($d in 'ParadoxBackend', 'ParadoxDirector') { Push-Location "$repo\$d"; cmd /c 'npm ci --no-audit --no-fund'; Pop-Location }
  Invoke-Mongo @'
const { MongoClient } = require('mongodb');
MongoClient.connect(process.env.MONGO_URI).then(async c => {
  const src = c.db('mysticparadox'), dst = c.db(process.env.TEST_DB);
  if ((await dst.listCollections().toArray()).length) { console.log('test db exists, kept'); return c.close(); }
  for (const { name, type } of await src.listCollections().toArray()) {
    if (type !== 'collection' || name.startsWith('system.')) continue;
    await src.collection(name).aggregate([{ $match: {} }, { $out: { db: process.env.TEST_DB, coll: name } }]).toArray();
    const idx = (await src.collection(name).indexes()).filter(i => i.name !== '_id_').map(({ v, ns, ...i }) => i);
    if (idx.length) await dst.collection(name).createIndexes(idx);
    console.log('copied ' + name);
  }
  await c.close();
});
'@
  Write-Host 'setup done'
}

if (-not (Test-Path "$repo\ParadoxBackend\.env")) { throw 'run with -Setup first' }
New-Item -ItemType Directory -Force $logs | Out-Null
Start-Sleep -Seconds 2
Remove-Item "$logs\backend.log" -ErrorAction SilentlyContinue   # else the ready check matches the last run

# mongod is shared (separate DB); start it the same way the live script does if it is down.
if (-not (Get-NetTCPConnection -State Listen -LocalPort 27018 -ErrorAction SilentlyContinue)) {
  Start-Process 'C:\Program Files\MongoDB\Server\9.0\bin\mongod.exe' -WindowStyle Hidden -ArgumentList '--port', '27018', '--bind_ip', '127.0.0.1', '--replSet', 'rs0', '--dbpath', 'D:\MysticParadoxData\mongo', '--logpath', 'D:\MysticParadoxData\mongo.log', '--logappend'
  Start-Sleep -Seconds 5
}

Start-Process cmd.exe -ArgumentList '/c', "npm start > `"$logs\backend.log`" 2>&1" -WorkingDirectory "$repo\ParadoxBackend" -WindowStyle Hidden
$deadline = (Get-Date).AddMinutes(3)
while (-not ((Test-Path "$logs\backend.log") -and (Select-String "$logs\backend.log" -Pattern 'paradox=ready|EADDRINUSE|FATAL' -Quiet))) {
  if ((Get-Date) -gt $deadline) { throw "test backend did not start; see $logs\backend.log" }
  Start-Sleep -Seconds 1
}
if (Select-String "$logs\backend.log" -Pattern 'EADDRINUSE|FATAL' -Quiet) { throw "test backend failed; see $logs\backend.log" }
Write-Host 'test backend ready'

Push-Location "$repo\ParadoxDirector"
cmd /c "npm run build > `"$logs\director-build.log`" 2>&1"
Pop-Location
Start-Process cmd.exe -ArgumentList '/c', "node --env-file=.env dist/server.js > `"$logs\director.log`" 2>&1" -WorkingDirectory "$repo\ParadoxDirector" -WindowStyle Hidden
Write-Host "test director started (watch $logs\director.log for 'ramsgate ready')"
