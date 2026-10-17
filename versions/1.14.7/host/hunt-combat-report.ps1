# Summarizes one hunt's combat log written by MysticParadox.dll (MpHuntCombatLog, 0.2.x+ server build).
#   Newest hunt:   powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\hunt-combat-report.ps1"
#   Pick one:      ... hunt-combat-report.ps1 -List      then      ... hunt-combat-report.ps1 -File <path>
# Logs: <game exe dir>\HuntCombat\hunt_<start>_port<N>.log, one per hunt server process.
# Lines: montage = behemoth attack began; try/ok/REJECT = predicted hit and the server's verdict; dmg = player took behemoth damage.
# "no dmg within Ns" on a montage = that attack never hurt anyone: either everyone dodged, or the hit never registered.
param([string]$File, [switch]$List, [double]$Window = 4,
      [string]$Dir = 'D:\Dev\dauntless 1.14.7\Dauntless_1.14.7\Archon\Binaries\Win64\HuntCombat')

$logs = Get-ChildItem $Dir -Filter 'hunt_*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if ($List) { $logs | Select-Object -First 20 LastWriteTime, Length, FullName | Format-Table -AutoSize; return }
if (-not $File) { if (-not $logs) { throw "no hunt logs in $Dir" }; $File = $logs[0].FullName }

$lines = Get-Content $File
"== $File"; $lines | Where-Object { $_ -like '#*' }
function Field($l, $k) { if ($l -match "\b$k=(\S+)") { $Matches[1] } }
$ev = foreach ($l in $lines) {
  if ($l -match '^t=([\d.]+) (\S+)') { [pscustomobject]@{ t = [double]$Matches[1]; kind = $Matches[2]; line = $l } }
}

"`n-- Predicted hits by attack key (try = client claimed a hit; REJECT = server refused it)"
$ev | Where-Object kind -in 'try', 'ok', 'REJECT' | Group-Object { Field $_.line 'key' } | ForEach-Object {
  $g = $_.Group; function N($kind) { @($g | Where-Object kind -ceq $kind).Count }
  [pscustomobject]@{ key = $_.Name; try = (N 'try'); ok = (N 'ok'); REJECT = (N 'REJECT') }
} | Sort-Object REJECT, try -Descending | Format-Table -AutoSize

$rej = $ev | Where-Object kind -eq 'REJECT'
if ($rej) { "-- Rejected hits"; $rej.line }

$dmg = @($ev | Where-Object kind -eq 'dmg')
"`n-- Behemoth attacks (montages) and whether any player took behemoth damage within ${Window}s"
$ev | Where-Object kind -eq 'montage' | Group-Object { Field $_.line 'montage' } | ForEach-Object {
  $hit = @($_.Group | Where-Object { $m = $_.t; $dmg | Where-Object { $_.t -ge $m -and $_.t -le $m + $Window } }).Count
  [pscustomobject]@{ montage = $_.Name; fired = $_.Count; ledToDmg = $hit; noDmg = $_.Count - $hit }
} | Sort-Object noDmg -Descending | Format-Table -AutoSize

"-- Damage taken: $($dmg.Count) events"
$dmg | Group-Object { (Field $_.line 'target') + ' <- ' + (Field $_.line 'giver') } |
  Select-Object Count, Name | Sort-Object Count -Descending | Format-Table -AutoSize

$other = $ev | Where-Object kind -like 'fn=*'
if ($other) { "-- Other DamageComponent calls seen"; $other.line }
