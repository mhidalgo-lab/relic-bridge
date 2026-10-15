// SPDX-License-Identifier: Apache-2.0
// Property / fuzz tests for the HTTP edge's input parsers (P8-01): OAuth client registration and metadata documents,
// redirect URIs, IP classification (T9/T10/T11); post-login redirects (T14); client addresses, Host/Origin and MCP
// headers (T1/T20/T24); the JSON-RPC body peek and its size bound (T20); OTLP and OAuth settings from the environment
// (T30). Bounded in the normal suite; `RB_FUZZ_RUNS` for longer runs (core/test/helpers/fuzz.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FUZZ_TIMEOUT, fuzzParams } from '../../core/test/helpers/fuzz.ts';
import { normalizeClientIp, resolveClientIp } from '../src/client-ip.ts';
import { safeNextPath } from '../src/identity.ts';
import { peekJsonRpc } from '../src/jsonrpc.ts';
import {
  CIMD_MAX_TTL_S,
  CIMD_MIN_TTL_S,
  ClientMetadataError,
  checkRegistration,
  clientIdUrlProblem,
  isLoopbackHost,
  isPublicIp,
  metadataCacheTtl,
  parseIpv4,
  parseIpv6,
  redirectUriVerdict,
  safeClientName,
  validateMetadataDocument,
} from '../src/oauth/clients.ts';
import { deviceLabel, looksLikeOAuthToken } from '../src/oauth/server.ts';
import { OAuthConfigError, oauthSettingsFromEnv } from '../src/oauth/settings.ts';
import { checkHost, checkOrigin, originHostname, safeMcpHeader } from '../src/security.ts';
import {
  parseOtlpEndpoint,
  parseOtlpHeaders,
  parseSampleRate,
  parseTraceparent,
  TelemetryConfigError,
  telemetrySettingsFromEnv,
} from '../src/telemetry.ts';

// ------------------------------------------------------------------------------------------------- generators

const v4 = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255));
const v4Text = v4.map((o) => o.join('.'));
const v6Groups = fc.array(fc.nat(0xffff), { minLength: 8, maxLength: 8 });
const v6Full = v6Groups.map((g) => g.map((x) => x.toString(16)).join(':'));
/** Compressed spellings as `URL` writes them (`[::1]`, `[2001:db8::]`). */
const v6Url = v6Groups.map((g) =>
  new URL(`http://[${g.map((x) => x.toString(16)).join(':')}]/`).hostname.slice(1, -1),
);

const hosts = fc.oneof(
  fc.constantFrom(
    'localhost',
    '127.0.0.1',
    '127.1',
    '[::1]',
    '[::ffff:127.0.0.1]',
    'localhost.evil.example',
    '127.0.0.1.nip.io',
    'claude.ai',
    'CLAUDE.AI',
    'claude.ai.',
    'xn--80ak6aa92e.com',
    '0x7f.1',
    '2130706433',
    '[fe80::1%25eth0]',
    'a',
    'rb.example.com',
    'internal',
    'host.internal',
    'evil.com',
  ),
  fc.domain(),
  v4Text,
  v6Full.map((s) => `[${s}]`),
);
const schemes = fc.constantFrom(
  'https://',
  'http://',
  'HTTPS://',
  'cursor://',
  'javascript:',
  '//',
  'https:\\\\',
  'https:/',
  '',
);
const paths = fc.oneof(
  fc.constantFrom(
    '',
    '/',
    '/cb',
    '/callback',
    '/a/../b',
    '/%2e%2e/x',
    '/#frag',
    '/*',
    '?q=1',
    ':8443/cb',
    ':443/x',
    '@evil.com/',
  ),
  fc.webPath(),
);
const urlish = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.tuple(schemes, fc.constantFrom('', 'user:pw@', 'u@'), hosts, paths).map((p) => p.join('')),
  },
  { weight: 1, arbitrary: fc.webUrl({ withQueryParameters: true, withFragments: true }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 60 }) },
);

