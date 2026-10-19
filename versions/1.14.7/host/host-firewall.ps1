# Opens the host's Dauntless 1.14.7 ports to everyone (public server; forward the same ports on the router).
# Run once as admin (again after changing it):
#   right-click > Run with PowerShell (as administrator), or from an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\host-firewall.ps1"
# Undo: Get-NetFirewallRule -DisplayName 'Dauntless 1.14.7 *' | Remove-NetFirewallRule
# ponytail: open to Any. Tailnet + LAN only was @('100.64.0.0/10', '192.168.1.0/24').

$ErrorActionPreference = 'Stop'
$allowed = @('100.64.0.0/10', '192.168.1.0/24')
Get-NetFirewallRule -DisplayName 'Dauntless 1.14.7 *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# Backend HTTPS (launcher API, game API, chat).
New-NetFirewallRule -DisplayName 'Dauntless 1.14.7 backend (TCP 443)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 443 -RemoteAddress $allowed -Profile Any | Out-Null
# Game servers: hunts 8780-8788, Training Dojo 8789, Ramsgate 8790.
New-NetFirewallRule -DisplayName 'Dauntless 1.14.7 game servers (UDP 8780-8790)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8780-8790 -RemoteAddress $allowed -Profile Any | Out-Null
# Party voice relay (backend voiceRelay.ts, VOICE_UDP_PORT).
New-NetFirewallRule -DisplayName 'Dauntless 1.14.7 voice relay (UDP 8791)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8791 -RemoteAddress $allowed -Profile Any | Out-Null
Get-NetFirewallRule -DisplayName 'Dauntless 1.14.7 *' | Select-Object DisplayName, Enabled, Profile
