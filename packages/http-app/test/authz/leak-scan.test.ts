// SPDX-License-Identifier: Apache-2.0
// P8-97: the OAuth suites' leak scan lists only credentials, so a public token-response field can never fail it by chance.
import { describe, expect, it } from 'vitest';
import { credentialsOf, expectOnlyCredentials, MIN_SECRET_LENGTH } from './oauth-suite.ts';

const access = `rb_live_${'a'.repeat(43)}_abcdef`;
const refresh = `rb_live_${'b'.repeat(43)}_ghijkl`;
const body = JSON.stringify({
  access_token: access,
  refresh_token: refresh,
  token_type: 'bearer',
  expires_in: 600,
  scope: 'mcp:read offline_access',
  resource: 'http://localhost/p/prod/mcp',
});

describe('OAuth leak scan secret list (P8-97)', () => {
  it('holds the access and refresh token and no public field of the response', () => {
    const list = credentialsOf(body);
    expect(list).toEqual([access, refresh]);
    for (const publicValue of [
      'bearer',
      'Bearer',
      '600',
      'mcp:read offline_access',
      'http://localhost/p/prod/mcp',
    ])
      expect(list).not.toContain(publicValue);
  });

  it('skips a missing credential instead of queueing an empty string that matches every log', () => {
    expect(credentialsOf(JSON.stringify({ access_token: access }))).toEqual([access]);
  });

  it('refuses a value too short to be a secret (a request id contains "600" about 1 run in 30)', () => {
    expect(() => expectOnlyCredentials(['600'])).toThrow();
    expect(() => expectOnlyCredentials([''])).toThrow();
    expect(() => expectOnlyCredentials(['x'.repeat(MIN_SECRET_LENGTH)])).not.toThrow();
  });
});