/** Every arbitrary JSON value, plus objects shaped like registration metadata. */
const metadata = fc.oneof(
  fc.jsonValue(),
  fc.record(
    {
      client_id: fc.oneof(urlish, fc.constant('https://claude.ai/oauth/client')),
      client_name: fc.oneof(
        fc.string({ unit: 'binary', maxLength: 40 }),
        fc.constantFrom('Claude', 'Cl\u0430ude', 'A\u202eB', ''),
      ),
      redirect_uris: fc.oneof(fc.array(fc.oneof(urlish, fc.anything()), { maxLength: 12 }), fc.anything()),
      grant_types: fc.oneof(
        fc.array(fc.constantFrom('authorization_code', 'refresh_token', 'implicit', 'x'), { maxLength: 4 }),
        fc.anything(),
      ),
      response_types: fc.oneof(fc.array(fc.constantFrom('code', 'token'), { maxLength: 3 }), fc.anything()),
      token_endpoint_auth_method: fc.constantFrom('none', 'client_secret_basic', undefined),
      client_secret: fc.constantFrom(undefined, 's3cr3t'),
    },
    { requiredKeys: [] },
  ),
);

function isHttpLoopback(url: URL): boolean {
  return isLoopbackHost(url.hostname);
}

// ------------------------------------------------------------------------------------------------- IP addresses

describe('IP classification for the metadata fetch guard (T11)', { timeout: FUZZ_TIMEOUT }, () => {
  /** Reference: the blocked IPv4 ranges, written independently as CIDR strings. */
  const BLOCKED = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.88.99.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ].map((cidr) => {
    const [base, bits] = cidr.split('/') as [string, string];
    const n = base.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
    return [n, Number(bits)] as const;
  });
  const refPublicV4 = (o: readonly number[]): boolean => {
    const n = o.reduce((acc, x) => acc * 256 + x, 0);
    return !BLOCKED.some(
      ([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
    );
  };

  it('IPv4: agrees with an independent CIDR table, also through IPv4-mapped, NAT64 and 6to4 IPv6', () => {
    fc.assert(
      fc.property(v4, (o) => {
        const text = o.join('.');
        const expected = refPublicV4(o);
        const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
        return (
          isPublicIp(text) === expected &&
          isPublicIp(`::ffff:${text}`) === expected &&
          isPublicIp(
            `[::ffff:${hex(o[0] as number, o[1] as number)}:${hex(o[2] as number, o[3] as number)}]`,
          ) === expected &&
          isPublicIp(`64:ff9b::${text}`) === expected &&
          isPublicIp(
            `2002:${hex(o[0] as number, o[1] as number)}:${hex(o[2] as number, o[3] as number)}::1`,
          ) === expected
        );
      }),
      fuzzParams(2000),
    );
  });

  it('IPv6: parse agrees with the URL parser, and only global unicast outside special blocks is public', () => {
    fc.assert(
      fc.property(v6Groups, (g) => {
        const full = g.map((x) => x.toString(16)).join(':');
        const compressed = new URL(`http://[${full}]/`).hostname.slice(1, -1);
        expect(parseIpv6(full)).toEqual(g);
        expect(parseIpv6(compressed)).toEqual(g);
        const [a = 0, b = 0] = g;
        if (a < 0x2000 || a > 0x3fff) {
          // Outside 2000::/3 only the IPv4-carrying forms can be public (judged by their IPv4 address).
          const carriesV4 =
            (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) ||
            (a === 0x64 && b === 0xff9b && g.slice(2, 6).every((x) => x === 0));
          if (!carriesV4) expect(isPublicIp(compressed)).toBe(false);
        }
        if (a === 0x2001 && b === 0x0db8) expect(isPublicIp(compressed)).toBe(false);
      }),
      fuzzParams(2000),
    );
  });

  it('anything that is not an address is not public, and parsing never throws', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 50 }), fc.domain(), hosts), (text) => {
        const v4n = parseIpv4(text);
        const v6g = parseIpv6(text);
        if (v4n === null && v6g === null && !(text.startsWith('[') && text.endsWith(']'))) {
          expect(isPublicIp(text)).toBe(false);
        }
        if (v4n !== null) expect(v4n >= 0 && v4n <= 0xffffffff).toBe(true);
        if (v6g !== null) expect(v6g.length === 8 && v6g.every((x) => x >= 0 && x <= 0xffff)).toBe(true);
      }),
      fuzzParams(2000),
    );
  });
});

