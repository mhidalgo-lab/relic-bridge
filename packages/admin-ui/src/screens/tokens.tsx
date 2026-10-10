// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Device tokens (P4-04, THREAT_MODEL T8): list, issue, revoke. A new token is shown exactly once, on the answer to the
// POST that issued it (`Cache-Control: no-store` like every UI page): never in a redirect, a flash, a URL or a log.
//
//   GET  /admin/tokens                  list (filter: grant; cursor pages)
//   GET  /admin/tokens/new              step 1: choose the grant
//   GET  /admin/tokens/new?grant=<id>   step 2: device name and lifetime
//   POST /admin/tokens                  issue → the one-time page
//   POST /admin/tokens/:id/revoke       revoke (needs confirm=yes)
//
// Connected OAuth clients join this screen with Phase 5.
import type { Context, Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Button,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  Pager,
  QueryForm,
  SecretOnce,
  SelectField,
  TextField,
} from '../components.tsx';
import { adminPath, ONCE_FIELD, type UiKit, type UiPrincipal } from '../kit.ts';
import { htmlResponse } from '../pages.tsx';
import { SnippetList } from '../snippets.tsx';
import {
  type Grant,
  isId,
  one,
  type Project,
  parseCredential,
  parseGrant,
  parseProject,
  parseToken,
  parseUser,
  type Token,
  validCursor,
} from './data.ts';
import { grantFor } from './grants.tsx';
import { endpointOf } from './projects.tsx';
import {
  confirmed,
  confirmPage,
  FormError,
  field,
  flashFor,
  formMessage,
  isOk,
  lifecycle,
  listAll,
  listOne,
  loadFailed,
  Notes,
  ownerLock,
  problemOf,
  RowAction,
  StatusBadge,
  When,
  withQuery,
} from './shared.tsx';

const BASE = '/admin/tokens';
/** Route paths inside the `/admin` sub-app. */
const ROUTE = '/tokens';

/** Lifetimes offered (days; `never` is warned about). */
export const LIFETIMES = [
  ['30', '30 days'],
  ['90', '90 days (default)'],
  ['180', '180 days'],
  ['365', '1 year'],
  ['never', 'Never expires (not recommended)'],
] as const;

interface Lookup {
  readonly grants: ReadonlyMap<string, Grant>;
  readonly projects: ReadonlyMap<string, Project>;
  readonly emails: ReadonlyMap<string, string>;
}

const grantText = (grantId: string, l: Lookup): string => {
  const g = l.grants.get(grantId);
  if (g === undefined) return grantId;
  return `${l.projects.get(g.projectId)?.slug ?? g.projectId}: ${grantFor(g, l.emails)}`;
};

