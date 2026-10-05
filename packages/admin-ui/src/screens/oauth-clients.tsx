// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// OAuth apps (P5-08, THREAT_MODEL T10): the clients that may ask people for access, and the switch for dynamic client
// registration. Owners only (the admin API decides again).
//
//   GET  /admin/oauth-clients                     list of clients and the registration switch
//   POST /admin/oauth-clients/remove              remove one client and revoke everything issued to it (confirm=yes)
//   POST /admin/oauth-clients/registration        turn dynamic registration on (confirm=yes) or off
//
// Names and URLs come from whoever registered the client: names are plain text children, hosts are plain text, and
// nothing here is ever a link. A metadata-document client is shown with the host that vouches for it; a dynamic one is
// marked not verified.
import type { Hono } from 'hono';
import { Button, DataTable, Form, Layout } from '../components.tsx';
import { ONCE_FIELD, type UiKit } from '../kit.ts';
import { listPage, type OAuthClient, one, parseOAuthClient, parseOAuthRegistration } from './data.ts';
import {
  confirmed,
  confirmPage,
  flashFor,
  isOk,
  listAll,
  loadFailed,
  problemOf,
  StatusBadge,
  When,
} from './shared.tsx';

const BASE = '/admin/oauth-clients';
const ROUTE = '/oauth-clients';
const CLIENT_FIELD = 'clientId';

/** How a client is named in tables and confirmation pages (plain text). */
const clientName = (cl: OAuthClient): string => cl.name ?? 'An unnamed app';