// ------------------------------------------------------------------------------------------------- OAuth clients

describe('OAuth client inputs (T9/T10/T11)', { timeout: FUZZ_TIMEOUT }, () => {
  it('redirectUriVerdict: never throws; a usable URI is an absolute https or loopback-http URL without userinfo or fragment', () => {
    fc.assert(
      fc.property(
        fc.oneof(urlish, fc.anything()),
        fc.option(fc.constantFrom('claude.ai', 'rb.example.com'), { nil: undefined }),
        fc.option(fc.array(fc.constantFrom('claude.ai', 'rb.example.com'), { maxLength: 2 }), {
          nil: undefined,
        }),
        (uri, clientHost, allowedHosts) => {
          const policy = {
            ...(clientHost === undefined ? {} : { clientHost }),
            ...(allowedHosts === undefined ? {} : { allowedHosts }),
          };
          const verdict = redirectUriVerdict(uri, policy);
          if (verdict !== 'usable') return true;
          const text = uri as string;
          const url = new URL(text);
          expect(text).not.toMatch(/[#*\s\p{Cc}]/u);
          expect(url.username + url.password).toBe('');
          if (url.protocol === 'http:') expect(isHttpLoopback(url)).toBe(true);
          else expect(url.protocol).toBe('https:');
          if (!isHttpLoopback(url)) {
            expect(/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')).toBe(false);
            if (clientHost !== undefined) expect(url.hostname).toBe(clientHost);
            if (allowedHosts !== undefined) expect(allowedHosts).toContain(url.hostname);
          }
          return true;
        },
      ),
      fuzzParams(3000),
    );
  });

  it('checkRegistration: any body gives a verdict (never throws); ok means every URI passed and one is usable', () => {
    const body = fc.oneof(
      metadata.map((m) => JSON.stringify(m) ?? 'null'),
      fc.string({ unit: 'binary', maxLength: 80 }),
    );
    fc.assert(
      fc.property(body, (text) => {
        const verdict = checkRegistration(text);
        if (!verdict.ok) {
          expect(['invalid_redirect_uri', 'invalid_client_metadata']).toContain(verdict.error);
          expect(verdict.reason).toMatch(/^[a-z_]+$/);
          return;
        }
        const meta = JSON.parse(text) as { redirect_uris: unknown[]; client_name?: unknown };
        const verdicts = meta.redirect_uris.map((u) => redirectUriVerdict(u, {}));
        expect(verdicts.some((v) => v.startsWith('bad:'))).toBe(false);
        expect(verdicts).toContain('usable');
        if ('client_name' in meta) expect(safeClientName(meta.client_name)).not.toBeNull();
      }),
      fuzzParams(2000),
    );
  });

  it('clientIdUrlProblem: a fetchable client id is a canonical https URL on a public DNS name, port 443, with a path', () => {
    fc.assert(
      fc.property(urlish, (id) => {
        if (clientIdUrlProblem(id, 'rb.example.com') !== null) return true;
        const url = new URL(id);
        expect(url.href).toBe(id);
        expect(url.protocol).toBe('https:');
        expect(url.port + url.username + url.password + url.hash).toBe('');
        expect(url.pathname.length).toBeGreaterThan(1);
        expect(url.hostname).toContain('.');
        expect(url.hostname).not.toBe('rb.example.com');
        expect(/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')).toBe(false);
        expect(id.length).toBeLessThanOrEqual(512);
        return true;
      }),
      fuzzParams(3000),
    );
  });

  it('validateMetadataDocument: refuses with ClientMetadataError, or keeps only usable redirect URIs on the client host', () => {
    const id = 'https://claude.ai/oauth/client';
    const doc = fc.oneof(
      metadata,
      metadata.map((m) =>
        typeof m === 'object' && m !== null && !Array.isArray(m) ? { ...m, client_id: id } : m,
      ),
    );
    fc.assert(
      fc.property(doc, (value) => {
        let client: ReturnType<typeof validateMetadataDocument>;
        try {
          client = validateMetadataDocument(id, value, 1_000);
        } catch (error) {
          expect(error).toBeInstanceOf(ClientMetadataError);
          return;
        }
        expect(client.clientId).toBe(id);
        expect(client.tokenEndpointAuthMethod).toBe('none');
        expect(client.grantTypes).toContain('authorization_code');
        expect(client.redirectUris.length).toBeGreaterThan(0);
        for (const uri of client.redirectUris) {
          expect(redirectUriVerdict(uri, { clientHost: 'claude.ai' })).toBe('usable');
          const url = new URL(uri);
          expect(url.hostname === 'claude.ai' || isLoopbackHost(url.hostname)).toBe(true);
        }
        expect(safeClientName(client.clientName)).toBe(client.clientName);
      }),
      fuzzParams(2000),
    );
  });

  it('display names and device labels: no control, format, separator or private-use character, bounded length', () => {
    const name = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 120 }),
      fc.string({ unit: 'grapheme', maxLength: 120 }),
      fc.string({
        unit: fc.constantFrom('a', '\u0430', '\u03b1', ' ', '\u202e', '\u200b', '\u2028', '\ue000', 'C'),
        maxLength: 20,
      }),
    );
    fc.assert(
      fc.property(fc.oneof(name, fc.anything()), (value) => {
        for (const out of [safeClientName(value), deviceLabel(value)]) {
          if (out === null) continue;
          expect(out).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u);
          expect(out).toBe(out.trim());
          expect([...out].length).toBeLessThanOrEqual(100);
          expect(out.length).toBeGreaterThan(0);
        }
        const label = deviceLabel(value);
        if (label !== null) expect(label.length).toBeLessThanOrEqual(60);
      }),
      fuzzParams(2000),
    );
  });

  it('metadata cache lifetime stays within its bounds for any Cache-Control', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.string({ unit: 'binary', maxLength: 60 }),
          fc
            .tuple(
              fc.constantFrom('max-age', 's-maxage', 'MAX-AGE', 'no-store', 'private', 'no-cache', 'public'),
              fc.constantFrom('=', ' = ', '="', ''),
              fc.oneof(fc.nat().map(String), fc.constant('99999999999999'), fc.constant('-5')),
            )
            .map((p) => p.join('')),
        ),
        (cc) => {
          const ttl = metadataCacheTtl(cc);
          return Number.isInteger(ttl) && ttl >= CIMD_MIN_TTL_S && ttl <= CIMD_MAX_TTL_S;
        },
      ),
      fuzzParams(2000),
    );
  });

  it('looksLikeOAuthToken never throws and accepts only the provider token shape', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 220 }),
          fc
            .tuple(
              fc.stringMatching(/^[A-Za-z0-9_-]{0,130}$/),
              fc.stringMatching(/^[A-Za-z0-9_-]{14,18}$/),
              fc.stringMatching(/^[A-Za-z0-9_-]{30,34}$/),
            )
            .map((p) => p.join(':')),
        ),
        (token) => {
          if (!looksLikeOAuthToken(token)) return true;
          return (
            token.length <= 200 && /^[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{32}$/.test(token)
          );
        },
      ),
      fuzzParams(2000),
    );
  });
});

