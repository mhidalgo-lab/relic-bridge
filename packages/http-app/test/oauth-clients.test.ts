// SPDX-License-Identifier: Apache-2.0
// Client registration policy (P5-03): address classification, client id and redirect URI checks, the metadata
// document fetch bounds. The integration side (authorize/token/register on every host) is in `authz/oauth-suite.ts`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CIMD_MAX_BYTES,
  CIMD_TIMEOUT_MS,
  ClientMetadataError,
  checkRegistration,
  clientIdUrlProblem,
  fetchMetadataDocument,
  isLoopbackHost,
  isPublicIp,
  looksLikeClientIdUrl,
  metadataCacheTtl,
  parseIpv6,
  redirectUriVerdict,
  safeClientName,
  validateMetadataDocument,
} from '../src/oauth/clients.ts';

const ID = 'https://app.example.com/oauth/client.json';
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: ID,
  client_name: 'Example',
  redirect_uris: ['https://app.example.com/cb', 'http://127.0.0.1/cb'],
  ...over,
});

describe('isPublicIp', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:a00:1::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '100::1',
    'fe80::1%eth0',
    'not-an-ip',
    '1.2.3',
    '01.2.3.4',
    '1:2:3:4:5:6:7:8:9',
  ])('refuses %s', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '160.79.104.10',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '[2606:4700::1]',
  ])('allows %s', (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it('parses IPv6 forms', () => {
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIpv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x102, 0x304]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const bad of ['1::2::3', ':::', '1:2:3:4:5:6:7', '12345::', '1:2:3:4:5:6:7:8:1.2.3.4', 'g::1']) {
      expect(parseIpv6(bad), bad).toBeNull();
    }
  });

  it('knows loopback redirect hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.9.9.9', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['localhost.example', '128.0.0.1', '[::2]', '10.0.0.1'])
      expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe('client id URLs (CIMD)', () => {
  it('takes any https-looking id for a metadata document URL (resolved or refused, never passed through)', () => {
    for (const id of [ID, 'HTTPS://x.example/a', ' https://x.example/a', '\thttps://x']) {
      expect(looksLikeClientIdUrl(id), id).toBe(true);
    }
    for (const id of ['abcDEF0123456789', 'http://x.example/a', 'urn:x'])
      expect(looksLikeClientIdUrl(id), id).toBe(false);
  });

  it('accepts canonical https URLs with a path on a public DNS name', () => {
    for (const id of [
      ID,
      'https://claude.ai/oauth/claude-code-client-metadata',
      'https://a.b.example.org/x?v=1',
    ]) {
      expect(clientIdUrlProblem(id, 'bridge.example.org'), id).toBeNull();
    }
  });

  it.each([
    ['https://bridge.example.org/c.json', 'client_id_self'],
    ['https://app.example.com', 'client_id_not_canonical'],
    ['https://app.example.com/', 'client_id_no_path'],
    ['https://App.example.com/c', 'client_id_not_canonical'],
    ['https://app.example.com/a/../c', 'client_id_not_canonical'],
    ['https://app.example.com/a/./c', 'client_id_not_canonical'],
    ['https://app.example.com:443/c', 'client_id_not_canonical'],
    ['https://app.example.com:8443/c', 'client_id_port'],
    ['https://u@app.example.com/c', 'client_id_userinfo'],
    ['https://app.example.com/c#f', 'client_id_fragment'],
    ['https://app.example.com/c#', 'client_id_fragment'],
    ['http://app.example.com/c', 'client_id_not_https'],
    ['https://10.0.0.1/c', 'client_id_ip_literal'],
    ['https://[::1]/c', 'client_id_ip_literal'],
    ['https://0x7f000001/c', 'client_id_not_canonical'],
    ['https://localhost/c', 'client_id_internal_name'],
    ['https://foo.localhost/c', 'client_id_internal_name'],
    ['https://metadata.google.internal/c', 'client_id_internal_name'],
    ['https://nas.local/c', 'client_id_internal_name'],
    ['https://example.com./c', 'client_id_internal_name'],
    ['https://intranet/c', 'client_id_internal_name'],
    ['https://app.example.com\\c', 'client_id_not_canonical'],
    [`https://app.example.com/${'a'.repeat(520)}`, 'client_id_too_long'],
    ['https://', 'client_id_not_url'],
  ])('refuses %s (%s)', (id, reason) => {
    expect(clientIdUrlProblem(id, 'bridge.example.org')).toBe(reason);
  });
});

