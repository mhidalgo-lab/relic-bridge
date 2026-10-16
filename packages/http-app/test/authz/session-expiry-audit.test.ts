// SPDX-License-Identifier: Apache-2.0
// P8-85 (ASVS V16.3.1, T17, T20): session expiry is deliberately not a `session.expired` row. Nothing runs when a
// session lapses, so a row would only appear when someone next presents the old cookie, and that request is already an
// `auth.denied` row with the reason (`session_idle`, `session_expired`), capped like every refusal. This test pins that
// evidence, so the decision in `docs/security/logging.md` stays true.
import { DEFAULT_SESSION_TIMEOUTS } from '@relic-bridge/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, PUBLIC_ORIGIN } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

const check = (headers: Readonly<Record<string, string>>) =>
  h.send(new Request(`${PUBLIC_ORIGIN}/api/admin/v1/session`, { headers }));
const denials = async () => (await h.auditRows()).filter((r) => r.action === 'auth.denied');

describe('an expired session is audited when it is presented', () => {
  it('idle expiry writes auth.denied with session_idle, and no session.expired row exists', async () => {
    const s = await h.addSession({ role: 'member' });
    expect((await check(s.headers)).status).toBe(200);
    h.world.clock.advance(DEFAULT_SESSION_TIMEOUTS.idleMs + 1000);
    expect((await check(s.headers)).status).toBe(401);
    await expect.poll(async () => (await denials()).map((r) => r.errorCode)).toContain('session_idle');
    expect((await h.auditRows()).some((r) => r.action === 'session.expired')).toBe(false);
  });

  it('absolute expiry writes auth.denied with session_expired', async () => {
    const s = await h.addSession({ role: 'member' });
    for (
      let elapsed = 0;
      elapsed <= DEFAULT_SESSION_TIMEOUTS.absoluteMs;
      elapsed += DEFAULT_SESSION_TIMEOUTS.idleMs / 2
    ) {
      h.world.clock.advance(DEFAULT_SESSION_TIMEOUTS.idleMs / 2);
      if (elapsed <= DEFAULT_SESSION_TIMEOUTS.absoluteMs - DEFAULT_SESSION_TIMEOUTS.idleMs)
        await check(s.headers);
    }
    expect((await check(s.headers)).status).toBe(401);
    await expect.poll(async () => (await denials()).map((r) => r.errorCode)).toContain('session_expired');
  });
});