// ------------------------------------------------------------------------------------------------- sign-in redirect

describe('post-login redirect (T14, open redirect)', { timeout: FUZZ_TIMEOUT }, () => {
  it('safeNextPath: null, or a same-origin absolute path that cannot be read as another host', () => {
    const PUBLIC = 'https://rb.example.com';
    const next = fc.oneof(
      fc.string({ unit: 'binary-ascii', maxLength: 60 }),
      fc.webPath(),
      fc
        .tuple(
          fc.constantFrom(
            '/',
            '//',
            '/\\',
            '/./',
            '/.//',
            '/..//',
            '/%2f',
            '/%5c',
            '\\',
            'https://',
            '/admin',
            '/oauth/authorize?',
          ),
          fc.constantFrom(
            '',
            'evil.example',
            '@evil.example',
            '/evil.example',
            '.',
            '..',
            '%09/evil',
            '?x=//evil',
            '#//evil',
          ),
          fc.webPath(),
        )
        .map((p) => p.join('')),
    );
    fc.assert(
      fc.property(fc.oneof(next, fc.constant(undefined)), (value) => {
        const path = safeNextPath(value, PUBLIC);
        if (path === null) return true;
        expect(path.startsWith('/')).toBe(true);
        expect(path.startsWith('//') || path.startsWith('/\\')).toBe(false);
        // Resolved against any base, the path stays on that base's origin.
        expect(new URL(path, PUBLIC).origin).toBe(PUBLIC);
        expect(new URL(path, 'https://other.example:8443').origin).toBe('https://other.example:8443');
        return true;
      }),
      fuzzParams(3000),
    );
  });
});

