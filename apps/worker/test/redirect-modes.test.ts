// SPDX-License-Identifier: Apache-2.0
// P8-65: credentialed outbound requests (NerdGraph, OTLP export, IdP calls, JWKS, client metadata documents) use
// `redirect: 'manual'` and refuse a 3xx themselves. workerd accepts only `follow` and `manual`: `error` throws.
import { describe, expect, it } from 'vitest';

const init = (redirect: RequestRedirect): RequestInit => ({ method: 'POST', body: '{}', redirect });

describe('workerd redirect modes', () => {
  it('keeps redirect: manual on an outbound request', () => {
    expect(new Request('https://api.newrelic.com/graphql', init('manual')).redirect).toBe('manual');
  });

  it('rejects redirect: error (so no outbound request in the Worker path may use it)', () => {
    expect(() => new Request('https://api.newrelic.com/graphql', init('error'))).toThrow(TypeError);
  });
});
