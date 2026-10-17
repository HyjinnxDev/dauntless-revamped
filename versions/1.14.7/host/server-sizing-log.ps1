# Logs what the 1.14.7 server stack costs, so you can size a host.
#   Sample (leave running during play sessions; Ctrl+C to stop, run elevated like restart-server.ps1):
#     powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\server-sizing-log.ps1"
#   Report:
#     powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\server-sizing-log.ps1" -Summary
# Output: D:\MysticParadoxData\logs\sizing.csv (one row / interval; safe to append across sessions)
# Groups: mongo, backend (owns 443/3000), director (owns 3001), hub (UDP 8789/8790 servers), hunt (other game servers).
# cpu_* = cores busy (1.0 = one full core). ram_* = MB working set. net = host NIC KB/s (loopback not counted).
# players = remote clients on backend 443. Run the game CLIENT on a different PC for clean numbers: a local client's CPU/RAM is not server cost.
param([int]$Interval = 10, [switch]$Summary, [string]$csv = 'D:\MysticParadoxData\logs\sizing.csv')

if ($Summary) {
  $r = Import-Csv $csv
  if (-not $r) { throw "no rows in $csv" }
  $cores = [Environment]::ProcessorCount
  function Pk($c) { ($r | ForEach-Object { [double]$_.$c } | Measure-Object -Maximum -Average) }
  $tot = $r | ForEach-Object { [double]$_.cpu_mongo + $_.cpu_backend + $_.cpu_director + $_.cpu_hub + $_.cpu_hunt }
  $ram = $r | ForEach-Object { [double]$_.ram_mongo + $_.ram_backend + $_.ram_director + $_.ram_hub + $_.ram_hunt }
  $cp = ($tot | Measure-Object -Maximum -Average); $rp = ($ram | Measure-Object -Maximum -Average)
  $pl = Pk 'players'; $hs = Pk 'hunts'; $net = Pk 'net_in_kbs'; $nout = Pk 'net_out_kbs'
  "samples: $($r.Count)  from $($r[0].time) to $($r[-1].time)  (sampled on a $cores-thread machine)"
  "peak players (443 conns): $($pl.Maximum)   peak concurrent hunts: $($hs.Maximum)"
  "CPU cores busy   peak {0:N2}  avg {1:N2}" -f $cp.Maximum, $cp.Average
  "RAM total MB     peak {0:N0}  avg {1:N0}" -f $rp.Maximum, $rp.Average
  "  by group peak MB: mongo {0:N0}, backend {1:N0}, director {2:N0}, hubs {3:N0}, hunts {4:N0}" -f (Pk 'ram_mongo').Maximum, (Pk 'ram_backend').Maximum, (Pk 'ram_director').Maximum, (Pk 'ram_hub').Maximum, (Pk 'ram_hunt').Maximum
  "Net KB/s         in peak {0:N0}  out peak {1:N0}" -f $net.Maximum, $nout.Maximum
  $perHunt = $r | Where-Object { [int]$_.hunts -gt 0 } | ForEach-Object { [double]$_.ram_hunt / [int]$_.hunts }
  $perHuntCpu = $r | Where-Object { [int]$_.hunts -gt 0 } | ForEach-Object { [double]$_.cpu_hunt / [int]$_.hunts }
  if ($perHunt) { "per hunt server: RAM peak {0:N0} MB, CPU peak {1:N2} cores" -f ($perHunt | Measure-Object -Maximum).Maximum, ($perHuntCpu | Measure-Object -Maximum).Maximum }
  # Sizing: measured peak + 30% headroom, + OS ~2 GB. MAX_CONCURRENT_HUNT_SERVERS caps hunts at 3 in .env.
  $needGb = [math]::Ceiling(($rp.Maximum * 1.3 + 2048) / 1024)
  $needCores = [math]::Max(2, [math]::Ceiling($cp.Maximum * 1.3))
  ""
  "SUGGESTED MINIMUM (peak +30%): $needCores vCPU, $needGb GB RAM, 20 GB disk for stack + ~16 GB game files if you serve downloads from the host."
  "Bandwidth: peak out {0:N1} Mbit/s. Game downloads (16 GB/friend) will dwarf this; check transfer quota." -f ($nout.Maximum * 8 / 1000)
  "Caveat: only valid for the player/hunt counts above. Re-run after a busier session."
  return
}

New-Item -ItemType Directory -Force (Split-Path $csv) | Out-Null
if (-not (Test-Path $csv)) {
  'time,players,hunts,cpu_mongo,cpu_backend,cpu_director,cpu_hub,cpu_hunt,ram_mongo,ram_backend,ram_director,ram_hub,ram_hunt,net_in_kbs,net_out_kbs' | Set-Content $csv
}
$cores = [Environment]::ProcessorCount
$prev = @{}; $prevNet = $null; $prevT = Get-Date
function NetNow { $s = Get-NetAdapterStatistics | Where-Object { $_.ReceivedBytes -or $_.SentBytes }; @{ i = ($s | Measure-Object ReceivedBytes -Sum).Sum; o = ($s | Measure-Object SentBytes -Sum).Sum } }
$prevNet = NetNow
Write-Host "sampling every ${Interval}s to $csv  (Ctrl+C to stop)"
while ($true) {
  Start-Sleep -Seconds $Interval
  $now = Get-Date; $dt = ($now - $prevT).TotalSeconds; $prevT = $now
  $own = @{}
  foreach ($p in 443, 3000, 3001) { $own[$p] = (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
  # game servers identified by the UDP game port they own (command line is unreadable across elevation)
  $udp = @{}; Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 8780 -and $_.LocalPort -le 8790 } | ForEach-Object { $udp[[int]$_.OwningProcess] = $_.LocalPort }
  $g = @{ mongo = @(0, 0); backend = @(0, 0); director = @(0, 0); hub = @(0, 0); hunt = @(0, 0) }; $hunts = 0
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    $grp = $null
    if ($p.ProcessName -eq 'mongod') { $grp = 'mongo' }
    elseif ($p.Id -eq $own[443] -or $p.Id -eq $own[3000]) { $grp = 'backend' }
    elseif ($p.Id -eq $own[3001]) { $grp = 'director' }
    elseif ($udp.ContainsKey($p.Id)) {
      $grp = if ($udp[$p.Id] -ge 8789) { 'hub' } else { 'hunt'; $hunts++ }
    }
    if (-not $grp) { continue }
    $t = try { $p.TotalProcessorTime.TotalSeconds } catch { 0 }
    if ($prev.ContainsKey($p.Id)) { $g[$grp][0] += [math]::Max(0.0, ($t - $prev[$p.Id]) / $dt) }
    $prev[$p.Id] = $t
    $g[$grp][1] += $p.WorkingSet64 / 1MB
  }
  $n = NetNow
  $inK = ($n.i - $prevNet.i) / 1KB / $dt; $outK = ($n.o - $prevNet.o) / 1KB / $dt; $prevNet = $n
  $players = @(Get-NetTCPConnection -State Established -LocalPort 443 -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -notin '127.0.0.1', '::1' }).Count
  $row = @($now.ToString('s'), $players, $hunts) + ('mongo', 'backend', 'director', 'hub', 'hunt' | ForEach-Object { '{0:F2}' -f $g[$_][0] }) + ('mongo', 'backend', 'director', 'hub', 'hunt' | ForEach-Object { '{0:F0}' -f $g[$_][1] }) + ('{0:F0}' -f $inK), ('{0:F0}' -f $outK)
  Add-Content $csv ($row -join ',')
}