// ------------------------------------------------------------------------------------------------- request headers

describe('client address, Host, Origin and MCP headers (T1/T20/T24)', { timeout: FUZZ_TIMEOUT }, () => {
  it('normalizeClientIp: null, or a dotted IPv4 / an IPv6 /64 key; never built from other text', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          v4Text,
          v6Full,
          v6Url,
          v6Full.map((s) => `[${s}]`),
          v4Text.map((s) => `::ffff:${s}`),
          fc.string({ unit: 'binary', maxLength: 50 }),
          fc.constantFrom('unknown', '', ' 1.2.3.4 ', '1.2.3.4:80', 'fe80::1%eth0', '01.2.3.4'),
        ),
        (raw) => {
          const key = normalizeClientIp(raw);
          if (key === null) return true;
          return /^\d{1,3}(\.\d{1,3}){3}$/.test(key) || /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::\/64$/.test(key);
        },
      ),
      fuzzParams(2000),
    );
  });

  it('every address in one IPv6 /64 shares a bucket, and a mapped IPv4 shares the IPv4 bucket', () => {
    fc.assert(
      fc.property(v6Groups, v6Groups, v4Text, (a, b, ip) => {
        const prefix = a.slice(0, 4);
        fc.pre(!prefix.every((x) => x === 0));
        const one = [...prefix, ...a.slice(4)].map((x) => x.toString(16)).join(':');
        const two = [...prefix, ...b.slice(4)].map((x) => x.toString(16)).join(':');
        expect(normalizeClientIp(one)).toBe(normalizeClientIp(two));
        expect(normalizeClientIp(`::ffff:${ip}`)).toBe(normalizeClientIp(ip));
      }),
      fuzzParams(1000),
    );
  });

  it('resolveClientIp: forwarded entries a client controls never pick the bucket', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(v4Text, fc.string({ maxLength: 12 })), { maxLength: 6 }),
        v4Text,
        fc.integer({ min: 0, max: 5 }),
        (claimed, socketIp, hops) => {
          const forwardedFor = claimed.join(', ');
          const picked = resolveClientIp({ socketIp, forwardedFor, trustedProxyHops: hops });
          if (hops === 0) return picked === normalizeClientIp(socketIp);
          // With N trusted hops, only the Nth entry from the right (appended by the first trusted proxy) may be used.
          const parts = forwardedFor.split(',').map((p) => p.trim());
          const nth = parts.length >= hops ? normalizeClientIp(parts[parts.length - hops]) : null;
          return picked === (nth ?? normalizeClientIp(socketIp));
        },
      ),
      fuzzParams(2000),
    );
  });

  it('Host and Origin checks pass only for an allowed host name', () => {
    const allowed = ['localhost', '127.0.0.1', '[::1]', 'rb.example.com'];
    fc.assert(
      fc.property(
        fc.oneof(urlish, hosts, fc.constant(null), fc.constant(undefined), fc.constant('null')),
        (value) => {
          const host = checkHost(value as string | null | undefined, allowed);
          if (host.ok) {
            // As a browser and the URL parser read it (`2130706433` and `127.1` are 127.0.0.1).
            expect(allowed).toContain(new URL(`http://${value as string}`).hostname);
          }
          const origin = checkOrigin(value as string | null | undefined, allowed);
          if (origin.ok && typeof value === 'string' && value !== '') {
            expect(allowed).toContain(new URL(value as string).hostname.toLowerCase());
          }
          const hostname = originHostname(String(value));
          if (hostname !== null) expect(new URL(String(value)).origin).toBe(String(value));
        },
      ),
      fuzzParams(2000),
    );
  });

  it('safeMcpHeader keeps only short plain values (never echoes anything else)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 160 }), fc.constant(null)), (value) => {
        const kept = safeMcpHeader(value);
        return kept === null || /^[A-Za-z0-9_.:/=+-]{1,128}$/.test(kept);
      }),
      fuzzParams(2000),
    );
  });
});

