# Collects what a launcher release publishes into release\ after `npm run make`: the Squirrel installer
# with its update files (RELEASES and the full .nupkg), the portable zip, and SHA256SUMS.txt for all of
# them. -Publish then uploads them as release v<version> of the releases repo, whose latest release
# is the launchers' update feed (UPDATE_FEED_URL in src/main/constants.ts).
#
# The zip is renamed DauntlessRevampedLauncher-<version>-win32-x64.zip: GitHub replaces the spaces of an
# uploaded file's name, which would no longer match its line in SHA256SUMS.txt. SHA256SUMS.txt has LF
# line endings, so `sha256sum --check` reads it as it is.
#
#   npm run release      (make, collect and publish; bump "version" in package.json first)
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
$repo = 'HyjinnxDev/dauntless-revamped-releases'
$launcher = Split-Path $PSScriptRoot -Parent
$release = Join-Path $launcher 'release'
$version = (Get-Content -LiteralPath (Join-Path $launcher 'package.json') -Raw | ConvertFrom-Json).version

if (Test-Path -LiteralPath $release) { Remove-Item -LiteralPath $release -Recurse -Force }
New-Item -ItemType Directory -Force $release | Out-Null
Copy-Item (Join-Path $launcher 'out/make/squirrel.windows/x64/*') $release
foreach ($name in 'DauntlessRevampedLauncher-Setup.exe', 'RELEASES') {
    if (-not (Test-Path -LiteralPath (Join-Path $release $name))) { throw "release/$name is missing; run npm run make first" }
}
$nupkg = @(Get-ChildItem -LiteralPath $release -File -Filter '*-full.nupkg')
if ($nupkg.Count -ne 1) { throw "expected one *-full.nupkg in release/, found $($nupkg.Count); run npm run make first" }
$zip = @(Get-ChildItem -LiteralPath (Join-Path $launcher 'out/make/zip/win32/x64') -File -Filter "*-win32-x64-$version.zip" -ErrorAction SilentlyContinue)
if ($zip.Count -ne 1) { throw "expected one *-win32-x64-$version.zip in out/make/zip/win32/x64, found $($zip.Count); run npm run make first" }
Copy-Item -LiteralPath $zip[0].FullName (Join-Path $release "DauntlessRevampedLauncher-$version-win32-x64.zip")

$sums = Get-ChildItem -LiteralPath $release -File | Sort-Object Name | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
}
[IO.File]::WriteAllText((Join-Path $release 'SHA256SUMS.txt'), (($sums -join "`n") + "`n"), [Text.Encoding]::ASCII)
Get-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt')

if ($Publish) {
    gh release create "v$version" --repo $repo --title "Launcher $version" --notes "Dauntless Revamped Launcher $version" (Get-ChildItem -LiteralPath $release -File).FullName
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
}
