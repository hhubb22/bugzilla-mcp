import { createHmac } from "node:crypto";
import { isIP } from "node:net";

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (nums.some((n) => n < 0)) return null;
  return nums as [number, number, number, number];
}

function isNonPublicIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function expandIpv6(address: string): number[] | null {
  let raw = address.toLowerCase();
  const zoneIdx = raw.indexOf("%");
  if (zoneIdx >= 0) raw = raw.slice(0, zoneIdx);

  // Convert trailing embedded IPv4 (e.g. ::ffff:192.168.0.20) into two 16-bit groups
  const lastColon = raw.lastIndexOf(":");
  if (lastColon >= 0 && raw.includes(".")) {
    const v4 = parseIpv4Octets(raw.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    raw = `${raw.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  const parsed: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    parsed.push(Number.parseInt(g, 16));
  }
  return parsed;
}

export function isPublicIpAddress(ip: string): boolean {
  const cleaned = ip.trim().replace(/^\[|\]$/g, "");
  const version = isIP(cleaned);
  if (version === 4) {
    const octets = parseIpv4Octets(cleaned);
    return octets !== null && !isNonPublicIpv4(octets);
  }
  if (version === 6) {
    const groups = expandIpv6(cleaned);
    if (!groups) return false;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    // Allow only globally routable unicast space (2000::/3), rejecting ::/96 IPv4-compatible,
    // ::ffff:0:0/96 IPv4-mapped, 64:ff9b::/96 NAT64, 100::/64 discard, fc00::/7 ULA, fe80::/10, ff00::/8, etc.
    if ((g0 & 0xe000) !== 0x2000) {
      // Special case: allow ::ffff:<public-ipv4> ONLY if embedded IPv4 is globally public?
      // Security best practice: reject all IPv4-mapped/translated transition addresses in SSRF checks.
      return false;
    }
    // Reject IETF Protocol Assignments 2001::/23 (covers Teredo 2001:0000::/32, Benchmarking 2001:2::/48, ORCHID)
    if (g0 === 0x2001 && g1 <= 0x01ff) return false;
    // Reject Documentation 2001:db8::/32
    if (g0 === 0x2001 && g1 === 0x0db8) return false;
    if (g0 === 0x3fff && g1 <= 0x0fff) return false; // Documentation 3fff::/20
    // Reject 6to4 tunnel prefix 2002::/16 (can encapsulate private IPv4)
    if (g0 === 0x2002) return false;
    // Reject 3ffe::/16 (deprecated 6bone)
    if (g0 === 0x3ffe) return false;
    void g2;
    void g3;
    void g4;
    void g5;
    void g6;
    void g7;
    return true;
  }
  return false;
}

export function validateWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid callback URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Callback URL must use https://");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("Callback URL must not include credentials or fragment");
  }
  return parsed;
}

export function selectValidatedPublicIp(addresses: readonly string[]): string | null {
  if (addresses.length === 0) return null;
  for (const addr of addresses) {
    if (!isPublicIpAddress(addr)) {
      return null;
    }
  }
  return addresses[0] ?? null;
}

export function signStandardWebhook(
  secrets: readonly string[],
  webhookId: string,
  timestampSec: string,
  rawBody: string,
): string {
  const payload = `${webhookId}.${timestampSec}.${rawBody}`;
  return secrets
    .map((sec) => {
      const rawKey = Buffer.from(sec.slice("whsec_".length), "base64");
      const digest = createHmac("sha256", rawKey).update(payload, "utf8").digest("base64");
      return `v1,${digest}`;
    })
    .join(" ");
}