// ------------------------------------------------------------------------------------------------- JSON-RPC body

describe('MCP JSON-RPC body peek and size bound (T20)', { timeout: FUZZ_TIMEOUT }, () => {
  const message = fc.oneof(
    fc.jsonValue(),
    fc.record(
      {
        jsonrpc: fc.constantFrom('2.0', '1.0'),
        id: fc.oneof(fc.integer(), fc.string({ maxLength: 8 })),
        method: fc.oneof(
          fc.constantFrom('tools/call', 'tools/list', 'initialize'),
          fc.string({ maxLength: 12 }),
        ),
        params: fc.oneof(
          fc.record(
            {
              name: fc.oneof(fc.constantFrom('run_nrql', 'create_change_event'), fc.anything()),
              arguments: fc.oneof(
                fc.record({ dry_run: fc.oneof(fc.constant(true), fc.anything()) }),
                fc.anything(),
              ),
              inputResponses: fc.anything(),
            },
            { requiredKeys: [] },
          ),
          fc.anything(),
        ),
      },
      { requiredKeys: [] },
    ),
  );
  const body = fc.oneof(
    { weight: 3, arbitrary: message.map((m) => new TextEncoder().encode(JSON.stringify(m) ?? 'null')) },
    { weight: 1, arbitrary: fc.uint8Array({ maxLength: 300 }) },
    {
      weight: 1,
      arbitrary: fc.array(message, { maxLength: 3 }).map((m) => new TextEncoder().encode(JSON.stringify(m))),
    },
  );

  /** A request whose body arrives in arbitrary chunks (no Content-Length), as a trickled upload would. */
  function chunked(bytes: Uint8Array, cuts: readonly number[]): Request {
    const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const p of [...points, bytes.length]) {
      parts.push(bytes.slice(at, p));
      at = p;
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) if (part.length > 0) controller.enqueue(part);
        controller.close();
      },
    });
    return new Request('http://localhost/p/x/mcp', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
  }

  it('classifies any body without throwing, refuses exactly the bodies over the cap, and leaves the body intact', async () => {
    await fc.assert(
      fc.asyncProperty(
        body,
        fc.integer({ min: 0, max: 400 }),
        fc.array(fc.nat(), { maxLength: 6 }),
        async (bytes, max, cuts) => {
          const request = chunked(bytes, cuts);
          const peek = await peekJsonRpc(request, max);
          if (bytes.length > max) {
            expect(peek.kind).toBe('too_large');
            return;
          }
          expect(peek.kind).not.toBe('too_large');
          // The handler still reads the whole, unchanged body.
          expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            expect(peek.kind).toBe('unparsable');
            return;
          }
          if (Array.isArray(parsed)) expect(peek.kind).toBe('batch');
          else if (typeof parsed !== 'object' || parsed === null) expect(peek.kind).toBe('unparsable');
          else {
            // What the peek names is what the handler will dispatch (same decoder, same parser).
            const m = parsed as { method?: unknown; params?: { name?: unknown } };
            expect(peek).toMatchObject({
              kind: 'message',
              method: typeof m.method === 'string' ? m.method : null,
            });
            const name =
              typeof m.params === 'object' && m.params !== null && typeof m.params.name === 'string'
                ? m.params.name
                : null;
            expect(peek.kind === 'message' && peek.name).toBe(name);
          }
        },
      ),
      fuzzParams(500),
    );
  });
});

