// SPDX-License-Identifier: Apache-2.0
// Write tools in the access resolver (P7-09, ADR-0015): only with an explicit name in the project AND the grant, never
// through `null` ("every tool"), never with somebody else's personal key, never past the catalog (server flag).
import { WRITE_TOOL_NAMES } from '@relic-bridge/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createGrant } from '../src/access/config.ts';
import { computeAccess } from '../src/access/resolve.ts';
import { CATALOG, credential, grant, input, project, user } from './access-fixtures.ts';

const WRITES = [...WRITE_TOOL_NAMES];
/** The catalog of a server with `RB_WRITE_TOOLS=on`. */
const WITH_WRITES = [...CATALOG, ...WRITES];

const toolsOf = (over: Parameters<typeof input>[0]): readonly string[] => {
  const d = computeAccess(input({ catalog: WITH_WRITES, ...over }));
  if (!d.ok) throw new Error(d.reason);
  return d.access.tools;
};
const writesOf = (over: Parameters<typeof input>[0]) => toolsOf(over).filter((t) => WRITES.includes(t));

describe('computeAccess: write tools', () => {
  it('never through null tool lists', () => {
    expect(writesOf({})).toEqual([]);
    expect(writesOf({ project: project({ enabledTools: WITH_WRITES }) })).toEqual([]);
    expect(writesOf({ grant: grant({ tools: WITH_WRITES }) })).toEqual([]);
  });

  it('only when both the project and the grant name it', () => {
    expect(
      writesOf({
        project: project({ enabledTools: ['whoami', 'close_issue', 'acknowledge_issue'] }),
        grant: grant({ tools: ['whoami', 'close_issue', 'create_change_event'] }),
      }),
    ).toEqual(['close_issue']);
  });

  it('create_dashboard (P7-19) stores raw NRQL: hidden when raw NRQL is off on either side, even when named', () => {
    const named = { project: project({ enabledTools: WITH_WRITES }), grant: grant({ tools: WITH_WRITES }) };
    expect(writesOf(named)).toContain('create_dashboard');
    for (const [p, g] of [
      [{ rawNrql: false }, {}],
      [{}, { rawNrql: false }],
    ] as const) {
      const writes = writesOf({
        project: project({ enabledTools: WITH_WRITES, limits: p }),
        grant: grant({ tools: WITH_WRITES, limits: g }),
      });
      expect(writes).not.toContain('create_dashboard');
      // The other write tools take no NRQL and stay.
      expect(writes).toContain('acknowledge_issue');
    }
  });

  it('not when the server flag is off (the catalog lacks them)', () => {
    const d = computeAccess(
      input({
        catalog: CATALOG,
        project: project({ enabledTools: ['whoami', ...WRITES] }),
        grant: grant({ tools: ['whoami', ...WRITES] }),
      }),
    );
    expect(d.ok && d.access.tools).toEqual(['whoami']);
  });

  it("key boundary: a shared key or the grant user's own key only", () => {
    const named = { project: project({ enabledTools: WITH_WRITES }), grant: grant({ tools: WITH_WRITES }) };
    expect(writesOf({ ...named, credential: credential({ ownerUserId: null }) })).toEqual(WRITES);
    expect(writesOf({ ...named, credential: credential({ ownerUserId: 'usr_a' }) })).toEqual(WRITES);
    // usr_b's grant on a project whose default key is usr_a's personal key: read tools only.
    const other = {
      project: project({ enabledTools: WITH_WRITES }),
      grant: grant({ userId: 'usr_b', tools: WITH_WRITES }),
      user: user({ id: 'usr_b' }),
      credential: credential({ ownerUserId: 'usr_a' }),
      credentialOwner: user({ id: 'usr_a' }),
    };
    expect(toolsOf(other)).toContain('whoami');
    expect(writesOf(other)).toEqual([]);
    // A service grant (no user) never uses a personal key for writes either.
    expect(
      writesOf({
        ...named,
        grant: grant({ userId: null, label: 'bot', tools: WITH_WRITES }),
        user: null,
        credentialOwner: user({ id: 'usr_a' }),
      }),
    ).toEqual([]);
  });

  it('a grant with only write tools on a project without them is denied (no tools), never widened', () => {
    const d = computeAccess(input({ catalog: WITH_WRITES, grant: grant({ tools: ['close_issue'] }) }));
    expect(d).toEqual({ ok: false, reason: 'no_tools' });
  });

  it('property: a write tool is granted only if explicitly named by both and the key is not someone else’s', () => {
    const lists = fc.option(fc.subarray(WITH_WRITES), { nil: null });
    fc.assert(
      fc.property(lists, lists, fc.constantFrom(null, 'usr_a', 'usr_x'), (p, g, owner) => {
        const d = computeAccess(
          input({
            catalog: WITH_WRITES,
            project: project({ enabledTools: p }),
            grant: grant({ tools: g }),
            credential: credential({ ownerUserId: owner }),
            ...(owner === 'usr_x' ? { credentialOwner: user({ id: 'usr_x' }) } : {}),
          }),
        );
        if (!d.ok) return;
        for (const t of d.access.tools.filter((x) => WRITES.includes(x))) {
          expect(p?.includes(t) && g?.includes(t)).toBe(true);
          expect(owner === 'usr_x').toBe(false);
        }
      }),
    );
  });
});

describe('createGrant warns about write tools a null project cannot enable', () => {
  it('stores them, with a warning', async () => {
    const projects = new Map([['prj_a', project()]]);
    const storage = {
      projects: { get: async (id: string) => projects.get(id) ?? null },
      users: { get: async () => user() },
      credentials: { get: async () => credential() },
      grants: { create: async (g: unknown) => g },
    };
    const result = await createGrant(
      storage as never,
      { projectId: 'prj_a', userId: 'usr_a', tools: ['whoami', 'close_issue'] },
      WITH_WRITES,
      0,
    );
    expect(result.warnings.join(' ')).toContain('write tools take effect only when the project names them');
  });
});
