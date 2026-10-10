// SPDX-License-Identifier: Apache-2.0
// The Node fetcher for OAuth Client ID Metadata Documents (P5-03, ADR-0012, THREAT_MODEL T11): the stand-in for
// Workers' `global_fetch_strictly_public`. Only https; IP-literal hosts are checked before connecting, and every DNS
// answer is checked inside the socket's own `lookup`, so the address connected to is the address that was checked (no
// resolve-then-connect window for DNS rebinding). Redirects are never followed (`node:https` doesn't), the body is
// cut one byte past the limit and the whole exchange is timed out. Used only for metadata documents, never for
// NerdGraph or sign-in traffic.
import { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  CIMD_MAX_BYTES,
  CIMD_TIMEOUT_MS,
  type ClientMetadataFetch,
  isPublicIp,
} from '@relic-bridge/http-app';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** A destination the guard refused (not public, or not https). */
export class BlockedDestinationError extends Error {
  readonly code = 'EBLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'BlockedDestinationError';
  }
}

export interface CimdFetchOptions {
  /** DNS resolution (every address). Default `node:dns` `lookup` with `all: true`. */
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /** Which addresses may be connected to. Default: public unicast only (`isPublicIp`). Tests only. */
  readonly allowAddress?: (address: string) => boolean;
  /** Tests only: plain http to a local server. Never set in a server. */
  readonly allowHttpForTests?: boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

const systemResolve = (hostname: string): Promise<readonly ResolvedAddress[]> =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

/**
 * A `lookup` for `net.connect` that resolves every address of the host and fails unless all of them are allowed (a
 * host with one private address among public ones is refused: the socket could pick it).
 */
export function guardedLookup(
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>,
  allow: (address: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (all) => {
        const family = options.family === 4 || options.family === 6 ? options.family : 0;
        const addresses = all.filter((a) => family === 0 || a.family === family);
        if (addresses.length === 0) {
          callback(new BlockedDestinationError('the host has no address'), '', 0);
          return;
        }
        if (!all.every((a) => allow(a.address))) {
          callback(new BlockedDestinationError('the host resolves to a non-public address'), '', 0);
          return;
        }
        if (options.all)
          callback(
            null,
            addresses.map((a) => ({ address: a.address, family: a.family })),
          );
        else
          callback(null, (addresses[0] as ResolvedAddress).address, (addresses[0] as ResolvedAddress).family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error('lookup failed'), '', 0);
      },
    );
  };
}

function headersOf(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    try {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    } catch {
      // a header value `Headers` refuses: dropped
    }
  }
  return headers;
}

/** The SSRF-guarded fetcher `createHttpApp({ oauth: { clientMetadataDocuments: { fetch } } })` takes on Node. */
export function createCimdFetch(options: CimdFetchOptions = {}): ClientMetadataFetch {
  const resolve = options.resolve ?? systemResolve;
  const allow = options.allowAddress ?? isPublicIp;
  const maxBytes = options.maxBytes ?? CIMD_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? CIMD_TIMEOUT_MS;
  const lookup = guardedLookup(resolve, allow);

  return (target, init) =>
    new Promise<Response>((resolvePromise, reject) => {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        reject(new BlockedDestinationError('not a URL'));
        return;
      }
      const plain = url.protocol === 'http:' && options.allowHttpForTests === true;
      if (url.protocol !== 'https:' && !plain) {
        reject(new BlockedDestinationError('only https is fetched'));
        return;
      }
      if (url.username !== '' || url.password !== '') {
        reject(new BlockedDestinationError('userinfo is not sent'));
        return;
      }
      // `lookup` is skipped for IP literals: check them here.
      const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      if (isIP(host) !== 0 && !allow(host)) {
        reject(new BlockedDestinationError('non-public address'));
        return;
      }
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = (plain ? httpRequest : httpsRequest)(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'relic-bridge (client metadata)' },
        // A fresh connection per document: never a pooled socket to an address checked for another host.
        agent: false,
        lookup,
        signal: init.signal,
        timeout: timeoutMs,
      });
      const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const headers = headersOf(res);
        if (status < 200 || status > 599) {
          res.destroy();
          clearTimeout(timer);
          fail(new Error('unexpected status'));
          return;
        }
        // Redirects and body-less statuses: answered without reading (and never followed).
        if (status !== 200) {
          res.destroy();
          clearTimeout(timer);
          settled = true;
          resolvePromise(new Response(null, { status, headers }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (): void => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          headers.delete('content-encoding');
          resolvePromise(new Response(Buffer.concat(chunks), { status, headers }));
        };
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = maxBytes + 1 - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          // One byte past the limit is enough for the caller to refuse the document; stop reading.
          if (size > maxBytes) {
            finish();
            res.destroy();
          }
        });
        res.on('end', finish);
        res.on('error', (error) => {
          clearTimeout(timer);
          fail(error);
        });
      });
      req.end();
    });
}
