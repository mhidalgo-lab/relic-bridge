// SPDX-License-Identifier: Apache-2.0
// The sealed replay cache and client authentication of the refresh token reuse interval (P5-09, ADR-0013).
import { describe, expect, it } from 'vitest';
import {
  clientAuthenticates,
  openReplay,
  presentedClient,
  type ReplayPayload,
  sealReplay,
} from '../src/oauth/refresh-replay.ts';

const TOKEN = `usr_${'a'.repeat(32)}:${'g'.repeat(16)}:${'s'.repeat(32)}`;
const OTHER = `usr_${'a'.repeat(32)}:${'g'.repeat(16)}:${'t'.repeat(32)}`;
const AAD = 'relic-bridge:oauth-refresh-replay:v1:usr_a:g:hash';
const PAYLOAD: ReplayPayload = {
  v: 1,
  issuedAt: 1_700_000_000,
  clientId: 'client-1',
  resource: 'https://bridge.example.com/p/prod/mcp',
  scope: null,
  successor: 'f'.repeat(64),
  response: { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: 600 },
};

const sha256Hex = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

describe('sealed replay (P5-09)', () => {
  it('round-trips under the same token and AAD and stores no plain text', async () => {
    const sealed = await sealReplay(TOKEN, AAD, PAYLOAD);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    for (const s of ['ACCESS-SECRET', 'REFRESH-SECRET', 'client-1', TOKEN]) expect(sealed).not.toContain(s);
    expect(await openReplay(TOKEN, AAD, sealed)).toEqual(PAYLOAD);
    // A fresh IV every time.
    expect(await sealReplay(TOKEN, AAD, PAYLOAD)).not.toBe(sealed);
  });

  it('does not open with another token, another AAD, or when tampered with or malformed', async () => {
    const sealed = await sealReplay(TOKEN, AAD, PAYLOAD);
    expect(await openReplay(OTHER, AAD, sealed)).toBeNull();
    expect(await openReplay(TOKEN, `${AAD}x`, sealed)).toBeNull();
    const [v, iv, data] = sealed.split('.') as [string, string, string];
    const flipped = `${data.slice(0, -2)}${data.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const bad of [
      `${v}.${iv}.${flipped}`,
      `v2.${iv}.${data}`,
      `${v}.${iv}`,
      `${v}.${iv}.${data}.x`,
      `${v}.***.${data}`,
      '',
    ]) {
      expect(await openReplay(TOKEN, AAD, bad), bad.slice(0, 12)).toBeNull();
    }
  });
});

describe('client authentication for a replay (P5-09)', () => {
  const form = (o: Record<string, string>) => new URLSearchParams(o);
  const basic = (id: string, secret: string) =>
    new Headers({
      authorization: `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`,
    });

  it('reads the client from the form or from Basic credentials, never both', () => {
    expect(presentedClient(new Headers(), form({ client_id: 'c1' }))).toEqual({
      clientId: 'c1',
      method: 'none',
      secret: '',
    });
    expect(presentedClient(new Headers(), form({ client_id: 'c1', client_secret: 'x' }))).toMatchObject({
      method: 'client_secret_post',
      secret: 'x',
    });
    expect(presentedClient(basic('c 1', 's:2'), form({}))).toEqual({
      clientId: 'c 1',
      method: 'client_secret_basic',
      secret: 's:2',
    });
    expect(presentedClient(basic('c1', 's'), form({ client_id: 'c1' }))).toBeNull();
    expect(presentedClient(new Headers({ authorization: 'Basic' }), form({}))).toBeNull();
    expect(presentedClient(new Headers({ authorization: 'Basic !!!' }), form({}))).toBeNull();
    expect(presentedClient(new Headers(), form({}))).toBeNull();
    // A bearer header is not client authentication: the form decides.
    expect(
      presentedClient(new Headers({ authorization: 'Bearer x' }), form({ client_id: 'c1' })),
    ).toMatchObject({
      method: 'none',
    });
  });

  it('accepts the registered method and secret only', async () => {
    const pub = { tokenEndpointAuthMethod: 'none' };
    const conf = { tokenEndpointAuthMethod: 'client_secret_post', clientSecret: await sha256Hex('right') };
    const none = { clientId: 'c', method: 'none', secret: '' } as const;
    const post = (secret: string) => ({ clientId: 'c', method: 'client_secret_post', secret }) as const;
    const viaBasic = { clientId: 'c', method: 'client_secret_basic', secret: 'right' } as const;
    expect(await clientAuthenticates(none, pub, sha256Hex)).toBe(true);
    expect(await clientAuthenticates(post('right'), pub, sha256Hex)).toBe(false);
    expect(await clientAuthenticates(none, conf, sha256Hex)).toBe(false);
    expect(await clientAuthenticates(post('right'), conf, sha256Hex)).toBe(true);
    expect(await clientAuthenticates(post('wrong'), conf, sha256Hex)).toBe(false);
    expect(await clientAuthenticates(post(''), conf, sha256Hex)).toBe(false);
    // The provider's rule: either secret method when the registration named none explicitly.
    expect(await clientAuthenticates(viaBasic, conf, sha256Hex)).toBe(true);
    expect(await clientAuthenticates(viaBasic, { ...conf, authMethodExplicit: true }, sha256Hex)).toBe(false);
    expect(await clientAuthenticates(none, null, sha256Hex)).toBe(false);
  });
});
