import os from "node:os";

// Which address a client should travel to for a hub/hunt the Director advertised on this machine's
// public address. The game's UDP needs NAT hairpin to reach our own public address from inside the
// network, and measured 2026-10-19 it doesn't: a LAN player (192.168.1.21) was told 202.137.x.x:8781,
// never arrived, and its retries then hit the hunt cap against its own empty server. So:
//   same machine            -> 127.0.0.1
//   private LAN / Tailscale -> this machine's address on that same network
//   anyone else             -> the advertised public host
const PRIVATE_RANGES: Array<[number, number]> = [
    [0x0a000000, 8],  // 10.0.0.0/8
    [0xac100000, 12], // 172.16.0.0/12
    [0xc0a80000, 16], // 192.168.0.0/16
    [0x64400000, 10], // 100.64.0.0/10 (Tailscale)
];

function ToInt(ip: string): number | undefined {
    const parts = ip.split(".");
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
    return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

function RangeOf(ip: string): [number, number] | undefined {
    const n = ToInt(ip);
    if (n === undefined) return undefined;
    return PRIVATE_RANGES.find(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

function LocalIPv4s(): string[] {
    return Object.values(os.networkInterfaces()).flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
        .map((i) => i.address);
}

export function PickTravelHost(clientAddress: string, advertisedHost: string, localAddresses: string[] = LocalIPv4s()): string {
    const Client = clientAddress.replace(/^::ffff:/, "");
    if (Client === advertisedHost || Client === "127.0.0.1" || Client === "::1" || localAddresses.includes(Client)) return "127.0.0.1";
    const Range = RangeOf(Client);
    if (!Range) return advertisedHost;
    // ponytail: first local address in the same private range; per-subnet match if the host ever has two LANs.
    return localAddresses.find((a) => RangeOf(a) === Range) ?? advertisedHost;
}
