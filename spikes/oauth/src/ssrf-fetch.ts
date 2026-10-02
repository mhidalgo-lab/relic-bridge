// SPDX-License-Identifier: Apache-2.0
// Node stand-in for Workers' `global_fetch_strictly_public`: outbound fetches must be https to a host that
// resolves only to public addresses. Spike-grade: resolve-then-fetch has a DNS-rebinding TOCTOU window —
// production must validate at connect time (undici Agent `connect.lookup`), see RESULTS.md.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_V4 = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xe0000000, 3],
] as const;

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    return !PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  return !(v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff'));
}

export function installStrictPublicFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.protocol !== 'https:') throw new TypeError(`strict-public fetch: https required (${url.origin})`);
    const addrs = await lookup(url.hostname, { all: true, verbatim: true });
    if (addrs.length === 0 || !addrs.every((a) => isPublicAddress(a.address)))
      throw new TypeError(`strict-public fetch: ${url.hostname} resolves to a non-public address`);
    return original(input, init);
  };
  // Tell workers-oauth-provider the SSRF guarantee is in place.
  (globalThis as { Cloudflare?: unknown }).Cloudflare = {
    compatibilityFlags: { global_fetch_strictly_public: true },
  };
}
