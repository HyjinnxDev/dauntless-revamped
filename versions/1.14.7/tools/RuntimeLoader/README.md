# Paradox Runtime Loader

A small winmm.dll proxy that forwards multimedia calls to the real Windows system library and
loads MysticParadox.dll from the game directory during process startup. The old
MystPaxInternalServer.dll name is no longer loaded (2026-11-03): launchers only verify MysticParadox.dll.

## Build

    cd tools\RuntimeLoader
    cargo build --release

Output: target\release\winmm.dll.

Place winmm.dll and MysticParadox.dll beside Dauntless-Win64-Shipping.exe. The loader can optionally read
mystic_loader.ini; when present, list one additional project-owned DLL path per line. These entries
never replace the runtime. Relative paths resolve from the game directory. Launchers do not hash these extra
DLLs.

Do not list untrusted DLLs. Every configured library executes inside the game process.

## Origin and license

This loader is derived from
https://github.com/denuvosanctuary/coldloader-proxy and remains available under
the Apache License 2.0. See LICENSE in this directory. Mystic Paradox does not require or ship
coldloader.dll.