describe('redirect URIs', () => {
  it('classifies redirect URIs', () => {
    const cimd = { clientHost: 'app.example.com' };
    const cases: [string, ReturnType<typeof redirectUriVerdict>][] = [
      ['https://app.example.com/cb', 'usable'],
      ['https://other.example.com/cb', 'unusable'],
      ['http://127.0.0.1:3000/cb', 'usable'],
      ['http://localhost/cb', 'usable'],
      ['http://[::1]:8080/cb', 'usable'],
      ['https://127.0.0.1/cb', 'usable'],
      ['cursor://anysphere.cursor-mcp/oauth/callback', 'unusable'],
      ['http://app.example.com/cb', 'bad:redirect_uri_http'],
      ['https://10.0.0.1/cb', 'bad:redirect_uri_ip_literal'],
      ['https://[fd00::1]/cb', 'bad:redirect_uri_ip_literal'],
      ['https://app.example.com/cb#x', 'bad:redirect_uri_fragment'],
      ['https://app.example.com/cb#', 'bad:redirect_uri_fragment'],
      ['https://*.example.com/cb', 'bad:redirect_uri_wildcard'],
      ['https://u:p@app.example.com/cb', 'bad:redirect_uri_userinfo'],
      ['https://app.example.com/c b', 'bad:redirect_uri_whitespace'],
      ['not a url', 'bad:redirect_uri_whitespace'],
      ['nope', 'bad:redirect_uri_not_url'],
      [`https://app.example.com/${'a'.repeat(2000)}`, 'bad:redirect_uri_too_long'],
    ];
    for (const [uri, verdict] of cases) expect(redirectUriVerdict(uri, cimd), uri).toBe(verdict);
    expect(redirectUriVerdict(42, {})).toBe('bad:redirect_uri_type');
    expect(redirectUriVerdict('https://other.example.com/cb', {})).toBe('usable');
    expect(redirectUriVerdict('https://other.example.com/cb', { allowedHosts: ['claude.ai'] })).toBe(
      'bad:redirect_uri_host',
    );
    expect(redirectUriVerdict('http://127.0.0.1/cb', { allowedHosts: ['claude.ai'] })).toBe('usable');
  });

  it('checks DCR requests', () => {
    const ok = (meta: unknown) => checkRegistration(JSON.stringify(meta));
    expect(ok({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' })).toEqual(
      {
        ok: true,
      },
    );
    expect(checkRegistration('{')).toMatchObject({ ok: false, reason: 'not_json' });
    expect(ok([])).toMatchObject({ ok: false, reason: 'not_object' });
    expect(ok({ redirect_uris: 'https://x.example/cb' })).toMatchObject({ reason: 'redirect_uris_count' });
    expect(ok({ redirect_uris: ['x-app:/cb'] })).toMatchObject({ reason: 'no_usable_redirect_uri' });
    expect(ok({ redirect_uris: ['https://x.example/cb'], client_name: 7 })).toMatchObject({
      reason: 'client_name',
    });
  });

  it('display names: no control, format or separator characters, ≤ 100 characters', () => {
    expect(safeClientName('  Claude  ')).toBe('Claude');
    expect(safeClientName('Café ☕ 日本')).toBe('Café ☕ 日本');
    for (const bad of ['', '   ', 'a\u0000b', 'a\nb', 'Cl‮aude', 'a​b', 'a b', 'ab', 'x'.repeat(101), 3]) {
      expect(safeClientName(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('metadata documents', () => {
  it('validates a document into a public client record, keeping only usable redirects', () => {
    const client = validateMetadataDocument(
      ID,
      doc({
        redirect_uris: [
          'https://app.example.com/cb',
          'https://evil.example/cb',
          'x-app:/cb',
          'http://localhost/cb',
        ],
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
        logo_uri: 'https://app.example.com/logo.png',
      }),
      1000,
    );
    expect(client).toEqual({
      clientId: ID,
      clientName: 'Example',
      redirectUris: ['https://app.example.com/cb', 'http://localhost/cb'],
      tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      registrationDate: 1000,
    });
  });

  it.each([
    [[], 'not_object'],
    [doc({ client_id: `${ID}x` }), 'client_id_mismatch'],
    [doc({ client_id: undefined }), 'client_id_mismatch'],
    [doc({ client_name: undefined }), 'client_name'],
    [doc({ client_secret: 'x' }), 'client_secret'],
    [doc({ client_secret_expires_at: 0 }), 'client_secret'],
    [doc({ token_endpoint_auth_method: 'private_key_jwt' }), 'token_endpoint_auth_method'],
    [doc({ token_endpoint_auth_method: 'client_secret_basic' }), 'token_endpoint_auth_method'],
    [doc({ grant_types: ['refresh_token'] }), 'grant_types'],
    [doc({ grant_types: 'authorization_code' }), 'grant_types'],
    [doc({ response_types: ['token'] }), 'response_types'],
    [doc({ redirect_uris: [] }), 'redirect_uris_count'],
    [
      doc({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app.example.com/${i}`) }),
      'redirect_uris_count',
    ],
    [doc({ redirect_uris: ['https://evil.example/cb'] }), 'no_usable_redirect_uri'],
    [doc({ redirect_uris: ['https://app.example.com/cb#x'] }), 'redirect_uri_fragment'],
    [doc({ redirect_uris: ['https://192.168.0.1/cb'] }), 'redirect_uri_ip_literal'],
  ])('refuses %j (%s)', (value, reason) => {
    expect(() => validateMetadataDocument(ID, value, 0)).toThrow(
      expect.objectContaining({ reason }) as unknown as Error,
    );
  });

  it('bounds the cache lifetime', () => {
    expect(metadataCacheTtl(null)).toBe(3600);
    expect(metadataCacheTtl('public')).toBe(3600);
    expect(metadataCacheTtl('max-age=10')).toBe(300);
    expect(metadataCacheTtl('max-age=7200')).toBe(7200);
    expect(metadataCacheTtl('max-age=999999999')).toBe(86_400);
    expect(metadataCacheTtl('max-age=600, s-maxage=1200')).toBe(1200);
    expect(metadataCacheTtl('no-store')).toBe(300);
    expect(metadataCacheTtl('private, max-age=9000')).toBe(300);
  });
});

describe('fetchMetadataDocument', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const reason = async (fetcher: Parameters<typeof fetchMetadataDocument>[1]): Promise<string> => {
    try {
      await fetchMetadataDocument(ID, fetcher, 0);
      return 'resolved';
    } catch (error) {
      return error instanceof ClientMetadataError ? error.reason : `other: ${String(error)}`;
    }
  };
  const json = (body: string, headers: Record<string, string> = {}, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });

  it('resolves a valid document with its cache lifetime and asks with an abort signal', async () => {
    let signal: AbortSignal | undefined;
    const r = await fetchMetadataDocument(
      ID,
      async (url, init) => {
        expect(url).toBe(ID);
        signal = init.signal;
        return json(JSON.stringify(doc()), { 'cache-control': 'max-age=900' });
      },
      5,
    );
    expect(r.ttlSeconds).toBe(900);
    expect(r.client.registrationDate).toBe(5);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(
      (
        await fetchMetadataDocument(
          ID,
          async () => json(JSON.stringify(doc()), { 'content-type': 'application/client+json' }),
          0,
        )
      ).client.clientId,
    ).toBe(ID);
  });

  it('refuses redirects, errors, other media types, oversized and broken bodies', async () => {
    const big = JSON.stringify(doc({ pad: 'x'.repeat(CIMD_MAX_BYTES) }));
    expect(
      await reason(
        async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
      ),
    ).toBe('redirect');
    expect(await reason(async () => json('{}', {}, 404))).toBe('http_status');
    expect(await reason(async () => json('{}', {}, 201))).toBe('http_status');
    expect(await reason(async () => json(JSON.stringify(doc()), { 'content-type': 'text/plain' }))).toBe(
      'content_type',
    );
    expect(await reason(async () => new Response(JSON.stringify(doc()), { status: 200 }))).toBe(
      'content_type',
    );
    expect(await reason(async () => json(big, { 'content-length': String(big.length) }))).toBe('too_large');
    expect(await reason(async () => json('{}', { 'content-length': 'abc' }))).toBe('too_large');
    expect(
      await reason(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(1024).fill(32)); // endless whitespace
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    ).toBe('too_large');
    expect(await reason(async () => json('\u{1F600}'.slice(0, 1)))).toBe('not_json');
    expect(
      await reason(
        async () =>
          new Response(new Uint8Array([0x7b, 0xff, 0x7d]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ).toBe('not_utf8');
    expect(await reason(async () => json('nope'))).toBe('not_json');
    expect(
      await reason(async () => {
        throw new TypeError('blocked');
      }),
    ).toBe('fetch_failed');
  });

  it('times out a fetch that never answers, and a body that never ends', async () => {
    vi.useFakeTimers();
    const hang = reason(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS + 1);
    expect(await hang).toBe('timeout');

    let cancelled = false;
    const slow = reason(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS + 1);
    expect(await slow).toBe('timeout');
    expect(cancelled).toBe(true);
  });
});