function newTokenPage(
  viewer: UiPrincipal,
  grant: Grant,
  lookup: Lookup,
  values: { label: string; lifetime: string },
  errors: Readonly<Record<string, string>>,
  once: string,
  message?: string,
) {
  return (
    <Layout title="New device token" viewer={viewer} current={BASE}>
      <p>
        For <strong>{grantText(grant.id, lookup)}</strong>. One token per device, so you can revoke a lost
        laptop or phone alone. <a href={`${BASE}/new`}>Choose another grant</a>
      </p>
      <FormError message={message} />
      <Form action={BASE} csrf={viewer.csrf} label="New device token">
        <input type="hidden" name="grantId" value={grant.id} />
        <input type="hidden" name={ONCE_FIELD} value={once} />
        <TextField
          name="label"
          label="Device name"
          hint="e.g. laptop, work-pc, phone."
          value={values.label}
          required
          maxlength={100}
          error={errors['label']}
        />
        <SelectField
          name="lifetime"
          label="Lifetime"
          value={values.lifetime}
          error={errors['lifetime']}
          options={LIFETIMES.map(([value, label]) => ({ value, label }))}
        />
        <div class="actions">
          <Button>Create token</Button>
          <LinkButton href={adminPath`/admin/grants/${grant.id}`} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

/**
 * The one-time page of a new device token (shared with the member screens): the token in a secret box, notes, how to use
 * it and the connect snippets. Rendered only as the answer to the POST that issued the token.
 */
export function IssuedTokenPage(props: {
  readonly viewer: UiPrincipal;
  readonly current: string;
  readonly record: Token;
  readonly token: string;
  readonly warnings: readonly string[];
  readonly endpoint: string;
  readonly slug: string;
  readonly done: string;
}): JSX.Element {
  const { record, token, endpoint } = props;
  return (
    <Layout title="Your new device token" viewer={props.viewer} current={props.current}>
      <div class="flash flash-info" role="status">
        Copy the token now. It is not stored and cannot be shown again: if you lose it, revoke it and create a
        new one.
      </div>
      <section class="card secret" aria-labelledby="token-label">
        <SecretOnce id="token" label={`Token for ${record.label}`} value={token} />
      </section>
      <Notes title="Notes" items={props.warnings} />
      <section aria-labelledby="use-heading">
        <h2 id="use-heading">Use it</h2>
        <Facts
          items={[
            ['MCP endpoint', <code>{endpoint}</code>],
            ['Header', <code>{'Authorization: Bearer <the token above>'}</code>],
            ['Expires', <When at={record.expiresAt} none="never" />],
          ]}
        />
        <ul>
          <li>Paste it only into this device's MCP client configuration or its secret store.</li>
          <li>Never paste it into a chat, a ticket, a shared document or a repository.</li>
          <li>This page is shown once: reloading it does not show the token again or create another one.</li>
        </ul>
      </section>
      <section aria-labelledby="snippets-heading">
        <h2 id="snippets-heading">Connect a client</h2>
        <p>
          Pick your client. The commands read the token from an environment variable, so it never lands in
          your shell history or a file you might commit. Only the Claude Desktop snippet holds the token
          itself.
        </p>
        <SnippetList endpoint={endpoint} slug={props.slug} token={token} idPrefix="connect" />
      </section>
      <div class="actions">
        <LinkButton href={props.done}>Done</LinkButton>
      </div>
    </Layout>
  );
}

export function registerTokens(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  const lookup = async (c: Context, principal: UiPrincipal, grantQuery: Record<string, string> = {}) => {
    const [grants, projects, users, credentials] = await Promise.all([
      listAll(kit, c, principal, '/grants', parseGrant, grantQuery),
      listAll(kit, c, principal, '/projects', parseProject),
      listAll(kit, c, principal, '/users', parseUser),
      // Only to know whose key a grant uses; an owner can act on everything and needs no lookup.
      principal.role === 'owner'
        ? Promise.resolve([])
        : listAll(kit, c, principal, '/credentials', parseCredential),
    ]);
    const keyOwner = new Map((credentials ?? []).map((k) => [k.id, k.ownerUserId]));
    const lock = ownerLock(principal, users);
    return {
      /** An administrator may not revoke a token of an owner's grant or of a grant using an owner's key. */
      locked: (grantId: string): boolean => {
        const g = (grants ?? []).find((x) => x.id === grantId);
        return g === undefined
          ? false
          : lock(g.userId, g.credentialId === null ? null : keyOwner.get(g.credentialId));
      },
      grants: new Map((grants ?? []).map((g) => [g.id, g])),
      projects: new Map((projects ?? []).map((p) => [p.id, p])),
      emails: new Map((users ?? []).map((u) => [u.id, u.email])),
    };
  };

  const loadGrant = async (c: Context, principal: UiPrincipal, id: string) => {
    const res = await kit.callAdmin(c, principal, { method: 'GET', path: adminPath`/grants/${id}` });
    return isOk(res) ? one(res.body, parseGrant) : null;
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const cursor = validCursor(c.req.query('cursor'));
      const grant = c.req.query('grant');
      const grantId = isId(grant) ? grant : undefined;
      const list = await listOne(kit, c, principal, '/tokens', parseToken, {
        ...(grantId ? { grantId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!('rows' in list)) return loadFailed(c, list, principal);
      const l = await lookup(c, principal);
      const t = now();
      return page.html(
        <Layout title="Device tokens" viewer={principal} current={BASE} flash={page.flash}>
          <p>
            Each device (laptop, phone, CI job) connects to a project with its own token. Tokens are stored as
            hashes: only the first characters are shown here.
          </p>
          <div class="actions page-actions">
            <LinkButton href={withQuery(`${BASE}/new`, { grant: grantId })}>New device token</LinkButton>
          </div>
          <QueryForm action={BASE} label="Filter tokens">
            <SelectField
              name="grant"
              label="Grant"
              value={grantId ?? ''}
              options={[
                { value: '', label: 'All grants' },
                ...[...l.grants.values()].map((g) => ({ value: g.id, label: grantText(g.id, l) })),
              ]}
            />
            <Button variant="secondary">Filter</Button>
          </QueryForm>
          <DataTable
            caption="Device tokens"
            empty={grantId ? 'This grant has no device tokens.' : 'No device tokens yet.'}
            rows={list.rows}
            columns={[
              { header: 'Device', cell: (k) => k.label },
              { header: 'Token', cell: (k) => <code>{`${k.prefix}…`}</code> },
              {
                header: 'Grant',
                cell: (k) => <a href={adminPath`/admin/grants/${k.grantId}`}>{grantText(k.grantId, l)}</a>,
              },
              { header: 'Status', cell: (k) => <StatusBadge {...lifecycle(k, t)} /> },
              { header: 'Last used', cell: (k) => <When at={k.lastUsedAt} none="never" /> },
              { header: 'Expires', cell: (k) => <When at={k.expiresAt} none="never" /> },
              {
                header: 'Action',
                cell: (k) =>
                  k.revokedAt === null && !l.locked(k.grantId) ? (
                    <RowAction
                      action={`${BASE}${adminPath`/${k.id}/revoke`}`}
                      csrf={principal.csrf}
                      label="Revoke…"
                      name={`Revoke ${k.label}`}
                    />
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <Pager
            label="Token pages"
            next={
              list.nextCursor === null ? null : withQuery(BASE, { grant: grantId, cursor: list.nextCursor })
            }
            first={cursor === undefined ? undefined : withQuery(BASE, { grant: grantId })}
          />
        </Layout>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const chosen = c.req.query('grant');
      const grant = isId(chosen) ? await loadGrant(c, principal, chosen) : null;
      const l = await lookup(c, principal);
      if (grant === null || grant.revokedAt !== null) {
        const t = now();
        const live = [...l.grants.values()].filter((g) => lifecycle(g, t).text === 'active');
        return page.html(
          <Layout title="New device token" viewer={principal} current={BASE} flash={page.flash}>
            <p>Step 1 of 2: choose the grant the device connects with.</p>
            {live.length === 0 ? (
              <p class="card">
                There is no active grant. <a href="/admin/grants/new">Create a grant</a> first.
              </p>
            ) : (
              <QueryForm action={`${BASE}/new`} label="Choose the grant">
                <SelectField
                  name="grant"
                  label="Grant"
                  options={live.map((g) => ({ value: g.id, label: grantText(g.id, l) }))}
                />
                <div class="actions">
                  <Button>Next</Button>
                  <LinkButton href={BASE} variant="secondary">
                    Cancel
                  </LinkButton>
                </div>
              </QueryForm>
            )}
          </Layout>,
        );
      }
      return page.html(
        newTokenPage(principal, grant, l, { label: '', lifetime: '90' }, {}, await kit.issueOnce(principal)),
      );
    }),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const grantId = field(form, 'grantId');
      if (!isId(grantId)) return kit.redirect(`${BASE}/new`, 'not_found');
      const grant = await loadGrant(c, principal, grantId);
      if (grant === null) return kit.redirect(`${BASE}/new`, 'not_found');
      const label = field(form, 'label');
      const lifetime = form.fields.get('lifetime') ?? '90';
      const values = { label: form.fields.get('label') ?? '', lifetime };
      const errors: Record<string, string> = {};
      if (label === null || label.length > 100)
        errors['label'] = 'Enter a device name of up to 100 characters.';
      if (!LIFETIMES.some(([v]) => v === lifetime)) errors['lifetime'] = 'Choose a lifetime from the list.';
      const again = async (errs: Record<string, string>, message?: string, status = 422) =>
        htmlResponse(
          newTokenPage(
            principal,
            grant,
            await lookup(c, principal),
            values,
            errs,
            await kit.issueOnce(principal),
            message,
          ),
          status,
        );
      if (Object.keys(errors).length > 0) return again(errors);
      // A re-sent form (reload or back button on the one-time page) must not issue another token (P4-07): the form's
      // single-use handle is taken here, before the API call. A used, expired or missing handle issues nothing.
      if (!(await kit.claimOnce(form)))
        return kit.redirect(withQuery(BASE, { grant: grantId }), 'token_form_used');

      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: '/tokens',
          body: {
            grantId,
            label,
            ttlSeconds: lifetime === 'never' ? 'never' : Number(lifetime) * 86_400,
          },
        },
        form,
      );
      if (!isOk(res)) {
        const problem = problemOf(res);
        if (problem.status === 404) return kit.redirect(`${BASE}/new`, 'not_found');
        if (problem.field === 'label' && problem.status === 400) return again({ label: problem.message });
        return again({}, formMessage(problem));
      }
      const body = res.body as { token?: unknown; warnings?: unknown } | null;
      const token = typeof body?.token === 'string' ? body.token : null;
      const record = one(res.body, parseToken);
      if (token === null || record === null)
        return again({}, 'The token could not be shown. Revoke it and try again.');
      const warnings = Array.isArray(body?.warnings)
        ? body.warnings.filter((w): w is string => typeof w === 'string')
        : [];
      const project = (await lookup(c, principal)).projects.get(grant.projectId);
      // The one place a token is ever rendered. The page is `no-store`; the token is not kept anywhere.
      return htmlResponse(
        <IssuedTokenPage
          viewer={principal}
          current={BASE}
          record={record}
          token={token}
          warnings={warnings}
          endpoint={endpointOf(kit.deps.publicUrl, project?.slug ?? '<project>')}
          slug={project?.slug ?? 'project'}
          done={adminPath`/admin/grants/${grant.id}`}
        />,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/revoke`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const self = `${BASE}${adminPath`/${id}/revoke`}`;
      if (!confirmed(form)) {
        const got = await kit.callAdmin(c, principal, { method: 'GET', path: adminPath`/tokens/${id}` });
        const token = isOk(got) ? one(got.body, parseToken) : null;
        if (token === null) return kit.redirect(BASE, flashFor(problemOf(got)));
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: `Revoke the token of ${token.label}?`,
          paragraphs: [
            `The device using ${token.prefix}… loses access at once. Other devices keep working.`,
            'A revoked token cannot be restored: the device needs a new token.',
          ],
          action: self,
          confirm: `Revoke ${token.label}`,
          cancel: withQuery(BASE, { grant: token.grantId }),
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/tokens/${id}/revoke` },
        form,
      );
      if (isOk(res)) {
        const token = one(res.body, parseToken);
        return kit.redirect(withQuery(BASE, { grant: token?.grantId }), 'revoked');
      }
      return kit.redirect(BASE, flashFor(problemOf(res)));
    }),
  );
}