// ------------------------------------------------------------------------------------------------- environment

describe('settings from the environment (T30, OAuth)', { timeout: FUZZ_TIMEOUT }, () => {
  const SECRET = 'NRAK-FUZZSECRETVALUE0123456789ABC';

  it('parseOtlpHeaders round-trips percent-encoded name=value lists', () => {
    const name = fc.stringMatching(/^[A-Za-z0-9-]{1,64}$/);
    const value = fc
      .string({ unit: 'binary', maxLength: 30 })
      // A valid header value (P8-75): Latin-1 without control characters other than tab.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
      .filter((v) => !/[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-\u00ff]/u.test(v) && v === v.trim());
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(name, value), { selector: ([n]) => n.toLowerCase(), maxLength: 6 }),
        (pairs) => {
          fc.pre(pairs.length > 0);
          let encoded: string;
          try {
            encoded = pairs.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join(',');
          } catch {
            return true; // lone surrogates cannot be percent-encoded
          }
          const parsed = parseOtlpHeaders(encoded);
          expect(parsed).toEqual(Object.fromEntries(pairs.map(([n, v]) => [n.toLowerCase(), v])));
          return true;
        },
      ),
      fuzzParams(1000),
    );
  });

  it('parseOtlpHeaders: any text gives valid header values, or a fixed error that never echoes a value', () => {
    const raw = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 80 }),
      fc
        .array(
          fc.tuple(
            fc.string({ maxLength: 10 }),
            fc.constantFrom('=', ''),
            fc.string({ unit: 'binary', maxLength: 12 }),
            fc.constantFrom('', '%0d%0a', '%00', '%zz', `%0aX-Evil: ${SECRET}`),
          ),
          { maxLength: 4 },
        )
        .map((ps) => ps.map((p) => p.join('')).join(',')),
    );
    fc.assert(
      fc.property(raw, (text) => {
        try {
          const headers = parseOtlpHeaders(text);
          for (const [n, v] of Object.entries(headers)) {
            expect(n).toMatch(/^[a-z0-9-]{1,64}$/);
            expect(v).not.toMatch(/[\r\n\0]/);
          }
          // Every accepted value is one `Headers` takes (P8-75).
          expect(() => new Headers(headers)).not.toThrow();
        } catch (error) {
          expect(error).toBeInstanceOf(TelemetryConfigError);
          const message = (error as Error).message;
          expect(message).toMatch(
            /^(the OTLP headers are not name=value pairs|the OTLP header [A-Za-z0-9-]{1,64} has a value with a control character or a character outside Latin-1)$/,
          );
          expect(message).not.toContain(SECRET);
        }
      }),
      fuzzParams(2000),
    );
  });

  it('parseOtlpEndpoint: https (http only on loopback), no credentials, query or fragment; errors never echo', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          urlish,
          urlish.map((u) => `${u}?api_key=${SECRET}`),
        ),
        (raw) => {
          try {
            const endpoint = parseOtlpEndpoint(raw);
            const url = new URL(endpoint);
            expect(
              url.protocol === 'https:' ||
                (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
            ).toBe(true);
            expect(url.username + url.password + url.search + url.hash).toBe('');
          } catch (error) {
            expect(error).toBeInstanceOf(TelemetryConfigError);
            expect((error as Error).message).not.toContain(SECRET);
          }
        },
      ),
      fuzzParams(2000),
    );
  });

  it('parseSampleRate and parseTraceparent accept only their exact forms', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 60 }),
          fc.double().map(String),
          fc.constant(undefined),
        ),
        (raw) => {
          try {
            const rate = parseSampleRate(raw);
            expect(rate >= 0 && rate <= 1).toBe(true);
          } catch (error) {
            expect(error).toBeInstanceOf(TelemetryConfigError);
          }
          const parent = parseTraceparent(raw);
          if (parent !== undefined) {
            expect(parent.traceId).toMatch(/^[0-9a-f]{32}$/);
            expect(parent.spanId).toMatch(/^[0-9a-f]{16}$/);
            expect(raw).toBe(`00-${parent.traceId}-${parent.spanId}-${(raw as string).slice(-2)}`);
          }
        },
      ),
      fuzzParams(2000),
    );
  });

  const envValue = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 30 }),
    fc.constantFrom(
      'on',
      'off',
      'ON',
      'true',
      '0',
      '1',
      'yes',
      '',
      ' ',
      '30',
      '90m',
      '12h',
      '30d',
      '0s',
      '-1',
      '99999999d',
      'claude.ai',
      'https://otlp.nr-data.net',
      'http://localhost:4318',
      `api-key=${SECRET}`,
      SECRET,
    ),
    fc.integer().map((n) => n as unknown as string),
    fc.boolean().map((b) => b as unknown as string),
  );

  it('telemetrySettingsFromEnv: settings or TelemetryConfigError, off unless RB_OTEL is on, never echoing a value', () => {
    const NAMES = ['RB_OTEL', 'RB_OTEL_ENDPOINT', 'RB_OTEL_HEADERS', 'RB_OTEL_SAMPLE', 'RB_OTEL_TRACEPARENT'];
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...NAMES), envValue, { maxKeys: 5 }), (env) => {
        let settings: ReturnType<typeof telemetrySettingsFromEnv>;
        try {
          settings = telemetrySettingsFromEnv(env);
        } catch (error) {
          expect(error).toBeInstanceOf(TelemetryConfigError);
          expect((error as Error).message).not.toContain(SECRET);
          return;
        }
        const flag = typeof env['RB_OTEL'] === 'string' ? env['RB_OTEL'].trim().toLowerCase() : undefined;
        if (settings !== null) expect(['on', 'true', '1']).toContain(flag);
      }),
      fuzzParams(2000),
    );
  });

  it('oauthSettingsFromEnv: settings or OAuthConfigError; OAuth stays off unless RB_OAUTH is on; bounded values', () => {
    const NAMES = [
      'RB_OAUTH',
      'RB_OAUTH_DCR',
      'RB_OAUTH_DCR_LIMIT',
      'RB_OAUTH_DCR_IP_LIMIT',
      'RB_OAUTH_DCR_REDIRECT_HOSTS',
      'RB_OAUTH_ACCESS_TTL',
      'RB_OAUTH_REFRESH_TTL',
      'RB_OAUTH_REFRESH_REUSE',
      'RB_OAUTH_CIMD',
    ];
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...NAMES), envValue, { maxKeys: 6 }),
        fc.boolean(),
        (env, signIn) => {
          let settings: ReturnType<typeof oauthSettingsFromEnv>;
          try {
            settings = oauthSettingsFromEnv(env, signIn);
          } catch (error) {
            expect(error).toBeInstanceOf(OAuthConfigError);
            expect((error as Error).message).not.toContain(SECRET);
            return;
          }
          if (settings === null) return;
          expect(['on', 'true', '1']).toContain(String(env['RB_OAUTH']).trim().toLowerCase());
          // Unset values fall back to the defaults; set ones are inside their documented ranges.
          const ttl = settings.accessTokenTtlSeconds;
          if (ttl !== undefined) expect(ttl >= 60 && ttl <= 86_400).toBe(true);
          const refresh = settings.refreshTokenTtlSeconds;
          if (refresh !== undefined)
            expect(refresh === 0 || (refresh >= 3600 && refresh <= 365 * 86_400)).toBe(true);
        },
      ),
      fuzzParams(2000),
    );
  });
});
