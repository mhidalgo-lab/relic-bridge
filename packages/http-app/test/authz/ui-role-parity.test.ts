// SPDX-License-Identifier: Apache-2.0
// The panel keeps its own copy of the role ranks and page roles (`admin-ui/src/components.tsx`, used to hide links and
// to gate pages); the API has `ROLE_RANK` and `requiredRole` (P4-20, review Q4). They must not drift apart: the ranks
// are equal, and every navigation entry is reachable exactly by the roles the menu shows it to.
import { NAV_ITEMS, UI_ROLE_RANK } from '@relic-bridge/admin-ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_RANK } from '../../src/session.ts';
import { createHarness, type Harness, PUBLIC_ORIGIN } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

describe('UI and API role rules agree', () => {
  it('the rank tables are identical', () => {
    expect({ ...UI_ROLE_RANK }).toEqual({ ...ROLE_RANK });
  });

  it('every navigation page answers 403 role below its minimum and not 403 at or above it', async () => {
    for (const role of ['member', 'admin', 'owner'] as const) {
      const s = await h.addSession({ role });
      for (const item of NAV_ITEMS) {
        const res = await h.send(
          new Request(`${PUBLIC_ORIGIN}${item.href}`, {
            headers: {
              cookie: s.cookie,
              'sec-fetch-site': 'same-origin',
              'sec-fetch-mode': 'navigate',
              'sec-fetch-dest': 'document',
            },
          }),
        );
        const allowed = ROLE_RANK[role] >= ROLE_RANK[item.minRole];
        expect(res.status === 403, `${role} ${item.href} -> ${res.status}`).toBe(!allowed);
      }
    }
  });
});
