# Fresh secrets for a test server (FINDINGS M2): a test stack or the test-machine bundle must never reuse the live
# signing keys, gameserver key or hash secret, or a token minted on one would be valid on the other.
# Dot-source it, then:  $s = New-TestSecrets "<repo>\versions\1.14.7"
#   $s.Backend  -> backend .env overrides     $s.Director -> Director .env overrides
# The admin TOTP secret is new too: $s.Backend.ADMIN_TOTP_SECRET (base32) goes into your authenticator for the test console.

function New-TestRandomBytes([int]$Count) {
  $Bytes = New-Object byte[] $Count
  $Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
  return $Bytes
}

function New-TestHex([int]$Count) {
  return ([BitConverter]::ToString((New-TestRandomBytes $Count))).Replace('-', '').ToLowerInvariant()
}

# RFC 4648 base32, no padding (what authenticator apps take).
function New-TestBase32([int]$Count) {
  $Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  $Bits = -join ((New-TestRandomBytes $Count) | ForEach-Object { [Convert]::ToString($_, 2).PadLeft(8, '0') })
  $Out = ''
  for ($i = 0; $i -lt $Bits.Length; $i += 5) {
    $Chunk = $Bits.Substring($i, [Math]::Min(5, $Bits.Length - $i)).PadRight(5, '0')
    $Out += $Alphabet[[Convert]::ToInt32($Chunk, 2)]
  }
  return $Out
}

function New-TestSecrets([string]$VersionRoot) {
  $Pair = & node "$VersionRoot\scripts\generate-selfhost-rsa-key.mjs" | ConvertFrom-Json
  if ($LASTEXITCODE -or -not $Pair.privateKeyB64 -or -not $Pair.publicKeyB64) { throw 'JWT signing-key generation failed' }
  $GameserverKey = New-TestHex 32
  return @{
    Backend = [ordered]@{
      AUTH_SIGNING_PRIVKEY_B64 = $Pair.privateKeyB64
      AUTH_SIGNING_PUBKEY_B64 = $Pair.publicKeyB64
      GAMESERVER_API_KEYS = $GameserverKey
      API_KEY_HASH_SECRET = New-TestHex 32
      ADMIN_TOTP_SECRET = New-TestBase32 20
      ADMIN_OPERATIONS_TOTP_SECRET = ''          # falls back to ADMIN_TOTP_SECRET
      MYSTICPARADOX_METRICS_TOKEN = New-TestHex 24
      UPDATE_PUBLISHER_API_KEY = ''              # runtime/launcher pushes stay with the live server
      LAUNCHER_LOG_SYNC_TOKEN = ''
      LAUNCHER_INVITE_CODES = 'TEST-' + (New-TestHex 4).ToUpperInvariant()
      DISCORD_CLIENT_SECRET = ''
    }
    Director = [ordered]@{ METAGAME_API_KEY = $GameserverKey }
  }
}
