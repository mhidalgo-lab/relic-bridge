// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// `GET /admin`: who is signed in, the session, sign-out, and (admins) the first users through the admin API. The
// reference screen for P4-04: a `kit.page` handler, data through `kit.callAdmin`, shared components only.
import type { Hono } from 'hono';
import { DataTable, Facts, Layout, SignOut, Time } from '../components.tsx';
import type { UiKit } from '../kit.ts';

interface UserRow {
  readonly email: string;
  readonly role: string;
  readonly disabledAt: unknown;
}

/** `{ data: [...] }` from a list endpoint, keeping only the fields this page shows (strings only). */
function userRows(body: unknown): UserRow[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data.map((u: Record<string, unknown>) => ({
    email: String(u['email'] ?? ''),
    role: String(u['role'] ?? ''),
    disabledAt: u['disabledAt'] ?? null,
  }));
}

export function registerOverview(ui: Hono, kit: UiKit): void {
  ui.get(
    '/',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      let users: UserRow[] | null | undefined;
      if (principal.role !== 'member') {
        const res = await kit.callAdmin(c, principal, {
          method: 'GET',
          path: '/users',
          query: { limit: '5' },
        });
        users = res.status === 200 ? userRows(res.body) : null;
      }
      return page.html(
        <Layout title="Overview" viewer={principal} current="/admin" flash={page.flash}>
          <section class="card" aria-labelledby="session-heading">
            <h2 id="session-heading">Your session</h2>
            <Facts
              items={[
                ['Email', principal.email],
                ['Role', principal.role],
                ['Ends', <Time at={principal.expiresAt} />],
                ['Idle until', <Time at={principal.idleExpiresAt} />],
              ]}
            />
            <div class="actions">
              <SignOut viewer={principal} />
              <SignOut viewer={principal} everywhere />
            </div>
          </section>
          {users === undefined ? null : users === null ? (
            <p class="flash flash-error" role="alert">
              The user list could not be loaded.
            </p>
          ) : (
            <DataTable
              caption="Users (first 5)"
              empty="No users yet."
              rows={users}
              columns={[
                { header: 'Email', cell: (u) => u.email },
                { header: 'Role', cell: (u) => u.role },
                { header: 'Status', cell: (u) => (u.disabledAt === null ? 'active' : 'disabled') },
              ]}
            />
          )}
        </Layout>,
      );
    }),
  );
}