export function registerOAuthClients(ui: Hono, kit: UiKit): void {
  ui.get(
    ROUTE,
    kit.page('owner', async (c, page) => {
      const { principal } = page;
      const [list, reg] = await Promise.all([
        kit.callAdmin(c, principal, { method: 'GET', path: '/oauth/clients' }),
        kit.callAdmin(c, principal, { method: 'GET', path: '/oauth/registration' }),
      ]);
      const listed = isOk(list) ? listPage(list.body, parseOAuthClient) : null;
      if (listed === null) return loadFailed(c, { status: 502, body: null }, principal);
      const clients = listed.rows;
      // The newest apps first; the API says when older ones are left out (a flood of registrations can be large).
      const truncated = (list.body as { truncated?: unknown } | null)?.truncated === true;
      // `404`: OAuth is off on this server.
      const state = isOk(reg) ? one(reg.body, parseOAuthRegistration) : null;
      return page.html(
        <Layout title="OAuth apps" viewer={principal} current={BASE} flash={page.flash}>
          {state === null ? (
            <p class="card">
              OAuth is not enabled on this server (<code>RB_OAUTH</code>), so no apps can connect with it.
            </p>
          ) : (
            <section class="card" aria-labelledby="dcr-heading">
              <h2 id="dcr-heading">Dynamic client registration</h2>
              <p>
                Status:{' '}
                <StatusBadge tone={state.enabled ? 'info' : 'ok'} text={state.enabled ? 'on' : 'off'} />
              </p>
              <p>
                Any app can register itself while this is on, and nothing about it is verified: people see a
                warning on the consent page. Turn it off once the apps you use are listed below (apps that
                identify themselves with a metadata document at their own https address keep working). Apps
                already registered keep working.
              </p>
              {!state.deployment ? (
                <p>
                  The deployment turned it off (<code>RB_OAUTH_DCR=off</code>); it cannot be turned on here.
                </p>
              ) : (
                <Form
                  action={`${BASE}/registration`}
                  csrf={principal.csrf}
                  label="Dynamic client registration"
                >
                  <input type="hidden" name="enabled" value={state.setting ? 'off' : 'on'} />
                  <div class="actions">
                    <Button variant={state.setting ? 'danger' : 'primary'}>
                      {state.setting ? 'Turn registration off' : 'Turn registration on…'}
                    </Button>
                  </div>
                </Form>
              )}
            </section>
          )}
          <section aria-labelledby="clients-heading">
            <h2 id="clients-heading">Apps known to this server</h2>
            <p>
              Names are chosen by whoever registered the app. Removing an app revokes every device
              authorization of it for all users and forgets their remembered approvals; a metadata-document
              app can start over with consent.
            </p>
            {truncated && (
              <p class="card">
                More apps exist than are shown: this list has the newest ones and leaves out the oldest.
              </p>
            )}
            <DataTable
              caption="OAuth apps"
              empty="No OAuth apps yet."
              rows={clients}
              columns={[
                { header: 'App', cell: (cl) => clientName(cl) },
                {
                  header: 'Identity',
                  cell: (cl) =>
                    cl.kind === 'metadata_document' && cl.host !== null ? (
                      <span>
                        by <strong>{cl.host}</strong>
                      </span>
                    ) : (
                      <StatusBadge tone="muted" text="not verified" />
                    ),
                },
                {
                  header: 'Redirects to',
                  cell: (cl) => (cl.redirectHosts.length === 0 ? '—' : cl.redirectHosts.join(', ')),
                },
                { header: 'Registered', cell: (cl) => <When at={cl.registeredAt} /> },
                { header: 'Record ends', cell: (cl) => <When at={cl.expiresAt} none="never" /> },
                {
                  header: 'Action',
                  cell: (cl) => (
                    <Form action={`${BASE}/remove`} csrf={principal.csrf}>
                      <input type="hidden" name={CLIENT_FIELD} value={cl.id} />
                      <button
                        type="submit"
                        class="button button-secondary button-small"
                        aria-label={`Remove ${clientName(cl)}`}
                      >
                        Remove…
                      </button>
                    </Form>
                  ),
                },
              ]}
            />
          </section>
        </Layout>,
      );
    }),
  );

  ui.post(
    `${ROUTE}/remove`,
    kit.form('owner', async (c, principal, form) => {
      const clientId = form.fields.get(CLIENT_FIELD) ?? '';
      if (clientId === '' || clientId.length > 512) return kit.redirect(BASE, 'not_found');
      if (!confirmed(form)) {
        const clients = await listAll(kit, c, principal, '/oauth/clients', parseOAuthClient);
        const client = (clients ?? []).find((cl) => cl.id === clientId);
        if (client === undefined) return kit.redirect(BASE, 'not_found');
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: `Remove ${clientName(client)}?`,
          paragraphs: [
            client.kind === 'metadata_document' && client.host !== null
              ? `This app identifies itself as ${client.host}. It can ask again, and people will be asked for consent again.`
              : 'This app registered itself and nothing about it was verified. It cannot ask again unless it registers again.',
            'Every device authorization of this app is revoked for all users: its access and refresh tokens stop working, and remembered approvals are forgotten.',
          ],
          action: `${BASE}/remove`,
          confirm: 'Remove app',
          cancel: BASE,
          hidden: [
            [CLIENT_FIELD, client.id],
            [ONCE_FIELD, await kit.issueOnce(principal)],
          ],
        });
      }
      // A re-sent confirmation (reload, back button) removes nothing twice.
      if (!(await kit.claimOnce(form))) return kit.redirect(BASE, 'form_used');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/oauth/clients/remove', body: { clientId } },
        form,
      );
      if (isOk(res)) return kit.redirect(BASE, 'client_removed');
      return kit.redirect(BASE, flashFor(problemOf(res)));
    }),
  );

  ui.post(
    `${ROUTE}/registration`,
    kit.form('owner', async (c, principal, form) => {
      const value = form.fields.get('enabled');
      if (value !== 'on' && value !== 'off') return kit.redirect(BASE, 'failed');
      const enabled = value === 'on';
      // Turning registration on opens the server to self-registered apps: say so first.
      if (enabled && !confirmed(form)) {
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: 'Turn dynamic client registration on?',
          paragraphs: [
            'Any app can then register itself without anyone checking it. People still see a warning on the consent page and must approve each app.',
          ],
          action: `${BASE}/registration`,
          confirm: 'Turn registration on',
          cancel: BASE,
          hidden: [['enabled', 'on']],
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/oauth/registration', body: { enabled } },
        form,
      );
      if (isOk(res)) return kit.redirect(BASE, enabled ? 'registration_on' : 'registration_off');
      const problem = problemOf(res);
      return kit.redirect(BASE, problem.status === 404 ? 'oauth_off' : flashFor(problem));
    }),
  );
}
