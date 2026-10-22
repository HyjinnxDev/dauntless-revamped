# Opens the host's Dauntless 1.14.7 ports, and only those. Run once as admin (again after changing it):
#   right-click > Run with PowerShell (as administrator), or from an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File "D:\Dev\dauntless-revamped\versions\1.14.7\host\host-firewall.ps1"
# Default: LAN only. A public server (outside players; forward the same ports on the router) passes -Allowed Any.
# Undo: Get-NetFirewallRule -DisplayName 'Dauntless 1.14.7 *' | Remove-NetFirewallRule
# Another host (deploy/README.md test server) passes its own ports, e.g.
#   host-firewall.ps1 -HttpsPort 9443 -GamePorts 9780-9790 -VoicePort 9791 -Allowed Any
# Windows' "allow this app" prompt makes inbound rules that open EVERY port of node.exe and the game exe
# (the plain-HTTP API, dev tools, anything). This script switches those off, so only the ports below stay
# open. If Windows asks again when the server starts, click Cancel: these rules already cover it.
# Undo that part: Get-NetFirewallRule -DisplayName 'Node.js*','Dauntless*' | Enable-NetFirewallRule
param(
  [string]$HttpsPort = '443',          # backend HTTPS_PORT
  [string]$GamePorts = '8780-8790',    # Director PORT_RANGE_BEGIN-PORT_RANGE_END
  [string]$VoicePort = '8791',         # backend VOICE_UDP_PORT
  [string[]]$Allowed = @('192.168.1.0/24')
)

$ErrorActionPreference = 'Stop'
Get-NetFirewallRule -DisplayName 'Dauntless 1.14.7 *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# Backend HTTPS (launcher API, game API, chat).
New-NetFirewallRule -DisplayName "Dauntless 1.14.7 backend (TCP $HttpsPort)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort -RemoteAddress $Allowed -Profile Any | Out-Null
# Game servers: hunts, then Training Dojo (second to last), Ramsgate (last).
New-NetFirewallRule -DisplayName "Dauntless 1.14.7 game servers (UDP $GamePorts)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort $GamePorts -RemoteAddress $Allowed -Profile Any | Out-Null
# Party voice relay (backend voiceRelay.ts, VOICE_UDP_PORT).
New-NetFirewallRule -DisplayName "Dauntless 1.14.7 voice relay (UDP $VoicePort)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort $VoicePort -RemoteAddress $Allowed -Profile Any | Out-Null

# Blanket per-program allow rules for node.exe / the game exe (all ports, all addresses): disabled, not deleted.
$AppRules = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -match '\\(node|Dauntless-Win64-Shipping)\.exe$' } |
  Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' }
$AppRules | Disable-NetFirewallRule
if ($AppRules) { Write-Host "disabled $(@($AppRules).Count) blanket app rule(s): $(($AppRules.DisplayName | Sort-Object -Unique) -join ', ')" }
Get-NetFirewallRule -DisplayName 'Dauntless 1.14.7 *' | Select-Object DisplayName, Enabled, Profile
