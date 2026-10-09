// SPDX-License-Identifier: Apache-2.0
// Client address handling for per-IP limits (T1, T20). Web-standard; the host supplies the socket address (Node:
// `getConnInfo`, Workers: `CF-Connecting-IP`). Forwarded headers are spoofable, so they count only for proxies the
// operator says exist.

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function parseV6(input: string): number[] | null {
  // Eight 16-bit groups, or null when it isn't an IPv6 address. Embedded IPv4 (`::ffff:1.2.3.4`) is expanded.
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail = s.lastIndexOf(':');
  const last = s.slice(tail + 1);
  if (tail >= 0 && V4.test(last)) {
    const o = last.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, tail + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] ?? '');
  if (rest === null || head.length + rest.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/**
 * A stable bucket key for a client address: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 as its /64 (a client
 * owns a whole /64, so per-address keys would let it rotate through 2^64 identities). Anything that is not an IP
 * address yields `null` (never a key built from attacker-chosen text).
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  let s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (V4.test(s)) return s;
  const g = parseV6(s);
  if (g === null) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi = 0, lo = 0] = g.slice(6);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/**
 * The client address for rate limiting. `trustedProxyHops` is how many reverse proxies sit in front of the server
 * (default 0: the socket address is the client and `X-Forwarded-For` is ignored). With N hops the client is the Nth
 * entry from the right: entries to its left are whatever the client claimed, so they are never used. Fewer entries
 * than hops (a misconfiguration or a direct request) falls back to the socket address.
 */
export function resolveClientIp(input: {
  readonly socketIp: string | null | undefined;
  readonly forwardedFor?: string | null | undefined;
  readonly trustedProxyHops?: number;
}): string | null {
  const hops = input.trustedProxyHops ?? 0;
  if (hops > 0 && input.forwardedFor) {
    const parts = input.forwardedFor.split(',').map((p) => p.trim());
    const picked = parts.length >= hops ? parts[parts.length - hops] : undefined;
    const ip = normalizeClientIp(picked);
    if (ip !== null) return ip;
  }
  return normalizeClientIp(input.socketIp);
}
