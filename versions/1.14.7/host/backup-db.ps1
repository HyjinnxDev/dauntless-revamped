# Dumps the live backend database (mongodump only reads; nothing is stopped) to one gzip archive and keeps the newest -Keep.
#   powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\backup-db.ps1"
#   -CopyTo E:\RevampedBackups   also copies the new archive there (another drive / synced folder; it holds account data)
# Restore (stop the backend first; --drop replaces each collection):
#   mongorestore --uri "<MONGODB_URI>" --archive=<file> --gzip --drop --nsInclude "mysticparadox.*"
# Needs MongoDB Database Tools: winget install MongoDB.DatabaseTools
param(
  [string]$Out = 'D:\MysticParadoxData\backups\db',
  [int]$Keep = 14,
  [string]$CopyTo
)
$ErrorActionPreference = 'Stop'
$EnvText = Get-Content -Raw "$PSScriptRoot\..\ParadoxBackend\.env"
function Read-EnvValue([string]$Key) { if ($EnvText -match "(?m)^$Key=`"?([^`"\r\n]*)`"?") { $Matches[1] } else { '' } }

$Dump = Get-Command mongodump -ErrorAction SilentlyContinue | ForEach-Object Source
if (-not $Dump) { $Dump = Get-ChildItem 'C:\Program Files\MongoDB\Tools\*\bin\mongodump.exe' -ErrorAction SilentlyContinue | Select-Object -Last 1 -ExpandProperty FullName }
if (-not $Dump) { throw 'mongodump not found: winget install MongoDB.DatabaseTools' }

New-Item -ItemType Directory -Force $Out | Out-Null
$File = Join-Path $Out ("mysticparadox-{0}.archive.gz" -f (Get-Date -Format 'yyyy-MM-dd_HHmm'))
& $Dump --uri (Read-EnvValue 'MONGODB_URI') --db (Read-EnvValue 'MONGODB_DB') --archive="$File" --gzip --quiet
if ($LASTEXITCODE) { Remove-Item $File -ErrorAction SilentlyContinue; throw 'mongodump failed (is the live mongod on 27018 running?)' }
Write-Host ("backup {0} ({1:N1} MB)" -f $File, ((Get-Item $File).Length / 1MB))

if ($CopyTo) { New-Item -ItemType Directory -Force $CopyTo | Out-Null; Copy-Item $File $CopyTo -Force }
foreach ($Dir in @($Out, $CopyTo) | Where-Object { $_ }) {
  Get-ChildItem $Dir -Filter 'mysticparadox-*.archive.gz' | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item
}
